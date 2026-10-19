package agent

import (
	"context"
	"easy-stock/backend/internal/appsettings"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestProbeResponsesDistinguishesUnsupportedAndUnknown(t *testing.T) {
	for _, tc := range []struct {
		name               string
		status             int
		body               string
		supported, unknown bool
	}{
		{"native", 200, `{"id":"r","object":"response"}`, true, false},
		{"missing endpoint", 404, `{}`, false, false},
		{"no method", 405, `{}`, false, false},
		{"bad auth", 401, `{"error":{"message":"bad key"}}`, false, true},
		{"missing model", 404, `{"error":{"code":"model_not_found"}}`, false, true},
		{"rate limited", 429, `{}`, false, true},
		{"not responses", 200, `{"choices":[{"message":{"content":"OK"}}]}`, false, true},
		{"explicit unsupported", 400, `{"error":{"code":"unsupported_protocol"}}`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("incorrect native route/auth")
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer server.Close()
			supported, err := ProbeResponses(context.Background(), appsettings.LLM{BaseURL: server.URL + "/v1", Model: "test"}, "fixture")
			if supported != tc.supported || errors.Is(err, ErrProtocolUnconfirmed) != tc.unknown {
				t.Fatalf("supported=%v err=%v", supported, err)
			}
		})
	}
}
