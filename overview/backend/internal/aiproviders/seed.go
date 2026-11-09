package aiproviders

// seedProviders 是首次启动写入注册表的内置供应商。
// 本阶段按需求只内置 codearts 一家登录型订阅渠道（OAuth + SDK-HMAC-SHA256 +
// 私有模型目录），其余 API Key 型供应商不再内置；需要时可运行时自行新增。
// 内置项 Builtin=true 不可删除，但可停用、可改 BaseURL / 子路径 / 鉴权方式。
//
// 三种出站协议的子路径分开配置，hub 反向代理按入口协议选用：
//   - chat_completions → ChatPath（默认 /chat/completions）
//   - responses / codex_responses → ResponsesPath（默认 /responses）
//   - anthropic_messages → MessagesPath（默认 /v1/messages）
func seedProviders() []Provider {
	return []Provider{
		// 登录型订阅渠道：走 OAuth 登录（PKCE+DPoP）换 AK/SK，出站用
		// SDK-HMAC-SHA256 签名而不是 Bearer，模型目录来自私有端点。
		// AuthScheme=none 是因为 hub 转发会按 LoginType 改用 SDK 签名头。
		{
			ID:            ProviderCodeArts,
			Label:         "CodeArts (华为云)",
			BaseURL:       caChatAPIBase,
			ChatPath:      caChatPath,
			AuthScheme:    AuthNone,
			APIMode:       "chat_completions",
			LoginType:     LoginTypeCodeArts,
			CachedModels:  append([]string(nil), defaultCodeArtsModels...),
			Enabled:       true,
			Builtin:       true,
		},
	}
}
