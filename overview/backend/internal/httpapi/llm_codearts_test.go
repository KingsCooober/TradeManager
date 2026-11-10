package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"easy-stock/backend/internal/aiproviders"
	"easy-stock/backend/internal/appsettings"
)

func TestCodeArtsModelDiscoveryUsesHubAndEnabledModels(t *testing.T) {
	providerStore, err := aiproviders.Open("", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := providerStore.SetModelDisabled(aiproviders.ProviderCodeArts, "GLM-5.1", true); err != nil {
		t.Fatal(err)
	}
	hub := aiproviders.NewHub(providerStore, "hub-test-secret", nil)
	hubServer := httptest.NewServer(hub.Handler())
	defer hubServer.Close()
	settingsStore, _ := appsettings.Open("")
	server := NewServer(Config{
		SettingsStore: settingsStore, AIProviderStore: providerStore,
		AIHub: hub, AIHubListen: strings.TrimPrefix(hubServer.URL, "http://"),
		AgentGateway: &fakeAgentGateway{},
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/settings/llm/models", strings.NewReader(
		`{"provider":"codearts","base_url":"https://snap-access.cn-north-4.myhuaweicloud.com/api/v2","api_mode":"chat_completions"}`,
	))
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var result struct{ Data llmModelsResult `json:"data"` }
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Data.SourceURL != hubServer.URL+"/v1/models" {
		t.Fatalf("source_url=%q", result.Data.SourceURL)
	}
	if len(result.Data.Models) == 0 {
		t.Fatal("CodeArts 模型列表为空")
	}
	for _, model := range result.Data.Models {
		if !strings.HasPrefix(model.ID, "codearts/") || model.ID == "codearts/GLM-5.1" {
			t.Fatalf("模型路由或未启用模型过滤错误：%+v", model)
		}
	}
	if strings.Contains(rec.Body.String(), "hub-test-secret") {
		t.Fatal("响应泄露网关密钥")
	}
}

func TestApplyCodeArtsLLMInjectsHubRouteAndProfileKey(t *testing.T) {
	providerStore, _ := aiproviders.Open("", "")
	hub := aiproviders.NewHub(providerStore, "hub-test-secret", nil)
	settingsStore, _ := appsettings.Open("")
	server := NewServer(Config{
		SettingsStore: settingsStore, AIProviderStore: providerStore,
		AIHub: hub, AIHubListen: "127.0.0.1:8327",
	})
	values := settingsStore.Snapshot()
	values.ActiveLLMProfileID = "ca"
	values.LLMProfiles = []appsettings.LLMProfile{{ID: "ca", Provider: "codearts", Model: "GLM-5.2"}}
	values.LLM = appsettings.LLM{Provider: "codearts", Model: "GLM-5.2"}
	updates := map[string]*string{}
	activeKey, err := server.applyCodeArtsLLM(&values, updates)
	if err != nil {
		t.Fatal(err)
	}
	profile := values.LLMProfiles[0]
	if profile.BaseURL != "http://127.0.0.1:8327/v1" || profile.APIMode != "chat_completions" || profile.Model != "codearts/GLM-5.2" || !profile.APIKeyConfigured {
		t.Fatalf("profile 未规范化：%+v", profile)
	}
	if values.LLM.BaseURL != profile.BaseURL || values.LLM.Model != profile.Model || values.LLM.APIMode != profile.APIMode {
		t.Fatalf("active LLM 未规范化：%+v", values.LLM)
	}
	if activeKey == nil || *activeKey != "hub-test-secret" || updates["ca"] == nil || *updates["ca"] != "hub-test-secret" {
		t.Fatal("网关密钥未注入 profile key updates")
	}
	if got := codeArtsModelRoute("codearts/deepseek-ai/DeepSeek-V4.1-Flash"); got != "codearts/deepseek-ai/DeepSeek-V4.1-Flash" {
		t.Fatalf("已有路由被重复加前缀：%s", got)
	}
}
