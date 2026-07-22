let diary2Data = [];
let diary2FilteredData = [];
let diary2CurrentPage = 1;
let diary2PageSize = 20;
let diary2SortField = 'tradeDate';
let diary2SortOrder = 'desc';
let diary2CurrentUserId = null;
let diary2IsLoggedIn = false;

function initDiary2() {
  loadDiaryData();
  setupEventListeners();
  // 关键：页面加载时清理指向已删除交易的自动同步条目
  // 场景：在 index.html 清空交易后，复盘总结里的自动同步条目会变成孤儿
  cleanupDeletedTrades();
  // 自动从交易记录同步（与 index 数据联动）
  syncFromTrades();
  applyFilters();
  checkLoginStatus();
  // 订阅全局登录/登出事件
  setupDiary2LoginEvents();
  // 注册全局搜索（diary2 页：搜索复盘记录）
  setupDiary2GlobalSearch();
  // 把所有原生 select 升级为 custom-select（视觉与"买点类型"统一）
  upgradeDiary2Selects();
}

// 把所有原生 <select> 升级为 custom-select
// 升级本身有幂等保护（dataset.csUpgraded 标记），多次调用安全
function upgradeDiary2Selects() {
  if (typeof upgradeSelectToCustom !== 'function') return;
  document.querySelectorAll('select').forEach(upgradeSelectToCustom);
}

// 订阅全局登录/登出事件，修复"未登录状态打开页面后登录"导致复盘不同步的 bug
function setupDiary2LoginEvents() {
  window.addEventListener('user-login', function() {
    console.log('[Diary2] 收到 user-login 事件，重新检查登录状态');
    checkLoginStatus();
  });
  window.addEventListener('user-logout', function() {
    console.log('[Diary2] 收到 user-logout 事件，重置登录状态');
    diary2IsLoggedIn = false;
    diary2CurrentUserId = null;
    document.getElementById('headerSyncLoggedIn').style.display = 'none';
    document.getElementById('headerSyncLoggedOut').style.display = 'flex';
  });
  // 监听交易清空事件：如果在 index.html 触发了"清空交易"，
  // 这里及时清理复盘总结里指向已删除交易的自动同步条目
  window.addEventListener('trades-cleared', function() {
    console.log('[Diary2] 收到 trades-cleared 事件，清理孤立条目');
    var before = diary2Data.length;
    cleanupDeletedTrades();
    if (diary2Data.length !== before) {
      applyFilters();
      if (diary2IsLoggedIn && diary2CurrentUserId) {
        syncToServer();
      }
    }
  });
}

function setupDiary2GlobalSearch() {
  window.performGlobalSearch = function(q) {
    if (!Array.isArray(diary2Data)) return [];
    var ql = q.toLowerCase();
    var results = [];
    for (var i = 0; i < diary2Data.length; i++) {
      var d = diary2Data[i];
      var fields = [d.tradeDate, d.symbol, d.dir, d.tradeLogic, d.mood, d.lesson, d.improvement, d.followSystem]
        .filter(function(v) { return v !== null && v !== undefined; }).join(' ');
      if (fields.toLowerCase().indexOf(ql) !== -1) {
        var pnlStr = d.pnlPercent !== undefined ? (parseFloat(d.pnlPercent) >= 0 ? '+' : '') + d.pnlPercent + '%' : '-';
        results.push({
          label: (d.tradeDate || '') + ' · ' + (d.symbol || '') + ' · ' + pnlStr,
          sublabel: d.tradeLogic ? '逻辑：' + d.tradeLogic.slice(0, 50) : (d.lesson ? '教训：' + d.lesson.slice(0, 50) : '未填写'),
          onClick: (function(recId) {
            return function() {
              if (typeof viewDiary === 'function') viewDiary(recId);
            };
          })(d.id)
        });
      }
    }
    return results;
  };
}

// 从 index 的交易记录（localStorage trades_v4）同步到 diary2
// 仅对 diary2 中尚不存在的 (tradeDate, symbol) 组合创建复盘条目
// 已有的复盘记录（包含 tradeLogic/mood/lesson 等用户填写的内容）不会被覆盖
function syncFromTrades() {
  var tradesRaw = null;
  try { tradesRaw = localStorage.getItem('trades_v4'); } catch(e) { return 0; }
  if (!tradesRaw) return 0;
  var tradesData = [];
  try { tradesData = JSON.parse(tradesRaw) || []; } catch(e) { return 0; }
  if (!Array.isArray(tradesData) || tradesData.length === 0) return 0;

  // 加载现有的 trades 同步状态
  var lastSyncedIds = {};
  try {
    var stored = localStorage.getItem('diary2_synced_trade_ids');
    if (stored) lastSyncedIds = JSON.parse(stored) || {};
  } catch(e) {}

  var addedCount = 0;
  tradesData.forEach(function(t) {
    if (!t.id || !t.date || !t.symbol) return;
    var tradeIdStr = String(t.id);
    // 已同步过的 trade 跳过
    if (lastSyncedIds[tradeIdStr]) return;
    // 检查 diary2Data 中是否已有相同 tradeId 的记录
    var existsByTradeId = diary2Data.some(function(d) {
      return d.tradeId && String(d.tradeId) === tradeIdStr;
    });
    if (existsByTradeId) {
      lastSyncedIds[tradeIdStr] = true;
      return;
    }
    // 检查是否已有相同 (tradeDate, symbol) 的记录
    var existsByDateSymbol = diary2Data.some(function(d) {
      return d.tradeDate === t.date && d.symbol === t.symbol;
    });
    if (existsByDateSymbol) {
      lastSyncedIds[tradeIdStr] = true;
      return;
    }

    // 计算盈亏百分比（用于显示）
    var pnlPercent = 0;
    if (t.entry && t.exit && parseFloat(t.entry) > 0) {
      var e = parseFloat(t.entry), ex = parseFloat(t.exit);
      var pct = t.dir === '多' ? (ex - e) / e : (e - ex) / e;
      pnlPercent = Math.round(pct * 10000) / 100;
    } else if (t.posSize && t.pnl && parseFloat(t.posSize) > 0) {
      pnlPercent = Math.round(parseFloat(t.pnl) / parseFloat(t.posSize) * 10000) / 100;
    }

    diary2Data.push({
      id: 'trade_' + tradeIdStr,
      tradeId: tradeIdStr,           // 关联到原 trade 的 id
      tradeDate: t.date,
      symbol: t.symbol,
      dir: t.dir || '',
      entry: t.entry || '',
      exit: t.exit || '',
      pnl: t.pnl !== '' ? t.pnl : 0,
      pnlR: t.pnlR !== '' ? t.pnlR : 0,
      pnlPercent: pnlPercent,
      tradeLogic: '',
      mood: '',
      followSystem: t.followedPlan || '是',
      lesson: '',
      improvement: t.note || '',     // 把 trade 的备注作为改进措施的初始值
      createdAt: t.openTime || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _autoSynced: true
    });
    lastSyncedIds[tradeIdStr] = true;
    addedCount++;
  });

  // 保存同步状态
  try { localStorage.setItem('diary2_synced_trade_ids', JSON.stringify(lastSyncedIds)); } catch(e) {}

  if (addedCount > 0) {
    saveDiaryData();
    showSyncStatus('已从交易记录同步 ' + addedCount + ' 条', 'success');
  }
  return addedCount;
}

// 手动触发从交易记录同步
function manualSyncFromTrades() {
  // 重置同步状态以强制重新检查
  try { localStorage.removeItem('diary2_synced_trade_ids'); } catch(e) {}
  // 同时清理已删除的 trade 对应的 diary 条目
  cleanupDeletedTrades();
  var added = syncFromTrades();
  if (added === 0) {
    showSyncStatus('没有新交易需要同步', 'info');
  }
  applyFilters();
}

// 清理已删除的 trade 对应的自动同步条目
// 仅清理用户未填写复盘内容的条目
function cleanupDeletedTrades() {
  var tradesRaw = null;
  try { tradesRaw = localStorage.getItem('trades_v4'); } catch(e) { return; }
  if (!tradesRaw) return;
  var tradesData = [];
  try { tradesData = JSON.parse(tradesRaw) || []; } catch(e) { return; }
  var currentTradeIds = {};
  tradesData.forEach(function(t) {
    if (t.id) currentTradeIds[String(t.id)] = true;
  });

  var before = diary2Data.length;
  diary2Data = diary2Data.filter(function(d) {
    // 仅自动同步且无复盘内容的条目可以清理
    if (!d._autoSynced || !d.tradeId) return true;
    if (currentTradeIds[String(d.tradeId)]) return true;
    // 原 trade 已被删除，检查是否填写了复盘内容
    if (d.tradeLogic || d.mood || d.lesson || d.improvement) {
      // 用户已填写复盘内容，保留（移除 _autoSynced 标记，转为独立条目）
      d._autoSynced = false;
      d.tradeId = null;
      return true;
    }
    return false;  // 未填写复盘内容，删除
  });
  if (diary2Data.length !== before) {
    saveDiaryData();
  }
}

function loadDiaryData() {
  const stored = localStorage.getItem('diary2_data');
  if (stored) {
    try {
      diary2Data = JSON.parse(stored);
    } catch (e) {
      console.error('加载数据失败:', e);
      diary2Data = [];
    }
  }
}

function saveDiaryData() {
  try {
    localStorage.setItem('diary2_data', JSON.stringify(diary2Data));
    if (diary2IsLoggedIn && diary2CurrentUserId) {
      syncToServer();
    }
  } catch (e) {
    console.error('保存数据失败:', e);
  }
}

function generateId() {
  return 'diary_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function setupEventListeners() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeDiaryModal();
      closeDeleteDiaryModal();
      closeViewDiaryModal();
    }
  });
  
  const table = document.getElementById('diaryTable');
  if (table) {
    table.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && e.target.tagName === 'TH') {
        const field = e.target.getAttribute('onclick')?.match(/sortDiary\('(\w+)'\)/)?.[1];
        if (field) sortDiary(field);
      }
    });
  }
}

function checkLoginStatus() {
  if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
    const user = syncModule.getCurrentUser();
    diary2CurrentUserId = user.id;
    diary2IsLoggedIn = true;
    document.getElementById('headerSyncLoggedIn').style.display = 'flex';
    document.getElementById('headerSyncLoggedOut').style.display = 'none';
    document.getElementById('headerUsername').textContent = user.username;
    loadFromServer();
  } else {
    showNotLoggedIn();
  }
}

function showNotLoggedIn() {
  document.getElementById('headerSyncLoggedIn').style.display = 'none';
  document.getElementById('headerSyncLoggedOut').style.display = 'flex';
}

function loadFromServer() {
  if (!diary2CurrentUserId) return;

  fetch(`/api/diary/${diary2CurrentUserId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  .then(res => res.json())
  .then(data => {
    if (data.diary && data.diary.length > 0) {
      var serverDiary = data.diary.map(item => ({
        id: item.id,
        tradeDate: item.trade_date || item.tradeDate,
        symbol: item.symbol,
        pnlPercent: item.pnl_percent || item.pnlPercent,
        tradeLogic: item.trade_logic || item.tradeLogic,
        mood: item.mood,
        followSystem: item.follow_system || item.followSystem,
        lesson: item.lesson,
        improvement: item.improvement,
        createdAt: item.created_at || item.createdAt,
        updatedAt: item.updated_at || item.updatedAt
      }));
      // 关键修复：合并而非覆盖
      // 服务器数据 + 本地存在但服务器没有的复盘（按 tradeDate+symbol+id 复合键判断）
      // 换电脑登录时，本地未同步的复盘会被增量上传
      var byKey = {};
      var makeKey = function(d) { return (d.id || '') + '|' + (d.tradeDate || '') + '|' + (d.symbol || ''); };
      serverDiary.forEach(function(d) { byKey[makeKey(d)] = d; });
      var localOnly = [];
      diary2Data.forEach(function(d) {
        if (byKey[makeKey(d)]) return;  // 服务器有
        if (d._autoSynced && !d.tradeLogic && !d.mood && !d.lesson && !d.improvement) return;  // 自动同步但未填写，跳过
        localOnly.push(d);
      });
      diary2Data = serverDiary.concat(localOnly);
      saveDiaryData();
      applyFilters();
      // 增量上传本地独有的复盘
      if (localOnly.length > 0) {
        console.log('[Diary2] 检测到本地有 ' + localOnly.length + ' 条未同步的复盘，正在增量上传...');
        localOnly.forEach(function(d) {
          // 调用 syncToServer 上传该条（注意：syncToServer 上传的是 diary2Data 全部，先用 backup 替换）
          var backup = diary2Data;
          diary2Data = [d];
          try { syncToServer(); } catch(e) {}
          diary2Data = backup;
        });
        showSyncStatus('已增量上传 ' + localOnly.length + ' 条复盘', 'success');
      } else {
        showSyncStatus('同步成功', 'success');
      }
    }
  })
  .catch(err => {
    console.error('从服务器加载失败:', err);
  });
}

function syncToServer() {
  if (!diary2CurrentUserId) return;
  
  fetch(`/api/diary/${diary2CurrentUserId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ diary: diary2Data })
  })
  .then(res => res.json())
  .then(data => {
    showSyncStatus('数据已同步', 'success');
  })
  .catch(err => {
    console.error('同步失败:', err);
    showSyncStatus('同步失败', 'error');
  });
}

function syncData() {
  syncToServer();
}

function handleLogout() {
  localStorage.removeItem('currentUser');
  diary2CurrentUserId = null;
  diary2IsLoggedIn = false;
  document.getElementById('headerSyncLoggedIn').style.display = 'none';
  document.getElementById('headerSyncLoggedOut').style.display = 'flex';
}

function openLoginModal() {
  if (confirm('您需要登录才能同步数据。是否返回主页面进行登录？\n\n提示：您可以在未登录状态下使用本地存储功能。')) {
    window.location.href = 'index.html';
  }
}

function showSyncStatus(message, type) {
  const statusEl = document.getElementById('syncStatus');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = 'sync-status-inline ' + type;
    setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'sync-status-inline';
    }, 3000);
  }
}

function applyFilters() {
  const quickFilter = document.getElementById('quickFilter')?.value || 'all';
  const startDate = document.getElementById('filterStartDate')?.value || '';
  const endDate = document.getElementById('filterEndDate')?.value || '';
  
  diary2FilteredData = diary2Data.filter(item => {
    if (quickFilter !== 'all') {
      switch (quickFilter) {
        case 'thisMonth':
          const now = new Date();
          const itemDate = new Date(item.tradeDate);
          if (itemDate.getMonth() !== now.getMonth() || itemDate.getFullYear() !== now.getFullYear()) {
            return false;
          }
          break;
        case 'thisWeek':
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);
          if (new Date(item.tradeDate) < weekAgo) {
            return false;
          }
          break;
        case 'win':
          if (parseFloat(item.pnlPercent) <= 0) return false;
          break;
        case 'loss':
          if (parseFloat(item.pnlPercent) >= 0) return false;
          break;
        case 'breakeven':
          if (parseFloat(item.pnlPercent) !== 0) return false;
          break;
        case 'followingSystem':
          if (item.followSystem !== '是') return false;
          break;
        case 'notFollowing':
          if (item.followSystem !== '否') return false;
          break;
      }
    }
    
    if (startDate && item.tradeDate < startDate) {
      return false;
    }
    
    if (endDate && item.tradeDate > endDate) {
      return false;
    }
    
    return true;
  });
  
  diary2CurrentPage = 1;
  renderTable();
}

function applyQuickFilter() {
  applyFilters();
}

function clearFilters() {
  document.getElementById('quickFilter').value = 'all';
  document.getElementById('filterStartDate').value = '';
  document.getElementById('filterEndDate').value = '';
  applyFilters();
}

function sortDiary(field) {
  if (diary2SortField === field) {
    diary2SortOrder = diary2SortOrder === 'asc' ? 'desc' : 'asc';
  } else {
    diary2SortField = field;
    diary2SortOrder = 'asc';
  }
  
  const headers = document.querySelectorAll('#diaryTable thead th');
  headers.forEach(th => {
    th.setAttribute('aria-sort', 'none');
  });
  
  const currentHeader = document.querySelector(`th[onclick="sortDiary('${field}')"]`);
  if (currentHeader) {
    currentHeader.setAttribute('aria-sort', diary2SortOrder === 'asc' ? 'ascending' : 'descending');
  }
  
  diary2FilteredData.sort((a, b) => {
    let valA = a[field];
    let valB = b[field];
    
    if (field === 'tradeDate') {
      valA = new Date(valA);
      valB = new Date(valB);
    } else if (field === 'pnlPercent') {
      valA = parseFloat(valA) || 0;
      valB = parseFloat(valB) || 0;
    }
    
    if (valA < valB) return diary2SortOrder === 'asc' ? -1 : 1;
    if (valA > valB) return diary2SortOrder === 'asc' ? 1 : -1;
    return 0;
  });
  
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('diaryTableBody');
  if (!tbody) return;
  
  const start = (diary2CurrentPage - 1) * diary2PageSize;
  const end = start + diary2PageSize;
  const pageData = diary2FilteredData.slice(start, end);
  
  if (pageData.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 40px; color: var(--text-tertiary);">
          暂无复盘记录，请点击"新增记录"添加
        </td>
      </tr>
    `;
    updatePagination();
    return;
  }
  
  tbody.innerHTML = pageData.map(item => {
    var dirBadge = '';
    if (item.dir === '多') dirBadge = '<span class="dir-badge dir-long" title="多头">多</span> ';
    else if (item.dir === '空') dirBadge = '<span class="dir-badge dir-short" title="空头">空</span> ';
    var syncBadge = item._autoSynced ? '<span class="sync-badge" title="自动从交易记录同步">🔗</span> ' : '';
    var pnlVal = parseFloat(item.pnlPercent) || 0;
    return `
    <tr>
      <td class="text-center">${item.tradeDate}</td>
      <td class="text-center">${syncBadge}${dirBadge}<strong>${escapeHtml(item.symbol)}</strong></td>
      <td class="text-center">
        <span class="pnl-badge ${pnlVal > 0 ? 'positive' : pnlVal < 0 ? 'negative' : 'zero'}">
          ${pnlVal > 0 ? '+' : ''}${item.pnlPercent}%
        </span>
      </td>
      <td class="text-left">
        <div class="table-content text-column-content" title="${escapeHtml(item.tradeLogic || '-')}">
          ${escapeHtml(item.tradeLogic) || '<span style="color: var(--text-tertiary);">-</span>'}
        </div>
      </td>
      <td class="text-left">
        <div class="table-content text-column-content" title="${escapeHtml(item.mood || '-')}">
          ${escapeHtml(item.mood) || '<span style="color: var(--text-tertiary);">-</span>'}
        </div>
      </td>
      <td class="text-center">
        <span class="system-badge ${item.followSystem === '是' ? 'yes' : 'no'}">
          ${item.followSystem || '否'}
        </span>
      </td>
      <td class="text-left">
        <div class="table-content text-column-content" title="${escapeHtml(item.lesson || '-')}">
          ${escapeHtml(item.lesson) || '<span style="color: var(--text-tertiary);">-</span>'}
        </div>
      </td>
      <td class="text-left">
        <div class="table-content text-column-content" title="${escapeHtml(item.improvement || '-')}">
          ${escapeHtml(item.improvement) || '<span style="color: var(--text-tertiary);">-</span>'}
        </div>
      </td>
      <td class="text-center">
        <div style="display: flex; gap: 6px; justify-content: center;">
          <button class="btn btn-sm btn-ghost" onclick="viewDiary('${item.id}')" title="查看">👁️</button>
          <button class="btn btn-sm btn-ghost" onclick="editDiary('${item.id}')" title="编辑">✏️</button>
          <button class="btn btn-sm btn-ghost-danger" onclick="deleteDiary('${item.id}')" title="删除">🗑️</button>
        </div>
      </td>
    </tr>
  `;
  }).join('');
  
  updatePagination();
}

function updatePagination() {
  const totalPages = Math.ceil(diary2FilteredData.length / diary2PageSize) || 1;
  const start = diary2FilteredData.length === 0 ? 0 : (diary2CurrentPage - 1) * diary2PageSize + 1;
  const end = Math.min(diary2CurrentPage * diary2PageSize, diary2FilteredData.length);
  
  const tableInfoEl = document.getElementById('tableInfo');
  if (tableInfoEl) tableInfoEl.textContent = `显示 ${start}-${end} 条，共 ${diary2FilteredData.length} 条`;
  
  const pageInfoEl = document.getElementById('pageInfo');
  if (pageInfoEl) pageInfoEl.textContent = `第 ${diary2CurrentPage} 页`;
  
  const prevPageEl = document.getElementById('prevPage');
  if (prevPageEl) prevPageEl.disabled = diary2CurrentPage <= 1;
  
  const nextPageEl = document.getElementById('nextPage');
  if (nextPageEl) nextPageEl.disabled = diary2CurrentPage >= totalPages;
}

function changePageSize() {
  var el = document.getElementById('pageSize') || document.getElementById('diary2PageSize');
  diary2PageSize = parseInt(el.value) || 20;
  diary2CurrentPage = 1;
  renderTable();
}

function prevPage() {
  if (diary2CurrentPage > 1) {
    diary2CurrentPage--;
    renderTable();
  }
}

function nextPage() {
  const totalPages = Math.ceil(diary2FilteredData.length / diary2PageSize) || 1;
  if (diary2CurrentPage < totalPages) {
    diary2CurrentPage++;
    renderTable();
  }
}

function openAddDiaryModal() {
  try {
    document.getElementById('modalTitle').textContent = '📝 新增复盘记录';
    document.getElementById('diaryId').value = '';
    document.getElementById('diaryForm').reset();
    document.getElementById('diaryDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('diaryModal').classList.add('show');
    // 升级弹窗内所有原生 select 为 custom-select（视觉与"买点类型"统一）
    if (typeof upgradeSelectToCustom === 'function') {
      document.querySelectorAll('#diaryModal select').forEach(upgradeSelectToCustom);
    }
  } catch (error) {
    console.error('打开模态框失败:', error);
    alert('打开记录表单失败，请刷新页面重试');
  }
}

function editDiary(id) {
  const item = diary2Data.find(d => d.id === id);
  if (!item) return;
  
  document.getElementById('modalTitle').textContent = '✏️ 编辑复盘记录';
  document.getElementById('diaryId').value = item.id;
  document.getElementById('diaryDate').value = item.tradeDate;
  document.getElementById('diarySymbol').value = item.symbol;
  document.getElementById('diaryPnlPercent').value = item.pnlPercent;
  document.getElementById('diaryTradeLogic').value = item.tradeLogic || '';
  document.getElementById('diaryMood').value = item.mood || '';
  document.getElementById('diaryFollowSystem').value = item.followSystem || '否';
  document.getElementById('diaryLesson').value = item.lesson || '';
  document.getElementById('diaryImprovement').value = item.improvement || '';

  document.getElementById('diaryModal').classList.add('show');
  // 升级弹窗内所有原生 select 为 custom-select（视觉与"买点类型"统一）
  if (typeof upgradeSelectToCustom === 'function') {
    document.querySelectorAll('#diaryModal select').forEach(upgradeSelectToCustom);
  }
}

function viewDiary(id) {
  const item = diary2Data.find(d => d.id === id);
  if (!item) return;
  
  document.getElementById('viewTitle').textContent = `📖 ${item.tradeDate} - ${item.symbol}`;
  
  const content = document.getElementById('viewDiaryContent');
  var dirHtml = '';
  if (item.dir) {
    dirHtml = `
    <div class="view-row">
      <div class="view-label">方向</div>
      <div class="view-value">
        <span class="dir-badge ${item.dir === '多' ? 'dir-long' : 'dir-short'}">${escapeHtml(item.dir)}</span>
      </div>
    </div>`;
  }
  var tradeInfoHtml = '';
  if (item.entry || item.exit) {
    tradeInfoHtml = `
    <div class="view-row">
      <div class="view-label">入场价 / 出场价</div>
      <div class="view-value">${escapeHtml(item.entry) || '-'} / ${escapeHtml(item.exit) || '-'}</div>
    </div>`;
  }
  var pnlHtml = '';
  if (item.pnl || item.pnlR) {
    var pnlNum = parseFloat(item.pnl) || 0;
    pnlHtml = `
    <div class="view-row">
      <div class="view-label">盈亏金额 / R 倍数</div>
      <div class="view-value">
        <span style="color:${pnlNum >= 0 ? 'var(--color-red)' : 'var(--color-green)'}">${pnlNum >= 0 ? '+' : ''}${item.pnl || 0} ￥</span>
        ${item.pnlR ? ' / ' + escapeHtml(item.pnlR) + 'R' : ''}
      </div>
    </div>`;
  }
  content.innerHTML = `
    <div class="view-row">
      <div class="view-label">代码/名称</div>
      <div class="view-value">${escapeHtml(item.symbol)}</div>
    </div>
    ${dirHtml}
    ${tradeInfoHtml}
    <div class="view-row">
      <div class="view-label">盈亏比例</div>
      <div class="view-value">
        <span class="pnl-badge ${parseFloat(item.pnlPercent) > 0 ? 'positive' : parseFloat(item.pnlPercent) < 0 ? 'negative' : 'zero'}">
          ${item.pnlPercent > 0 ? '+' : ''}${item.pnlPercent}%
        </span>
      </div>
    </div>
    ${pnlHtml}
    <div class="view-row">
      <div class="view-label">买入/卖出逻辑</div>
      <div class="view-value">${escapeHtml(item.tradeLogic) || '-'}</div>
    </div>
    <div class="view-row">
      <div class="view-label">当时心态</div>
      <div class="view-value">${escapeHtml(item.mood) || '-'}</div>
    </div>
    <div class="view-row">
      <div class="view-label">是否符合系统</div>
      <div class="view-value">
        <span class="system-badge ${item.followSystem === '是' ? 'yes' : 'no'}">${item.followSystem || '否'}</span>
      </div>
    </div>
    <div class="view-row">
      <div class="view-label">教训与总结</div>
      <div class="view-value">${escapeHtml(item.lesson) || '-'}</div>
    </div>
    <div class="view-row">
      <div class="view-label">改进措施</div>
      <div class="view-value">${escapeHtml(item.improvement) || '-'}</div>
    </div>
  `;
  
  window.currentViewingId = id;
  document.getElementById('viewDiaryModal').classList.add('show');
}

function editCurrentDiary() {
  if (window.currentViewingId) {
    closeViewDiaryModal();
    editDiary(window.currentViewingId);
  }
}

function closeViewDiaryModal() {
  document.getElementById('viewDiaryModal').classList.remove('show');
  window.currentViewingId = null;
}

function saveDiaryRecord(event) {
  event.preventDefault();
  
  const id = document.getElementById('diaryId').value;
  const record = {
    id: id || generateId(),
    tradeDate: document.getElementById('diaryDate').value,
    symbol: document.getElementById('diarySymbol').value.trim(),
    pnlPercent: parseFloat(document.getElementById('diaryPnlPercent').value) || 0,
    tradeLogic: document.getElementById('diaryTradeLogic').value.trim(),
    mood: document.getElementById('diaryMood').value.trim(),
    followSystem: document.getElementById('diaryFollowSystem').value,
    lesson: document.getElementById('diaryLesson').value.trim(),
    improvement: document.getElementById('diaryImprovement').value.trim(),
    updatedAt: new Date().toISOString()
  };
  
  if (!record.tradeDate || !record.symbol) {
    alert('请填写必填字段');
    return;
  }
  
  if (id) {
    const index = diary2Data.findIndex(d => d.id === id);
    if (index !== -1) {
      record.createdAt = diary2Data[index].createdAt;
      diary2Data[index] = record;
    }
  } else {
    record.createdAt = new Date().toISOString();
    diary2Data.push(record);
  }
  
  saveDiaryData();
  closeDiaryModal();
  applyFilters();
}



function closeDiaryModal() {
  document.getElementById('diaryModal').classList.remove('show');
  document.getElementById('diaryForm').reset();
}

function deleteDiary(id) {
  const item = diary2Data.find(d => d.id === id);
  if (!item) return;
  
  document.getElementById('deleteDiaryInfo').innerHTML = `
    <div><strong>日期:</strong> ${item.tradeDate}</div>
    <div><strong>品种:</strong> ${escapeHtml(item.symbol)}</div>
    <div><strong>盈亏:</strong> ${item.pnlPercent}%</div>
  `;
  
  window.currentDeleteId = id;
  document.getElementById('deleteDiaryModal').classList.add('show');
}

function confirmDeleteDiary() {
  if (window.currentDeleteId) {
    diary2Data = diary2Data.filter(d => d.id !== window.currentDeleteId);
    saveDiaryData();
    closeDeleteDiaryModal();
    applyFilters();
  }
}

function closeDeleteDiaryModal() {
  document.getElementById('deleteDiaryModal').classList.remove('show');
  window.currentDeleteId = null;
}

function exportDiaryData() {
  const dataStr = JSON.stringify(diary2Data, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `diary2_export_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importDiaryData(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported)) {
        const newData = imported.filter(item => item.tradeDate && item.symbol);
        if (newData.length > 0) {
          diary2Data = diary2Data.concat(newData.map(item => ({
            ...item,
            id: item.id || generateId()
          })));
          saveDiaryData();
          applyFilters();
          alert(`成功导入 ${newData.length} 条记录`);
        } else {
          alert('导入失败：数据格式不正确');
        }
      } else {
        alert('导入失败：不是有效的JSON数组');
      }
    } catch (err) {
      alert('导入失败：' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function handleFullSync() {
  if (!syncModule.isLoggedIn()) {
    alert('请先登录');
    return;
  }
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

function openChangePasswordModal() {
  var modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'flex';
}

