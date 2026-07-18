// ===== 共享顶部导航栏 =====
// 用法：renderAppHeader('index') / renderAppHeader('daily') / renderAppHeader('diary')

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
      '<div id="syncStatus" class="sync-status-inline"></div>' +
      '<div id="headerSyncLoggedIn" style="display:none;align-items:center;gap:8px">' +
        '<span class="header-user-badge">👤 <span id="headerUsername">-</span></span>' +
        '<button class="btn btn-sm btn-primary" onclick="handleFullSync()">🔄 同步</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="handleToggleAutoSync()" id="headerBtnAutoSync">自动: 关</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="openChangePasswordModal()">🔐 修改密码</button>' +
        '<button class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()">退出</button>' +
      '</div>' +
      '<div id="headerSyncLoggedOut" style="display:flex;align-items:center;gap:8px">' +
        '<button class="btn btn-sm btn-primary" onclick="' + loginFn + '()">☁️ 登录同步</button>' +
      '</div>' +
      '<div id="adminMenu" style="display:none;align-items:center;gap:8px">' +
        '<span class="header-user-badge admin-badge">🔧 管理员</span>' +
        (page === 'index' ? '<button class="btn btn-sm btn-warning" onclick="toggleAdminPanel()">管理面板</button>' : '') +
        '<button class="btn btn-sm btn-ghost" onclick="openChangePasswordModal()">🔐 修改密码</button>' +
        '<button class="btn btn-sm btn-ghost-danger" onclick="' + logoutFn + '()">退出</button>' +
      '</div>' +
      '<div class="theme-divider"></div>' +
      '<button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换明暗主题">' +
        '<span class="theme-icon-light">🌙</span><span class="theme-icon-dark">☀️</span>' +
      '</button>' +
    '</div>';
}
