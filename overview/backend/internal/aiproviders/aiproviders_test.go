package aiproviders

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "ai-providers.json"), filepath.Join(dir, "ai-credentials.json"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}

func TestOpenSeedsTenBuiltinProviders(t *testing.T) {
	s := testStore(t)
	list := s.List()
	if len(list) != 10 {
		t.Fatalf("builtin count = %d, want 10", len(list))
	}
	ids := map[string]bool{}
	for _, p := range list {
		ids[p.ID] = true
		if !p.Builtin || !p.Enabled {
			t.Fatalf("builtin %q flags: builtin=%v enabled=%v", p.ID, p.Builtin, p.Enabled)
		}
	}
	for _, want := range []string{"openai", "deepseek", "moonshot", "minimax", "zhipu", "qwen", "siliconflow", "xiaomi", "anthropic", "custom"} {
		if !ids[want] {
			t.Fatalf("missing builtin %q", want)
		}
	}
	if got := s.Exists("openai"); !got {
		t.Fatal("Exists(openai) = false")
	}
	if got := s.Exists("nope"); got {
		t.Fatal("Exists(nope) = true")
	}
}

func TestUpsertProviderCustomAndValidate(t *testing.T) {
	s := testStore(t)
	custom := Provider{
		ID: "qiniu", Label: "七牛云", BaseURL: "https://api.qnaigc.com/v1/",
		ChatPath: "chat/completions", ModelsPath: "models",
		AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "deepseek-v3",
		CredentialRef: "QINIU_ACCESS_TOKEN", Enabled: true,
	}
	if err := s.UpsertProvider(custom); err != nil {
		t.Fatalf("UpsertProvider: %v", err)
	}
	p, ok := s.Get("qiniu")
	if !ok {
		t.Fatal("custom provider not found")
	}
	if p.Builtin {
		t.Fatal("custom provider must not be Builtin")
	}
	if p.BaseURL != "https://api.qnaigc.com/v1" {
		t.Fatalf("BaseURL not trimmed: %q", p.BaseURL)
	}
	if p.ChatPath != "/chat/completions" || p.ModelsPath != "/models" {
		t.Fatalf("child paths: chat=%q models=%q", p.ChatPath, p.ModelsPath)
	}
	if s.Exists("qiniu") != true {
		t.Fatal("Exists(qiniu) = false")
	}

	// 更新供应商不应丢失 Builtin 标记与账号池。
	_ = s.UpsertAccount("qiniu", Account{ID: "acc-1", Enabled: true, CredentialRef: "QINIU_ACCESS_TOKEN"})
	before, _ := s.Get("qiniu")
	p.Label = "七牛云（改名）"
	if err := s.UpsertProvider(p); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _ := s.Get("qiniu")
	if got.Builtin != before.Builtin || len(got.Accounts) != 1 {
		t.Fatalf("update lost flags: builtin=%v(want %v) accounts=%d", got.Builtin, before.Builtin, len(got.Accounts))
	}

	if err := s.DeleteProvider("openai"); err == nil {
		t.Fatal("builtin provider should not be deletable")
	}
	if err := s.DeleteProvider("qiniu"); err != nil {
		t.Fatalf("delete custom: %v", err)
	}
	if s.Exists("qiniu") {
		t.Fatal("custom provider still exists after delete")
	}
}

func TestValidateProviderRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		p    Provider
	}{
		{"bad id", Provider{ID: "BAD ID", Label: "x", BaseURL: "https://a.com"}},
		{"empty label", Provider{ID: "ok", Label: "", BaseURL: "https://a.com"}},
		{"bad url", Provider{ID: "ok", Label: "x", BaseURL: "ftp://a.com"}},
		{"url with query", Provider{ID: "ok", Label: "x", BaseURL: "https://a.com/v1?x=1"}},
		{"bad auth", Provider{ID: "ok", Label: "x", BaseURL: "https://a.com", AuthScheme: "hmac"}},
		{"bad mode", Provider{ID: "ok", Label: "x", BaseURL: "https://a.com", APIMode: "grpc"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := testStore(t)
			if err := s.UpsertProvider(tc.p); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestCredentialsSeparatedFromProviderList(t *testing.T) {
	s := testStore(t)
	if err := s.SetCredential("QINIU_ACCESS_TOKEN", "sk-secret-value"); err != nil {
		t.Fatalf("SetCredential: %v", err)
	}
	key, ok := s.Credential("QINIU_ACCESS_TOKEN")
	if !ok || key != "sk-secret-value" {
		t.Fatalf("Credential = %q, %v", key, ok)
	}
	for _, p := range s.List() {
		if strings.Contains(mustJSON(p), "sk-secret-value") {
			t.Fatal("plaintext credential leaked into provider list")
		}
	}
	if err := s.SetCredential("QINIU_ACCESS_TOKEN", ""); err != nil {
		t.Fatalf("delete credential: %v", err)
	}
	if _, ok := s.Credential("QINIU_ACCESS_TOKEN"); ok {
		t.Fatal("credential not deleted")
	}
	if err := s.SetCredential("bad-ref", "x"); err == nil {
		t.Fatal("invalid ref should be rejected")
	}
}

func TestSelectOrderRateLimitAndFallback(t *testing.T) {
	s := testStore(t)
	s.SetNow(func() time.Time { return time.UnixMilli(1_000_000) })
	_ = s.UpsertProvider(Provider{ID: "sub", Label: "订阅供应商", BaseURL: "https://sub.example.com/v1", Enabled: true, CredentialRef: "SUB_FALLBACK_KEY"})
	_ = s.SetCredential("ACC_A", "key-a")
	_ = s.SetCredential("ACC_B", "key-b")
	_ = s.SetCredential("SUB_FALLBACK_KEY", "key-fallback")
	_ = s.UpsertAccount("sub", Account{ID: "a", Enabled: true, CredentialRef: "ACC_A"})
	_ = s.UpsertAccount("sub", Account{ID: "b", Enabled: true, CredentialRef: "ACC_B"})

	// 数组顺序即选号优先级。
	sel, err := s.Select("sub", "model-x", nil)
	if err != nil || sel.Account == nil || sel.Account.ID != "a" || sel.Key != "key-a" {
		t.Fatalf("first select = %+v, %v", sel, err)
	}
	// tried 跳过第一个。
	sel, err = s.Select("sub", "model-x", map[string]bool{"a": true})
	if err != nil || sel.Account == nil || sel.Account.ID != "b" {
		t.Fatalf("second select = %+v, %v", sel, err)
	}
	// 模型级限流（未来截止）跳过。
	_ = s.MarkRateLimited("sub", "a", "model-x", 9_000_000)
	sel, err = s.Select("sub", "model-x", nil)
	if err != nil || sel.Account == nil || sel.Account.ID != "b" {
		t.Fatalf("rate limited select = %+v, %v", sel, err)
	}
	// 限流只对特定模型生效。
	sel, err = s.Select("sub", "model-y", nil)
	if err != nil || sel.Account == nil || sel.Account.ID != "a" {
		t.Fatalf("other model select = %+v, %v", sel, err)
	}
	// 停用 + 已尝试全部账号时回退到供应商级 Key。
	_, err = s.Select("sub", "model-x", map[string]bool{"a": true, "b": true})
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	// 无账号池且无 key → ErrNoAccount。
	_ = s.DeleteAccount("sub", "a")
	_ = s.DeleteAccount("sub", "b")
	p, _ := s.Get("sub")
	p.CredentialRef = ""
	_ = s.UpsertProvider(p)
	if _, err := s.Select("sub", "model-x", nil); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("want ErrNoAccount, got %v", err)
	}
}

func TestMoveAccountAndClassifyStatus(t *testing.T) {
	s := testStore(t)
	_ = s.UpsertProvider(Provider{ID: "sub", Label: "订阅", BaseURL: "https://a.com", Enabled: true})
	for _, id := range []string{"a", "b", "c"} {
		_ = s.UpsertAccount("sub", Account{ID: id, Enabled: true, CredentialRef: "R_" + strings.ToUpper(id)})
	}
	_ = s.MoveAccount("sub", "c", -2)
	p, _ := s.Get("sub")
	if p.Accounts[0].ID != "c" {
		t.Fatalf("move order: %+v", p.Accounts)
	}
	cases := map[int]string{
		401: "auth", 403: "auth", 429: "rate_limit", 400: "invalid_request",
		422: "invalid_request", 500: "server", 0: "transport", 200: "ok",
	}
	for status, want := range cases {
		if got := ClassifyStatus(status); got != want {
			t.Fatalf("ClassifyStatus(%d) = %q, want %q", status, got, want)
		}
	}
	if ShouldRotate("invalid_request") || !ShouldRotate("rate_limit") {
		t.Fatal("ShouldRotate logic broken")
	}
}

func TestAuthHeadersAndPaths(t *testing.T) {
	s := testStore(t)
	if got := s.AuthHeaders("openai", "k")["Authorization"]; got != "Bearer k" {
		t.Fatalf("bearer header = %q", got)
	}
	if got := s.AuthHeaders("anthropic", "k")["x-api-key"]; got != "k" {
		t.Fatalf("x-api-key header = %q", got)
	}
	if got := s.AuthHeaders("anthropic", "k")["anthropic-version"]; got != "2023-06-01" {
		t.Fatalf("anthropic-version = %q", got)
	}
	if len(s.AuthHeaders("openai", "")) != 0 {
		t.Fatal("empty key should produce no auth headers")
	}
	if got := s.MessagesPath("anthropic"); got != "/v1/messages" {
		t.Fatalf("MessagesPath = %q", got)
	}
	if got := s.ResponsesPath("openai"); got != "/responses" {
		t.Fatalf("ResponsesPath = %q", got)
	}
}

func TestParseModelRoute(t *testing.T) {
	p, m, err := ParseModelRoute("codearts/deepseek-ai/DeepSeek-V4-Flash")
	if err != nil || p != "codearts" || m != "deepseek-ai/DeepSeek-V4-Flash" {
		t.Fatalf("parse = %q %q %v", p, m, err)
	}
	for _, bad := range []string{"", "no-slash", "/leading", "trailing/"} {
		if _, _, err := ParseModelRoute(bad); err == nil {
			t.Fatalf("ParseModelRoute(%q) should fail", bad)
		}
	}
}

func TestHubListenAddrRejectsNonLoopback(t *testing.T) {
	if got, err := HubListenAddr(""); err != nil || got != "127.0.0.1:8327" {
		t.Fatalf("default = %q, %v", got, err)
	}
	for _, bad := range []string{"0.0.0.0:8327", "212.64.17.221:8327", "[::]:8327"} {
		if _, err := HubListenAddr(bad); err == nil {
			t.Fatalf("HubListenAddr(%q) should be rejected", bad)
		}
	}
	if _, err := HubListenAddr("127.0.0.1:9000"); err != nil {
		t.Fatalf("loopback rejected: %v", err)
	}
}

func TestHubModelsAndProxyRotation(t *testing.T) {
	s := testStore(t)
	// 上游 1 返回 429，上游 2 返回 200；用同一个 httptest server 按序模拟。
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"error":"rate limited"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer upstream.Close()

	_ = s.UpsertProvider(Provider{
		ID: "sub", Label: "订阅", BaseURL: upstream.URL, ChatPath: "/chat/completions",
		APIMode: "chat_completions", Enabled: true, CachedModels: []string{"m1"},
	})
	_ = s.SetCredential("ACC_A", "key-a")
	_ = s.SetCredential("ACC_B", "key-b")
	_ = s.UpsertAccount("sub", Account{ID: "a", Enabled: true, CredentialRef: "ACC_A"})
	_ = s.UpsertAccount("sub", Account{ID: "b", Enabled: true, CredentialRef: "ACC_B"})

	hub := NewHub(s, "test-hub-key", nil)
	// /v1/models 聚合。
	modelsReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	modelsReq.Header.Set("Authorization", "Bearer test-hub-key")
	rec := httptest.NewRecorder()
	hub.Handler().ServeHTTP(rec, modelsReq)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "sub/m1") {
		t.Fatalf("models = %d %s", rec.Code, rec.Body.String())
	}
	// 鉴权失败。
	rec = httptest.NewRecorder()
	hub.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("missing key status = %d", rec.Code)
	}
	// 换号重试。
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"sub/m1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-hub-key")
	rec = httptest.NewRecorder()
	hub.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("proxy status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if calls != 2 {
		t.Fatalf("upstream calls = %d, want 2 (rotation)", calls)
	}
	// 429 应写入 modelRateLimits。
	p, _ := s.Get("sub")
	if until := p.Accounts[0].ModelRateLimits["m1"]; until <= s.Now() {
		t.Fatal("429 did not mark rate limit on account a")
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func osWriteFile(path, content string) error { return os.WriteFile(path, []byte(content), 0o600) }

func osStat(path string) (os.FileInfo, error) { return os.Stat(path) }

func TestLoadOrCreateAPIKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "api-key")
	t.Setenv("A_STOCK_AI_HUB_API_KEY", "")
	key, err := LoadOrCreateAPIKey(path)
	if err != nil || len(key) != 43 {
		t.Fatalf("generated key = %q (%d), %v", key, len(key), err)
	}
	key2, err := LoadOrCreateAPIKey(path)
	if err != nil || key2 != key {
		t.Fatalf("key not stable: %q vs %q, %v", key2, key, err)
	}
	_ = osWriteFile(path, "bad")
	if _, err := LoadOrCreateAPIKey(path); err == nil {
		t.Fatal("malformed existing key should error")
	}
}

func TestRefreshPlansAndUsage(t *testing.T) {
	s := testStore(t)
	s.SetNow(func() time.Time { return time.UnixMilli(1_000_000) })
	_ = s.UpsertProvider(Provider{ID: "sub", Label: "订阅", BaseURL: "https://a.com", Enabled: true, RefreshURL: "https://a.com/refresh"})
	_ = s.UpsertAccount("sub", Account{ID: "a", Enabled: true, Refreshable: true, CredentialRef: "R_A", ExpiresAt: 1_000_000 + RefreshLeadMs - 1})
	_ = s.UpsertAccount("sub", Account{ID: "b", Enabled: true, Refreshable: true, CredentialRef: "R_B", ExpiresAt: 1_000_000 + 10*RefreshLeadMs})
	plans := s.RefreshPlans()
	var dueA, dueB bool
	for _, p := range plans {
		if p.AccountID == "a" {
			dueA = p.Due
		}
		if p.AccountID == "b" {
			dueB = p.Due
		}
	}
	if !dueA || dueB {
		t.Fatalf("refresh window: a=%v b=%v", dueA, dueB)
	}
	s.RecordUsage("sub", "a", "m1", 10, 20, false)
	s.RecordUsage("sub", "a", "m1", 5, 6, true)
	views := s.UsageSnapshot(7)
	if len(views) != 1 || len(views[0].Entries) != 1 {
		t.Fatalf("usage views = %+v", views)
	}
	e := views[0].Entries[0]
	if e.Requests != 2 || e.Errors != 1 || e.InputTokens != 15 || e.OutputTokens != 26 {
		t.Fatalf("usage entry = %+v", e)
	}
}

func TestPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "ai-providers.json")
	credPath := filepath.Join(dir, "ai-credentials.json")
	s, err := Open(statePath, credPath)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.UpsertProvider(Provider{ID: "mine", Label: "我的供应商", BaseURL: "https://mine.example.com/v1", Enabled: true})
	_ = s.SetCredential("MINE_KEY", "secret")
	_ = s.UpsertAccount("mine", Account{ID: "acc", Enabled: true, CredentialRef: "MINE_KEY"})

	s2, err := Open(statePath, credPath)
	if err != nil {
		t.Fatal(err)
	}
	if !s2.Exists("mine") {
		t.Fatal("custom provider not persisted")
	}
	if key, _ := s2.Credential("MINE_KEY"); key != "secret" {
		t.Fatalf("credential not persisted: %q", key)
	}
	p, _ := s2.Get("mine")
	if len(p.Accounts) != 1 || p.Accounts[0].ID != "acc" {
		t.Fatalf("accounts not persisted: %+v", p.Accounts)
	}
	// 文件权限 0600。
	for _, path := range []string{statePath, credPath, filepath.Join(dir, "ai-usage.json")} {
		info, err := osStat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s perm = %o, want 600", path, perm)
		}
	}
}
