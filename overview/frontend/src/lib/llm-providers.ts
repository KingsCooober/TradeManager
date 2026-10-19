export type LLMAPIMode = 'auto' | 'chat_completions' | 'codex_responses' | 'anthropic_messages';

export type LLMProviderDefinition = {
	id: string;
	label: string;
	baseURL: string;
	defaultModel: string;
	apiMode: LLMAPIMode;
	protocolBaseURLs?: Partial<Record<LLMAPIMode, string>>;
};

export const llmProviders: LLMProviderDefinition[] = [
	{ id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', apiMode: 'codex_responses' },
	{ id: 'deepseek', label: 'DeepSeek', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-pro', apiMode: 'codex_responses' },
	{ id: 'moonshot', label: 'Kimi（月之暗面）', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', apiMode: 'codex_responses' },
	{ id: 'minimax', label: 'MiniMax', baseURL: 'https://api.minimaxi.com/v1', defaultModel: 'MiniMax-Text-01', apiMode: 'codex_responses' },
	{
		id: 'zhipu', label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/v1', defaultModel: 'glm-5.3-flash', apiMode: 'codex_responses',
		// Official GLM Responses / Claude compatibility guides use distinct bases.
		protocolBaseURLs: {
			codex_responses: 'https://open.bigmodel.cn/api/v1',
			chat_completions: 'https://open.bigmodel.cn/api/paas/v4',
			anthropic_messages: 'https://open.bigmodel.cn/api/anthropic',
		},
	},
	{ id: 'qwen', label: '通义千问（百炼）', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', apiMode: 'codex_responses' },
	{ id: 'siliconflow', label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1', defaultModel: '', apiMode: 'codex_responses' },
	{ id: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com', defaultModel: 'claude-3-5-haiku-latest', apiMode: 'anthropic_messages' },
	{ id: 'custom', label: 'OpenAI 兼容接口', baseURL: '', defaultModel: '', apiMode: 'codex_responses' },
];

const providersByID = new Map(llmProviders.map((provider) => [provider.id, provider]));

export function llmProviderDefinition(provider: string): LLMProviderDefinition {
	return providersByID.get(provider) || providersByID.get('custom')!;
}

export function llmProviderName(provider: string): string {
	return providersByID.get(provider)?.label || provider;
}

export function llmProviderDefaultModel(provider: string): string {
	return providersByID.get(provider)?.defaultModel || '';
}

export function llmBaseURLForAPIMode(provider: string, currentBaseURL: string, nextMode: string): string {
	const definition = llmProviderDefinition(provider);
	const routes = definition.protocolBaseURLs;
	if (!routes) return currentBaseURL || definition.baseURL;
	const mode = nextMode === 'auto' || nextMode === 'responses' ? 'codex_responses' : nextMode;
	const target = routes[mode as LLMAPIMode];
	if (!target) return currentBaseURL;
	const normalize = (value: string) => value.trim().replace(/\/+$/, '');
	// Match whole known defaults only. A proxy, another plan's endpoint, or a
	// URL with a custom port/query must never be redirected with its saved key.
	const isDefault = Object.values(routes).some((url) => normalize(url) === normalize(currentBaseURL));
	return !currentBaseURL.trim() || isDefault ? target : currentBaseURL;
}
