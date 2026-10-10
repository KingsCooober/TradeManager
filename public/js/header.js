// ===== 共享顶部导航栏 =====
// 用法：renderAppHeader('index') / renderAppHeader('daily') / renderAppHeader('diary')

// ===== 主题切换（共享逻辑） =====
// 各页面如需在主题切换时执行额外操作（例如重绘图表），
// 可重写 toggleTheme 函数（后定义的同名函数会覆盖此处的版本）。
function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme');
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
}

// 初始化主题：localStorage 优先，否则跟随系统偏好
function initTheme() {
  var saved = localStorage.getItem('app_theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

initTheme();

function renderAppHeader(page) {
  var existing = document.getElementById('appHeader');
  if (!existing) return;

  var logoutFn = 'handleLogout';
  var loginFn = 'openLoginModal';
  if (page === 'daily') {
    logoutFn = 'handleDRLogout';
    loginFn = 'openDRLoginModal';
  } else if (page === 'aihot') {
    logoutFn = 'handleAihotLogout';
    loginFn = 'openAihotLoginModal';
  }

  existing.innerHTML =
    '<div class="header-left">' +
      '<div class="app-logo">📊</div>' +
      '<div class="app-title"><h1>Trade Manager</h1></div>' +
      '<nav class="header-tabs">' +
        '<a href="index.html" class="header-tab' + (page === 'index' ? ' active' : '') + '" data-page="index" title="实时记录开仓 / 平仓 / 仓位管理；计算器辅助决策">📊 交易管理</a>' +
        '<a href="daily-review.html" class="header-tab' + (page === 'daily' ? ' active' : '') + '" data-page="daily" title="每日盘后总结：纪律 / 大盘 / 心态 / 复盘笔记">📋 每日复盘</a>' +
        '<a href="diary2.html" class="header-tab' + (page === 'diary' ? ' active' : '') + '" data-page="diary" title="历史交易深度复盘：筛选 / 排序 / 单笔分析">📖 复盘总结</a>' +
        '<a href="backtest.html" class="header-tab' + (page === 'backtest' ? ' active' : '') + '" data-page="backtest" title="看着历史 K 线手动模拟买卖的练习工具">🎯 回测练习</a>' +
        '<a href="research.html" class="header-tab' + (page === 'research' ? ' active' : '') + '" data-page="research" title="研报库：订阅式抓取公开研报、AI 摘要要点、划词高亮与批注、按行业标签归档">📑 研报库</a>' +
        '<a href="aihot.html" class="header-tab' + (page === 'aihot' ? ' active' : '') + '" data-page="aihot" title="AIHOT：精选资讯、全部动态、热点榜与 AI 日报">🤖 AIHOT</a>' +
      '</nav>' +
    '</div>' +
    '<div class="header-right">' +
      '<span id="syncIndicator" class="sync-indicator sync-indicator-idle" title="从未同步" aria-label="同步状态">●</span>' +
      '<div id="syncStatus" class="sync-status-inline" aria-live="polite"></div>' +
      '<div class="header-search-wrapper">' +
        '<input type="text" id="globalSearchInput" class="header-search-input" placeholder="🔍 搜索..." autocomplete="off" aria-label="全局搜索" />' +
        '<div id="globalSearchResults" class="header-search-results" style="display:none;"></div>' +
      '</div>' +
      '<div id="headerSyncLoggedIn" style="display:none;align-items:center;gap:8px">' +
        '<span class="header-user-badge">👤 <span id="headerUsername">-</span></span>' +
        '<button type="button" class="btn btn-sm btn-primary" onclick="handleFullSync()" aria-label="立即同步">🔄 同步</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" onclick="handleToggleAutoSync()" id="headerBtnAutoSync" aria-label="切换自动同步">自动: 关</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" onclick="openAppSettings()" aria-label="设置">⚙️ 设置</button>' +
        '<button type="button" class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()" aria-label="退出登录">退出</button>' +
      '</div>' +
      '<div id="headerSyncLoggedOut" style="display:flex;align-items:center;gap:8px">' +
        '<button type="button" class="btn btn-sm btn-primary" onclick="' + loginFn + '()" aria-label="登录并同步">☁️ 登录同步</button>' +
      '</div>' +
      '<div id="adminMenu" style="display:none;align-items:center;gap:8px">' +
        '<span class="header-user-badge admin-badge">🔧 管理员</span>' +
        (page === 'index' ? '<button type="button" class="btn btn-sm btn-warning" onclick="toggleAdminPanel()" aria-label="打开管理面板">管理面板</button>' : '') +
        '<button type="button" class="btn btn-sm btn-ghost" onclick="openAppSettings()" aria-label="设置">⚙️ 设置</button>' +
        '<button type="button" class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()" aria-label="退出登录">退出</button>' +
      '</div>' +
      '<div class="theme-divider"></div>' +
      '<button type="button" class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换明暗主题" aria-label="切换明暗主题">' +
        '<span class="theme-icon-light">🌙</span><span class="theme-icon-dark">☀️</span>' +
      '</button>' +
    '</div>';
}

// ===== 全局搜索逻辑 =====// 各页面可通过定义 window.performGlobalSearch(query) 覆盖搜索行为
// 该函数应返回一个数组，每项格式：{ label, sublabel, onClick }
function setupGlobalSearch() {
  // 延迟绑定以等待 DOM 渲染完成
  setTimeout(function() {
    var input = document.getElementById('globalSearchInput');
    var resultsBox = document.getElementById('globalSearchResults');
    if (!input || !resultsBox) return;

    var debounceTimer = null;
    input.addEventListener('input', function() {
      var q = input.value.trim();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (!q) {
        resultsBox.style.display = 'none';
        resultsBox.innerHTML = '';
        return;
      }
      debounceTimer = setTimeout(function() { doGlobalSearch(q); }, 200);
    });

    // 点击外部关闭搜索结果
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.header-search-wrapper')) {
        resultsBox.style.display = 'none';
      }
    });

    // ESC 关闭
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        resultsBox.style.display = 'none';
        input.blur();
      }
    });
  }, 50);
}

function doGlobalSearch(q) {
  var resultsBox = document.getElementById('globalSearchResults');
  if (!resultsBox) return;
  var results = [];
  if (typeof window.performGlobalSearch === 'function') {
    try {
      results = window.performGlobalSearch(q) || [];
    } catch (e) {
      console.error('全局搜索出错:', e);
      results = [];
    }
  }
  if (results.length === 0) {
    resultsBox.innerHTML = '<div class="search-result-empty">未找到匹配项</div>';
  } else {
    resultsBox.innerHTML = results.slice(0, 8).map(function(r, i) {
      var sub = r.sublabel ? '<span class="search-result-sublabel">' + escapeHtml(r.sublabel) + '</span>' : '';
      return '<div class="search-result-item" data-idx="' + i + '">' +
        '<span class="search-result-label">' + escapeHtml(r.label) + '</span>' +
        sub +
      '</div>';
    }).join('');
    // 绑定点击事件
    var items = resultsBox.querySelectorAll('.search-result-item');
    var inputEl = document.getElementById('globalSearchInput');
    items.forEach(function(item) {
      item.addEventListener('click', function() {
        var idx = parseInt(item.getAttribute('data-idx'));
        var r = results[idx];
        if (r && typeof r.onClick === 'function') {
          r.onClick();
        }
        resultsBox.style.display = 'none';
        if (inputEl) inputEl.value = '';
      });
    });
  }
  resultsBox.style.display = 'block';
}

// 在 DOMContentLoaded 时初始化
document.addEventListener('DOMContentLoaded', function() {
  setupGlobalSearch();
});

// P0-2: HTML 转义统一委托给 utils.js 的 esc()（仅当 esc 未定义时降级，避免循环依赖）
// utils.js 在 header.js 之前加载，正常情况下 esc 已存在
if (typeof window.escapeHtml !== 'function') {
  window.escapeHtml = function(str) {
    if (typeof esc === 'function') return esc(str);
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
}

// ===== 全局设置弹窗（AI 大模型配置 + 账号安全） =====
// 6 个页面共用。配置本体存在研报库，通过主站带鉴权的 /api/ai/settings 读写，
// 研报摘要与 AIHOT 英文翻译共用同一份配置。

function appSettingsToken() {
  try {
    return localStorage.getItem('sync_token') || localStorage.getItem('token') || '';
  } catch (e) {
    return '';
  }
}

function appSettingsStyles() {
  if (document.getElementById('appSettingsStyle')) return;
  var style = document.createElement('style');
  style.id = 'appSettingsStyle';
  style.textContent = [
    '.app-settings-modal{position:fixed;inset:0;z-index:1200;display:grid;place-items:center;padding:20px}',
    '.app-settings-modal[hidden]{display:none}',
    '.app-settings-mask{position:absolute;inset:0;background:var(--bg-overlay,rgba(0,0,0,.45))}',
    '.app-settings-card{position:relative;width:min(100%,520px);max-height:86vh;overflow:auto;padding:24px 26px;border:1px solid var(--border-card,#e5e5e5);border-radius:var(--radius-lg,12px);background:var(--bg-card,#fff);color:var(--text-primary,#222);box-shadow:0 12px 40px rgba(0,0,0,.25)}',
    '.app-settings-card h2{margin:0 0 4px;font-size:20px}',
    '.app-settings-sub{margin:0 0 18px;color:var(--text-secondary,#666);font-size:13px}',
    '.app-settings-section{padding:16px 0;border-top:1px solid var(--border-divider,#eee)}',
    '.app-settings-section:first-of-type{border-top:0;padding-top:0}',
    '.app-settings-section h3{margin:0 0 10px;font-size:15px}',
    '.app-settings-hint{margin:0 0 12px;color:var(--text-tertiary,#999);font-size:12px;line-height:1.7}',
    '.app-settings-card label{display:block;margin:10px 0 5px;color:var(--text-secondary,#666);font-size:12px}',
    '.app-settings-card input{width:100%;box-sizing:border-box;min-height:40px;padding:0 12px;border:1px solid var(--border-input,#ddd);border-radius:8px;background:var(--bg-input,#fff);color:var(--text-primary,#222);font:inherit;font-size:13px}',
    '.app-settings-card select{width:100%;box-sizing:border-box;min-height:40px;padding:0 12px;border:1px solid var(--border-input,#ddd);border-radius:8px;background:var(--bg-input,#fff);color:var(--text-primary,#222);font:inherit;font-size:13px}',
    '.app-settings-inline{display:flex;align-items:center;gap:8px}',
    '.app-settings-inline select{flex:1 1 auto;min-width:0}',
    '.app-settings-inline .btn{flex:0 0 auto;white-space:nowrap}',
    '.app-settings-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-top:16px}',
    '.app-settings-msg{color:var(--text-tertiary,#999);font-size:12px}',
    '.app-settings-msg.is-ok{color:var(--color-teal,#0f6e56)}',
    '.app-settings-msg.is-err{color:var(--color-red,#d33)}',
    '.app-settings-close{position:absolute;top:10px;right:12px;border:0;background:transparent;color:var(--text-secondary,#666);font-size:24px;line-height:1;cursor:pointer}'
  ].join('');
  document.head.appendChild(style);
}

// ===== 朗读音色（AIHOT 划词 / 段落小喇叭共用）=====
// 音色来自小米 MiMo TTS（mimo-v2.5-tts），偏好存本地，请求时带给后端。
var TTS_VOICES = {
  en: [
    { id: 'Chloe', label: 'Chloe · 女声' },
    { id: 'Mia', label: 'Mia · 女声' },
    { id: 'Milo', label: 'Milo · 男声' },
    { id: 'Dean', label: 'Dean · 男声' },
    { id: 'mimo_default', label: '默认音色' }
  ],
  zh: [
    { id: '茉莉', label: '茉莉 · 女声' },
    { id: '冰糖', label: '冰糖 · 女声' },
    { id: '苏打', label: '苏打 · 男声' },
    { id: '白桦', label: '白桦 · 男声' },
    { id: 'mimo_default', label: '默认音色' }
  ]
};
var TTS_VOICE_DEFAULT = { en: 'Chloe', zh: '茉莉' };
var TTS_PREVIEW_TEXT = {
  en: 'Hello, this is how the English voice sounds.',
  zh: '你好，这是中文音色的试听效果。'
};

function ttsVoiceKey(lang) {
  return lang === 'zh' ? 'zh' : 'en';
}

function getTtsVoice(lang) {
  var key = ttsVoiceKey(lang);
  var saved = '';
  try { saved = localStorage.getItem('ah_voice_' + key) || ''; } catch (e) { saved = ''; }
  var list = TTS_VOICES[key] || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === saved) return saved;
  }
  return TTS_VOICE_DEFAULT[key];
}

function setTtsVoice(lang, voice) {
  try { localStorage.setItem('ah_voice_' + ttsVoiceKey(lang), String(voice || '')); } catch (e) { /* 忽略 */ }
}

window.getTtsVoice = getTtsVoice;
window.setTtsVoice = setTtsVoice;
window.TTS_VOICES = TTS_VOICES;

function appSettingsMsg(text, kind) {
  var el = document.getElementById('appSetMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'app-settings-msg' + (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '');
}

function appSettingsFetch(method, path, body) {
  var headers = { Accept: 'application/json' };
  var token = appSettingsToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  var options = { method: method, headers: headers, cache: 'no-store' };
  if (body) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return fetch(path, options).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (!response.ok) throw new Error(data.error || ('请求失败（HTTP ' + response.status + '）'));
      return data;
    });
  });
}

function appSettingsKeyPlaceholder(data) {
  return data.ai_configured
    ? '已保存：' + (data.ai_api_key_masked || '••••••') + '（留空则不修改）'
    : 'sk-...';
}

function appSettingsLoad() {
  appSettingsMsg('读取中…', '');
  appSettingsFetch('GET', '/api/ai/settings').then(function (data) {
    document.getElementById('appSetBase').value = data.ai_base_url || '';
    document.getElementById('appSetModel').value = data.ai_model || '';
    var keyInput = document.getElementById('appSetKey');
    keyInput.value = '';
    keyInput.placeholder = appSettingsKeyPlaceholder(data);
    appSettingsMsg(data.ai_configured ? '已配置 API Key' : '尚未配置 API Key', data.ai_configured ? 'ok' : '');
  }).catch(function (error) {
    appSettingsMsg(error.message, 'err');
  });
}

function appSettingsPayload() {
  var payload = {
    ai_base_url: document.getElementById('appSetBase').value.trim(),
    ai_model: document.getElementById('appSetModel').value.trim()
  };
  var key = document.getElementById('appSetKey').value.trim();
  if (key) payload.ai_api_key = key;
  return payload;
}

function appSettingsSave() {
  appSettingsMsg('保存中…', '');
  appSettingsFetch('PUT', '/api/ai/settings', appSettingsPayload()).then(function (data) {
    document.getElementById('appSetKey').value = '';
    document.getElementById('appSetKey').placeholder = appSettingsKeyPlaceholder(data);
    appSettingsMsg('已保存', 'ok');
  }).catch(function (error) {
    appSettingsMsg(error.message, 'err');
  });
}

function appSettingsTest() {
  appSettingsMsg('测试中…（会真实调用一次模型）', '');
  appSettingsFetch('POST', '/api/ai/settings/test', appSettingsPayload()).then(function () {
    appSettingsMsg('连接成功 ✅', 'ok');
  }).catch(function (error) {
    appSettingsMsg(error.message, 'err');
  });
}

// ---------- 朗读音色 ----------

function appSettingsVoiceMsg(text, kind) {
  var el = document.getElementById('appSetVoiceMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'app-settings-msg' + (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '');
}

function appSettingsFillVoices() {
  ['en', 'zh'].forEach(function (lang) {
    var select = document.getElementById(lang === 'zh' ? 'appSetVoiceZh' : 'appSetVoiceEn');
    if (!select) return;
    var current = getTtsVoice(lang);
    select.innerHTML = TTS_VOICES[lang].map(function (voice) {
      return '<option value="' + voice.id + '">' + voice.label + '</option>';
    }).join('');
    select.value = current;
    select.addEventListener('change', function () {
      setTtsVoice(lang, select.value);
      appSettingsVoiceMsg('已保存：' + (lang === 'zh' ? '中文' : '英文') + ' → ' + select.value, 'ok');
    });
  });
}

function appSettingsBase64Url(base64, format) {
  try {
    var binary = window.atob(String(base64 || ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }));
  } catch (e) {
    return '';
  }
}

var appSettingsPreviewAudio = null;

async function appSettingsPreview(lang, button) {
  var select = document.getElementById(lang === 'zh' ? 'appSetVoiceZh' : 'appSetVoiceEn');
  var voice = select ? select.value : getTtsVoice(lang);
  if (appSettingsPreviewAudio) {
    try { appSettingsPreviewAudio.pause(); } catch (e) { /* 忽略 */ }
    appSettingsPreviewAudio = null;
  }
  if (button) button.disabled = true;
  appSettingsVoiceMsg('合成中…（首次约 2 秒）', '');
  try {
    var data = await appSettingsFetch('POST', '/api/aihot/tts', {
      text: TTS_PREVIEW_TEXT[lang],
      lang: lang,
      voice: voice
    });
    var url = appSettingsBase64Url(data.audio, data.format);
    if (!url) throw new Error('音频解析失败。');
    var audio = new Audio(url);
    appSettingsPreviewAudio = audio;
    audio.addEventListener('ended', function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
      appSettingsPreviewAudio = null;
    });
    await audio.play();
    appSettingsVoiceMsg('正在试听：' + voice, 'ok');
  } catch (error) {
    appSettingsVoiceMsg(error.message, 'err');
  } finally {
    if (button) button.disabled = false;
  }
}

function ensureAppSettingsModal() {
  appSettingsStyles();
  var modal = document.getElementById('appSettingsModal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'appSettingsModal';
  modal.className = 'app-settings-modal';
  modal.hidden = true;
  modal.innerHTML =
    '<div class="app-settings-mask" data-app-settings-close></div>' +
    '<div class="app-settings-card" role="dialog" aria-modal="true" aria-labelledby="appSettingsTitle">' +
      '<button type="button" class="app-settings-close" data-app-settings-close aria-label="关闭">×</button>' +
      '<h2 id="appSettingsTitle">设置</h2>' +
      '<p class="app-settings-sub">AI 能力与账号安全</p>' +
      '<section class="app-settings-section">' +
        '<h3>AI 大模型</h3>' +
        '<p class="app-settings-hint">用于研报摘要与 AIHOT 英文翻译，全站共用这一份配置。兼容 OpenAI Chat Completions 协议：DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等。</p>' +
        '<label for="appSetBase">API Base URL</label>' +
        '<input id="appSetBase" type="text" placeholder="https://api.deepseek.com/v1" autocomplete="off">' +
        '<label for="appSetModel">模型名称</label>' +
        '<input id="appSetModel" type="text" placeholder="deepseek-chat" autocomplete="off">' +
        '<label for="appSetKey">API Key</label>' +
        '<input id="appSetKey" type="password" placeholder="sk-..." autocomplete="off">' +
        '<div class="app-settings-actions">' +
          '<button type="button" class="btn btn-sm btn-ghost" id="appSetTest">测试连接</button>' +
          '<button type="button" class="btn btn-sm btn-primary" id="appSetSave">保存</button>' +
          '<span class="app-settings-msg" id="appSetMsg"></span>' +
        '</div>' +
      '</section>' +
      '<section class="app-settings-section">' +
        '<h3>朗读音色</h3>' +
        '<p class="app-settings-hint">AIHOT 文章里划词、点段落小喇叭时用的发音音色（小米 MiMo TTS）。</p>' +
        '<label for="appSetVoiceEn">英文音色</label>' +
        '<div class="app-settings-inline">' +
          '<select id="appSetVoiceEn"></select>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-tts-preview="en">🔊 试听</button>' +
        '</div>' +
        '<label for="appSetVoiceZh">中文音色</label>' +
        '<div class="app-settings-inline">' +
          '<select id="appSetVoiceZh"></select>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-tts-preview="zh">🔊 试听</button>' +
        '</div>' +
        '<div class="app-settings-actions">' +
          '<span class="app-settings-msg" id="appSetVoiceMsg"></span>' +
        '</div>' +
      '</section>' +
      '<section class="app-settings-section">' +
        '<h3>账号安全</h3>' +
        '<div class="app-settings-actions">' +
          '<button type="button" class="btn btn-sm btn-ghost" id="appSetPassword">🔐 修改密码</button>' +
        '</div>' +
      '</section>' +
    '</div>';

  document.body.appendChild(modal);

  modal.querySelectorAll('[data-app-settings-close]').forEach(function (el) {
    el.addEventListener('click', closeAppSettings);
  });
  document.getElementById('appSetSave').addEventListener('click', appSettingsSave);
  document.getElementById('appSetTest').addEventListener('click', appSettingsTest);
  appSettingsFillVoices();
  modal.querySelectorAll('[data-tts-preview]').forEach(function (button) {
    button.addEventListener('click', function () {
      appSettingsPreview(button.getAttribute('data-tts-preview'), button);
    });
  });
  document.getElementById('appSetPassword').addEventListener('click', function () {
    if (typeof window.openChangePasswordModal === 'function') {
      closeAppSettings();
      window.openChangePasswordModal();
    } else {
      appSettingsMsg('当前页面不支持修改密码。', 'err');
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeAppSettings();
  });

  return modal;
}

function openAppSettings() {
  var modal = ensureAppSettingsModal();
  modal.hidden = false;
  appSettingsVoiceMsg('');
  appSettingsLoad();
}

function closeAppSettings() {
  var modal = document.getElementById('appSettingsModal');
  if (modal) modal.hidden = true;
}

window.openAppSettings = openAppSettings;
window.closeAppSettings = closeAppSettings;
