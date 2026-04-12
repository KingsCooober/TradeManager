// ===== 仓位管理表 - 主入口 =====
// 模块化版本：将功能拆分为多个文件便于维护

// 引入各模块（需按依赖顺序加载）
// <script src="utils.js"></script>
// <script src="storage.js"></script>
// <script src="calculator.js"></script>
// <script src="table.js"></script>
// <script src="charts.js"></script>
// <script src="main.js"></script>

// ===== 统计数据更新 =====
function updateStats() {
  var closed = trades.filter(function(t) {
    return t.status !== 'open' && t.pnl !== '' && !isNaN(parseFloat(t.pnl));
  });
  var wins = closed.filter(function(t) { return parseFloat(t.pnl) > 0; });
  var losses = closed.filter(function(t) { return parseFloat(t.pnl) < 0; });

  var wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) + '%' : '-';

  var avgRR = '-';
  if (wins.length > 0 && losses.length > 0) {
    var aW = wins.reduce(function(s, t) { return s + parseFloat(t.pnlR || 0); }, 0) / wins.length;
    var aL = Math.abs(losses.reduce(function(s, t) { return s + parseFloat(t.pnlR || 0); }, 0) / losses.length);
    avgRR = '1:' + (aW / aL).toFixed(2);
  }

  var ev = '-';
  if (closed.length > 0) ev = (closed.reduce(function(s, t) { return s + parseFloat(t.pnlR || 0); }, 0) / closed.length).toFixed(2) + 'R';

  var maxDD = 0, curDD = 0;
  for (var i = 0; i < closed.length; i++) {
    if (parseFloat(closed[i].pnl) < 0) {
      curDD++;
      maxDD = Math.max(maxDD, curDD);
    } else {
      curDD = 0;
    }
  }

  var totalR = closed.reduce(function(s, t) {
    return s + (t.pnlR !== '' && !isNaN(parseFloat(t.pnlR)) ? parseFloat(t.pnlR) : 0);
  }, 0);

  // 更新交易记录工具栏中的统计数据
  var el = function(id) { return document.getElementById(id); };
  
  var trEl = el('s_totalR');
  if (trEl) {
    trEl.textContent = (totalR >= 0 ? '+' : '') + totalR.toFixed(2) + 'R';
    trEl.className = (totalR > 0 ? 'glow-red' : totalR < 0 ? 'glow-green' : '');
  }
  
  if (el('s_total')) el('s_total').textContent = closed.length;
  if (el('s_wins')) el('s_wins').textContent = wins.length;
  if (el('s_losses')) el('s_losses').textContent = losses.length;
  if (el('s_winrate')) el('s_winrate').textContent = wr;
  if (el('s_avgrr')) el('s_avgrr').textContent = avgRR;
  if (el('s_ev')) el('s_ev').textContent = ev;
  if (el('s_maxdd')) el('s_maxdd').textContent = maxDD;
}

// ===== 主更新函数 =====
function updateAll() {
  var cap = getCurrentCapital(),
      init = getInitCapital(),
      td = getTotalDeposit(),
      tw = getTotalWithdraw(),
      tradePnl = getTotalTradePnl(),
      totalFees = getTotalFees(),
      rPct = getRiskPct(),
      maxR = getMaxRisk();
  
  var availableCapital = init + td - tw;
  var totalReturn = availableCapital > 0 ? (tradePnl / availableCapital) * 100 : 0;
  
  var rAmt = cap * rPct / 100,
      maxRiskAmt = rAmt * maxR,
      usedRisk = getUsedRisk(),
      remainRisk = maxRiskAmt - usedRisk;

  // 实时保存账户参数到数据库和 LocalStorage
  saveAccountParams();

  // 更新账户资金显示
  var cp = document.getElementById('currentCapital');
  if (cp) cp.textContent = CNY(cap);
  var pEl = document.getElementById('totalPnl');
  if (pEl) {
    pEl.textContent = (tradePnl >= 0 ? '+' : '-') + CNY(Math.abs(tradePnl));
    pEl.className = 'val ' + (tradePnl >= 0 ? 'glow-red' : 'glow-green');
  }
  var rEl = document.getElementById('totalReturn');
  if (rEl) {
    rEl.textContent = (totalReturn >= 0 ? '+' : '') + totalReturn.toFixed(2) + '%';
    rEl.className = 'val ' + (totalReturn >= 0 ? 'glow-red' : 'glow-green');
  }

  // 更新入金出金显示
  var tdEl = document.getElementById('totalDeposit');
  if (tdEl) tdEl.textContent = CNY(td);
  var twEl = document.getElementById('totalWithdraw');
  if (twEl) twEl.textContent = CNY(tw);

  // 更新手续费显示
  var tfEl = document.getElementById('totalFees');
  if (tfEl) tfEl.textContent = CNY(totalFees);

  // 更新风险参数显示
  var rAmtEl = document.getElementById('rAmount');
  if (rAmtEl) rAmtEl.textContent = CNY(rAmt);
  var mrEl = document.getElementById('maxRiskAmount');
  if (mrEl) mrEl.textContent = CNY(maxRiskAmt);
  var uEl = document.getElementById('usedRisk');
  if (uEl) {
    uEl.textContent = CNY(usedRisk);
    uEl.className = 'val ' + (usedRisk > 0 ? 'glow-yellow' : 'glow-cyan');
  }
  var rmEl = document.getElementById('remainRisk');
  if (rmEl) {
    rmEl.textContent = CNY(remainRisk);
    rmEl.className = 'val ' + (remainRisk < 0 ? 'glow-green' : 'glow-cyan');
  }

  // 重新计算并更新
  calcPosition();
  renderTable();
  updateStats();
  drawEquityCurve();
  drawPositionPie();
}

// ===== 入金出金弹窗函数 =====

// 初始化弹窗日期选择器
function initModalDatePicker() {
  var today = getToday();
  
  // 入金日期选择器
  var depositPicker = document.getElementById('depositDatePicker');
  if (depositPicker) {
    depositPicker.innerHTML = createModalDateSelects('depositDate', today);
  }
  
  // 出金日期选择器
  var withdrawPicker = document.getElementById('withdrawDatePicker');
  if (withdrawPicker) {
    withdrawPicker.innerHTML = createModalDateSelects('withdrawDate', today);
  }
}

// 创建弹窗用日期选择器下拉
function createModalDateSelects(baseId, currentValue) {
  var td = currentValue || getToday();
  var y = td.substring(0, 4);
  var m = td.substring(5, 7);
  var d = td.substring(8, 10);

  var years = getYearRange();
  var yearsHtml = years.map(function(year) {
    return '<option value="' + year + '"' + (year === y ? ' selected' : '') + '>' + year + '年</option>';
  }).join('');

  var monthsHtml = '';
  for (var i = 1; i <= 12; i++) {
    var val = i < 10 ? '0' + i : i;
    monthsHtml += '<option value="' + val + '"' + (i === parseInt(m) ? ' selected' : '') + '>' + i + '月</option>';
  }

  var daysHtml = '';
  for (var i = 1; i <= 31; i++) {
    var val = i < 10 ? '0' + i : i;
    daysHtml += '<option value="' + val + '"' + (i === parseInt(d) ? ' selected' : '') + '>' + i + '日</option>';
  }

  return '<select id="' + baseId + '_year" class="date-select date-year" style="flex:1" onchange="syncModalDate(\'' + baseId + '\')">' + yearsHtml + '</select>' +
    '<select id="' + baseId + '_month" class="date-select date-month" style="flex:1" onchange="syncModalDate(\'' + baseId + '\')">' + monthsHtml + '</select>' +
    '<select id="' + baseId + '_day" class="date-select date-day" style="flex:1" onchange="syncModalDate(\'' + baseId + '\')">' + daysHtml + '</select>';
}

// 同步弹窗日期选择器到隐藏输入框
function syncModalDate(baseId) {
  var year = document.getElementById(baseId + '_year').value;
  var month = document.getElementById(baseId + '_month').value;
  var day = document.getElementById(baseId + '_day').value;
  var dateValue = year + '-' + month + '-' + day;
  document.getElementById(baseId).value = dateValue;
}

function showDepositModal() {
  document.getElementById('depositModal').style.display = 'flex';
  document.getElementById('depositAmount').value = '';
  var today = getToday();
  document.getElementById('depositDate').value = today;
  // 更新下拉选择器
  var yearSel = document.getElementById('depositDate_year');
  var monthSel = document.getElementById('depositDate_month');
  var daySel = document.getElementById('depositDate_day');
  if (yearSel) yearSel.value = today.substring(0, 4);
  if (monthSel) monthSel.value = today.substring(5, 7);
  if (daySel) daySel.value = today.substring(8, 10);
}

function closeDepositModal() {
  document.getElementById('depositModal').style.display = 'none';
}

function confirmDeposit() {
  var amt = parseFloat(document.getElementById('depositAmount').value);
  if (!amt || amt <= 0) {
    alert('请输入有效金额');
    return;
  }
  var date = document.getElementById('depositDate').value || getToday();
  addDeposit(amt, date).then(function() {
    updateAll();
    closeDepositModal();
  }).catch(function(err) {
    console.error('入金失败:', err);
    alert('入金记录失败');
  });
}

function showWithdrawModal() {
  document.getElementById('withdrawModal').style.display = 'flex';
  document.getElementById('withdrawAmount').value = '';
  var today = getToday();
  document.getElementById('withdrawDate').value = today;
  // 更新下拉选择器
  var yearSel = document.getElementById('withdrawDate_year');
  var monthSel = document.getElementById('withdrawDate_month');
  var daySel = document.getElementById('withdrawDate_day');
  if (yearSel) yearSel.value = today.substring(0, 4);
  if (monthSel) monthSel.value = today.substring(5, 7);
  if (daySel) daySel.value = today.substring(8, 10);
}

function closeWithdrawModal() {
  document.getElementById('withdrawModal').style.display = 'none';
}

function confirmWithdraw() {
  var amt = parseFloat(document.getElementById('withdrawAmount').value);
  if (!amt || amt <= 0) {
    alert('请输入有效金额');
    return;
  }
  var date = document.getElementById('withdrawDate').value || getToday();
  addWithdrawal(amt, date).then(function() {
    updateAll();
    closeWithdrawModal();
  }).catch(function(err) {
    console.error('出金失败:', err);
    alert('出金记录失败');
  });
}

// ===== 清空记录 =====
function clearAll() {
  if (!confirm('确认清空所有交易记录？此操作不可撤销！')) return;

  // 先清空本地
  trades = [];

  // 清空 IndexedDB
  if (dbInitialized && db) {
    clearAllTradesFromDB().then(function() {
      console.log('本地数据库已清空');
    }).catch(function(err) {
      console.error('清空数据库失败:', err);
    });
  }

  // 清空 LocalStorage 备份
  localStorage.setItem('trades_v4', '[]');

  // 如果已登录，通知服务器清空
  var syncModule = window.syncModule;
  if (syncModule && typeof syncModule.clearServerData === 'function') {
    syncModule.clearServerData().then(function() {
      console.log('服务器数据已清空');
    }).catch(function(err) {
      console.error('清空服务器失败:', err);
    });
  }

  // 更新界面
  updateAll();
}

// ===== 导出CSV =====
function exportCSV() {
  var headers = ['#', '日期', '品种', '方向', '入场价', '止损价', '止盈价', '止盈距离%', '仓位金额', '风险R', '出场价', '盈亏距离%', '盈亏金额', '盈亏R', '状态', '备注'];
  var rows = trades.map(function(t, i) {
    return [i + 1, t.date, t.symbol, t.dir, t.entry, t.stop, t.target, calcTpDist(t), t.posSize, t.riskAmount, t.exit, calcExitDist(t), t.pnl, t.pnlR, t.status, t.note];
  });
  var csv = [headers].concat(rows).map(function(r) { return r.join(','); }).join('\n');
  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '交易记录_' + getToday() + '.csv';
  a.click();
}

// ===== 同步功能处理函数 =====

// 打开登录弹窗
function openLoginModal() {
  var modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'flex';
}

// 关闭登录弹窗
function closeLoginModal() {
  var modal = document.getElementById('loginModal');
  if (modal) modal.style.display = 'none';
}

// 更新顶部导航栏登录状态
function updateHeaderSyncUI() {
  var user = syncModule.getCurrentUser();
  var loggedIn = document.getElementById('headerSyncLoggedIn');
  var headerUsername = document.getElementById('headerUsername');
  var headerBtnAutoSync = document.getElementById('headerBtnAutoSync');
  var loggedOut = document.getElementById('headerSyncLoggedOut');

  if (user) {
    // 更新管理员菜单显示
    updateAdminMenu();
    
    // 如果不是管理员，显示普通用户登录状态
    if (user.role !== 'admin') {
      if (loggedIn) { loggedIn.style.display = 'flex'; }
      if (loggedOut) { loggedOut.style.display = 'none'; }
      if (headerUsername) { headerUsername.textContent = user.username; }
      if (headerBtnAutoSync) {
        var isAuto = localStorage.getItem('sync_auto') === 'true';
        headerBtnAutoSync.textContent = '自动: ' + (isAuto ? '开' : '关');
      }
    } else {
      // 管理员不显示普通用户的登录状态
      if (loggedIn) { loggedIn.style.display = 'none'; }
      if (loggedOut) { loggedOut.style.display = 'none'; }
    }
  } else {
    if (loggedIn) { loggedIn.style.display = 'none'; }
    if (loggedOut) { loggedOut.style.display = 'flex'; }
    if (document.getElementById('adminMenu')) {
      document.getElementById('adminMenu').style.display = 'none';
    }
  }
}

function handleLogin() {
  const username = document.getElementById('syncLoginUser').value.trim();
  const password = document.getElementById('syncLoginPass').value;
  const serverUrl = document.getElementById('syncServerUrl').value.trim();
  
  if (!username || !password) {
    alert('请输入用户名和密码');
    return;
  }
  
  if (serverUrl) {
    syncModule.setServerUrl(serverUrl);
  }
  
  syncModule.login(username, password)
    .then(() => {
      syncModule.updateSyncUI();
      updateHeaderSyncUI();
      syncModule.showSyncStatus('登录成功', 'success');
      // 关闭登录弹窗
      closeLoginModal();
      // 清空本地数据后再从服务器下载新用户数据（不上传）
      clearLocalDataAndRefresh();
      handleDownloadOnly();
    })
    .catch(err => {
      alert('登录失败: ' + err.message);
    });
}

function clearLocalDataAndRefresh() {
  try {
    // 清空内存中的数据
    if (typeof trades !== 'undefined' && Array.isArray(trades)) {
      trades.length = 0;
    }
    if (typeof deposits !== 'undefined' && Array.isArray(deposits)) {
      deposits.length = 0;
    }
    if (typeof withdrawals !== 'undefined' && Array.isArray(withdrawals)) {
      withdrawals.length = 0;
    }
  } catch(e) {}

  try {
    // 清空 localStorage
    localStorage.removeItem('trades');
    localStorage.removeItem('deposits');
    localStorage.removeItem('withdrawals');
    localStorage.removeItem('trades_v4');
    localStorage.removeItem('initCapital');
    localStorage.removeItem('riskPct');
    localStorage.removeItem('maxRisk');
    localStorage.removeItem('feeRate');
  } catch(e) {}

  // 清空 IndexedDB（异步，完成后刷新UI）
  if (typeof clearAllDataFromDB === 'function') {
    clearAllDataFromDB().then(function() {
      console.log('本地数据已全部清除（含IndexedDB）');
    }).catch(function(err) {
      console.warn('清除IndexedDB数据时出错:', err);
    });
  }

  // 立即刷新页面显示
  updateAll();
}

function handleRegister() {
  const username = document.getElementById('syncLoginUser').value.trim();
  const password = document.getElementById('syncLoginPass').value;
  const serverUrl = document.getElementById('syncServerUrl').value.trim();
  
  if (!username || !password) {
    alert('请输入用户名和密码');
    return;
  }
  
  if (password.length < 6) {
    alert('密码至少需要6位');
    return;
  }
  
  if (serverUrl) {
    syncModule.setServerUrl(serverUrl);
  }
  
  syncModule.register(username, password)
    .then(() => {
      syncModule.updateSyncUI();
      updateHeaderSyncUI();
      syncModule.showSyncStatus('注册成功，已自动登录', 'success');
      closeLoginModal();
      // 新注册用户清空本地后从服务器下载（不上传）
      clearLocalDataAndRefresh();
      handleDownloadOnly();
    })
    .catch(err => {
      alert('注册失败: ' + err.message);
    });
}

function handleLogout() {
  // 退出时先清空本地数据，回到未登录的空白状态
  clearLocalDataAndRefresh();
  syncModule.logout();
  syncModule.updateSyncUI();
  updateHeaderSyncUI();
  syncModule.showSyncStatus('已退出登录', 'info');
}

// 仅从服务器下载数据（用于登录/注册后，不上传）
function handleDownloadOnly() {
  if (!syncModule.isLoggedIn()) {
    alert('请先登录');
    return;
  }
  var statusEl = document.getElementById('syncStatus');
  if (statusEl) { statusEl.textContent = '同步中...'; statusEl.className = 'sync-status-inline info'; }
  
  syncModule.syncFromServer().then(function(ok) {
    if (statusEl) {
      statusEl.textContent = ok ? '已同步' : '同步失败';
      statusEl.className = 'sync-status-inline ' + (ok ? 'success' : 'error');
      setTimeout(function() { statusEl.textContent = ''; statusEl.className = 'sync-status-inline'; }, 3000);
    }
  });
}

function handleFullSync() {
  if (!syncModule.isLoggedIn()) {
    alert('请先登录');
    return;
  }
  // 显示顶部状态
  var statusEl = document.getElementById('syncStatus');
  if (statusEl) { statusEl.textContent = '同步中...'; statusEl.className = 'sync-status-inline info'; }
  syncModule.fullSync().then(function(ok) {
    if (statusEl) {
      statusEl.textContent = ok ? '已同步' : '同步失败';
      statusEl.className = 'sync-status-inline ' + (ok ? 'success' : 'error');
      setTimeout(function() { statusEl.textContent = ''; statusEl.className = 'sync-status-inline'; }, 3000);
    }
  });
}

function handleToggleAutoSync() {
  const isOn = syncModule.toggleAutoSync();
  var btn1 = document.getElementById('btnAutoSync');
  var btn2 = document.getElementById('headerBtnAutoSync');
  if (btn1) btn1.textContent = '自动同步: ' + (isOn ? '开' : '关');
  if (btn2) btn2.textContent = '自动: ' + (isOn ? '开' : '关');
  syncModule.showSyncStatus(isOn ? '自动同步已开启' : '自动同步已关闭', 'info');
}

// ===== 管理员面板功能 =====

var currentAdminUser = null;
var adminUserList = [];

function toggleAdminPanel() {
  var panel = document.getElementById('adminPanel');
  if (panel.style.display === 'flex') {
    panel.style.display = 'none';
  } else {
    panel.style.display = 'flex';
    refreshAdminStats();
    refreshAdminUserList();
  }
}

function refreshAdminStats() {
  if (!syncModule.isLoggedIn() || syncModule.getCurrentUser().role !== 'admin') {
    return;
  }
  
  var userId = syncModule.getCurrentUser().id;
  var serverUrl = syncModule.getServerUrl();
  
  fetch(serverUrl + '/api/admin/stats?adminId=' + userId)
    .then(res => res.json())
    .then(data => {
      document.getElementById('adminStatUsers').textContent = data.user_count || 0;
      document.getElementById('adminStatTrades').textContent = data.trade_count || 0;
      document.getElementById('adminStatDeposit').textContent = (data.total_deposit || 0).toLocaleString() + ' ￥';
      document.getElementById('adminStatWithdraw').textContent = (data.total_withdrawal || 0).toLocaleString() + ' ￥';
    })
    .catch(err => {
      console.error('获取统计数据失败:', err);
    });
}

function refreshAdminUserList() {
  if (!syncModule.isLoggedIn() || syncModule.getCurrentUser().role !== 'admin') {
    return;
  }
  
  var userId = syncModule.getCurrentUser().id;
  var serverUrl = syncModule.getServerUrl();
  
  fetch(serverUrl + '/api/admin/users?adminId=' + userId)
    .then(res => res.json())
    .then(data => {
      adminUserList = data.users || [];
      renderAdminUserList(adminUserList);
    })
    .catch(err => {
      console.error('获取用户列表失败:', err);
      document.getElementById('adminUserList').innerHTML = '<div class="error">加载失败</div>';
    });
}

function renderAdminUserList(users) {
  var listEl = document.getElementById('adminUserList');
  if (!users || users.length === 0) {
    listEl.innerHTML = '<div class="empty">暂无用户</div>';
    return;
  }
  
  var html = users.map(user => `
    <div class="user-item" onclick="showAdminUserDetail('${user.id}', '${escapeHtml(user.username)}')">
      <div class="user-info">
        <span class="user-name">${escapeHtml(user.username)}</span>
        <span class="user-role ${user.role === 'admin' ? 'role-admin' : 'role-user'}">${user.role === 'admin' ? '管理员' : '普通用户'}</span>
      </div>
      <div class="user-meta">
        <span class="user-date">${user.created_at}</span>
      </div>
    </div>
  `).join('');
  
  listEl.innerHTML = html;
}

function filterAdminUserList() {
  var search = document.getElementById('adminSearchUser').value.toLowerCase();
  var filtered = adminUserList.filter(user => 
    user.username.toLowerCase().includes(search)
  );
  renderAdminUserList(filtered);
}

function showAdminUserDetail(userId, username) {
  currentAdminUser = { id: userId, username: username };
  document.getElementById('adminDetailUsername').textContent = username;
  document.getElementById('adminUserDetail').style.display = 'block';
  document.querySelector('.admin-section:not(#adminUserDetail)').style.display = 'none';
  showUserDetailTab('trades');
}

function closeAdminUserDetail() {
  currentAdminUser = null;
  document.getElementById('adminUserDetail').style.display = 'none';
  document.querySelector('.admin-section:not(#adminUserDetail)').style.display = 'block';
}

function showUserDetailTab(tab) {
  if (!currentAdminUser) return;
  
  var userId = syncModule.getCurrentUser().id;
  var serverUrl = syncModule.getServerUrl();
  
  fetch(serverUrl + '/api/admin/user/' + currentAdminUser.id + '?adminId=' + userId)
    .then(res => res.json())
    .then(data => {
      var contentEl = document.getElementById('adminDetailContent');
      
      if (tab === 'trades') {
        renderAdminTrades(data.trades || []);
      } else if (tab === 'funds') {
        renderAdminFunds(data.deposits || [], data.withdrawals || []);
      } else if (tab === 'settings') {
        renderAdminSettings(data.settings);
      }
      
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelector('.tab-btn[onclick="showUserDetailTab(\'' + tab + '\')"]').classList.add('active');
    })
    .catch(err => {
      console.error('获取用户详情失败:', err);
      document.getElementById('adminDetailContent').innerHTML = '<div class="error">加载失败</div>';
    });
}

function renderAdminTrades(trades) {
  var contentEl = document.getElementById('adminDetailContent');
  if (trades.length === 0) {
    contentEl.innerHTML = '<div class="empty">暂无交易记录</div>';
    return;
  }
  
  var html = `
    <table class="admin-table">
      <thead>
        <tr><th>日期</th><th>品种</th><th>方向</th><th>入场价</th><th>出场价</th><th>盈亏</th><th>状态</th></tr>
      </thead>
      <tbody>
        ${trades.map(t => `
          <tr>
            <td>${t.open_date || '-'}</td>
            <td>${escapeHtml(t.symbol || '-')}</td>
            <td>${t.direction || '-'}</td>
            <td>${t.entry_price || '-'}</td>
            <td>${t.close_price || '-'}</td>
            <td>${(t.pnl_amount !== undefined ? (t.pnl_amount >= 0 ? '+' : '') + t.pnl_amount.toLocaleString() : '-')} ￥</td>
            <td>${t.status || '-'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  
  contentEl.innerHTML = html;
}

function renderAdminFunds(deposits, withdrawals) {
  var contentEl = document.getElementById('adminDetailContent');
  
  var depositHtml = deposits.length > 0 ? `
    <div class="fund-section">
      <h5>💰 入金记录</h5>
      <table class="admin-table">
        <thead><tr><th>日期</th><th>金额</th></tr></thead>
        <tbody>
          ${deposits.map(d => `<tr><td>${d.date}</td><td>+${d.amount.toLocaleString()} ￥</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="fund-total">累计入金: <strong>+${deposits.reduce((sum, d) => sum + d.amount, 0).toLocaleString()} ￥</strong></div>
    </div>
  ` : '';
  
  var withdrawHtml = withdrawals.length > 0 ? `
    <div class="fund-section">
      <h5>💸 出金记录</h5>
      <table class="admin-table">
        <thead><tr><th>日期</th><th>金额</th></tr></thead>
        <tbody>
          ${withdrawals.map(w => `<tr><td>${w.date}</td><td>-${w.amount.toLocaleString()} ￥</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="fund-total">累计出金: <strong>-${withdrawals.reduce((sum, w) => sum + w.amount, 0).toLocaleString()} ￥</strong></div>
    </div>
  ` : '';
  
  if (!depositHtml && !withdrawHtml) {
    contentEl.innerHTML = '<div class="empty">暂无资金记录</div>';
    return;
  }
  
  contentEl.innerHTML = depositHtml + withdrawHtml;
}

function renderAdminSettings(settings) {
  var contentEl = document.getElementById('adminDetailContent');
  if (!settings) {
    contentEl.innerHTML = '<div class="empty">暂无设置数据</div>';
    return;
  }
  
  contentEl.innerHTML = `
    <div class="settings-grid">
      <div class="setting-item">
        <label>初始资金</label>
        <span>${(settings.init_capital || 0).toLocaleString()} ￥</span>
      </div>
      <div class="setting-item">
        <label>风险百分比</label>
        <span>${settings.risk_pct || 0}%</span>
      </div>
      <div class="setting-item">
        <label>最大风险</label>
        <span>${settings.max_risk || 0}</span>
      </div>
      <div class="setting-item">
        <label>手续费率</label>
        <span>${settings.fee_rate || 0}%</span>
      </div>
    </div>
  `;
}

function deleteUserWithConfirm() {
  if (!currentAdminUser) return;
  
  if (!confirm(`确认删除用户 "${currentAdminUser.username}" 及其所有数据？此操作不可撤销！`)) {
    return;
  }
  
  var userId = syncModule.getCurrentUser().id;
  var serverUrl = syncModule.getServerUrl();
  
  fetch(serverUrl + '/api/admin/user/' + currentAdminUser.id + '?adminId=' + userId, {
    method: 'DELETE'
  })
  .then(res => res.json())
  .then(data => {
    alert('用户删除成功');
    closeAdminUserDetail();
    refreshAdminUserList();
    refreshAdminStats();
  })
  .catch(err => {
    console.error('删除用户失败:', err);
    alert('删除失败');
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 更新管理员菜单显示
function updateAdminMenu() {
  var user = syncModule.getCurrentUser();
  var adminMenu = document.getElementById('adminMenu');
  var headerLoggedIn = document.getElementById('headerSyncLoggedIn');
  
  if (user && user.role === 'admin') {
    if (adminMenu) adminMenu.style.display = 'flex';
    if (headerLoggedIn) headerLoggedIn.style.display = 'none';
  } else {
    if (adminMenu) adminMenu.style.display = 'none';
  }
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', function() {
  // 重置实际手数修改标志
  userModifiedActualLots = false;
  
  // 初始化同步模块
  syncModule.initSync();
  syncModule.updateSyncUI();
  updateHeaderSyncUI();
  
  // 初始化数据库，然后加载数据
  initStorage().then(function() {
    loadAccountParams();
    loadFunds();
    initModalDatePicker();
    updateAll();
    console.log('应用初始化完成');
    
    // 如果已登录，自动同步一次
    if (syncModule.isLoggedIn()) {
      syncModule.syncFromServer();
    }
  }).catch(function(err) {
    console.error('初始化失败:', err);
    // 即使失败也继续加载
    loadAccountParams();
    loadFunds();
    initModalDatePicker();
    updateAll();
  });
});
