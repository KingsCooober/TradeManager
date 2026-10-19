import { describe, expect, it } from 'vitest';
import { llmBaseURLForAPIMode, llmProviderDefaultModel, llmProviderDefinition, llmProviderName, llmProviders } from './llm-providers';

describe('LLM provider definitions', () => {
	it('includes the supported Chinese model providers', () => {
		expect(llmProviders.map((provider) => provider.id)).toEqual(expect.arrayContaining(['moonshot', 'minimax', 'zhipu', 'qwen', 'siliconflow']));
		expect(llmProviderName('moonshot')).toContain('Kimi');
		expect(llmProviderName('zhipu')).toContain('GLM');
	});

	it('provides model-discovery defaults for provider switching', () => {
		expect(llmProviderDefinition('minimax')).toMatchObject({ baseURL: 'https://api.minimaxi.com/v1', apiMode: 'codex_responses' });
		expect(llmProviderDefinition('zhipu')).toMatchObject({ baseURL: 'https://open.bigmodel.cn/api/v1', defaultModel: 'glm-5.3-flash', apiMode: 'codex_responses' });
		expect(llmProviderDefinition('openai').apiMode).toBe('codex_responses');
		expect(llmProviderDefinition('custom').apiMode).toBe('codex_responses');
		expect(llmProviderDefinition('anthropic').apiMode).toBe('anthropic_messages');
		expect(llmProviderDefaultModel('deepseek')).toBe('deepseek-v4-pro');
	});

	it('falls back to custom settings for unknown providers', () => {
		expect(llmProviderDefinition('unknown')).toMatchObject({ id: 'custom', baseURL: '', defaultModel: '' });
	});
});

describe('protocol URL switching', () => {
	const responses = 'https://open.bigmodel.cn/api/v1';
	const chat = 'https://open.bigmodel.cn/api/paas/v4';
	const messages = 'https://open.bigmodel.cn/api/anthropic';

	it('switches GLM official URLs in both directions, including an already mismatched form', () => {
		expect(llmBaseURLForAPIMode('zhipu', responses, 'chat_completions')).toBe(chat);
		expect(llmBaseURLForAPIMode('zhipu', chat, 'codex_responses')).toBe(responses);
		expect(llmBaseURLForAPIMode('zhipu', responses, 'anthropic_messages')).toBe(messages);
		expect(llmBaseURLForAPIMode('zhipu', messages, 'codex_responses')).toBe(responses);
		expect(llmBaseURLForAPIMode('zhipu', ` ${chat}/ `, 'responses')).toBe(responses);
		expect(llmBaseURLForAPIMode('zhipu', chat, 'auto')).toBe(responses);
		expect(llmBaseURLForAPIMode('zhipu', '', 'chat_completions')).toBe(chat);
	});

	it.each([
		'https://proxy.example/api/v1',
		'https://open.bigmodel.cn.proxy.example/api/v1',
		'https://open.bigmodel.cn:8443/api/v1',
		'https://open.bigmodel.cn/api/v1?tenant=mine',
		'https://open.bigmodel.cn/api/v1/tenant',
		'https://open.bigmodel.cn/api/coding/paas/v4',
		'http://localhost:8080/v1',
	])('preserves the explicitly configured endpoint %s', (url) => {
		for (const mode of ['chat_completions', 'codex_responses', 'anthropic_messages', 'auto']) {
			expect(llmBaseURLForAPIMode('zhipu', url, mode)).toBe(url);
		}
	});

	it('keeps shared base URLs and does not infer mappings for custom providers', () => {
		for (const mode of ['codex_responses', 'chat_completions']) {
			expect(llmBaseURLForAPIMode('openai', 'https://api.openai.com/v1', mode)).toBe('https://api.openai.com/v1');
			expect(llmBaseURLForAPIMode('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', mode)).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
			expect(llmBaseURLForAPIMode('custom', chat, mode)).toBe(chat);
		}
	});
});
