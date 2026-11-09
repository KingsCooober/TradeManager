package aiproviders

// CodeArts 登录会话管理：复刻 Jet Hub 的两步式 account.create / login.poll。
// ① StartLogin 立即写入占位账号并返回 loginUrl（window.open 只在用户手势的
//    transient activation 内有效，不能等完整 OAuth 走完才返回）；
// ② 本机 loopback 回调 server 收到 code 后后台用 STS 换凭据，写凭据库并回填账号；
// ③ Poll 只读「凭据是否落库」判定成功，失败终态单独记表。
// 远程部署时浏览器回调打不到 127.0.0.1，提供 SubmitCode 手动回填授权 code 兜底。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const loginSessionTTL = 5 * time.Minute

type loginSession struct {
	providerID string
	accountID  string
	refName    string
	port       int
	pkce       pkcePair
	key        *dpopKeyPair
	ticketID   string
	createdAt  int64
	codeCh     chan string
	closeOnce  sync.Once
	server     *http.Server
	listener   net.Listener
}

// LoginStartResult 是 StartLogin 的返回（对齐 Jet Hub account.create 的 value）。
type LoginStartResult struct {
	AccountID      string `json:"accountId"`
	LoginURL       string `json:"loginUrl"`
	IncognitoOpened bool  `json:"incognitoOpened"`
	CallbackPort   int    `json:"callbackPort"`
}

// LoginPollResult 是 Poll 的返回（对齐 Jet Hub login.poll 的三态）。
type LoginPollResult struct {
	Done    bool   `json:"done"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

// LoginBroker 持有进行中的登录会话。进程内状态，不落盘。
type LoginBroker struct {
	mu       sync.Mutex
	store    *Store
	client   *http.Client
	sessions map[string]*loginSession
	failures map[string]string
}

func NewLoginBroker(store *Store, client *http.Client) *LoginBroker {
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	return &LoginBroker{
		store:    store,
		client:   client,
		sessions: map[string]*loginSession{},
		failures: map[string]string{},
	}
}

func randomHex(n int) string {
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func shortID() string { return randomHex(4) } // 8 字符，对齐插件 shortId()

// StartLogin 只支持 codearts。立即返回，不等 OAuth 完成。
func (b *LoginBroker) StartLogin(providerID string) (LoginStartResult, error) {
	if providerID != ProviderCodeArts {
		return LoginStartResult{}, fmt.Errorf("该供应商暂不支持登录：%s", providerID)
	}
	pkce, err := newPKCE()
	if err != nil {
		return LoginStartResult{}, err
	}
	key, err := newDPoPKeyPair()
	if err != nil {
		return LoginStartResult{}, err
	}
	accountID := ProviderCodeArts + "-" + shortID()
	refName := strings.ToUpper(ProviderCodeArts) + "_ACCOUNT_" + strings.ToUpper(shortID())
	ticketID := randomHex(32)

	// 找一个 >= 10000 的回环端口（portal 会据此拼 redirect_uri）。
	listener, port, err := listenCallbackPort()
	if err != nil {
		return LoginStartResult{}, err
	}

	session := &loginSession{
		providerID: providerID,
		accountID:  accountID,
		refName:    refName,
		port:       port,
		pkce:       pkce,
		key:        key,
		ticketID:   ticketID,
		createdAt:  time.Now().UnixMilli(),
		codeCh:     make(chan string, 1),
		listener:   listener,
	}

	// 占位账号：enabled、无凭据、refreshable=false。凭据落库后回填 nickname 等。
	if err := b.store.UpsertAccount(providerID, Account{
		ID:            accountID,
		Nickname:      accountID,
		Enabled:       true,
		CredentialRef: refName,
		Refreshable:   false,
		CreatedAt:     session.createdAt,
	}); err != nil {
		_ = listener.Close()
		return LoginStartResult{}, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc(caRedirectPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		code := strings.TrimSpace(r.URL.Query().Get("code"))
		if code != "" {
			select {
			case session.codeCh <- code:
			default:
			}
		}
		http.Redirect(w, r, buildPortalResultURL(code != ""), http.StatusTemporaryRedirect)
	})
	session.server = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}

	b.mu.Lock()
	b.sessions[accountID] = session
	delete(b.failures, accountID)
	b.mu.Unlock()

	go b.finalize(session)
	go func() {
		_ = session.server.Serve(listener)
	}()

	loginURL := buildOAuthLoginURL(port, pkce, ticketID)
	return LoginStartResult{
		AccountID:       accountID,
		LoginURL:        loginURL,
		IncognitoOpened: false,
		CallbackPort:    port,
	}, nil
}

func listenCallbackPort() (net.Listener, int, error) {
	for i := 0; i < 12; i++ {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, 0, err
		}
		port := ln.Addr().(*net.TCPAddr).Port
		if port >= caMinCallbackPort {
			return ln, port, nil
		}
		_ = ln.Close()
	}
	return nil, 0, errors.New("无法分配 >=10000 的本地回调端口")
}

// finalize 后台等 code → STS 换 token → 写凭据 → 回填账号；失败写终态并删占位。
func (b *LoginBroker) finalize(s *loginSession) {
	defer b.closeSession(s)
	var code string
	select {
	case code = <-s.codeCh:
	case <-time.After(caOAuthTimeout):
		b.fail(s, "CodeArts OAuth login timed out（已等待 3 分钟）")
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tok, err := exchangeAuthorizationCode(ctx, b.client, code, s.pkce, s.port, s.key)
	if err != nil {
		b.fail(s, err.Error())
		return
	}
	cred := credentialFromToken(tok, s.pkce, s.key)
	raw, err := json.Marshal(cred)
	if err != nil {
		b.fail(s, err.Error())
		return
	}
	if err := b.store.SetCredential(s.refName, string(raw)); err != nil {
		b.fail(s, err.Error())
		return
	}
	// 回填账号：昵称、到期、是否可续期。
	account := Account{
		ID:            s.accountID,
		Nickname:      s.accountID,
		Enabled:       true,
		CredentialRef: s.refName,
		Refreshable:   cred.RefreshToken != "",
		CreatedAt:     s.createdAt,
		ExpiresAt:     parseExpiry(cred.ExpiresAt),
	}
	if cred.UserName != "" {
		account.Nickname = cred.UserName
	}
	_ = b.store.UpsertAccount(s.providerID, account)
	// 登录后顺手刷新一次私有模型目录缓存（best-effort）。
	b.refreshCatalog(s.providerID, cred)
}

func (b *LoginBroker) fail(s *loginSession, reason string) {
	b.mu.Lock()
	b.failures[s.accountID] = reason
	b.mu.Unlock()
	_ = b.store.DeleteAccount(s.providerID, s.accountID)
}

func (b *LoginBroker) closeSession(s *loginSession) {
	s.closeOnce.Do(func() {
		if s.server != nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = s.server.Shutdown(ctx)
			cancel()
		}
		if s.listener != nil {
			_ = s.listener.Close()
		}
		b.mu.Lock()
		delete(b.sessions, s.accountID)
		b.mu.Unlock()
	})
}

// Poll 判据顺序：失败终态 → 查账号 → 凭据非空即成功 → 否则 done:false。
func (b *LoginBroker) Poll(accountID string) LoginPollResult {
	b.mu.Lock()
	failure, failed := b.failures[accountID]
	_, pending := b.sessions[accountID]
	b.mu.Unlock()
	if failed {
		return LoginPollResult{Done: true, Success: false, Error: failure}
	}
	p, ok := b.store.Get(ProviderCodeArts)
	if ok {
		for _, a := range p.Accounts {
			if a.ID != accountID {
				continue
			}
			if secret, exists := b.store.Credential(a.CredentialRef); exists && strings.TrimSpace(secret) != "" {
				return LoginPollResult{Done: true, Success: true}
			}
			return LoginPollResult{Done: false}
		}
	}
	if !pending {
		// 会话已结束且账号不在 → 终态失败（例如占位被删）。
		return LoginPollResult{Done: true, Success: false, Error: "账号不存在（可能已被删除）"}
	}
	return LoginPollResult{Done: false}
}

// SubmitCode 远程部署 / 弹窗被拦时，用户手动粘贴授权 code（或完整回调 URL）。
func (b *LoginBroker) SubmitCode(accountID, codeOrURL string) error {
	b.mu.Lock()
	session, ok := b.sessions[accountID]
	b.mu.Unlock()
	if !ok {
		return errors.New("登录会话不存在或已结束，请重新点击登录")
	}
	code := strings.TrimSpace(codeOrURL)
	if u, err := parseCallbackCode(code); err == nil {
		code = u
	}
	if code == "" {
		return errors.New("授权 code 不能为空")
	}
	select {
	case session.codeCh <- code:
		return nil
	default:
		return errors.New("该登录会话已收到授权 code")
	}
}

func parseCallbackCode(value string) (string, error) {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		u, err := url.Parse(value)
		if err != nil {
			return "", err
		}
		code := strings.TrimSpace(u.Query().Get("code"))
		if code == "" {
			return "", errors.New("回调 URL 里没有 code 参数")
		}
		return code, nil
	}
	return value, nil
}

// refreshCatalog 登录成功后用新凭据拉一次 CodeArts 私有模型目录并缓存（best-effort，
// 失败保留内置默认清单，ProviderModels/EnabledModelIDs 都会自行兜底）。
func (b *LoginBroker) refreshCatalog(providerID string, cred CodeArtsCredential) {
	if providerID != ProviderCodeArts {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	models, _ := FetchCodeArtsModels(ctx, b.client, cred)
	if len(models) > 0 {
		_ = b.store.SetProviderCatalog(providerID, models)
	}
}
