import { useEffect, useMemo, useState } from 'react';
import { Database, KeyRound, LoaderCircle, Plus, RefreshCw, Save, Server, Trash2, ArrowUp, ArrowDown, Power } from 'lucide-react';
import { BackendConfig, requestJSON } from '../lib/backend';
import { AIProvider, AIProviderAccount, AIHubStatus, registerLLMProviders, llmProviderList } from '../lib/llm-providers';
import { SettingsSection } from './SettingsSection';

type Props = {
	config: BackendConfig | null;
	providers: AIProvider[];
	hub: AIHubStatus | null;
	onProvidersChanged: (providers: AIProvider[]) => void;
	disabled?: boolean;
};

type ProvidersResult = { data: { providers: AIProvider[]; credential_refs?: string[] } };
type CredentialRefsResult = { data: { credential_refs: string[] } };
type RefreshPlan = { provider_id: string; account_id: string; nickname: string; expires_at: number; due: boolean; refreshable: boolean };
type RefreshResult = { provider_id: string; account_id: string; ok: boolean; message?: string; expires_at?: number };
type PlansResult = { data: { plans: RefreshPlan[]; results?: RefreshResult[] } };
type UsageEntry = { key: string; provider: string; account: string; model: string; requests: number; errors: number; input_tokens: number; output_tokens: number };
type UsageResult = { data: { days: { date: string; entries: UsageEntry[] }[] } };

type ProviderDraft = {
	id: string;
	label: string;
	base_url: string;
	chat_path: string;
	responses_path: string;
	messages_path: string;
	models_path: string;
	refresh_url: string;
	auth_scheme: string;
	api_mode: string;
	default_model: string;
	credential_ref: string;
	cached_models: string;
	enabled: boolean;
};

type AccountDraft = {
	id: string;
	nickname: string;
	credential_ref: string;
	refreshable: boolean;
	enabled: boolean;
	expires_at: string;
};

const emptyProviderDraft = (): ProviderDraft => ({
	id: '', label: '', base_url: 'https://', chat_path: '/chat/completions', responses_path: '/responses',
	messages_path: '/v1/messages', models_path: '/models', refresh_url: '', auth_scheme: 'bearer',
	api_mode: 'chat_completions', default_model: '', credential_ref: '', cached_models: '', enabled: true,
});

const emptyAccountDraft = (): AccountDraft => ({ id: '', nickname: '', credential_ref: '', refreshable: false, enabled: true, expires_at: '' });

function toDraft(provider: AIProvider): ProviderDraft {
	return {
		id: provider.id,
		label: provider.label,
		base_url: provider.base_url,
		chat_path: provider.chat_path || '/chat/completions',
		responses_path: provider.responses_path || '/responses',
		messages_path: provider.messages_path || '/v1/messages',
		models_path: provider.models_path || '/models',
		refresh_url: provider.refresh_url || '',
		auth_scheme: provider.auth_scheme || 'bearer',
		api_mode: provider.api_mode || 'chat_completions',
		default_model: provider.default_model || '',
		credential_ref: provider.credential_ref || '',
		cached_models: (provider.cached_models || []).join(', '),
		enabled: provider.enabled,
	};
}

function providerPayload(draft: ProviderDraft) {
	const models = draft.cached_models.split(',').map((value) => value.trim()).filter(Boolean);
	return {
		id: draft.id.trim().toLowerCase(),
		label: draft.label.trim(),
		base_url: draft.base_url.trim(),
		chat_path: draft.chat_path.trim(),
		responses_path: draft.responses_path.trim(),
		messages_path: draft.messages_path.trim(),
		models_path: draft.models_path.trim(),
		refresh_url: draft.refresh_url.trim(),
		auth_scheme: draft.auth_scheme,
		api_mode: draft.api_mode,
		default_model: draft.default_model.trim(),
		credential_ref: draft.credential_ref.trim(),
		cached_models: models,
		enabled: draft.enabled,
	};
}

function accountPayload(draft: AccountDraft): AIProviderAccount {
	const expires = draft.expires_at ? new Date(draft.expires_at).getTime() : 0;
	return {
		id: draft.id.trim(),
		nickname: draft.nickname.trim(),
		credential_ref: draft.credential_ref.trim(),
		refreshable: draft.refreshable,
		enabled: draft.enabled,
		created_at: 0,
		...(Number.isFinite(expires) && expires > 0 ? { expires_at: expires } : {}),
	};
}

function formatExpiry(value?: number): string {
	if (!value) return '未设置';
	return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function AIProviderRegistryPanel({ config, providers, hub, onProvidersChanged, disabled }: Props) {
	const [items, setItems] = useState<AIProvider[]>(providers);
	const [credentialRefs, setCredentialRefs] = useState<string[]>([]);
	const [selectedID, setSelectedID] = useState('');
	const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProviderDraft());
	const [editing, setEditing] = useState(false);
	const [accountDraft, setAccountDraft] = useState<AccountDraft>(emptyAccountDraft());
	const [credentialRef, setCredentialRef] = useState('');
	const [credentialSecret, setCredentialSecret] = useState('');
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	const [error, setError] = useState('');
	const [plans, setPlans] = useState<RefreshPlan[]>([]);
	const [refreshResults, setRefreshResults] = useState<RefreshResult[]>([]);
	const [usage, setUsage] = useState<UsageResult['data']['days']>([]);

	useEffect(() => { setItems(providers); }, [providers]);

	const selected = useMemo(() => items.find((item) => item.id === selectedID), [items, selectedID]);
	const customProviders = useMemo(() => items.filter((item) => !item.builtin), [items]);

	const applyProviders = (next: AIProvider[]) => {
		setItems(next);
		registerLLMProviders(next);
		onProvidersChanged(next);
	};

	const run = async (task: () => Promise<void>) => {
		if (!config || busy || disabled) return;
		setBusy(true);
		setError('');
		setMessage('');
		try {
			await task();
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : '操作失败');
		} finally {
			setBusy(false);
		}
	};

	const loadProviders = () => run(async () => {
		const payload = await requestJSON<ProvidersResult>(config!, '/api/v1/settings/llm/providers');
		applyProviders(payload.data.providers || []);
		setCredentialRefs(payload.data.credential_refs || []);
		const plansPayload = await requestJSON<PlansResult>(config!, '/api/v1/settings/llm/providers/refresh');
		setPlans(plansPayload.data.plans || []);
		setMessage('供应商注册表与续期计划已刷新');
	});

	const saveProvider = () => run(async () => {
		if (!providerDraft.id.trim()) { setError('请填写供应商 ID'); return; }
		const payload = await requestJSON<{ data: { providers: AIProvider[] } }>(config!, '/api/v1/settings/llm/providers', {
			method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(providerPayload(providerDraft)),
		});
		applyProviders(payload.data.providers || []);
		setSelectedID(providerDraft.id.trim().toLowerCase());
		setEditing(false);
		setMessage(`供应商 ${providerDraft.label} 已保存`);
	});

	const deleteProvider = (id: string) => run(async () => {
		const payload = await requestJSON<{ data: { providers: AIProvider[] } }>(config!, '/api/v1/settings/llm/providers', {
			method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
		});
		applyProviders(payload.data.providers || []);
		if (selectedID === id) { setSelectedID(''); setProviderDraft(emptyProviderDraft()); }
		setMessage(`供应商 ${id} 已删除`);
	});

	const toggleProvider = (provider: AIProvider) => run(async () => {
		const payload = await requestJSON<{ data: { providers: AIProvider[] } }>(config!, '/api/v1/settings/llm/providers', {
			method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(providerPayload(toDraft({ ...provider, enabled: !provider.enabled }))),
		});
		applyProviders(payload.data.providers || []);
		setMessage(`${provider.label} 已${provider.enabled ? '停用' : '启用'}`);
	});

	const accountAction = (action: 'upsert' | 'delete' | 'move' | 'toggle', account: AIProviderAccount, delta = 0) => run(async () => {
		if (!selectedID) { setError('请先选择一个供应商'); return; }
		const payload = await requestJSON<{ data: { providers: AIProvider[] } }>(config!, '/api/v1/settings/llm/providers/account', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider_id: selectedID, action, account, delta }),
		});
		applyProviders(payload.data.providers || []);
		if (action === 'upsert') setAccountDraft(emptyAccountDraft());
		setMessage('账号池已更新（数组顺序即选号优先级）');
	});

	const writeCredential = (clear: boolean) => run(async () => {
		if (!credentialRef.trim()) { setError('请填写凭据引用名'); return; }
		const payload = await requestJSON<CredentialRefsResult>(config!, '/api/v1/settings/llm/providers/credential', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ credential_ref: credentialRef.trim(), secret: clear ? '' : credentialSecret, clear }),
		});
		setCredentialRefs(payload.data.credential_refs || []);
		setCredentialSecret('');
		setMessage(clear ? `凭据 ${credentialRef.trim()} 已删除` : `凭据 ${credentialRef.trim()} 已写入独立凭据库`);
	});

	const refreshDue = () => run(async () => {
		const payload = await requestJSON<PlansResult>(config!, '/api/v1/settings/llm/providers/refresh', { method: 'POST' });
		setPlans(payload.data.plans || []);
		setRefreshResults(payload.data.results || []);
		setMessage('已进入提前续期窗口的账号处理完毕');
	});

	const loadUsage = () => run(async () => {
		const payload = await requestJSON<UsageResult>(config!, '/api/v1/settings/llm/providers/usage');
		setUsage(payload.data.days || []);
		setMessage('用量账本已刷新');
	});

	const beginEdit = (provider: AIProvider) => {
		setSelectedID(provider.id);
		setProviderDraft(toDraft(provider));
		setEditing(true);
		setAccountDraft(emptyAccountDraft());
	};

	const beginCreate = () => {
		setProviderDraft(emptyProviderDraft());
		setEditing(true);
		setSelectedID('');
	};

	return (
		<SettingsSection
			title="AI 供应商注册表与订阅账号池"
			description="运行时自定义供应商、按账号顺序选号、429 自动换号、提前 1 小时续期；凭据单独存 0600 文件，明文不出现在任何列表里。本机网关把 provider/model 反代到注册表里的真实地址。"
			icon={<Server size={18} />}
		>
			<div className="ai-registry-toolbar">
				<button type="button" onClick={() => void loadProviders()} disabled={!config || busy || disabled}><RefreshCw size={14} />刷新注册表</button>
				<button type="button" onClick={beginCreate} disabled={busy || disabled}><Plus size={14} />新增供应商</button>
				<button type="button" onClick={() => void loadUsage()} disabled={!config || busy || disabled}><Database size={14} />用量账本</button>
				<button type="button" onClick={() => void refreshDue()} disabled={!config || busy || disabled}><RefreshCw size={14} />立即续期</button>
			</div>

			{hub && (
				<div className={`llm-connection-test ${hub.enabled ? 'success' : ''}`}>
					<div><Server size={17} /><span><strong>本机 OpenAI 兼容网关 · {hub.enabled ? '已启动' : '未启用'}</strong><small>
						{hub.listen ? `监听 ${hub.listen}（仅回环）` : '监听地址未配置'} · Key {hub.api_key_masked || '未生成'} · 模型路由 {hub.model_routes?.length || 0} 条。
						第三方把 baseURL 填 http://{hub.listen || '127.0.0.1:8327'}/v1，model 填 provider/model 即可走账号池选号。
					</small></span></div>
				</div>
			)}

			<div className="ai-registry-list">
				{llmProviderList().map((definition) => {
					const record = items.find((item) => item.id === definition.id);
					const builtin = record?.builtin ?? true;
					return (
						<div className={`ai-registry-row ${selectedID === definition.id ? 'active' : ''}`} key={definition.id}>
							<button type="button" className="ai-registry-name" onClick={() => record && beginEdit(record)}>
								<strong>{definition.label}</strong><small>{definition.id} · {record?.accounts?.length || 0} 个账号 · {record?.enabled === false ? '已停用' : '启用'}</small>
							</button>
							{record && <button type="button" title={record.enabled ? '停用' : '启用'} onClick={() => void toggleProvider(record)} disabled={busy || disabled}><Power size={14} /></button>}
							{!builtin && record && <button type="button" className="danger" title="删除自定义供应商" onClick={() => void deleteProvider(record.id)} disabled={busy || disabled}><Trash2 size={14} /></button>}
						</div>
					);
				})}
				{customProviders.length === 0 && <div className="review-profile-empty"><strong>还没有自定义供应商</strong><span>内置 10 家可直接停用或改地址；点击「新增供应商」接入订阅制渠道。</span></div>}
			</div>

			{editing && (
				<div className="ai-registry-editor">
					<strong>{providerDraft.id ? `编辑 ${providerDraft.id}` : '新增自定义供应商'}</strong>
					<div className="settings-grid two-columns">
						<label><span>供应商 ID</span><input value={providerDraft.id} onChange={(event) => setProviderDraft({ ...providerDraft, id: event.target.value })} placeholder="例如 qiniu / codearts" disabled={!!providerDraft.id} /></label>
						<label><span>显示名称</span><input value={providerDraft.label} onChange={(event) => setProviderDraft({ ...providerDraft, label: event.target.value })} placeholder="例如 七牛云" /></label>
						<label><span>API Base URL</span><input value={providerDraft.base_url} onChange={(event) => setProviderDraft({ ...providerDraft, base_url: event.target.value })} placeholder="https://api.example.com/v1" /></label>
						<label><span>鉴权方式</span><select value={providerDraft.auth_scheme} onChange={(event) => setProviderDraft({ ...providerDraft, auth_scheme: event.target.value })}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key（Anthropic）</option><option value="none">无鉴权</option></select></label>
						<label><span>接口协议</span><select value={providerDraft.api_mode} onChange={(event) => setProviderDraft({ ...providerDraft, api_mode: event.target.value })}><option value="chat_completions">Chat Completions</option><option value="codex_responses">Responses</option><option value="anthropic_messages">Anthropic Messages</option><option value="auto">自动检测</option></select></label>
						<label><span>模型列表路径</span><input value={providerDraft.models_path} onChange={(event) => setProviderDraft({ ...providerDraft, models_path: event.target.value })} placeholder="/models" /></label>
						<label><span>Chat 路径</span><input value={providerDraft.chat_path} onChange={(event) => setProviderDraft({ ...providerDraft, chat_path: event.target.value })} /></label>
						<label><span>Responses 路径</span><input value={providerDraft.responses_path} onChange={(event) => setProviderDraft({ ...providerDraft, responses_path: event.target.value })} /></label>
						<label><span>Messages 路径</span><input value={providerDraft.messages_path} onChange={(event) => setProviderDraft({ ...providerDraft, messages_path: event.target.value })} /></label>
						<label><span>刷新地址（可选）</span><input value={providerDraft.refresh_url} onChange={(event) => setProviderDraft({ ...providerDraft, refresh_url: event.target.value })} placeholder="订阅续期端点" /></label>
						<label><span>默认模型</span><input value={providerDraft.default_model} onChange={(event) => setProviderDraft({ ...providerDraft, default_model: event.target.value })} placeholder="例如 deepseek-v3" /></label>
						<label><span>可用模型（逗号分隔，供网关 /v1/models）</span><input value={providerDraft.cached_models} onChange={(event) => setProviderDraft({ ...providerDraft, cached_models: event.target.value })} placeholder="deepseek-v3, qwen-plus" /></label>
						<label><span>单 Key 凭据引用（账号池为空时兜底）</span><input value={providerDraft.credential_ref} onChange={(event) => setProviderDraft({ ...providerDraft, credential_ref: event.target.value })} placeholder="MY_PROVIDER_KEY" list="ai-credential-refs" /></label>
					</div>
					<label className="ai-registry-check"><input type="checkbox" checked={providerDraft.enabled} onChange={(event) => setProviderDraft({ ...providerDraft, enabled: event.target.checked })} /><span>启用该供应商</span></label>
					<div className="ai-registry-toolbar">
						<button type="button" onClick={() => void saveProvider()} disabled={busy || disabled}><Save size={14} />保存供应商</button>
						<button type="button" onClick={() => { setEditing(false); setProviderDraft(emptyProviderDraft()); }}>取消</button>
					</div>
				</div>
			)}

			{selected && (
				<div className="ai-registry-editor">
					<strong>订阅账号池 · {selected.label}</strong>
					<small>数组顺序即选号优先级；429 会写模型级限流并自动换下一个账号，401/403 换号但不写限流。</small>
					{(selected.accounts || []).map((account, index) => (
						<div className="ai-registry-account" key={account.id}>
							<span><strong>{account.nickname || account.id}</strong><small>{account.credential_ref} · {account.enabled ? '启用' : '停用'} · 到期 {formatExpiry(account.expires_at)} · {account.refreshable ? '可续期' : '纯 Key'}</small></span>
							<button type="button" title="上移（提高优先级）" onClick={() => void accountAction('move', account, -1)} disabled={index === 0 || busy || disabled}><ArrowUp size={13} /></button>
							<button type="button" title="下移" onClick={() => void accountAction('move', account, 1)} disabled={index === (selected.accounts?.length || 0) - 1 || busy || disabled}><ArrowDown size={13} /></button>
							<button type="button" title={account.enabled ? '停用' : '启用'} onClick={() => void accountAction('toggle', { ...account, enabled: !account.enabled })} disabled={busy || disabled}><Power size={13} /></button>
							<button type="button" className="danger" title="删除账号" onClick={() => void accountAction('delete', account)} disabled={busy || disabled}><Trash2 size={13} /></button>
						</div>
					))}
					{!(selected.accounts || []).length && <div className="review-profile-empty"><span>暂无账号；可新增订阅账号，或直接用「单 Key 凭据引用」。</span></div>}
					<div className="settings-grid two-columns">
						<label><span>账号 ID</span><input value={accountDraft.id} onChange={(event) => setAccountDraft({ ...accountDraft, id: event.target.value })} placeholder="acc-1" /></label>
						<label><span>昵称</span><input value={accountDraft.nickname} onChange={(event) => setAccountDraft({ ...accountDraft, nickname: event.target.value })} placeholder="主号 / 备用号" /></label>
						<label><span>凭据引用名</span><input value={accountDraft.credential_ref} onChange={(event) => setAccountDraft({ ...accountDraft, credential_ref: event.target.value })} placeholder="ACC_1" list="ai-credential-refs" /></label>
						<label><span>到期时间（可选）</span><input type="datetime-local" value={accountDraft.expires_at} onChange={(event) => setAccountDraft({ ...accountDraft, expires_at: event.target.value })} /></label>
					</div>
					<div className="ai-registry-checks">
						<label className="ai-registry-check"><input type="checkbox" checked={accountDraft.enabled} onChange={(event) => setAccountDraft({ ...accountDraft, enabled: event.target.checked })} /><span>启用</span></label>
						<label className="ai-registry-check"><input type="checkbox" checked={accountDraft.refreshable} onChange={(event) => setAccountDraft({ ...accountDraft, refreshable: event.target.checked })} /><span>可自动续期</span></label>
					</div>
					<button type="button" onClick={() => void accountAction('upsert', accountPayload(accountDraft))} disabled={!accountDraft.id.trim() || !accountDraft.credential_ref.trim() || busy || disabled}><Plus size={14} />添加 / 更新账号</button>
				</div>
			)}

			<div className="ai-registry-editor">
				<strong>凭据库（独立 0600 文件）</strong>
				<small>引用名只是间接指针，明文 token / API Key 只在这一次请求里出现，列表接口永不返回。</small>
				<datalist id="ai-credential-refs">{credentialRefs.map((ref) => <option value={ref} key={ref} />)}</datalist>
				<div className="settings-grid two-columns">
					<label><span>凭据引用名</span><input value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} placeholder="MY_PROVIDER_KEY" list="ai-credential-refs" /></label>
					<label><span>明文 secret / JSON 订阅凭据</span><input type="password" value={credentialSecret} onChange={(event) => setCredentialSecret(event.target.value)} placeholder="sk-... 或含 refresh_token 的 JSON" /></label>
				</div>
				<div className="ai-registry-toolbar">
					<button type="button" onClick={() => void writeCredential(false)} disabled={!credentialSecret || busy || disabled}><KeyRound size={14} />写入凭据</button>
					<button type="button" className="danger" onClick={() => void writeCredential(true)} disabled={busy || disabled}><Trash2 size={14} />清除凭据</button>
					{credentialRefs.length > 0 && <small>已配置：{credentialRefs.join('、')}</small>}
				</div>
			</div>

			{(plans.length > 0 || refreshResults.length > 0 || usage.length > 0) && (
				<div className="ai-registry-editor">
					<strong>续期计划与用量</strong>
					{refreshResults.map((result) => <small key={`${result.provider_id}-${result.account_id}`}>{result.provider_id}/{result.account_id} · {result.ok ? '续期成功' : '失败'} · {result.message || ''}</small>)}
					{plans.filter((plan) => plan.refreshable).map((plan) => <small key={`${plan.provider_id}-${plan.account_id}`}>{plan.provider_id}/{plan.nickname || plan.account_id} · {plan.due ? '已进入提前续期窗口' : '未到期'} · 到期 {formatExpiry(plan.expires_at)}</small>)}
					{usage.map((day) => day.entries.map((entry) => <small key={`${day.date}-${entry.key}`}>{day.date} · {entry.provider}/{entry.account}/{entry.model} · 请求 {entry.requests} · 错误 {entry.errors} · 入 {entry.input_tokens} / 出 {entry.output_tokens}</small>))}
				</div>
			)}

			{(message || error) && <div className={`llm-connection-test ${error ? 'error' : 'success'}`}><div>{busy ? <LoaderCircle className="spin" size={17} /> : <KeyRound size={17} />}<span><strong>{error ? '操作失败' : '操作完成'}</strong><small>{error || message}</small></span></div></div>}
		</SettingsSection>
	);
}
