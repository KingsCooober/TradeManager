package agent

import "strings"

func budgetReasoningCapability(source, wire string) ReasoningCapability {
	c := reasoningCapability(source, wire, "通过原生 thinking_budget 控制思考 Token 上限：低 1024、中 4096、高 8192；不是固定消耗量。", "medium", "none", "low", "medium", "high")
	for i, suffix := range []string{"", "（1024）", "（4096）", "（8192）"} {
		c.Options[i].Label += suffix
	}
	return c
}

// These rules describe native endpoints, not a compatibility proxy. Unknown
// models must declare capabilities in their catalog before offering controls.
func providerReasoningCapability(host, path, model, mode string) (ReasoningCapability, bool) {
	responses := mode == "responses" || mode == "codex_responses"
	chat := mode == "chat_completions"
	wire := "openai_chat"
	if responses {
		wire = "openai_responses"
	}
	makeCap := func(source, note, fallback string, values ...string) (ReasoningCapability, bool) {
		return reasoningCapability(source, wire, note, fallback, values...), true
	}
	if host == "api.openai.com" && path == "/v1" && (chat || responses) {
		source := "https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort"
		switch model {
		case "gpt-6-astra", "gpt-6.1-sol":
			return makeCap(source, "支持低、中、高、极高、最大；模型不支持关闭思考。", "medium", "low", "medium", "high", "xhigh", "max")
		case "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna":
			return makeCap(source, "按官方模型文档提供原生思考档位。", "medium", "none", "low", "medium", "high", "xhigh", "max")
		}
	}
	if host == "api.deepseek.com" && (path == "" || path == "/v1") && (chat || responses) {
		switch model {
		case "deepseek-flash":
			if chat {
				wire = "deepseek"
			}
			return makeCap("https://api-docs.deepseek.com/guides/thinking_mode", "支持关闭、低、高、最大；medium 和 xhigh 在服务端映射为 high。", "high", "none", "low", "high", "max")
		}
	}
	if (host == "api.moonshot.cn" || host == "api.moonshot.ai") && path == "/v1" {
		if model == "kimi-k3" && (chat || responses) {
			return makeCap("https://platform.kimi.com/docs/guide/use-reasoning-effort", "Kimi K3 始终开启思考，支持低、高、最大，默认最大。", "max", "low", "high", "max")
		}
		if chat && (model == "kimi-k2.5" || model == "kimi-k2.6") {
			wire = "thinking_toggle"
			return makeCap("https://platform.kimi.com/docs/guide/use-thinking-models", "此模型提供思考开关；独立推理强度档位适用于 Kimi K3。", "enabled", "none", "enabled")
		}
	}
	if (host == "api.minimaxi.com" || host == "api.minimax.io") && path == "/v1" && (chat || responses) {
		source := "https://platform.minimax.io/docs/api-reference/responses-create"
		if chat {
			wire, source = "minimax", "https://platform.minimax.io/docs/api-reference/text-openai-api"
		}
		switch model {
		case "minimax-m3.1-flash-preview":
			return makeCap(source, "支持低、中、高、极高、最大，默认最大；不能关闭思考。", "max", "low", "medium", "high", "xhigh", "max")
		case "minimax-m3":
			fallback := "enabled"
			if responses {
				fallback = "none"
			}
			return makeCap(source, "MiniMax M3 仅支持思考开关，不支持独立强度档位。", fallback, "none", "enabled")
		case "minimax-m2", "minimax-m2.1", "minimax-m2.1-highspeed", "minimax-m2.5", "minimax-m2.5-highspeed", "minimax-m2.7", "minimax-m2.7-highspeed":
			c := reasoningCapability(source, wire, "此模型始终开启思考，不支持关闭或调节强度。", "default", "default")
			c.Options[0].Label = "固定思考"
			return c, true
		}
	}
	// Responses requires a workspace endpoint from the Bailian console. Do not
	// silently send a saved credential to a guessed workspace URL.
	if strings.HasSuffix(host, ".maas.aliyuncs.com") && path == "/compatible-mode/v1" && responses {
		source := "https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses"
		switch model {
		case "qwen3.8-max", "qwen3.8-max-0902", "qwen3.8-flash", "qwen3.8-2.4t-a95b", "qwen3.8-27b":
			return makeCap(source, "原生有效档位为关闭、低、中、极高；其他值会被服务端映射。", "xhigh", "none", "low", "medium", "xhigh")
		case "deepseek-v4-flash-0731", "deepseek-v4-pro-0813", "deepseek-v4.1-flash":
			return makeCap(source, "按百炼 Responses 接口声明的有效档位。", "high", "none", "low", "high", "max")
		case "glm-5.3":
			return makeCap(source, "按百炼 Responses 接口声明的有效档位。", "max", "low", "high", "max")
		case "glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash":
			return makeCap(source, "按百炼 Responses 接口声明的有效档位。", "high", "none", "high", "max")
		}
	}
	if (host == "api.siliconflow.cn" || host == "api.siliconflow.com") && path == "/v1" && chat {
		// This API controls token budgets. Label the budget explicitly instead of
		// presenting it as provider-defined reasoning_effort levels.
		switch model {
		case "qwen/qwen3-8b", "qwen/qwen3-14b", "qwen/qwen3-32b", "qwen/qwen3-30b-a3b", "qwen/qwen3-235b-a22b", "tencent/hunyuan-a13b-instruct", "zai-org/glm-5v-turbo", "zai-org/glm-4.6v", "zai-org/glm-4.5v", "deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3.1-terminus", "deepseek-ai/deepseek-v3.2-exp", "deepseek-ai/deepseek-v3.2":
			return budgetReasoningCapability("https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions", "siliconflow_budget"), true
		}
	}
	if host == "api.anthropic.com" && (path == "" || path == "/v1") && mode == "anthropic_messages" {
		wire = "anthropic"
		source := "https://platform.claude.com/docs/en/build-with-claude/effort"
		switch model {
		case "claude-opus-5-5":
			return makeCap(source, "原生自适应思考，默认中；不能关闭思考。", "medium", "low", "medium", "high", "xhigh", "max")
		case "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5", "claude-mythos-5-1":
			return makeCap(source, "通过原生 output_config.effort 设置自适应思考强度。", "high", "low", "medium", "high", "xhigh", "max")
		case "claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview":
			return makeCap(source, "支持低、中、高、最大，不支持独立 xhigh 档位。", "high", "low", "medium", "high", "max")
		case "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-sonnet-4-0", "claude-opus-4-0", "claude-3-7-sonnet-latest", "claude-3-7-sonnet-20250219":
			wire = "anthropic_budget"
			return makeCap("https://platform.claude.com/docs/en/build-with-claude/extended-thinking", "通过思考 Token 预算设置强度：低 4000、中 8000、高 16000；不是固定消耗量。", "medium", "none", "low", "medium", "high")
		}
	}
	return ReasoningCapability{}, false
}
