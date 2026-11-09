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
	// 小米 MiMo：官方主站 api.xiaomimimo.com 走按量付费（sk- key）；
	// Token Plan 用户实际用的是 token-plan-cn.xiaomimimo.com（tp- key），
	// 后者不是这里的默认地址，切换协议时会被原样保留（见 llmBaseURLForAPIMode）。
	{ id: 'xiaomi', label: '小米 MiMo', baseURL: 'https://api.xiaomimimo.com/v1', defaultModel: 'mimo-v2.6-flash', apiMode: 'codex_responses' },
	{ id: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com', defaultModel: 'claude-3-5-haiku-latest', apiMode: 'anthropic_messages' },
	{ id: 'custom', label: 'OpenAI 兼容接口', baseURL: '', defaultModel: '', apiMode: 'codex_responses' },
];

// 后端运行时注册表项，字段逐字对齐 overview/backend/internal/aiproviders.Provider。
export type AIProviderAccount = {
	id: string;
	nickname: string;
	enabled: boolean;
	credential_ref: string;
	refreshable: boolean;
	created_at: number;
	expires_at?: number;
	model_rate_limits?: Record<string, number>;
};

export type AIProviderModel = {
	id: string;
	name: string;
	disabled: boolean;
	dead?: boolean;
};

export type AIProvider = {
	id: string;
	label: string;
	base_url: string;
	chat_path?: string;
	responses_path?: string;
	messages_path?: string;
	models_path?: string;
	refresh_url?: string;
	auth_scheme?: string;
	api_mode?: string;
	default_model?: string;
	credential_ref?: string;
	cached_models?: string[];
	login_type?: string;
	model_catalog?: AIProviderModel[];
	disabled_models?: string[];
	enabled: boolean;
	builtin: boolean;
	accounts?: AIProviderAccount[];
};

export type AIHubStatus = {
	enabled: boolean;
	listen?: string;
	model_routes?: string[];
	api_key_masked?: string;
};

const staticIDs = new Set(llmProviders.map((provider) => provider.id));

// providersByID 可被后端注册表刷新；llmProviders 静态数组始终保持原样
// （llm-providers.test.ts 直接断言它的内容与 llmProviderDefinition 的回落行为）。
let providersByID = new Map(llmProviders.map((provider) => [provider.id, provider]));
let providerList: LLMProviderDefinition[] = [...llmProviders];

function normalizeAPIMode(value: string): LLMAPIMode {
	if (value === 'auto' || value === 'chat_completions' || value === 'anthropic_messages' || value === 'codex_responses') {
		return value;
	}
	// 后端的 responses / 空值 / 未知值一律按 Codex Responses 处理。
	return 'codex_responses';
}

function toDefinition(provider: AIProvider): LLMProviderDefinition {
	return {
		id: provider.id,
		label: provider.label || provider.id,
		baseURL: provider.base_url || '',
		defaultModel: provider.default_model || '',
		apiMode: normalizeAPIMode(provider.api_mode || ''),
	};
}

// registerLLMProviders 把 /api/v1/settings 返回的运行时注册表合并进下拉列表：
// 内置项只用后端的显示名覆盖（保留静态的 protocolBaseURLs 与默认地址），
// 用户自定义供应商追加到末尾。凭据明文永不进入前端。
export function registerLLMProviders(providers: AIProvider[]): void {
	const overrides = new Map<string, AIProvider>();
	const custom: AIProvider[] = [];
	for (const provider of providers || []) {
		if (!provider || !provider.id) continue;
		if (staticIDs.has(provider.id)) {
			overrides.set(provider.id, provider);
		} else {
			custom.push(provider);
		}
	}
	const mergedStatic = llmProviders.map((definition) => {
		const override = overrides.get(definition.id);
		return override ? { ...definition, label: override.label || definition.label } : definition;
	});
	const mergedCustom = custom.map(toDefinition);
	providerList = [...mergedStatic, ...mergedCustom];
	providersByID = new Map(providerList.map((provider) => [provider.id, provider]));
}

// llmProviderList 供设置页的「服务商」下拉使用：静态 10 家 + 运行时自定义项。
export function llmProviderList(): LLMProviderDefinition[] {
	return providerList;
}

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
