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
  }

  existing.innerHTML =
    '<div class="header-left">' +
      '<div class="app-logo">📊</div>' +
      '<div class="app-title"><h1>Trade Manager</h1></div>' +
      '<nav class="header-tabs">' +
        '<a href="index.html" class="header-tab' + (page === 'index' ? ' active' : '') + '" data-page="index" title="实时记录开仓 / 平仓 / 仓位管理；计算器辅助决策">📊 交易管理</a>' +
        '<a href="daily-review.html" class="header-tab' + (page === 'daily' ? ' active' : '') + '" data-page="daily" title="每日盘后总结：纪律 / 大盘 / 心态 / 复盘笔记">📋 每日复盘</a>' +
        '<a href="diary2.html" class="header-tab' + (page === 'diary' ? ' active' : '') + '" data-page="diary" title="历史交易深度复盘：筛选 / 排序 / 单笔分析">📖 复盘总结</a>' +
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
        '<button type="button" class="btn btn-sm btn-ghost" onclick="openChangePasswordModal()" aria-label="修改密码">🔐 修改密码</button>' +
        '<button type="button" class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()" aria-label="退出登录">退出</button>' +
      '</div>' +
      '<div id="headerSyncLoggedOut" style="display:flex;align-items:center;gap:8px">' +
        '<button type="button" class="btn btn-sm btn-primary" onclick="' + loginFn + '()" aria-label="登录并同步">☁️ 登录同步</button>' +
      '</div>' +
      '<div id="adminMenu" style="display:none;align-items:center;gap:8px">' +
        '<span class="header-user-badge admin-badge">🔧 管理员</span>' +
        (page === 'index' ? '<button type="button" class="btn btn-sm btn-warning" onclick="toggleAdminPanel()" aria-label="打开管理面板">管理面板</button>' : '') +
        '<button type="button" class="btn btn-sm btn-ghost" onclick="openChangePasswordModal()" aria-label="修改密码">🔐 修改密码</button>' +
        '<button type="button" class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()" aria-label="退出登录">退出</button>' +
      '</div>' +
      '<div class="theme-divider"></div>' +
      '<button type="button" class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换明暗主题" aria-label="切换明暗主题">' +
        '<span class="theme-icon-light">🌙</span><span class="theme-icon-dark">☀️</span>' +
      '</button>' +
    '</div>';
}

// ===== 全局搜索逻辑 =====
// 各页面可通过定义 window.performGlobalSearch(query) 覆盖搜索行为
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

// HTML 转义（避免重复定义）
if (typeof window.escapeHtml !== 'function') {
  window.escapeHtml = function(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
}
