package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"easy-stock/backend/internal/agent"
	"easy-stock/backend/internal/appsettings"
)

const revealKeyPath = "/api/v1/settings/llm/api-key/reveal"

func TestSettingsLLMAPIKeyRevealAfterReopen(t *testing.T) {
	root := t.TempDir()
	settingsPath := filepath.Join(root, "settings.json")
	store, err := appsettings.Open(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "hermes")
	runtime := agent.NewHermesRuntime(agent.HermesConfig{Home: home})
	var logs bytes.Buffer
	server := NewServer(Config{SettingsStore: store, AgentGateway: runtime, Logger: log.New(&logs, "", 0)})
	body := `{"llm_profiles":[
		{"id":"one","name":"One","provider":"custom","base_url":"https://model.example/v1","model":"one","api_mode":"chat_completions","api_key":"dummy-key-one"},
		{"id":"two","name":"Two","provider":"custom","base_url":"https://model.example/v1","model":"two","api_mode":"chat_completions","api_key":"dummy-key-two"}
	],"active_llm_profile_id":"one"}`
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/api/v1/settings", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("save status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "dummy-key") {
		t.Fatal("save response exposed a key")
	}
	// Recreate both stores so this covers persisted keys, not just a draft.
	store, err = appsettings.Open(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	runtime = agent.NewHermesRuntime(agent.HermesConfig{Home: home})
	server = NewServer(Config{Token: "test-token", SettingsStore: store, AgentGateway: runtime, Logger: log.New(&logs, "", 0)})
	before := store.Snapshot()
	for _, id := range []string{"one", "two"} {
		req := httptest.NewRequest(http.MethodPost, revealKeyPath, strings.NewReader(`{"profile_id":"`+id+`"}`))
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("Origin", "null") // Packaged desktop uses file:// plus the backend token.
		rec := httptest.NewRecorder()
		server.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("reveal %s status=%d headers=%v", id, rec.Code, rec.Header())
		}
		var payload struct {
			Data struct {
				APIKey string `json:"api_key"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || payload.Data.APIKey != "dummy-key-"+id {
			t.Fatalf("incorrect key for profile %s: decode error=%v", id, err)
		}
	}
	if !reflect.DeepEqual(before, store.Snapshot()) {
		t.Fatal("revealing changed the selected profile or settings")
	}
	if key, err := runtime.ModelAPIKey(); err != nil || key != "dummy-key-one" {
		t.Fatal("revealing inactive profile changed the active runtime key")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings", nil)
	req.Header.Set("Authorization", "Bearer test-token")
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "dummy-key") || strings.Contains(logs.String(), "dummy-key") {
		t.Fatal("ordinary settings response or logs exposed a key")
	}
}

func TestSettingsLLMAPIKeyRevealAccess(t *testing.T) {
	for _, tt := range []struct {
		name, token, authorization, peer, host, origin string
		want                                           int
	}{
		{"local", "", "", "127.0.0.1:4321", "localhost:20081", "http://127.0.0.1:20073", 200},
		{"local-cli", "", "", "127.0.0.1:4321", "127.0.0.1:20081", "", 200},
		{"ipv6", "", "", "[::1]:4321", "[::1]:20081", "http://[::1]:20073", 200},
		{"remote-peer", "", "", "192.0.2.1:4321", "localhost:20081", "", 403},
		{"remote-origin", "", "", "127.0.0.1:4321", "localhost:20081", "https://external.example", 403},
		{"remote-host", "", "", "127.0.0.1:4321", "external.example:20081", "http://localhost:20073", 403},
		{"opaque-origin", "", "", "127.0.0.1:4321", "localhost:20081", "null", 403},
		{"token-required", "test-token", "", "127.0.0.1:4321", "localhost:20081", "", 401},
		{"wrong-token", "test-token", "Bearer wrong", "127.0.0.1:4321", "localhost:20081", "", 401},
		{"desktop", "test-token", "Bearer test-token", "127.0.0.1:4321", "localhost:20081", "null", 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := appsettings.Open("")
			server := NewServer(Config{Token: tt.token, SettingsStore: store, AgentGateway: &fakeAgentGateway{modelAPIKey: "dummy-saved-key"}})
			req := httptest.NewRequest(http.MethodPost, revealKeyPath, strings.NewReader(`{"profile_id":"`+store.Snapshot().ActiveLLMProfileID+`"}`))
			req.RemoteAddr, req.Host = tt.peer, tt.host
			req.Header.Set("Origin", tt.origin)
			req.Header.Set("Authorization", tt.authorization)
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)
			if rec.Code != tt.want {
				t.Fatalf("status=%d want=%d", rec.Code, tt.want)
			}
			if tt.want != 200 && strings.Contains(rec.Body.String(), "dummy-saved-key") {
				t.Fatal("rejected request exposed key")
			}
		})
	}
}

func TestSettingsLLMAPIKeyRevealErrors(t *testing.T) {
	for _, tt := range []struct {
		name, body string
		gateway    agent.Gateway
		want       int
	}{
		{"invalid-json", `{`, nil, 400},
		{"missing-profile", `{}`, nil, 400},
		{"extra-field", `{"profile_id":"llm-default","unexpected":true}`, nil, 400},
		{"extra-json", `{"profile_id":"llm-default"}{}`, nil, 400},
		{"oversized", `{"profile_id":"` + strings.Repeat("x", 4096) + `"}`, nil, 400},
		{"unknown-profile", `{"profile_id":"deleted"}`, &fakeAgentGateway{modelAPIKey: "dummy-active-key"}, 404},
		{"no-runtime", `{"profile_id":"llm-default"}`, nil, 503},
		{"read-failure", `{"profile_id":"llm-default"}`, &fakeAgentGateway{modelKeyErr: errors.New("dummy-private-error")}, 503},
		{"no-key", `{"profile_id":"llm-default"}`, &fakeAgentGateway{}, 404},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := NewServer(Config{Token: "test-token", AgentGateway: tt.gateway})
			req := httptest.NewRequest(http.MethodPost, revealKeyPath, strings.NewReader(tt.body))
			req.Header.Set("Authorization", "Bearer test-token")
			rec := httptest.NewRecorder()
			server.ServeHTTP(rec, req)
			if rec.Code != tt.want || strings.Contains(rec.Body.String(), "dummy-") || rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("status=%d want=%d body=%s", rec.Code, tt.want, rec.Body.String())
			}
		})
	}
}
