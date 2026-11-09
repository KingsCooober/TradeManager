package aiproviders

// CodeArts 登录会话管理：复刻 Jet Hub 的两步式 account.create / login.poll。
// ① StartLogin 立即写入占位账号并返回 loginUrl（window.open 只在用户手势的
//    transient activation 内有效，不能等完整 OAuth 走完才返回）；
// ② 收到授权回调（code 或 secret）后后台换凭据，写凭据库并回填账号；
// ③ Poll 只读「凭据是否落库」判定成功，失败终态单独记表。
//
// 两种登录模式（关键差异在「回调 host」）：
//   - oauth（本机桌面）：新式 portal 把回调 host 硬编码成 127.0.0.1，浏览器回到本机
//     loopback 服务器，用 code 向 STS 换 AK/SK。只适合浏览器与后端同一台机器。
//   - ticket（公网部署）：旧式 doer/redirect 的 auth_callback_url 可指向服务器公网地址，
//     华为云授权完成后浏览器 302 回跳到服务器 callback 端点并带回 secret，服务器后台
//     轮询 ticket 端点换 AK/SK。浏览器跳的是服务器，不再是访客本机 127.0.0.1。
// 除此之外还有 SubmitCode 手动回填（粘贴完整回调 URL / code / secret）兜底。

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

// loginCallback 汇总一次授权回调里可能带回的凭据线索：新式给 code，旧式给 secret。
type loginCallback struct {
	code   string
	secret string
}

type loginSession struct {
	providerID  string
	accountID   string
	refName     string
	port        int
	pkce        pkcePair
	key         *dpopKeyPair
	ticketID    string
	mode        string // "oauth" | "ticket"
	callbackURL string // ticket 模式下回跳到服务器的完整 callback URL
	createdAt   int64
	resultCh    chan loginCallback
	closeOnce   sync.Once
	server      *http.Server
	listener    net.Listener
}

// LoginStartResult 是 StartLogin 的返回（对齐 Jet Hub account.create 的 value）。
type LoginStartResult struct {
	AccountID       string `json:"accountId"`
	LoginURL        string `json:"loginUrl"`
	IncognitoOpened bool   `json:"incognitoOpened"`
	CallbackPort    int    `json:"callbackPort"`
	Mode            string `json:"mode"`
	CallbackURL     string `json:"callbackUrl"`
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
// callbackBase 是「服务器可达的回调端点绝对 URL」：非空时走 ticket 模式（公网部署自动回跳），
// 为空时走 oauth 模式（本机桌面插件）。浏览器授权后永远把凭据线索交回服务器，凭据换取全在服务器。
func (b *LoginBroker) StartLogin(providerID string, callbackBase string) (LoginStartResult, error) {
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

	mode := "oauth"
	var callbackURL string
	if cb := strings.TrimSpace(callbackBase); cb != "" {
		mode = "ticket"
		u, err := url.Parse(cb)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return LoginStartResult{}, fmt.Errorf("回调地址无效（必须是服务器可达的 http(s) 绝对 URL）：%s", cb)
		}
		// accountId / ticket_id 放进路径而非 query：华为云 doer/redirect 授权后回跳时
		// 只会追加/覆盖 query 参数（secret），path 段保持不变，会话定位才可靠。
		// 若把标识放 query，一旦回跳实现重建 URL 就会丢参数，服务器找不到会话。
		u.Path = strings.TrimRight(u.Path, "/") + "/" + url.PathEscape(accountID) + "/" + ticketID
		u.RawQuery = ""
		callbackURL = u.String()
	}

	// 找一个 >= 10000 的回环端口：oauth 模式是真回调监听端口；ticket 模式保留给
	// 「新式 code 兜底」用（exchangeAuthorizationCode 的 redirect_uri 需要这个端口值）。
	listener, port, err := listenCallbackPort()
	if err != nil {
		return LoginStartResult{}, err
	}

	session := &loginSession{
		providerID:  providerID,
		accountID:   accountID,
		refName:     refName,
		port:        port,
		pkce:        pkce,
		key:         key,
		ticketID:    ticketID,
		mode:        mode,
		callbackURL: callbackURL,
		createdAt:   time.Now().UnixMilli(),
		resultCh:    make(chan loginCallback, 1),
		listener:    listener,
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

	// 本机 loopback 回调（oauth 主路径 + ticket 模式下的 code 兜底）。
	mux := http.NewServeMux()
	mux.HandleFunc(caRedirectPath, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		q := r.URL.Query()
		cb := loginCallback{code: strings.TrimSpace(q.Get("code")), secret: strings.TrimSpace(q.Get("secret"))}
		if cb.code != "" || cb.secret != "" {
			select {
			case session.resultCh <- cb:
			default:
			}
		}
		http.Redirect(w, r, buildPortalResultURL(cb.code != "" || cb.secret != ""), http.StatusTemporaryRedirect)
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
	if mode == "ticket" {
		// auth_callback_url 指向服务器：浏览器授权后 302 回跳服务器 callback 端点。
		loginURL = buildTicketLoginURL(callbackURL, ticketID)
	}
	return LoginStartResult{
		AccountID:       accountID,
		LoginURL:        loginURL,
		IncognitoOpened: false,
		CallbackPort:    port,
		Mode:            mode,
		CallbackURL:     callbackURL,
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

// finalize 后台等回调 → 换凭据 → 写凭据 → 回填账号；失败写终态并删占位。
func (b *LoginBroker) finalize(s *loginSession) {
	defer b.closeSession(s)
	var cb loginCallback
	select {
	case cb = <-s.resultCh:
	case <-time.After(caOAuthTimeout):
		b.fail(s, "CodeArts 授权超时（已等待 3 分钟，未收到浏览器回调）")
		return
	}

	var cred CodeArtsCredential
	switch {
	case cb.secret != "":
		// 旧式 ticket：服务器用 secret 轮询 ticket 端点换 AK/SK。
		ctx, cancel := context.WithTimeout(context.Background(), 130*time.Second)
		c, err := pollTicketCredential(ctx, b.client, s.ticketID, cb.secret, 110)
		cancel()
		if err != nil {
			b.fail(s, err.Error())
			return
		}
		cred = c
	case cb.code != "":
		// 新式 OAuth：服务器用 code 向 STS 换 AK/SK（redirect_uri 只是校验值，不需可达）。
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		tok, err := exchangeAuthorizationCode(ctx, b.client, cb.code, s.pkce, s.port, s.key)
		cancel()
		if err != nil {
			b.fail(s, err.Error())
			return
		}
		cred = credentialFromToken(tok, s.pkce, s.key)
	default:
		b.fail(s, "授权回调既没有 code 也没有 secret")
		return
	}
	b.persist(s, cred)
}

// persist 把凭据写库 + 回填账号 + 顺手刷新私有模型目录缓存（best-effort）。
func (b *LoginBroker) persist(s *loginSession, cred CodeArtsCredential) {
	raw, err := json.Marshal(cred)
	if err != nil {
		b.fail(s, err.Error())
		return
	}
	if err := b.store.SetCredential(s.refName, string(raw)); err != nil {
		b.fail(s, err.Error())
		return
	}
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

// pushCallback 把一次回调投给进行中的会话（带会话存在性校验）。
func (b *LoginBroker) pushCallback(accountID string, cb loginCallback) error {
	b.mu.Lock()
	session, ok := b.sessions[accountID]
	b.mu.Unlock()
	if !ok {
		return errors.New("登录会话不存在或已结束，请重新点击登录")
	}
	if cb.code == "" && cb.secret == "" {
		return errors.New("回调里没有授权 code 或 secret")
	}
	select {
	case session.resultCh <- cb:
		return nil
	default:
		return errors.New("该登录会话已收到授权回调")
	}
}

// SubmitServerCallback 供「服务器公网回调端点」调用：华为云授权后浏览器 302 回跳时
// 带上 code/secret + 一次性 ticket_id，校验通过后交回服务器会话，凭据换取全在服务器。
// ticket_id 是构造登录 URL 时生成的 64 位随机串，等价于一次性凭证，避免该免鉴权
// GET 端点被随意触发；secret 本身也由华为云在轮询时校验。
func (b *LoginBroker) SubmitServerCallback(accountID, ticketID, code, secret string) error {
	b.mu.Lock()
	session, ok := b.sessions[accountID]
	b.mu.Unlock()
	if !ok {
		return errors.New("登录会话不存在或已结束，请回到设置页重新点击登录")
	}
	if ticketID == "" || ticketID != session.ticketID {
		return errors.New("回调票据不匹配，请重新登录")
	}
	cb := loginCallback{code: strings.TrimSpace(code), secret: strings.TrimSpace(secret)}
	if cb.code == "" && cb.secret == "" {
		return errors.New("回调里没有授权 code 或 secret")
	}
	select {
	case session.resultCh <- cb:
		return nil
	default:
		return errors.New("该登录会话已收到授权回调")
	}
}

// SubmitCode 手动回填兜底：弹窗被拦 / 自动回跳失败时，用户粘贴授权 code 或完整回调 URL。
// 完整 URL 里带 secret 时按旧式 ticket 处理，带 code 时按新式 OAuth 处理。
func (b *LoginBroker) SubmitCode(accountID, codeOrURL string) error {
	cb := parseLoginCallbackValue(strings.TrimSpace(codeOrURL))
	return b.pushCallback(accountID, cb)
}

// parseLoginCallbackValue 解析用户粘贴的内容：
//   - http(s) 完整回调 URL → 提取 code / secret 两个 query 参数；
//   - 裸值 → 当作 code（新式授权页地址栏里 code= 后面的那一串）。
func parseLoginCallbackValue(value string) loginCallback {
	if strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		if u, err := url.Parse(value); err == nil {
			q := u.Query()
			return loginCallback{code: strings.TrimSpace(q.Get("code")), secret: strings.TrimSpace(q.Get("secret"))}
		}
	}
	return loginCallback{code: value}
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
