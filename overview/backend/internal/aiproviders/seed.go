package aiproviders

// seedProviders 是首次启动写入注册表的内置供应商，逐字对齐前端
// overview/frontend/src/lib/llm-providers.ts 的 llmProviders 常量，保证旧配置
// （10 家 provider id）在升级后无需迁移即可继续通过白名单校验。
// 内置项 Builtin=true 不可删除，但可停用、可改 BaseURL / 子路径 / 鉴权方式。
//
// 三种出站协议的子路径分开配置，hub 反向代理按入口协议选用：
//   - chat_completions → ChatPath（默认 /chat/completions）
//   - responses / codex_responses → ResponsesPath（默认 /responses）
//   - anthropic_messages → MessagesPath（默认 /v1/messages）
func seedProviders() []Provider {
	return []Provider{
		{ID: "openai", Label: "OpenAI", BaseURL: "https://api.openai.com/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "codex_responses", DefaultModel: "gpt-4o-mini", Enabled: true, Builtin: true},
		{ID: "deepseek", Label: "DeepSeek", BaseURL: "https://api.deepseek.com", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "deepseek-v4-pro", Enabled: true, Builtin: true},
		{ID: "moonshot", Label: "Kimi / 月之暗面", BaseURL: "https://api.moonshot.cn/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "moonshot-v1-8k", Enabled: true, Builtin: true},
		{ID: "minimax", Label: "MiniMax", BaseURL: "https://api.minimaxi.com/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "codex_responses", DefaultModel: "MiniMax-Text-01", Enabled: true, Builtin: true},
		{ID: "zhipu", Label: "智谱 GLM", BaseURL: "https://open.bigmodel.cn/api/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "codex_responses", DefaultModel: "glm-5.3-flash", Enabled: true, Builtin: true},
		{ID: "qwen", Label: "通义千问", BaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "qwen-plus", Enabled: true, Builtin: true},
		{ID: "siliconflow", Label: "硅基流动 SiliconFlow", BaseURL: "https://api.siliconflow.cn/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "", Enabled: true, Builtin: true},
		{ID: "xiaomi", Label: "小米 MiMo", BaseURL: "https://api.xiaomimimo.com/v1", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "chat_completions", DefaultModel: "mimo-v2.6-flash", Enabled: true, Builtin: true},
		{ID: "anthropic", Label: "Anthropic Claude", BaseURL: "https://api.anthropic.com", MessagesPath: "/v1/messages", ModelsPath: "/v1/models", AuthScheme: AuthAPIKey, APIMode: "anthropic_messages", DefaultModel: "claude-3-5-haiku-latest", Enabled: true, Builtin: true},
		{ID: "custom", Label: "OpenAI 兼容接口", BaseURL: "", ChatPath: "/chat/completions", ResponsesPath: "/responses", ModelsPath: "/models", AuthScheme: AuthBearer, APIMode: "codex_responses", DefaultModel: "", Enabled: true, Builtin: true},
	}
}
