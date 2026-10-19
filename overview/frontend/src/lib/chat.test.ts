import { describe, expect, it } from 'vitest';
import { createChatConversation, chatModelKey, clearAgentSessionIDs, deriveChatTitle, parseStoredConversations, resumableAgentSessionID, storeableConversations, type ChatConversation } from './chat';

describe('AI chat history helpers', () => {
	it('restores saved reasoning while continuing to accept older messages', () => {
		const current = conversation('current', '2026-09-16T00:00:00.000Z');
		current.messages = [
			{ id: 'old', role: 'assistant', content: '旧回复', created_at: current.created_at },
			{ id: 'new', role: 'assistant', content: '新回复', reasoning: '已核对数据。', created_at: current.created_at },
		];
		const restored = parseStoredConversations(JSON.stringify(storeableConversations([current])));
		expect(restored[0].messages).toEqual(current.messages);
		expect(parseStoredConversations(JSON.stringify([{ ...current, messages: [{ ...current.messages[1], reasoning: {} }] }]))).toEqual([]);
	});

	it('derives a compact title from the first message', () => {
		expect(deriveChatTitle('  分析\n这套交易体系的核心拐点  ')).toBe('分析 这套交易体系的核心拐点');
		expect(Array.from(deriveChatTitle('这是一个超过二十四个字符并且应该被截断的会话标题测试内容')).length).toBeLessThanOrEqual(25);
	});

	it('ignores invalid stored data and sorts valid conversations', () => {
		const raw = JSON.stringify([
			conversation('old', '2026-08-01T00:00:00.000Z'),
			{ broken: true },
			conversation('new', '2026-08-02T00:00:00.000Z'),
		]);
		expect(parseStoredConversations(raw).map((item) => item.id)).toEqual(['new', 'old']);
		expect(parseStoredConversations('{')).toEqual([]);
	});

	it('limits local history to the newest thirty conversations', () => {
		const values = Array.from({ length: 35 }, (_, index) => conversation(String(index), `2026-08-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
		expect(storeableConversations(values)).toHaveLength(30);
	});

	it('clears Agent sessions after changing the global chat model without removing messages', () => {
		const current = conversation('current', '2026-08-07T00:00:00.000Z');
		current.agent_session_id = 'agent-old-model';
		current.analysis_id = 'saved-report';
		current.agent_model_key = 'old-model-key';
		current.messages = [{ id: 'message-1', role: 'user', content: '保留这条消息', created_at: current.created_at }];

		const [next] = clearAgentSessionIDs([current]);

		expect(next.agent_session_id).toBeUndefined();
		expect(next.agent_model_key).toBeUndefined();
		expect(next.messages).toEqual(current.messages);
		expect(next.analysis_id).toBe('saved-report');
		expect(parseStoredConversations(JSON.stringify([next]))[0].analysis_id).toBe('saved-report');
	});

	it('only resumes a Agent session created for the active model configuration', () => {
		const current = conversation('current', '2026-09-08T00:00:00.000Z');
		const deepSeekKey = chatModelKey({ provider: 'deepseek', base_url: 'https://api.deepseek.com/', model: 'deepseek-v4-flash', api_mode: 'codex_responses' }, 'deepseek-profile');
		const lunaKey = chatModelKey({ provider: 'custom', base_url: 'https://dutifly.com/sub2api/v1', model: 'gpt-5.6-luna', api_mode: 'codex_responses' }, 'luna-profile');
		current.agent_session_id = 'agent-luna-session';
		current.agent_model_key = lunaKey;

		expect(resumableAgentSessionID(current, deepSeekKey)).toBeUndefined();
		expect(resumableAgentSessionID(current, lunaKey)).toBe('agent-luna-session');
	});

	it('does not resume legacy sessions that have no model configuration marker', () => {
		const current = conversation('legacy', '2026-09-08T00:00:00.000Z');
		current.agent_session_id = 'agent-legacy-session';
		const modelKey = chatModelKey({ provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-v4-flash', api_mode: 'codex_responses' });

		expect(resumableAgentSessionID(current, modelKey)).toBeUndefined();
	});
});

function conversation(id: string, updatedAt: string): ChatConversation {
	return { id, title: id, messages: [], created_at: updatedAt, updated_at: updatedAt };
}

it('migrates legacy Hermes bindings and preserves history across runtime switches', () => {
  const config = { provider: 'openai', base_url: 'https://example.com/v1', model: 'test', api_mode: 'responses' };
  const legacyKey = JSON.stringify({ profile_id: '', ...config });
  const conversation = createChatConversation();
  conversation.messages = [{ id: 'm', role: 'user', content: 'existing history', created_at: conversation.created_at }];
  const [migrated] = parseStoredConversations(JSON.stringify([{ ...conversation, hermes_session_id: 'native-old', hermes_model_key: legacyKey }]));
  expect(resumableAgentSessionID(migrated, chatModelKey(config))).toBe('native-old');
  expect(resumableAgentSessionID(migrated, chatModelKey(config, '', 'codex'))).toBeUndefined();
  expect(migrated.messages[0].content).toBe('existing history');
  expect(migrated.hermes_session_id).toBeUndefined();
});
