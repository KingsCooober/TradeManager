package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"easy-stock/backend/internal/agent"
	"easy-stock/backend/internal/appsettings"
)

func TestRuntimeSelectionProbesResponsesBeforeCommit(t *testing.T) {
	var responseCode atomic.Int32
	responseCode.Store(404)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Error("protocol conversion attempted")
		}
		w.WriteHeader(int(responseCode.Load()))
		w.Write([]byte(`{"id":"r","object":"response"}`))
	}))
	defer provider.Close()
	store, err := appsettings.Open(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "codex")
	os.WriteFile(bin, []byte("fixture"), 0700)
	runtime := agent.NewService(agent.ServiceConfig{Hermes: agent.HermesConfig{Home: t.TempDir()}, Codex: agent.CodexConfig{Home: t.TempDir(), Executable: bin}})
	server := NewServer(Config{SettingsStore: store, AgentGateway: runtime})
	body := map[string]any{"agent_runtime": "codex", "llm": map[string]any{"provider": "custom", "base_url": provider.URL + "/v1", "model": "test", "api_mode": "auto", "api_key": "test-secret"}}
	request := func() *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		server.ServeHTTP(w, httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(string(data))))
		return w
	}
	rejected := request()
	if rejected.Code != 400 || !strings.Contains(rejected.Body.String(), "MODEL_PROTOCOL_UNSUPPORTED") {
		t.Fatalf("unsupported: %d %s", rejected.Code, rejected.Body)
	}
	if agent.RuntimeID(store.Snapshot().AgentRuntime) != agent.Hermes || runtime.ActiveRuntime() != agent.Hermes {
		t.Fatal("unsupported model activated Codex")
	}
	responseCode.Store(401)
	rejected = request()
	if rejected.Code != 400 || strings.Contains(rejected.Body.String(), "MODEL_PROTOCOL_UNSUPPORTED") {
		t.Fatalf("auth was mistaken for unsupported: %s", rejected.Body)
	}
	responseCode.Store(200)
	saved := request()
	if saved.Code != 200 {
		t.Fatalf("supported: %d %s", saved.Code, saved.Body)
	}
	if store.Snapshot().LLM.APIMode != "codex_responses" || store.Snapshot().AgentRuntime != agent.Codex || runtime.ActiveRuntime() != agent.Codex {
		t.Fatal("shared model/runtime not activated together")
	}
	if strings.Contains(saved.Body.String(), "test-secret") {
		t.Fatal("credential exposed")
	}
}
