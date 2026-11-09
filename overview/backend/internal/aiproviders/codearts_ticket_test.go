package aiproviders

import (
	"net/url"
	"strings"
	"testing"
)

// 远程部署自动回跳：auth_callback_url 必须原样指向服务器公网 callback 端点，
// 且 ticket_id 保持与会话一致（回跳时华为云只追加 secret query，不改 path）。
func TestBuildTicketLoginURLUsesServerCallback(t *testing.T) {
	ticket := strings.Repeat("b", 64)
	callback := "https://trade.example.com/overview/api/v1/settings/llm/login/callback/codearts-abcd1234/" + ticket

	loginURL := buildTicketLoginURL(callback, ticket)
	outer, err := url.Parse(loginURL)
	if err != nil {
		t.Fatalf("parse loginURL: %v", err)
	}
	if outer.Host != "auth.huaweicloud.com" {
		t.Fatalf("login host = %q, want auth.huaweicloud.com", outer.Host)
	}
	service := outer.Query().Get("service")
	redirect, err := url.Parse(service)
	if err != nil {
		t.Fatalf("parse service: %v", err)
	}
	if redirect.Host != "devcloud.cn-north-4.huaweicloud.com" || redirect.Path != "/doer/redirect" {
		t.Fatalf("redirect = %q", service)
	}
	q := redirect.Query()
	if got := q.Get("auth_callback_url"); got != callback {
		t.Fatalf("auth_callback_url = %q, want %q", got, callback)
	}
	if got := q.Get("ticket_id"); got != ticket {
		t.Fatalf("ticket_id = %q, want %q", got, ticket)
	}
	if got := q.Get("IdeaType"); got != "jetbrains" {
		t.Fatalf("IdeaType = %q", got)
	}
	if got := q.Get("plugin-name"); got != "snap_jetbrains" {
		t.Fatalf("plugin-name = %q", got)
	}
	if got := q.Get("plugin-version"); got != "26.3.3" {
		t.Fatalf("plugin-version = %q", got)
	}
	// 与桌面插件一致：新式 portal 靠 auth_callback_url 走旧流程，绝不能掺入 callback host 的 127.0.0.1
	if strings.Contains(loginURL, "127.0.0.1") {
		t.Fatalf("loginURL 不应含本机回环：%q", loginURL)
	}
}

// 插件 parseCredentialResponse 的两种响应形状都要能解析。
func TestParseTicketCredentialBothShapes(t *testing.T) {
	legacy := []byte(`{"credential":{"access":"AK-1","secret":"SK-1","securitytoken":"ST-1","expires_at":"2026-11-10T00:00:00Z"},"domain_id":"d","user_id":"u","user_name":"yg"}`)
	cred, ok := parseTicketCredential(legacy)
	if !ok {
		t.Fatal("legacy 形状解析失败")
	}
	if cred.AccessKeyID != "AK-1" || cred.SecretAccessKey != "SK-1" || cred.SecurityToken != "ST-1" || cred.UserName != "yg" {
		t.Fatalf("legacy 字段错误：%+v", cred)
	}

	current := []byte(`{"result":{"accessKeyId":"AK-2","secretAccessKey":"SK-2","securityToken":"ST-2","expiration":"2026-11-11T00:00:00Z"}}`)
	cred, ok = parseTicketCredential(current)
	if !ok {
		t.Fatal("result 形状解析失败")
	}
	if cred.AccessKeyID != "AK-2" || cred.SecretAccessKey != "SK-2" || cred.SecurityToken != "ST-2" || cred.ExpiresAt != "2026-11-11T00:00:00Z" {
		t.Fatalf("result 字段错误：%+v", cred)
	}

	// 缺 security_token 视为未完成，继续轮询。
	if _, ok := parseTicketCredential([]byte(`{"credential":{"access":"AK","secret":"SK"}}`)); ok {
		t.Fatal("不完整凭据不应判定成功")
	}
	if _, ok := parseTicketCredential([]byte(`not json`)); ok {
		t.Fatal("非法 JSON 不应判定成功")
	}
}

// 手动回填：完整回调 URL 提取 code/secret，裸值当 code。
func TestParseLoginCallbackValue(t *testing.T) {
	withSecret := parseLoginCallbackValue("https://trade.example.com/overview/api/v1/settings/llm/login/callback/codearts-x/" + strings.Repeat("a", 64) + "?secret=deadbeef")
	if withSecret.secret != "deadbeef" || withSecret.code != "" {
		t.Fatalf("secret 提取错误：%+v", withSecret)
	}
	withCode := parseLoginCallbackValue("https://codearts.huaweicloud.com/portal/login?login_succeed=true&code=abc123")
	if withCode.code != "abc123" {
		t.Fatalf("code 提取错误：%+v", withCode)
	}
	bare := parseLoginCallbackValue("raw-code-value")
	if bare.code != "raw-code-value" || bare.secret != "" {
		t.Fatalf("裸值错误：%+v", bare)
	}
}

// 免鉴权回调端点靠路径里的一次性 ticket_id 兜底：票据不匹配必须拒绝。
func TestSubmitServerCallbackRejectsMismatchedTicket(t *testing.T) {
	store := testStore(t)
	broker := NewLoginBroker(store, nil)
	accountID := "codearts-test0001"
	ticket := strings.Repeat("c", 64)
	broker.mu.Lock()
	broker.sessions[accountID] = &loginSession{
		providerID: ProviderCodeArts,
		accountID:  accountID,
		ticketID:   ticket,
		resultCh:   make(chan loginCallback, 1),
	}
	broker.mu.Unlock()

	if err := broker.SubmitServerCallback(accountID, strings.Repeat("d", 64), "", "secret-x"); err == nil {
		t.Fatal("票据不匹配应报错")
	}
	if err := broker.SubmitServerCallback(accountID, ticket, "", "secret-ok"); err != nil {
		t.Fatalf("票据匹配却报错：%v", err)
	}
	select {
	case cb := <-broker.sessions[accountID].resultCh:
		if cb.secret != "secret-ok" {
			t.Fatalf("回调 secret = %q", cb.secret)
		}
	default:
		t.Fatal("回调未投递到会话")
	}
	if err := broker.SubmitServerCallback("missing-account", ticket, "", "secret-y"); err == nil {
		t.Fatal("不存在的会话应报错")
	}
}
