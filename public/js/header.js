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
        '<a href="index.html" class="header-tab' + (page === 'index' ? ' active' : '') + '" data-page="index">📊 交易管理</a>' +
        '<a href="daily-review.html" class="header-tab' + (page === 'daily' ? ' active' : '') + '" data-page="daily">📋 每日复盘</a>' +
        '<a href="diary2.html" class="header-tab' + (page === 'diary' ? ' active' : '') + '" data-page="diary">📖 复盘总结</a>' +
      '</nav>' +
    '</div>' +
    '<div class="header-right">' +
      '<div id="syncStatus" class="sync-status-inline" aria-live="polite"></div>' +
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
