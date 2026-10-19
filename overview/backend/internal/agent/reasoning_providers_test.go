package agent

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	"easy-stock/backend/internal/appsettings"
)

func TestProviderReasoningMatrix(t *testing.T) {
	pythons := []string{""}
	if python := os.Getenv("HERMES_TEST_PYTHON"); python != "" {
		pythons = append(pythons, python)
	}
	for _, python := range pythons {
		r := NewHermesRuntime(HermesConfig{Home: t.TempDir(), PythonPath: python})
		for _, tc := range []struct {
			model, url, mode, values, fallback string
			metadata                           json.RawMessage
		}{
			{"gpt-6.1-sol", "https://api.openai.com/v1", "responses", "low,medium,high,xhigh,max", "medium", nil},
			{"deepseek-flash", "https://api.deepseek.com", "responses", "none,low,high,max", "high", nil},
			{"deepseek-flash", "https://api.deepseek.com/v1", "chat_completions", "none,low,high,max", "high", nil},
			{"kimi-k3", "https://api.moonshot.cn/v1", "responses", "low,high,max", "max", nil},
			{"kimi-k3", "https://api.moonshot.cn/v1", "chat_completions", "low,high,max", "max", nil},
			{"kimi-k2.6", "https://api.moonshot.cn/v1", "chat_completions", "none,enabled", "enabled", nil},
			{"MiniMax-M3.1-Flash-Preview", "https://api.minimaxi.com/v1", "responses", "low,medium,high,xhigh,max", "max", nil},
			{"MiniMax-M3.1-Flash-Preview", "https://api.minimax.io/v1", "chat_completions", "low,medium,high,xhigh,max", "max", nil},
			{"MiniMax-M3", "https://api.minimaxi.com/v1", "responses", "none,enabled", "none", nil},
			{"MiniMax-M3", "https://api.minimaxi.com/v1", "chat_completions", "none,enabled", "enabled", nil},
			{"MiniMax-M2.7", "https://api.minimaxi.com/v1", "responses", "default", "default", nil},
			{"glm-5.3-flash", "https://open.bigmodel.cn/api/v1", "responses", "low,high,max", "max", nil},
			{"qwen3.8-max", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "responses", "none,low,medium,xhigh", "xhigh", nil},
			{"qwen-plus", "https://dashscope.aliyuncs.com/compatible-mode/v1", "chat_completions", "none,low,medium,high", "medium", nil},
			{"Qwen/Qwen3-8B", "https://api.siliconflow.cn/v1", "chat_completions", "none,low,medium,high", "medium", nil},
			{"claude-opus-5-5", "https://api.anthropic.com", "anthropic_messages", "low,medium,high,xhigh,max", "medium", nil},
			{"claude-sonnet-4-5", "https://api.anthropic.com", "anthropic_messages", "none,low,medium,high", "medium", nil},
			{"custom-model", "https://custom.example/v1", "responses", "low,high", "high", json.RawMessage(`{"supported_reasoning_efforts":["low","high"],"default_reasoning_effort":"high"}`)},
			{"custom-model", "https://custom.example/v1", "chat_completions", "low,high", "high", json.RawMessage(`{"supported_reasoning_efforts":["low","high"],"default_reasoning_effort":"high"}`)},
			// Capabilities cannot leak across routes, protocols, or model names.
			{"kimi-k3", "https://unrelated.example/v1", "responses", "default", "default", nil},
			{"kimi-k3-future", "https://api.moonshot.cn/v1", "chat_completions", "default", "default", nil},
			{"Qwen/Qwen3-8B", "https://api.siliconflow.cn/v1", "responses", "default", "default", nil},
			{"claude-opus-5-5", "https://api.anthropic.com", "responses", "default", "default", nil},
			{"qwen3.8-max", "https://workspace.cn-beijing.maas.aliyuncs.com.evil.example/compatible-mode/v1", "responses", "default", "default", nil},
		} {
			t.Run(tc.model+tc.mode+python, func(t *testing.T) {
				caps, err := r.ResolveModelCapabilities(tc.url, tc.mode, map[string]json.RawMessage{tc.model: tc.metadata})
				c := caps[tc.model]
				if err != nil || !reflect.DeepEqual(optionValues(c), strings.Split(tc.values, ",")) || c.Default != tc.fallback {
					t.Fatalf("capability %s: %+v err=%v", tc.url, c, err)
				}
				cfg := appsettings.LLM{Model: tc.model, BaseURL: tc.url, APIMode: tc.mode}
				if err := r.SyncLLM(cfg, nil); err != nil {
					t.Fatal(err)
				}
				if err := r.SyncModelCapabilities(tc.url, tc.mode, caps); err != nil {
					t.Fatal(err)
				}
				for _, option := range c.Options {
					s, err := r.AgentSettings()
					if err != nil {
						t.Fatal(err)
					}
					s.ReasoningEffort = option.Value
					if err := r.SyncAgentSettings(s); err != nil {
						t.Fatal(err)
					}
					saved, err := r.AgentSettings()
					if err != nil || saved.ReasoningEffort != option.Value {
						t.Fatalf("setting was lost: %+v %v", saved, err)
					}
				}
			})
		}
	}
}
