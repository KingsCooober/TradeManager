package aiproviders

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCodeArtsBenefitCatalogAndLearning(t *testing.T) {
	s := testStore(t)
	if err := s.SetProviderCatalog(ProviderCodeArts, []ModelInfo{
		{ID: "glm-5.3", Name: "glm-5.3", Benefit: false},
		{ID: "glm-5.3-flash", Name: "glm-5.3-flash", Benefit: true},
	}); err != nil {
		t.Fatal(err)
	}
	if s.CodeArtsBenefitModel(ProviderCodeArts, "glm-5.3") {
		t.Fatal("glm-5.3 不能按名字猜成 benefit")
	}
	if !s.CodeArtsBenefitModel(ProviderCodeArts, "glm-5.3-flash") {
		t.Fatal("gateway 标记的 benefit 丢失")
	}
	if err := s.LearnCodeArtsBenefit(ProviderCodeArts, "glm-5.3", true); err != nil {
		t.Fatal(err)
	}
	if !s.CodeArtsBenefitModel(ProviderCodeArts, "glm-5.3") {
		t.Fatal("自愈学习未保存")
	}
}

func TestShouldFlipCodeArtsBenefit(t *testing.T) {
	if !shouldFlipCodeArtsBenefit(404, []byte(`{"code":"002002009.404"}`), false) {
		t.Fatal("benefit-only 模型应补头重试")
	}
	if !shouldFlipCodeArtsBenefit(400, []byte(`{"code":"InferHub.4004.200","message":"benefit not found"}`), true) {
		t.Fatal("错误 benefit 头应去头重试")
	}
	if shouldFlipCodeArtsBenefit(400, []byte(`{"code":"bad_request"}`), false) {
		t.Fatal("普通请求错误不应重试")
	}
}

func TestHubReturnsUpstreamInvalidRequest(t *testing.T) {
	s := testStore(t)
	if err := s.UpsertProvider(Provider{
		ID: "demo", Label: "Demo", BaseURL: "https://upstream.test/v1",
		ChatPath: "/chat/completions", APIMode: "chat_completions",
		AuthScheme: AuthBearer, CredentialRef: "DEMO_KEY", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCredential("DEMO_KEY", "secret"); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 400,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"error":"unsupported field"}`)),
			Request:    r,
		}, nil
	})}
	h := NewHub(s, "hub-key", client)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"demo/test","messages":[]}`))
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, req)
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), "unsupported field") {
		t.Fatalf("上游 4xx 被吞成空响应：status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestHubCodeArtsRetriesEmpty200AndLearnsBenefit(t *testing.T) {
	s := testStore(t)
	p, ok := s.Get(ProviderCodeArts)
	if !ok {
		t.Fatal("codearts seed 缺失")
	}
	p.CredentialRef = "CODEARTS_TEST"
	if err := s.UpsertProvider(p); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCredential("CODEARTS_TEST", `{"access_key_id":"ak","secret_access_key":"sk","security_token":"st"}`); err != nil {
		t.Fatal(err)
	}
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			if r.Header.Get("maas_type") != "" {
				t.Fatal("glm-5.3 首次请求不应按名字带 benefit")
			}
			return &http.Response{
				StatusCode: 200, ContentLength: 0, Header: make(http.Header),
				Body: io.NopCloser(strings.NewReader("")), Request: r,
			}, nil
		}
		if got := r.Header.Get("maas_type"); got != "benefit" {
			t.Fatalf("空 200 后未切换 benefit，got=%q", got)
		}
		return &http.Response{
			StatusCode: 200, ContentLength: -1, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"OK"}}]}`)), Request: r,
		}, nil
	})}
	h := NewHub(s, "hub-key", client)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"codearts/glm-5.3","messages":[]}`))
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "OK") || calls != 2 {
		t.Fatalf("双向纠错失败：status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
	}
	if !s.CodeArtsBenefitModel(ProviderCodeArts, "glm-5.3") {
		t.Fatal("纠错后的 benefit 未学习保存")
	}
}

func TestHubCodeArtsRaisesMaxTokensFloor(t *testing.T) {
	s := testStore(t)
	p, ok := s.Get(ProviderCodeArts)
	if !ok {
		t.Fatal("codearts seed 缺失")
	}
	p.CredentialRef = "CODEARTS_TEST"
	if err := s.UpsertProvider(p); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCredential("CODEARTS_TEST", `{"access_key_id":"ak","secret_access_key":"sk","security_token":"st"}`); err != nil {
		t.Fatal(err)
	}
	var gotMaxTokens float64
	var gotModel string
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var env map[string]any
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &env)
		gotMaxTokens, _ = env["max_tokens"].(float64)
		gotModel, _ = env["model"].(string)
		return &http.Response{
			StatusCode: 200, ContentLength: -1, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"OK"}}]}`)), Request: r,
		}, nil
	})}
	h := NewHub(s, "hub-key", client)

	// 小预算必须抬到 32000（推理模型正文才出得来）
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"codearts/glm-5.3","messages":[],"max_tokens":500}`))
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || gotMaxTokens != 32000 || gotModel != "glm-5.3" {
		t.Fatalf("max_tokens 未抬升：code=%d max_tokens=%v model=%q", rec.Code, gotMaxTokens, gotModel)
	}

	// 缺省也必须给默认值
	req2 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"codearts/glm-5.3","messages":[]}`))
	req2.Header.Set("Authorization", "Bearer hub-key")
	req2.Header.Set("Content-Type", "application/json")
	rec2 := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != 200 || gotMaxTokens != 32000 {
		t.Fatalf("缺省 max_tokens 未给默认：code=%d max_tokens=%v", rec2.Code, gotMaxTokens)
	}

	// 调用方显式给更大值：只抬不降
	req3 := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"codearts/glm-5.3","messages":[],"max_tokens":48000}`))
	req3.Header.Set("Authorization", "Bearer hub-key")
	req3.Header.Set("Content-Type", "application/json")
	rec3 := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec3, req3)
	if rec3.Code != 200 || gotMaxTokens != 48000 {
		t.Fatalf("更大的 max_tokens 被降级：code=%d max_tokens=%v", rec3.Code, gotMaxTokens)
	}
}

func TestHubCodeArtsRetriesConcurrencyQueue(t *testing.T) {
	s := testStore(t)
	p, ok := s.Get(ProviderCodeArts)
	if !ok {
		t.Fatal("codearts seed 缺失")
	}
	p.CredentialRef = "CODEARTS_TEST"
	if err := s.UpsertProvider(p); err != nil {
		t.Fatal(err)
	}
	if err := s.SetCredential("CODEARTS_TEST", `{"access_key_id":"ak","secret_access_key":"sk","security_token":"st"}`); err != nil {
		t.Fatal(err)
	}
	previousDelay := codeArtsQueueRetryDelay
	codeArtsQueueRetryDelay = time.Millisecond
	t.Cleanup(func() { codeArtsQueueRetryDelay = previousDelay })
	calls := 0
	chatID, sessionID := "", ""
	client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			chatID, sessionID = r.Header.Get("Chat-Id"), r.Header.Get("Session-Id")
			if chatID == "" || sessionID == "" {
				t.Fatal("CodeArts 请求缺少会话头")
			}
			return &http.Response{
				StatusCode: 400, ContentLength: -1, Header: make(http.Header),
				Body: io.NopCloser(strings.NewReader(`{"error_code":"TM.00001041","error_msg":"并发会话数已达上限(3个)"}`)), Request: r,
			}, nil
		}
		if r.Header.Get("Chat-Id") != chatID || r.Header.Get("Session-Id") != sessionID {
			t.Fatal("排队重试没有复用同一会话头")
		}
		return &http.Response{
			StatusCode: 200, ContentLength: -1, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"OK"}}]}`)), Request: r,
		}, nil
	})}
	h := NewHub(s, "hub-key", client)
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"codearts/glm-5.3","messages":[]}`))
	req.Header.Set("Authorization", "Bearer hub-key")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 || calls != 2 || !strings.Contains(rec.Body.String(), "OK") {
		t.Fatalf("并发排队重试失败：status=%d calls=%d body=%s", rec.Code, calls, rec.Body.String())
	}
}
