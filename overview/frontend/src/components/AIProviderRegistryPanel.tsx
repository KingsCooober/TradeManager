import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, KeyRound, LoaderCircle, Plus, RefreshCw, Save, Server, Trash2, ArrowUp, ArrowDown, Power, LogIn, ExternalLink, CheckCircle2, CircleAlert, X } from 'lucide-react';
import { BackendConfig, requestJSON } from '../lib/backend';
import { AIProvider, AIProviderAccount, AIProviderModel, AIHubStatus, registerLLMProviders } from '../lib/llm-providers';
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

// 登录与模型：对齐 Jet Hub 的 account.create / login.poll / model.list 契约。
type LoginStart = { data: { accountId: string; loginUrl: string; incognitoOpened: boolean; callbackPort: number; mode?: string; callbackUrl?: string } };
type LoginPoll = { data: { done: boolean; success: boolean; error?: string } };

// 远程登录统一用新式 OAuth（portal authorize）。回调 host 被华为云硬编码成 127.0.0.1，
// 公网部署下浏览器跳的是访客本机——这没关系：用户在新窗口完成授权后，地址栏里会显示
// http://127.0.0.1:PORT/oauth/callback?code=XXX（页面打不开但 URL 里有 code），
// 复制该完整 URL 粘贴回来即可。服务器用 code 向 STS 换 AK/SK，全程不依赖外部 callback 可达。
// 本机访问时 loopback 自动回调成功，无需手动粘贴。
type ModelsData = { models: AIProviderModel[]; enabled: string[] };
type ModelsResult = { data: ModelsData; complete?: boolean };

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

const CODEARTS = 'codearts';
const LOGIN_TYPE = 'codearts_oauth';
const POLL_INTERVAL_MS = 1000;
const POLL_DEADLINE_MS = 5 * 60 * 1000;

// 模块级全局 poll timer：不随组件卸载而中断。SettingsDrawer 关闭/重渲染时面板会卸载，
// 但登录会话仍在服务器后台等待回调，poll 必须持续运行直到成功/超时/手动取消。
let globalPollTimer: number | null = null;
let globalPollConfig: BackendConfig | null = null;
let globalPollAccountID = '';
let globalPollDeadline = 0;
let globalPollOnDone: (() => void) | null = null;
let globalPollOnError: ((msg: string) => void) | null = null;

function stopGlobalPoll() {
	if (globalPollTimer !== null) { window.clearInterval(globalPollTimer); globalPollTimer = null; }
	globalPollAccountID = '';
}

function startGlobalPoll(config: BackendConfig, accountId: string, onDone: () => void, onError: (msg: string) => void) {
	stopGlobalPoll();
	globalPollConfig = config;
	globalPollAccountID = accountId;
	globalPollDeadline = Date.now() + POLL_DEADLINE_MS;
	globalPollOnDone = onDone;
	globalPollOnError = onError;
	globalPollTimer = window.setInterval(async () => {
		if (!globalPollConfig || !globalPollAccountID) { stopGlobalPoll(); return; }
		try {
			const poll = await requestJSON<LoginPoll>(globalPollConfig, `/api/v1/settings/llm/login/poll?accountId=${encodeURIComponent(globalPollAccountID)}`);
			if (poll.data.success === false) {
				stopGlobalPoll();
				globalPollOnError?.(poll.data.error || '登录失败，请重试');
				return;
			}
			if (poll.data.done) {
				stopGlobalPoll();
				globalPollOnDone?.();
				return;
			}
			if (Date.now() > globalPollDeadline) {
				stopGlobalPoll();
				globalPollOnError?.('登录超时（已等待 5 分钟）。请重新点击「登录账号」再试。');
			}
		} catch {
			// 偶发网络错误不终止，累计到 deadline 才超时
		}
	}, POLL_INTERVAL_MS);
}

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

	// 登录会话状态：与 Jet Hub 一致，先返回链接再后台轮询凭据是否落库。
	const [loginOpen, setLoginOpen] = useState(false);
	const [loginURL, setLoginURL] = useState('');
	const [loginAccountID, setLoginAccountID] = useState('');
	const [loginStatus, setLoginStatus] = useState<'idle' | 'waiting' | 'success' | 'error'>('idle');
	const [loginNote, setLoginNote] = useState('');
	const [manualCode, setManualCode] = useState('');

	// 模型目录：黑名单制，只有被关掉的模型才会隐藏，服务端新增模型默认显示。
	const [models, setModels] = useState<AIProviderModel[]>([]);
	const [enabledModels, setEnabledModels] = useState<string[]>([]);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelBusyID, setModelBusyID] = useState('');
	const [modelFilter, setModelFilter] = useState('');

	useEffect(() => { setItems(providers); }, [providers]);

	useEffect(() => {
		if (!selectedID && items.length > 0) setSelectedID(items[0].id);
	}, [items, selectedID]);

	useEffect(() => {
		// 组件挂载时恢复全局 poll 状态（如果之前有正在进行的登录会话）
		if (globalPollAccountID && globalPollConfig) {
			setLoginOpen(true);
			setLoginAccountID(globalPollAccountID);
			setLoginStatus('waiting');
			setLoginNote('登录会话仍在进行中，正在等待授权回调…');
		}
	}, []);

	const selected = useMemo(() => items.find((item) => item.id === selectedID), [items, selectedID]);
	const customProviders = useMemo(() => items.filter((item) => !item.builtin), [items]);
	const isLoginProvider = selected?.login_type === LOGIN_TYPE;

	const shownModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		return q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
	}, [models, modelFilter]);

	const applyProviders = (next: AIProvider[]) => {
		setItems(next);
		registerLLMProviders(next);
		onProvidersChanged(next);
	};

	const applyModels = (data: ModelsData) => {
		setModels(data.models || []);
		setEnabledModels(data.enabled || []);
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

	const loadModels = (providerID: string) => run(async () => {
		setModelsLoading(true);
		try {
			const payload = await requestJSON<ModelsResult>(config!, `/api/v1/settings/llm/models?provider=${encodeURIComponent(providerID)}`);
			applyModels(payload.data);
		} finally {
			setModelsLoading(false);
		}
	});

	const refreshModels = () => run(async () => {
		setModelsLoading(true);
		try {
			const payload = await requestJSON<ModelsResult>(config!, '/api/v1/settings/llm/models/refresh', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: selectedID }),
			});
			applyModels(payload.data);
			setMessage(payload.complete === false ? '已读取缓存目录（远端目录暂不可用）' : '私有模型目录已刷新');
		} finally {
			setModelsLoading(false);
		}
	});

	const toggleModel = (model: AIProviderModel) => run(async () => {
		setModelBusyID(model.id);
		try {
			const payload = await requestJSON<ModelsResult>(config!, '/api/v1/settings/llm/models/disabled', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ provider: selectedID, modelId: model.id, disabled: !model.disabled }),
			});
			applyModels(payload.data);
		} finally {
			setModelBusyID('');
		}
	});

	const setAllModels = (disabledAll: boolean) => run(async () => {
		const payload = await requestJSON<ModelsResult>(config!, '/api/v1/settings/llm/models/all', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider: selectedID, disabled: disabledAll }),
		});
		applyModels(payload.data);
		setMessage(disabledAll ? '已关闭全部模型' : '已启用全部模型');
	});

	const stopPoll = () => {
		stopGlobalPoll();
	};

	const startLogin = () => run(async () => {
		const payload = await requestJSON<LoginStart>(config!, '/api/v1/settings/llm/login/start', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: selectedID || CODEARTS }),
		});
		const { accountId, loginUrl } = payload.data;
		setLoginOpen(true);
		setLoginURL(loginUrl);
		setLoginAccountID(accountId);
		setLoginStatus('waiting');
		setLoginNote('已打开华为云授权页。请在新窗口完成登录；若页面跳转到 127.0.0.1 打不开，复制地址栏里的完整链接粘贴到下方提交。');
		setManualCode('');
		const opened = window.open(loginUrl, '_blank', 'width=800,height=600');
		if (!opened) setLoginNote('登录窗口被浏览器拦截，请手动打开下方链接完成登录。');
		stopPoll();
		startGlobalPoll(config!, accountId, async () => {
			setLoginStatus('success');
			setLoginNote('登录成功，账号已写入凭据库，模型目录同步完成。');
			try {
				const refreshed = await requestJSON<ProvidersResult>(config!, '/api/v1/settings/llm/providers');
				applyProviders(refreshed.data.providers || []);
				const modelsPayload = await requestJSON<ModelsResult>(config!, `/api/v1/settings/llm/models?provider=${encodeURIComponent(selectedID || CODEARTS)}`);
				applyModels(modelsPayload.data);
			} catch { /* best-effort refresh */ }
		}, (msg) => {
			setLoginStatus('error');
			setLoginNote(msg);
		});
	});

	const submitManualCode = () => run(async () => {
		if (!manualCode.trim()) { setError('请粘贴授权完成后浏览器地址栏里的完整链接（含 code 或 secret 参数）'); return; }
		await requestJSON(config!, '/api/v1/settings/llm/login/code', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ accountId: loginAccountID, code: manualCode.trim() }),
		});
		setManualCode('');
		setLoginNote('已把授权结果交给服务器，继续等待凭据落库…');
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

	const selectProvider = (id: string) => {
		setSelectedID(id);
		setEditing(false);
		setModels([]);
		setEnabledModels([]);
		if (config) void loadModels(id);
	};

	return (
		<SettingsSection
			title="AI 供应商与订阅账号"
			description="内置 CodeArts 订阅渠道：点「登录账号」完成授权后自动建号、拉取私有模型目录；勾选要使用的模型，第三方通过本机网关按 provider/model 调用。凭据单独存 0600 文件，明文不出现在任何列表里。"
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
				{items.map((record) => (
					<div className={`ai-registry-row ${selectedID === record.id ? 'active' : ''}`} key={record.id}>
						<button type="button" className="ai-registry-name" onClick={() => selectProvider(record.id)}>
							<strong>{record.label || record.id}</strong><small>{record.id} · {record.accounts?.length || 0} 个账号 · {record.enabled === false ? '已停用' : '启用'}{record.login_type ? ' · 登录型' : ''}</small>
						</button>
						<button type="button" title={record.enabled ? '停用' : '启用'} onClick={() => void toggleProvider(record)} disabled={busy || disabled}><Power size={14} /></button>
						{!record.builtin && <button type="button" className="danger" title="删除自定义供应商" onClick={() => void deleteProvider(record.id)} disabled={busy || disabled}><Trash2 size={14} /></button>}
					</div>
				))}
				{items.length === 0 && <div className="review-profile-empty"><strong>注册表为空</strong><span>点击「刷新注册表」从后端载入内置 CodeArts 供应商。</span></div>}
				{customProviders.length > 0 && <div className="review-profile-empty"><span>已接入 {customProviders.length} 个自定义供应商；内置只保留 CodeArts 一家。</span></div>}
			</div>

			{/* 登录账号：两步式 OAuth，与插件一致（先给链接，再轮询凭据落库） */}
			{selected && isLoginProvider && (
				<div className="ai-registry-editor ai-registry-login">
					<strong>登录账号 · {selected.label}</strong>
					<small>点击后打开华为云授权页。在新窗口完成登录后，若页面跳转到 127.0.0.1 打不开，复制地址栏里的完整链接（含 code=...）粘贴到下方提交即可。本机访问时会自动完成。</small>
					<div className="ai-registry-toolbar">
						<button type="button" onClick={() => void startLogin()} disabled={!config || busy || disabled || loginStatus === 'waiting'}><LogIn size={14} />登录账号</button>
						{loginOpen && <button type="button" onClick={() => { stopPoll(); setLoginOpen(false); setLoginStatus('idle'); }}><X size={14} />取消等待</button>}
					</div>
					{loginOpen && (
						<div className={`ai-registry-login-card ${loginStatus}`}>
							<div className="ai-registry-login-status">
								{loginStatus === 'waiting' && <LoaderCircle className="spin" size={16} />}
								{loginStatus === 'success' && <CheckCircle2 size={16} />}
								{loginStatus === 'error' && <CircleAlert size={16} />}
								<span>{loginNote}</span>
							</div>
							{loginURL && <a className="ai-registry-login-link" href={loginURL} target="_blank" rel="noreferrer"><ExternalLink size={13} />打开授权链接</a>}
							<div className="ai-registry-login-manual">
								<input value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="粘贴授权后地址栏里的完整链接（含 code=...）" />
								<button type="button" onClick={() => void submitManualCode()} disabled={!manualCode.trim() || busy || disabled}>提交</button>
							</div>
						</div>
					)}
				</div>
			)}

			{/* 选择模型：黑名单制勾选，只有被关闭的才隐藏 */}
			{selected && (
				<div className="ai-registry-editor ai-registry-models">
					<strong>选择模型 · {selected.label}</strong>
					<small>列出该供应商的全部模型。开关默认打开；关闭后该模型不再出现在网关的模型列表里（黑名单制，服务端新增模型默认显示）。已启用 {enabledModels.length} / {models.length} 个。</small>
					<div className="ai-registry-toolbar">
						<button type="button" onClick={() => void loadModels(selectedID)} disabled={!config || busy || disabled || modelsLoading}><RefreshCw size={14} />读取模型</button>
						{isLoginProvider && <button type="button" onClick={() => void refreshModels()} disabled={!config || busy || disabled || modelsLoading}><RefreshCw size={14} />刷新远端目录</button>}
						<button type="button" onClick={() => void setAllModels(false)} disabled={!config || busy || disabled || models.length === 0}>全部启用</button>
						<button type="button" onClick={() => void setAllModels(true)} disabled={!config || busy || disabled || models.length === 0}>全部关闭</button>
						<input className="ai-registry-model-filter" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)} placeholder="搜索模型" />
					</div>
					<div className="ai-registry-model-list">
						{shownModels.map((model) => (
							<label className={`ai-registry-model-row ${model.disabled ? 'off' : ''} ${model.dead ? 'dead' : ''}`} key={model.id}>
								<input
									type="checkbox"
									role="switch"
									checked={!model.disabled}
									disabled={busy || disabled || modelBusyID === model.id}
									onChange={() => void toggleModel(model)}
								/>
								<span><strong>{model.name || model.id}</strong><small>{model.id}{model.dead ? ' · 目录已移除，可重新打开' : ''}</small></span>
								{modelBusyID === model.id && <LoaderCircle className="spin" size={13} />}
							</label>
						))}
						{shownModels.length === 0 && <div className="review-profile-empty"><span>{modelsLoading ? '正在读取模型目录…' : models.length === 0 ? '点击「读取模型」加载目录；登录型供应商可先「刷新远端目录」。' : '没有匹配的模型。'}</span></div>}
					</div>
				</div>
			)}

			{editing && (
				<div className="ai-registry-editor">
					<strong>{providerDraft.id ? `编辑 ${providerDraft.id}` : '新增自定义供应商'}</strong>
					<div className="settings-grid two-columns">
						<label><span>供应商 ID</span><input value={providerDraft.id} onChange={(event) => setProviderDraft({ ...providerDraft, id: event.target.value })} placeholder="例如 qiniu" disabled={!!providerDraft.id} /></label>
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
					<small>数组顺序即选号优先级；429 会写模型级限流并自动换下一个账号，401/403 换号但不写限流。登录型账号由「登录账号」自动创建。</small>
					{(selected.accounts || []).map((account, index) => (
						<div className="ai-registry-account" key={account.id}>
							<span><strong>{account.nickname || account.id}</strong><small>{account.credential_ref} · {account.enabled ? '启用' : '停用'} · 到期 {formatExpiry(account.expires_at)} · {account.refreshable ? '可续期' : '纯 Key'}</small></span>
							<button type="button" title="上移（提高优先级）" onClick={() => void accountAction('move', account, -1)} disabled={index === 0 || busy || disabled}><ArrowUp size={13} /></button>
							<button type="button" title="下移" onClick={() => void accountAction('move', account, 1)} disabled={index === (selected.accounts?.length || 0) - 1 || busy || disabled}><ArrowDown size={13} /></button>
							<button type="button" title={account.enabled ? '停用' : '启用'} onClick={() => void accountAction('toggle', { ...account, enabled: !account.enabled })} disabled={busy || disabled}><Power size={13} /></button>
							<button type="button" className="danger" title="删除账号" onClick={() => void accountAction('delete', account)} disabled={busy || disabled}><Trash2 size={13} /></button>
						</div>
					))}
					{!(selected.accounts || []).length && <div className="review-profile-empty"><span>暂无账号；登录型供应商请点「登录账号」，或手工添加订阅账号。</span></div>}
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
