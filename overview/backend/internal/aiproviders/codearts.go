package aiproviders

// CodeArts（华为云 snap）订阅制登录协议层。逐字对齐 DSH dsh-providers-hub 的
// login.js / oauth.js / sign.js / models.js / llm-adapter.js：
//   - 登录：浏览器 OAuth 授权页 + 本机 loopback 回调（PKCE + DPoP ES256），
//     STS 用 authorization_code 换临时 AK/SK，凭据是 JSON 不是简单 API Key；
//   - 出站：SDK-HMAC-SHA256 签名（不是 Bearer），chat 端点是私有 /api/v2；
//   - 模型目录：两个带签名的私有 GET，不是 OpenAI /v1/models。
// 全部用 Go 标准库实现，不引入 jose / 第三方依赖。

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// 内置订阅制供应商 ID。用户要求本阶段只内置 codearts 一家。
const ProviderCodeArts = "codearts"

// LoginTypeCodeArts 标记走 OAuth 登录 + SDK 签名通道的供应商。
const LoginTypeCodeArts = "codearts_oauth"

// 线上端点与常量（与插件逐字一致）。
const (
	caClientID          = "codearts-agent"
	caRedirectPath      = "/oauth/callback"
	caSTSTokenEndpoint  = "https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens"
	caPortalAuthorize   = "https://codearts.huaweicloud.com/portal/authorize"
	caPortalLogin       = "https://codearts.huaweicloud.com/portal/login"
	caChatAPIBase       = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v2"
	caGatewayConfigURL  = "https://opengw.developer.huaweicloud.com/api/v1/gateway/config"
	caBuiltinModelsURL  = "https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin"
	caUserAgent         = "codearts/1.0.0-1147257973136832"
	caLoginPluginName   = "snap_AIIDE"
	caLoginPluginVer    = "5.2.0"
	caOAuthTheme        = "2"
	caOAuthLocale       = "zh-cn"
	caChatPath          = "/chat/completions"
	caOAuthTimeout      = 180 * time.Second
	caMinCallbackPort   = 10000

	// 旧式 ticket 登录（浏览器授权后回跳 auth_callback_url，可指向服务器公网地址）。
	// 新式 portal 把回调 host 硬编码成 127.0.0.1，只适合 IDE 桌面插件本机登录；
	// 公网部署必须走这条 doer/redirect + secret 轮询链路，否则浏览器跳到访客本机回环。
	caTicketLoginBase  = "https://devcloud.cn-north-4.huaweicloud.com/doer/redirect"
	caHuaweiAuthBase   = "https://auth.huaweicloud.com/authui/login.html"
	caTicketEndpoint   = "https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket"
	caTicketPluginName = "snap_jetbrains"
	caTicketPluginVer  = "26.3.3"
)

// defaultCodeArtsModels 是远端目录拉不到时的冷缓存兜底（插件 DEFAULT_MODELS）。
var defaultCodeArtsModels = []string{
	"GLM-5.2", "GLM-5.1", "glm-5.3", "glm-5.2-sft-harmony",
	"openpangu-2.0-flash", "openpangu-2.0-pro", "deepseek-v4-flash",
	"deepseek-v4.1-flash", "deepseek-v4.1-flash-1017",
}

// ModelInfo 是设置页模型勾选列表的一行（对齐 Jet Hub model.list 的 5 字段）。
type ModelInfo struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Disabled bool   `json:"disabled"`
	Dead     bool   `json:"dead"`
}

// CodeArtsCredential 是写进凭据库的 JSON 形状：前 6 字段来自 STS token，
// 后 3 字段是旧 ticket 回退 / 展示用；签名只需要 AK/SK/security_token。
type CodeArtsCredential struct {
	AccessKeyID     string      `json:"access_key_id"`
	SecretAccessKey string      `json:"secret_access_key"`
	SecurityToken   string      `json:"security_token"`
	ExpiresAt       string      `json:"expires_at"`
	RefreshToken    string      `json:"refresh_token,omitempty"`
	CodeVerifier    string      `json:"code_verifier,omitempty"`
	DPoPPrivateJWK  *dpopJWK    `json:"dpop_private_key_jwk,omitempty"`
	DomainID        string      `json:"domain_id,omitempty"`
	UserID          string      `json:"user_id,omitempty"`
	UserName        string      `json:"user_name,omitempty"`
}

// dpopJWK 是 ES256 P-256 密钥的 JWK（含私钥 d 时即可重建签名密钥）。
type dpopJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	D   string `json:"d,omitempty"`
}

type pkcePair struct {
	Verifier  string
	Challenge string
}

type dpopKeyPair struct {
	priv   *ecdsa.PrivateKey
	pubJWK dpopJWK
	privJWK dpopJWK
}

func newPKCE() (pkcePair, error) {
	buf := make([]byte, 48)
	if _, err := rand.Read(buf); err != nil {
		return pkcePair{}, err
	}
	verifier := base64.RawURLEncoding.EncodeToString(buf)
	sum := sha256.Sum256([]byte(verifier))
	return pkcePair{Verifier: verifier, Challenge: base64.RawURLEncoding.EncodeToString(sum[:])}, nil
}

func newDPoPKeyPair() (*dpopKeyPair, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	x := base64.RawURLEncoding.EncodeToString(priv.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(priv.Y.FillBytes(make([]byte, 32)))
	d := base64.RawURLEncoding.EncodeToString(priv.D.FillBytes(make([]byte, 32)))
	pub := dpopJWK{Kty: "EC", Crv: "P-256", X: x, Y: y}
	return &dpopKeyPair{priv: priv, pubJWK: pub, privJWK: dpopJWK{Kty: "EC", Crv: "P-256", X: x, Y: y, D: d}}, nil
}

func privateKeyFromJWK(jwk dpopJWK) (*ecdsa.PrivateKey, dpopJWK, error) {
	dBytes, err := base64.RawURLEncoding.DecodeString(jwk.D)
	if err != nil || len(dBytes) == 0 {
		return nil, dpopJWK{}, errors.New("DPoP 私钥 JWK 缺少 d")
	}
	d := new(big.Int).SetBytes(dBytes)
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult(dBytes)
	priv := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: curve, X: x, Y: y}, D: d}
	pub := dpopJWK{Kty: "EC", Crv: "P-256",
		X: base64.RawURLEncoding.EncodeToString(x.FillBytes(make([]byte, 32))),
		Y: base64.RawURLEncoding.EncodeToString(y.FillBytes(make([]byte, 32)))}
	return priv, pub, nil
}

func b64json(v any) string {
	b, _ := json.Marshal(v)
	return base64.RawURLEncoding.EncodeToString(b)
}

// signDPoP 生成 DPoP proof JWT（ES256）：header 带 public JWK，payload 带 htm/htu/iat/jti。
func signDPoP(priv *ecdsa.PrivateKey, pub dpopJWK, htm, htu string) (string, error) {
	header := b64json(map[string]any{
		"alg": "ES256", "typ": "dpop+jwt",
		"jwk": map[string]string{"kty": pub.Kty, "crv": pub.Crv, "x": pub.X, "y": pub.Y},
	})
	jti := make([]byte, 32)
	_, _ = rand.Read(jti)
	payload := b64json(map[string]any{
		"htm": htm, "htu": htu, "iat": time.Now().Unix(), "jti": hex.EncodeToString(jti),
	})
	signingInput := header + "." + payload
	hash := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, priv, hash[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// buildOAuthLoginURL 与插件 buildOAuthLoginUrl 逐字一致：
// code_challenge_method 必须是非标准的 SHA-256（不是 S256），且不能加 auth_callback_url。
func buildOAuthLoginURL(port int, pkce pkcePair, ticketID string) string {
	q := url.Values{}
	q.Set("theme", caOAuthTheme)
	q.Set("locale", caOAuthLocale)
	q.Set("uri_scheme", caClientID)
	q.Set("client_id", caClientID)
	q.Set("port", strconv.Itoa(port))
	q.Set("code_challenge", pkce.Challenge)
	q.Set("code_challenge_method", "SHA-256")
	q.Set("ticket_id", ticketID)
	q.Set("plugin-name", caLoginPluginName)
	q.Set("plugin-version", caLoginPluginVer)
	return caPortalAuthorize + "?" + q.Encode()
}

func buildPortalResultURL(succeeded bool) string {
	q := url.Values{}
	q.Set("login_succeed", strconv.FormatBool(succeeded))
	q.Set("uri_scheme", caClientID)
	q.Set("locale", caOAuthLocale)
	return caPortalLogin + "?" + q.Encode()
}

// buildTicketLoginURL 构造旧式 ticket 登录链接：auth_callback_url 可指向服务器公网地址，
// 华为云 doer/redirect 授权完成后浏览器 302 回跳该地址并带回 secret。
// 与插件 buildLoginUrl 逐字一致，唯一差别是 callbackURL 不再是 127.0.0.1。
func buildTicketLoginURL(callbackURL, ticketID string) string {
	q := url.Values{}
	q.Set("IdeaType", "jetbrains")
	q.Set("auth_callback_url", callbackURL)
	q.Set("plugin-name", caTicketPluginName)
	q.Set("plugin-version", caTicketPluginVer)
	q.Set("ticket_id", ticketID)
	redirectURL := caTicketLoginBase + "?" + q.Encode()
	return caHuaweiAuthBase + "?service=" + url.QueryEscape(redirectURL)
}

// ticketCredentialResponse 对齐插件 parseCredentialResponse 的两种响应形状：
// data.credential（旧版）/ data.result（新版）。
type ticketCredentialResponse struct {
	Credential *struct {
		Access         string `json:"access"`
		Secret         string `json:"secret"`
		SecurityToken  string `json:"securitytoken"`
		SecurityToken2 string `json:"securityToken"`
		ExpiresAt      string `json:"expires_at"`
		ExpiresAt2     string `json:"expiresAt"`
	} `json:"credential"`
	DomainID string `json:"domain_id"`
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	Result   *struct {
		AccessKeyID     string `json:"accessKeyId"`
		SecretAccessKey string `json:"secretAccessKey"`
		SecurityToken   string `json:"securityToken"`
		Expiration      string `json:"expiration"`
		ExpiresAt       string `json:"expiresAt"`
	} `json:"result"`
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// parseTicketCredential 未拿到完整 AK/SK/security_token 时返回 false（继续轮询）。
func parseTicketCredential(body []byte) (CodeArtsCredential, bool) {
	var resp ticketCredentialResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return CodeArtsCredential{}, false
	}
	if c := resp.Credential; c != nil && c.Access != "" {
		st := firstNonEmpty(c.SecurityToken, c.SecurityToken2)
		if st != "" {
			return CodeArtsCredential{
				AccessKeyID:     c.Access,
				SecretAccessKey: c.Secret,
				SecurityToken:   st,
				ExpiresAt:       firstNonEmpty(c.ExpiresAt, c.ExpiresAt2),
				DomainID:        resp.DomainID,
				UserID:          resp.UserID,
				UserName:        resp.UserName,
			}, true
		}
	}
	if r := resp.Result; r != nil && r.AccessKeyID != "" && r.SecurityToken != "" {
		return CodeArtsCredential{
			AccessKeyID:     r.AccessKeyID,
			SecretAccessKey: r.SecretAccessKey,
			SecurityToken:   r.SecurityToken,
			ExpiresAt:       firstNonEmpty(r.Expiration, r.ExpiresAt),
		}, true
	}
	return CodeArtsCredential{}, false
}

// pollTicketCredential 用回调带回的 secret 轮询 ticket 端点换 AK/SK（对齐插件
// pollForCredential：120 次 ×1s，瞬时失败跳过不视为致命）。
func pollTicketCredential(ctx context.Context, client *http.Client, ticketID, secret string, maxAttempts int) (CodeArtsCredential, error) {
	endpoint := caTicketEndpoint + "?ticket_id=" + url.QueryEscape(ticketID) + "&secret=" + url.QueryEscape(secret)
	for i := 0; i < maxAttempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return CodeArtsCredential{}, ctx.Err()
			case <-time.After(time.Second):
			}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return CodeArtsCredential{}, err
		}
		req.Header.Set("Content-Type", "application/json;charset=UTF-8")
		req.Header.Set("plugin-name", caTicketPluginName)
		req.Header.Set("plugin-version", caTicketPluginVer)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
		if cred, ok := parseTicketCredential(body); ok {
			return cred, nil
		}
	}
	return CodeArtsCredential{}, errors.New("CodeArts ticket 凭据轮询超时：授权可能未完成或被拒绝")
}

// stsTokenResponse 是 STS /v1/oauth2/tokens 的响应形状。
type stsTokenResponse struct {
	Credentials struct {
		AccessKeyID     string `json:"access_key_id"`
		SecretAccessKey string `json:"secret_access_key"`
		SecurityToken   string `json:"security_token"`
		Expiration      string `json:"expiration"`
	} `json:"credentials"`
	RefreshToken string `json:"refresh_token"`
	Error        string `json:"error"`
	ErrorCode    string `json:"error_code"`
	ErrorMsg     string `json:"error_msg"`
}

// requestSTSToken POST 表单到 STS，带 DPoP proof 头。
func requestSTSToken(ctx context.Context, client *http.Client, form url.Values, priv *ecdsa.PrivateKey, pub dpopJWK) (*stsTokenResponse, error) {
	dpop, err := signDPoP(priv, pub, "POST", caSTSTokenEndpoint)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, caSTSTokenEndpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("DPoP", dpop)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out stsTokenResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("解析 STS 响应失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || out.Credentials.AccessKeyID == "" {
		msg := out.ErrorMsg
		if msg == "" {
			msg = out.Error
		}
		if msg == "" {
			msg = out.ErrorCode
		}
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return nil, fmt.Errorf("CodeArts 换取凭据失败：%s", msg)
	}
	return &out, nil
}

// credentialFromToken 把 STS 响应 + PKCE + DPoP 私钥组装成凭据（对齐 credentialFromTokenResponse）。
func credentialFromToken(tok *stsTokenResponse, pkce pkcePair, key *dpopKeyPair) CodeArtsCredential {
	jwk := key.privJWK
	return CodeArtsCredential{
		AccessKeyID:     tok.Credentials.AccessKeyID,
		SecretAccessKey: tok.Credentials.SecretAccessKey,
		SecurityToken:   tok.Credentials.SecurityToken,
		ExpiresAt:       tok.Credentials.Expiration,
		RefreshToken:    tok.RefreshToken,
		CodeVerifier:    pkce.Verifier,
		DPoPPrivateJWK:  &jwk,
	}
}

func exchangeAuthorizationCode(ctx context.Context, client *http.Client, code string, pkce pkcePair, port int, key *dpopKeyPair) (*stsTokenResponse, error) {
	form := url.Values{}
	form.Set("client_id", caClientID)
	form.Set("code", code)
	form.Set("code_verifier", pkce.Verifier)
	form.Set("grant_type", "authorization_code")
	form.Set("redirect_uri", fmt.Sprintf("http://127.0.0.1:%d%s", port, caRedirectPath))
	return requestSTSToken(ctx, client, form, key.priv, key.pubJWK)
}

// RefreshCodeArtsCredential 用 refresh_token 续期（对齐 exchangeRefreshToken）。
// 返回的新凭据保留原 DPoP 私钥与 code_verifier，并把展示字段带过去。
func RefreshCodeArtsCredential(ctx context.Context, client *http.Client, cred CodeArtsCredential) (CodeArtsCredential, error) {
	if cred.RefreshToken == "" || cred.DPoPPrivateJWK == nil {
		return CodeArtsCredential{}, errors.New("该 CodeArts 账号不可续期（无 refresh_token 或 DPoP 私钥）")
	}
	priv, pub, err := privateKeyFromJWK(*cred.DPoPPrivateJWK)
	if err != nil {
		return CodeArtsCredential{}, err
	}
	form := url.Values{}
	form.Set("client_id", caClientID)
	form.Set("code_verifier", cred.CodeVerifier)
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", cred.RefreshToken)
	tok, err := requestSTSToken(ctx, client, form, priv, pub)
	if err != nil {
		return CodeArtsCredential{}, err
	}
	jwk := *cred.DPoPPrivateJWK
	next := CodeArtsCredential{
		AccessKeyID:     tok.Credentials.AccessKeyID,
		SecretAccessKey: tok.Credentials.SecretAccessKey,
		SecurityToken:   tok.Credentials.SecurityToken,
		ExpiresAt:       tok.Credentials.Expiration,
		RefreshToken:    tok.RefreshToken,
		CodeVerifier:    cred.CodeVerifier,
		DPoPPrivateJWK:  &jwk,
		DomainID:        cred.DomainID,
		UserID:          cred.UserID,
		UserName:        cred.UserName,
	}
	if next.RefreshToken == "" {
		next.RefreshToken = cred.RefreshToken
	}
	return next, nil
}

// ---------- SDK-HMAC-SHA256 请求签名（sign.js 等价实现） ----------

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hmacSha256Hex(key, data []byte) string {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}

// jsEncodeURIComponent 对齐 JS encodeURIComponent 的不编码集：A-Za-z0-9-_.!~*'()。
func jsEncodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			b.WriteString("%" + strings.ToUpper(hex.EncodeToString([]byte{c})))
		}
	}
	return b.String()
}

// canonicalQueryOf 按 key 字典序排序后重编码（对齐 sign.js canonicalQueryOf）。
func canonicalQueryOf(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	type pair struct{ k, v string }
	var pairs []pair
	for _, part := range strings.Split(rawQuery, "&") {
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		if eq == -1 {
			pairs = append(pairs, pair{k: part, v: ""})
		} else {
			pairs = append(pairs, pair{k: part[:eq], v: part[eq+1:]})
		}
	}
	sort.SliceStable(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return pairs[i].v < pairs[j].v
	})
	parts := make([]string, 0, len(pairs))
	for _, p := range pairs {
		parts = append(parts, jsEncodeURIComponent(p.k)+"="+jsEncodeURIComponent(p.v))
	}
	return strings.Join(parts, "&")
}

// isSignedQueryValueSafe 对齐 sign.js 的 query 安全集闸门（值含 +/空格/&/=/畸形% 时拒绝）。
func isSignedQueryValueSafe(rawURL string) bool {
	q := strings.IndexByte(rawURL, '?')
	if q == -1 {
		return true
	}
	for _, part := range strings.Split(rawURL[q+1:], "&") {
		if part == "" {
			continue
		}
		eq := strings.IndexByte(part, '=')
		key, val := part, ""
		if eq != -1 {
			key, val = part[:eq], part[eq+1:]
		}
		for _, value := range []string{key, val} {
			for i := 0; i < len(value); i++ {
				c := value[i]
				safe := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
					c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' || c == '-'
				if safe {
					continue
				}
				if c == '%' && i+2 < len(value) && isHex(value[i+1]) && isHex(value[i+2]) {
					i += 2
					continue
				}
				return false
			}
		}
	}
	return true
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f')
}

// sdkHMACHeaders 生成 SDK-HMAC-SHA256 签名头。extra 是参与签名的额外头（如 maas_type）。
func sdkHMACHeaders(ak, sk, st, method, rawURL string, body []byte, extra map[string]string) (map[string]string, error) {
	if !isSignedQueryValueSafe(rawURL) {
		return nil, errors.New("华为云签名被拒：query 值不在安全集内")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	uri := u.Path
	if !strings.HasSuffix(uri, "/") {
		uri += "/"
	}
	query := canonicalQueryOf(u.RawQuery)
	dateStamp := time.Now().UTC().Format("20060102T150405Z")
	payloadHash := sha256Hex(body)
	headers := map[string]string{
		"host":                  u.Host,
		"x-sdk-date":            dateStamp,
		"x-sdk-content-sha256":  payloadHash,
		"x-security-token":      st,
	}
	for k, v := range extra {
		headers[strings.ToLower(k)] = v
	}
	if strings.ToUpper(method) != "GET" {
		headers["content-type"] = "application/json"
	}
	keys := make([]string, 0, len(headers))
	for k := range headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+":"+headers[k])
	}
	signedHeaders := strings.Join(keys, ";")
	canonicalRequest := strings.Join([]string{
		method, uri, query, strings.Join(lines, "\n"), "", signedHeaders, payloadHash,
	}, "\n")
	canonicalHash := sha256Hex([]byte(canonicalRequest))
	stringToSign := "SDK-HMAC-SHA256\n" + dateStamp + "\n" + canonicalHash
	signature := hmacSha256Hex([]byte(sk), []byte(stringToSign))
	headers["Authorization"] = fmt.Sprintf("SDK-HMAC-SHA256 Access=%s,SignedHeaders=%s,Signature=%s", ak, signedHeaders, signature)
	return headers, nil
}

// codeArtsSignedGet 用 AK/SK 签名 GET 私有端点。
func codeArtsSignedGet(ctx context.Context, client *http.Client, cred CodeArtsCredential, rawURL string, extraSigned, extraUnsigned map[string]string) ([]byte, error) {
	signed, err := sdkHMACHeaders(cred.AccessKeyID, cred.SecretAccessKey, cred.SecurityToken, "GET", rawURL, nil, extraSigned)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	for k, v := range signed {
		if k == "host" || k == "content-type" {
			continue
		}
		req.Header.Set(k, v)
	}
	for k, v := range extraUnsigned {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}

// FetchCodeArtsModels 拉取私有模型目录（gateway/config benefit + builtin 常规），
// 两个来源都带 SDK 签名。任一来源可用即可；都失败回落 DEFAULT_MODELS。
func FetchCodeArtsModels(ctx context.Context, client *http.Client, cred CodeArtsCredential) ([]ModelInfo, bool) {
	type rawModel struct {
		ModelID   string `json:"model_id"`
		ModelName string `json:"model_name"`
		Credit    []struct {
			RatioDisplay string `json:"ratio_display"`
		} `json:"credit"`
	}
	parse := func(data []byte, path ...string) []rawModel {
		var v any = func() any { var m map[string]any; _ = json.Unmarshal(data, &m); return m }()
		for _, key := range path {
			m, ok := v.(map[string]any)
			if !ok {
				return nil
			}
			v = m[key]
		}
		arr, ok := v.([]any)
		if !ok {
			return nil
		}
		out := make([]rawModel, 0, len(arr))
		for _, item := range arr {
			b, _ := json.Marshal(item)
			var rm rawModel
			if json.Unmarshal(b, &rm) == nil {
				out = append(out, rm)
			}
		}
		return out
	}
	seen := map[string]bool{}
	result := []ModelInfo{}
	add := func(list []rawModel) {
		for _, m := range list {
			id := m.ModelID
			if id == "" || seen[id] || strings.Contains(id, "-VL-") || strings.HasSuffix(id, "-VL") {
				continue
			}
			seen[id] = true
			name := m.ModelName
			if name == "" {
				name = id
			}
			if len(m.Credit) > 0 && m.Credit[0].RatioDisplay != "" {
				name = name + " · x" + strings.TrimSuffix(m.Credit[0].RatioDisplay, "x")
			}
			result = append(result, ModelInfo{ID: id, Name: name})
		}
	}
	gatewayOK, builtinOK := false, false
	if data, err := codeArtsSignedGet(ctx, client, cred, caGatewayConfigURL, nil, nil); err == nil {
		gatewayOK = true
		add(parse(data, "result", "models"))
	}
	if data, err := codeArtsSignedGet(ctx, client, cred, caBuiltinModelsURL, nil, map[string]string{
		"Content-Type": "application/json", "Agent-Type": "PromptCenter", "X-Language": "zh-cn",
	}); err == nil {
		builtinOK = true
		add(parse(data, "builtinModels"))
	}
	complete := gatewayOK && builtinOK
	if len(result) == 0 {
		for _, id := range defaultCodeArtsModels {
			result = append(result, ModelInfo{ID: id, Name: id})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, complete
}

// ParseCodeArtsCredential 解析凭据库里的 JSON 字符串；纯 API Key 会解析失败。
func ParseCodeArtsCredential(secret string) (CodeArtsCredential, error) {
	var cred CodeArtsCredential
	secret = strings.TrimSpace(secret)
	if !strings.HasPrefix(secret, "{") {
		return cred, errors.New("不是 CodeArts 凭据 JSON")
	}
	if err := json.Unmarshal([]byte(secret), &cred); err != nil {
		return cred, err
	}
	if cred.AccessKeyID == "" || cred.SecretAccessKey == "" {
		return cred, errors.New("CodeArts 凭据缺少 AK/SK")
	}
	return cred, nil
}

// parseExpiry 兼容 RFC3339 / 毫秒数字 / 秒数字，返回毫秒时间戳。
func parseExpiry(value string) int64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if n, err := strconv.ParseInt(value, 10, 64); err == nil {
		if n < 1e12 {
			return n * 1000
		}
		return n
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02 15:04:05"} {
		if t, err := time.Parse(layout, value); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// codeArtsChatURL 是私有 chat 端点（与 provider.BaseURL 无关）。
func codeArtsChatURL() string { return caChatAPIBase + caChatPath }

// codeArtsChatHeaders 为一次 chat 请求生成 SDK 签名头（含可选 maas_type: benefit）。
func codeArtsChatHeaders(cred CodeArtsCredential, body []byte, benefit bool) (map[string]string, error) {
	var extra map[string]string
	if benefit {
		extra = map[string]string{"maas_type": "benefit"}
	}
	return sdkHMACHeaders(cred.AccessKeyID, cred.SecretAccessKey, cred.SecurityToken, "POST", codeArtsChatURL(), body, extra)
}

