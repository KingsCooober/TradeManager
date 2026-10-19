export type ChatRole = 'user' | 'assistant';

export type ChatMessage = {
	id: string;
	role: ChatRole;
	content: string;
	reasoning?: string;
	created_at: string;
	error?: boolean;
};

export type ChatConversation = {
	analysis_id?: string;
	id: string;
	title: string;
	agent_session_id?: string;
	hermes_session_id?: string;
	hermes_model_key?: string;
	agent_model_key?: string;
	messages: ChatMessage[];
	created_at: string;
	updated_at: string;
};

export type ChatModelConfig = {
	provider: string;
	base_url: string;
	model: string;
	api_mode: string;
};

const MAX_STORED_CONVERSATIONS = 30;
const MAX_STORED_MESSAGES = 100;

export function createChatID(prefix = 'chat') {
	const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return `${prefix}-${random}`;
}

export function createChatConversation(now = new Date().toISOString()): ChatConversation {
	return {
		id: createChatID('conversation'),
		title: '新对话',
		messages: [],
		created_at: now,
		updated_at: now,
	};
}

export function deriveChatTitle(content: string) {
	const normalized = content.replace(/\s+/g, ' ').trim();
	if (!normalized) return '新对话';
	const runes = Array.from(normalized);
	return runes.length > 24 ? `${runes.slice(0, 24).join('')}…` : normalized;
}

export function parseStoredConversations(raw: string | null): ChatConversation[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(isConversation)
			.map((conversation) => {
                const { hermes_session_id, hermes_model_key, ...current } = conversation;
                let legacyKey: string | undefined;
                if (hermes_model_key) {
                    try { legacyKey = JSON.stringify({ ...JSON.parse(hermes_model_key), runtime: 'hermes' }); } catch { /* Unrecognized bindings are reseeded from visible history. */ }
                }
                return { ...current, agent_session_id: current.agent_session_id || hermes_session_id,
                    agent_model_key: current.agent_model_key || legacyKey,
                    messages: current.messages.slice(-MAX_STORED_MESSAGES) };
            })
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
			.slice(0, MAX_STORED_CONVERSATIONS);
	} catch {
		return [];
	}
}

export function storeableConversations(conversations: ChatConversation[]) {
	return conversations
		.map((conversation) => ({ ...conversation, messages: conversation.messages.slice(-MAX_STORED_MESSAGES) }))
		.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
		.slice(0, MAX_STORED_CONVERSATIONS);
}

export function chatModelKey(config: ChatModelConfig, profileID = '', runtime = 'hermes') {
	return JSON.stringify({
		profile_id: profileID.trim(),
		runtime,
		provider: config.provider.trim().toLowerCase(),
		base_url: config.base_url.trim().replace(/\/+$/, ''),
		model: config.model.trim(),
		api_mode: config.api_mode.trim().toLowerCase(),
	});
}

export function resumableAgentSessionID(conversation: ChatConversation, modelKey: string) {
	try {
        const previous = JSON.parse(conversation.agent_model_key || '{}');
        const current = JSON.parse(modelKey);
        return Object.keys(current).every((key) => previous[key] === current[key]) ? conversation.agent_session_id : undefined;
    } catch { return undefined; }
}

export function clearAgentSessionIDs(conversations: ChatConversation[]): ChatConversation[] {
	return conversations.map((conversation) => {
		if (!conversation.agent_session_id && !conversation.agent_model_key) return conversation;
		const { agent_session_id: _agentSessionID, agent_model_key: _agentModelKey, ...next } = conversation;
		return next;
	});
}

function isConversation(value: unknown): value is ChatConversation {
	if (!value || typeof value !== 'object') return false;
	const item = value as Partial<ChatConversation>;
	return typeof item.id === 'string'
		&& (item.analysis_id === undefined || typeof item.analysis_id === 'string')
		&& typeof item.title === 'string'
		&& typeof item.created_at === 'string'
		&& typeof item.updated_at === 'string'
		&& (item.agent_session_id === undefined || typeof item.agent_session_id === 'string')
		&& (item.agent_model_key === undefined || typeof item.agent_model_key === 'string')
		&& Array.isArray(item.messages)
		&& item.messages.every(isMessage);
}

function isMessage(value: unknown): value is ChatMessage {
	if (!value || typeof value !== 'object') return false;
	const item = value as Partial<ChatMessage>;
	return typeof item.id === 'string'
		&& (item.role === 'user' || item.role === 'assistant')
		&& typeof item.content === 'string'
		&& (item.reasoning === undefined || typeof item.reasoning === 'string')
		&& typeof item.created_at === 'string'
		&& (item.error === undefined || typeof item.error === 'boolean');
}
