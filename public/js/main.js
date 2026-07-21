// ===== 仓位管理表 - 主入口 =====
// 模块化版本：将功能拆分为多个文件便于维护

// 引入各模块（需按依赖顺序加载）
// <script src="utils.js"></script>
// <script src="storage.js"></script>
// <script src="calculator.js"></script>
// <script src="table.js"></script>
// <script src="charts.js"></script>
// <script src="main.js"></script>

// ===== 工具函数 =====

// 防抖函数
function debounce(func, wait) {
  var timeout;
  return function executedFunction(...args) {
    var later = function() {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 自动保存函数（带防抖，500ms延迟）
var autoSave = debounce(function() {
  if (typeof save === 'function') {
    save().then(function() {
      console.log('本地保存完成');
      
      // 如果已登录，自动同步到服务器 SQLite 数据库
      if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
        syncModule.syncToServer().then(function(success) {
          if (success) {
            console.log('已同步到服务器 SQLite 数据库');
          } else {
            console.warn('服务器同步失败，将在下次尝试');
          }
        }).catch(function(err) {
          console.error('服务器同步失败:', err);
        });
      }
    }).catch(function(err) {
      console.error('本地保存失败:', err);
    });
  }
}, 500);

// 触发自动保存
function triggerAutoSave() {
  autoSave();
}

// 页面关闭前保存数据
window.addEventListener('beforeunload', function() {
  try { localStorage.setItem('trades_v4', JSON.stringify(trades)); } catch(e) {}
});

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

  // 更新今日仪表盘
  updateTodayDashboard();
  
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
  renderTableWithSelects();
  updateStats();
  if (typeof drawEquityCurve === 'function') drawEquityCurve();
  if (typeof drawPositionPie === 'function') drawPositionPie();
}

// ===== 入金出金弹窗函数 =====

// 初始化弹窗日期选择器
function initModalDatePicker() {
  var today = getToday();
  
  // 设置入金日期默认值
  var depositDateInput = document.getElementById('depositDate');
  if (depositDateInput) {
    depositDateInput.value = today;
  }
  
  // 设置出金日期默认值
  var withdrawDateInput = document.getElementById('withdrawDate');
  if (withdrawDateInput) {
    withdrawDateInput.value = today;
  }
}

// ===== 今日仪表盘 =====
function updateTodayDashboard() {
  var todayStr = getToday();
  var dateEl = document.getElementById('todayDashboardDate');
  if (dateEl) dateEl.textContent = todayStr;

  var openedCount = 0;
  var closedCount = 0;
  var todayPnl = 0;
  var todayWins = 0;
  var holdingCount = 0;

  if (typeof trades !== 'undefined' && Array.isArray(trades)) {
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      // 今日开仓（按 t.date 字段判断）
      if (t.date === todayStr) openedCount++;
      // 今日平仓（按 t.closeTime ISO 字符串前 10 位判断）
      if (t.closeTime && typeof t.closeTime === 'string' && t.closeTime.slice(0, 10) === todayStr) {
        closedCount++;
        if (t.pnl !== '' && !isNaN(parseFloat(t.pnl))) {
          todayPnl += parseFloat(t.pnl);
          if (parseFloat(t.pnl) > 0) todayWins++;
        }
      }
      // 当前持仓
      if (t.status === 'open') holdingCount++;
    }
  }

  var openedEl = document.getElementById('todayOpenedCount');
  if (openedEl) openedEl.textContent = openedCount;
  var closedEl = document.getElementById('todayClosedCount');
  if (closedEl) closedEl.textContent = closedCount;
  var pnlEl = document.getElementById('todayPnl');
  if (pnlEl) {
    pnlEl.textContent = (todayPnl >= 0 ? '+' : '') + CNY(todayPnl);
    pnlEl.className = 'today-metric-value ' + (todayPnl > 0 ? 'glow-red' : todayPnl < 0 ? 'glow-green' : '');
  }
  var winRateEl = document.getElementById('todayWinRate');
  if (winRateEl) {
    if (closedCount === 0) {
      winRateEl.textContent = '-';
    } else {
      var rate = Math.round(todayWins / closedCount * 100);
      winRateEl.textContent = rate + '%';
    }
  }
  var holdingEl = document.getElementById('todayHoldingCount');
  if (holdingEl) holdingEl.textContent = holdingCount;
}

// ===== 全局搜索（index 页：搜索交易记录） =====
window.performGlobalSearch = function(q) {
  if (typeof trades === 'undefined' || !Array.isArray(trades)) return [];
  var ql = q.toLowerCase();
  var results = [];
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    var fields = [t.date, t.symbol, t.dir, t.note, t.exitType, t.status].filter(function(v) { return v !== null && v !== undefined; }).join(' ');
    if (fields.toLowerCase().indexOf(ql) !== -1) {
      var pnlStr = t.pnl !== '' && !isNaN(parseFloat(t.pnl)) ? (parseFloat(t.pnl) >= 0 ? '+' : '') + CNY(parseFloat(t.pnl)) : '未平仓';
      results.push({
        label: (t.date || '') + ' · ' + (t.symbol || '') + ' · ' + (t.dir || '') + ' · ' + pnlStr,
        sublabel: t.note ? '备注：' + t.note : '状态：' + (t.status || '-'),
        onClick: (function(tradeId) {
          return function() {
            if (typeof openTradeDetail === 'function') openTradeDetail(tradeId);
          };
        })(t.id)
      });
    }
  }
  return results;
};

function showDepositModal() {
  document.getElementById('depositModal').style.display = 'flex';
  document.getElementById('depositAmount').value = '';
  document.getElementById('depositDate').value = getToday();
  renderDepositHistory();
}

function closeDepositModal() {
  document.getElementById('depositModal').style.display = 'none';
}

function renderDepositHistory() {
  var container = document.getElementById('depositHistoryList');
  if (!container) return;
  if (!deposits || deposits.length === 0) {
    container.innerHTML = '<div class="funds-history-empty">暂无入金记录</div>';
    return;
  }
  // 按日期倒序展示
  var sorted = deposits.slice().sort(function(a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });
  container.innerHTML = sorted.map(function(d) {
    return '<div class="funds-history-item">' +
      '<div class="funds-history-info">' +
        '<span class="funds-history-date">' + escapeHtml(d.date) + '</span>' +
        '<span class="funds-history-amount glow-red">+' + CNY(d.amount) + '</span>' +
      '</div>' +
      '<button class="btn btn-sm btn-ghost-danger" onclick="deleteDepositRecord(\'' + escapeHtml(String(d.id)) + '\')" title="删除">🗑️</button>' +
    '</div>';
  }).join('');
  var statsEl = document.getElementById('depositHistoryStats');
  if (statsEl) {
    statsEl.textContent = '共 ' + deposits.length + ' 笔，累计 ' + CNY(getTotalDeposit());
  }
}

function deleteDepositRecord(id) {
  if (!confirm('确认删除此入金记录？')) return;
  deleteDeposit(id).then(function(ok) {
    if (ok) {
      updateAll();
      renderDepositHistory();
      if (typeof triggerAutoSave === 'function') triggerAutoSave();
    } else {
      alert('未找到该记录');
    }
  }).catch(function(err) {
    console.error('删除入金失败:', err);
    alert('删除入金记录失败');
  });
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
    document.getElementById('depositAmount').value = '';
    renderDepositHistory();
    if (typeof triggerAutoSave === 'function') {
      triggerAutoSave();
    }
  }).catch(function(err) {
    console.error('入金失败:', err);
    alert('入金记录失败');
  });
}

function showWithdrawModal() {
  document.getElementById('withdrawModal').style.display = 'flex';
  document.getElementById('withdrawAmount').value = '';
  document.getElementById('withdrawDate').value = getToday();
  renderWithdrawHistory();
}

function closeWithdrawModal() {
  document.getElementById('withdrawModal').style.display = 'none';
}

function renderWithdrawHistory() {
  var container = document.getElementById('withdrawHistoryList');
  if (!container) return;
  if (!withdrawals || withdrawals.length === 0) {
    container.innerHTML = '<div class="funds-history-empty">暂无出金记录</div>';
    return;
  }
  var sorted = withdrawals.slice().sort(function(a, b) {
    return (b.date || '').localeCompare(a.date || '');
  });
  container.innerHTML = sorted.map(function(d) {
    return '<div class="funds-history-item">' +
      '<div class="funds-history-info">' +
        '<span class="funds-history-date">' + escapeHtml(d.date) + '</span>' +
        '<span class="funds-history-amount glow-green">-' + CNY(d.amount) + '</span>' +
      '</div>' +
      '<button class="btn btn-sm btn-ghost-danger" onclick="deleteWithdrawRecord(\'' + escapeHtml(String(d.id)) + '\')" title="删除">🗑️</button>' +
    '</div>';
  }).join('');
  var statsEl = document.getElementById('withdrawHistoryStats');
  if (statsEl) {
    statsEl.textContent = '共 ' + withdrawals.length + ' 笔，累计 ' + CNY(getTotalWithdraw());
  }
}

function deleteWithdrawRecord(id) {
  if (!confirm('确认删除此出金记录？')) return;
  deleteWithdrawal(id).then(function(ok) {
    if (ok) {
      updateAll();
      renderWithdrawHistory();
      if (typeof triggerAutoSave === 'function') triggerAutoSave();
    } else {
      alert('未找到该记录');
    }
  }).catch(function(err) {
    console.error('删除出金失败:', err);
    alert('删除出金记录失败');
  });
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
    document.getElementById('withdrawAmount').value = '';
    renderWithdrawHistory();
    if (typeof triggerAutoSave === 'function') {
      triggerAutoSave();
    }
  }).catch(function(err) {
    console.error('出金失败:', err);
    alert('出金记录失败');
  });
}

// ===== 清空记录 =====
function clearAll() {
  // 保留旧函数作为兼容入口，但重定向到新的设置弹窗
  openSettingsModal();
}

// ===== 设置弹窗（数据管理） =====
var clearActionType = null;  // 'trades' / 'funds' / 'all'

function openSettingsModal() {
  document.getElementById('settingsModal').style.display = 'flex';
  // 更新统计
  var tcEl = document.getElementById('settingsTradeCount');
  if (tcEl) tcEl.textContent = (typeof trades !== 'undefined' && trades) ? trades.length : 0;
  var dcEl = document.getElementById('settingsDepositCount');
  if (dcEl) dcEl.textContent = (typeof deposits !== 'undefined' && deposits) ? deposits.length : 0;
  var wcEl = document.getElementById('settingsWithdrawCount');
  if (wcEl) wcEl.textContent = (typeof withdrawals !== 'undefined' && withdrawals) ? withdrawals.length : 0;
}

function closeSettingsModal() {
  document.getElementById('settingsModal').style.display = 'none';
}

function openClearTradesConfirm() {
  openClearConfirmInternal('trades', '清空所有交易记录', '清空交易', 'CLEAR-TRADES');
}
function openClearFundsConfirm() {
  openClearConfirmInternal('funds', '清空所有资金记录', '清空资金', 'CLEAR-FUNDS');
}
function openClearAllConfirm() {
  openClearConfirmInternal('all', '清空全部数据', '清空全部', 'CLEAR-ALL');
}

function openClearConfirmInternal(type, title, actionLabel, verifyCode) {
  clearActionType = type;
  document.getElementById('clearConfirmTitle').textContent = '⚠️ ' + title;
  document.getElementById('clearConfirmAction').textContent = actionLabel;
  document.getElementById('clearConfirmCode').textContent = verifyCode;
  document.getElementById('clearConfirmInput').value = '';
  document.getElementById('clearConfirmBtn').disabled = true;
  document.getElementById('clearConfirmHint').textContent = '';
  document.getElementById('clearConfirmModal').style.display = 'flex';
}

function closeClearConfirm() {
  document.getElementById('clearConfirmModal').style.display = 'none';
  clearActionType = null;
}

// 监听输入验证
document.addEventListener('input', function(e) {
  if (e.target && e.target.id === 'clearConfirmInput') {
    var expected = document.getElementById('clearConfirmCode').textContent;
    var actual = e.target.value;
    var btn = document.getElementById('clearConfirmBtn');
    var hint = document.getElementById('clearConfirmHint');
    if (actual === expected) {
      btn.disabled = false;
      hint.textContent = '✓ 验证通过，可点击确认清空';
      hint.style.color = 'var(--color-green)';
    } else {
      btn.disabled = true;
      hint.textContent = '请准确输入 "' + expected + '" 以解锁确认按钮';
      hint.style.color = 'var(--text-tertiary)';
    }
  }
});

function executeClearAction() {
  if (!clearActionType) return;
  var type = clearActionType;
  closeClearConfirm();

  if (type === 'trades') {
    clearAllTradesData();
  } else if (type === 'funds') {
    clearAllFundsData();
  } else if (type === 'all') {
    clearAllTradesData();
    clearAllFundsData();
    // 清空账户参数
    localStorage.removeItem('account_params_v1');
    // 重置输入框为默认值
    var initEl = document.getElementById('initCapital');
    if (initEl) initEl.value = 100000;
    var riskPctEl = document.getElementById('riskPct');
    if (riskPctEl) riskPctEl.value = 2;
    var maxRiskEl = document.getElementById('maxRisk');
    if (maxRiskEl) maxRiskEl.value = 3;
    var feeRateEl = document.getElementById('feeRate');
    if (feeRateEl) feeRateEl.value = 0.1;
  }

  updateAll();
  // 重新打开设置弹窗以刷新统计
  openSettingsModal();
  alert('清空操作已完成');
}

function clearAllTradesData() {
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
  if (window.syncModule && typeof window.syncModule.clearServerData === 'function') {
    window.syncModule.clearServerData().then(function() {
      console.log('服务器数据已清空');
    }).catch(function(err) {
      console.error('清空服务器失败:', err);
    });
  }
}

function clearAllFundsData() {
  deposits = [];
  withdrawals = [];
  if (dbInitialized && db) {
    // 假设 DB 中也有 funds store - 这里只是清空内存和 localStorage
    // 完整的 DB 清空需要 addDepositToDB 等函数支持
    console.log('内存中的资金记录已清空');
  }
  localStorage.removeItem('funds_v1');
  if (window.syncModule && typeof window.syncModule.clearServerFundsData === 'function') {
    window.syncModule.clearServerFundsData().catch(function(err) {
      console.error('清空服务器资金数据失败:', err);
    });
  }
}

// ===== 导出CSV =====
function exportCSV() {
  var headers = ['#', '日期', '品种', '方向', '入场价', '止损价', '平保价', '止盈价', '止盈距离%', '仓位金额', '风险R', '出场价', '出场日期', '卖点类型', '盈亏距离%', '盈亏金额', '盈亏R', '状态', '备注'];
  var rows = trades.map(function(t, i) {
    return [i + 1, t.date, t.symbol, t.dir, t.entry, t.stop, t.breakEvenPrice, t.target, calcTpDist(t), t.posSize, t.riskAmount, t.exit, t.exitDate, t.exitType, calcExitDist(t), t.pnl, t.pnlR, t.status, t.note];
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
  var indicator = document.getElementById('syncIndicator');

  if (user) {
    // 更新管理员菜单显示
    updateAdminMenu();

    // 如果不是管理员，显示普通用户登录状态
    if (user.role !== 'admin') {
      if (loggedIn) { loggedIn.style.display = 'flex'; }
      if (loggedOut) { loggedOut.style.display = 'none'; }
      if (headerUsername) { headerUsername.textContent = user.username; }
      if (headerBtnAutoSync) {
        // 使用 SYNC_CONFIG.autoSync 作为真实状态来源（与 sync.js 中的默认值保持一致）
        // 避免 localStorage 未设置时（初始状态）显示错误
        var isAuto = (typeof SYNC_CONFIG !== 'undefined' && SYNC_CONFIG.autoSync === true);
        headerBtnAutoSync.textContent = '自动: ' + (isAuto ? '开' : '关');
      }
      // 初始化同步指示器（已登录但未同步）
      if (indicator && typeof syncModule.setSyncIndicatorState === 'function') {
        if (syncModule.getLastSyncTime && syncModule.getLastSyncTime()) {
          syncModule.setSyncIndicatorState('success', syncModule.buildSyncTooltip());
        } else {
          syncModule.setSyncIndicatorState('idle', '已登录，尚未同步');
        }
      }
    } else {
      // 管理员不显示普通用户的登录状态
      if (loggedIn) { loggedIn.style.display = 'none'; }
      if (loggedOut) { loggedOut.style.display = 'none'; }
      if (indicator && typeof syncModule.setSyncIndicatorState === 'function') {
        syncModule.setSyncIndicatorState('idle', '管理员模式');
      }
    }
  } else {
    if (loggedIn) { loggedIn.style.display = 'none'; }
    if (loggedOut) { loggedOut.style.display = 'flex'; }
    if (document.getElementById('adminMenu')) {
      document.getElementById('adminMenu').style.display = 'none';
    }
    if (indicator && typeof syncModule.setSyncIndicatorState === 'function') {
      syncModule.setSyncIndicatorState('offline', '未登录，无法同步');
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
      // 通知其他页面/模块：用户已登录
      try { window.dispatchEvent(new CustomEvent('user-login', { detail: syncModule.getCurrentUser() })); } catch(e) {}
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
    localStorage.removeItem('funds_v1');
    localStorage.removeItem('initCapital');
    localStorage.removeItem('riskPct');
    localStorage.removeItem('maxRisk');
    localStorage.removeItem('feeRate');
    // 清空复盘数据（避免切换账号后看到上一个用户的本地缓存）
    localStorage.removeItem('daily_reviews');
    localStorage.removeItem('diary2');
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
  // 关闭管理员面板（如果打开）
  var adminPanel = document.getElementById('adminPanel');
  if (adminPanel) adminPanel.style.display = 'none';

  // 退出时先清空本地数据，回到未登录的空白状态
  clearLocalDataAndRefresh();
  syncModule.logout();
  syncModule.updateSyncUI();
  updateHeaderSyncUI();
  syncModule.showSyncStatus('已退出登录', 'info');
  // 通知其他页面/模块：用户已登出
  try { window.dispatchEvent(new CustomEvent('user-logout')); } catch(e) {}
}

// ===== 修改密码功能 =====
function openChangePasswordModal() {
  var modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'flex';
}

function closeChangePasswordModal() {
  var modal = document.getElementById('changePasswordModal');
  if (modal) modal.style.display = 'none';
  // 清空输入
  document.getElementById('changePwdOld').value = '';
  document.getElementById('changePwdNew').value = '';
  document.getElementById('changePwdConfirm').value = '';
}

function handleChangePassword() {
  const oldPassword = document.getElementById('changePwdOld').value;
  const newPassword = document.getElementById('changePwdNew').value;
  const confirmPassword = document.getElementById('changePwdConfirm').value;
  
  // 验证输入
  if (!oldPassword || !newPassword || !confirmPassword) {
    alert('请填写所有字段');
    return;
  }
  
  if (newPassword.length < 6) {
    alert('新密码至少需要6位');
    return;
  }
  
  if (newPassword !== confirmPassword) {
    alert('两次输入的新密码不一致');
    return;
  }
  
  if (!syncModule.isLoggedIn()) {
    alert('请先登录');
    return;
  }
  
  const user = syncModule.getCurrentUser();
  const serverUrl = syncModule.getServerUrl();
  
  console.log('[修改密码] 用户信息:', user);
  console.log('[修改密码] 服务器地址:', serverUrl);
  
  fetch(serverUrl + '/api/change-password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      userId: user.id,
      oldPassword: oldPassword,
      newPassword: newPassword
    })
  })
  .then(res => {
    console.log('[修改密码] HTTP状态码:', res.status);
    return res.text();
  })
  .then(rawText => {
    console.log('[修改密码] 原始响应:', rawText);
    try {
      const data = JSON.parse(rawText);
      if (data.error) {
        alert('修改失败: ' + data.error);
      } else {
        alert('密码修改成功，请重新登录');
        closeChangePasswordModal();
        handleLogout();
      }
    } catch (parseErr) {
      console.error('解析响应失败:', parseErr);
      alert('服务器响应格式错误: ' + rawText.substring(0, 100));
    }
  })
  .catch(err => {
    console.error('修改密码失败:', err);
    alert('修改密码失败，请稍后重试\n错误: ' + err.message);
  });
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
      } else if (tab === 'diary') {
        renderAdminDiary(data.diary2 || []);
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

function renderAdminDiary(diary2) {
  var contentEl = document.getElementById('adminDetailContent');
  if (diary2.length === 0) {
    contentEl.innerHTML = '<div class="empty">暂无复盘总结记录</div>';
    return;
  }
  
  var html = `
    <style>
      .admin-diary-table td {
        white-space: pre-wrap;
        word-wrap: break-word;
        word-break: break-word;
        vertical-align: top;
        max-width: 300px;
      }
      .admin-diary-table .text-col {
        max-width: 400px;
      }
    </style>
    <table class="admin-table admin-diary-table">
      <thead>
        <tr>
          <th style="width: 100px;">日期</th>
          <th style="width: 120px;">品种</th>
          <th style="width: 100px;">盈亏比例</th>
          <th class="text-col" style="width: 400px;">买入/卖出逻辑</th>
          <th class="text-col" style="width: 250px;">当时心态</th>
          <th style="width: 80px;">符合系统</th>
          <th class="text-col" style="width: 350px;">教训与总结</th>
          <th class="text-col" style="width: 350px;">改进措施</th>
        </tr>
      </thead>
      <tbody>
        ${diary2.map(d => `
          <tr>
            <td>${d.trade_date || '-'}</td>
            <td>${escapeHtml(d.symbol || '-')}</td>
            <td><span style="color: ${parseFloat(d.pnl_percent) > 0 ? '#ef4444' : parseFloat(d.pnl_percent) < 0 ? '#48bb78' : '#6b7280'}">${d.pnl_percent !== undefined ? (d.pnl_percent > 0 ? '+' : '') + d.pnl_percent + '%' : '-'}</span></td>
            <td class="text-col">${escapeHtml(d.trade_logic || '-')}</td>
            <td class="text-col">${escapeHtml(d.mood || '-')}</td>
            <td><span style="color: ${d.follow_system === '是' ? '#ef4444' : '#48bb78'}">${d.follow_system || '否'}</span></td>
            <td class="text-col">${escapeHtml(d.lesson || '-')}</td>
            <td class="text-col">${escapeHtml(d.improvement || '-')}</td>
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

// ===== 计算器卡片折叠 =====
function toggleCalcCard() {
  var card = document.getElementById('calcCard');
  var btn = document.getElementById('calcToggleBtn');
  if (!card) return;
  var expanded = card.classList.toggle('expanded');
  if (btn) btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  // 折叠状态变更后保存用户偏好
  try { localStorage.setItem('calcCardExpanded', expanded ? '1' : '0'); } catch(e) {}
}

// 根据用户偏好初始化计算器折叠状态（默认折叠）
function initCalcCardState() {
  var card = document.getElementById('calcCard');
  var btn = document.getElementById('calcToggleBtn');
  if (!card) return;
  var pref = null;
  try { pref = localStorage.getItem('calcCardExpanded'); } catch(e) {}
  // 默认折叠；仅当用户之前显式展开过才展开
  var expanded = (pref === '1');
  if (expanded) {
    card.classList.add('expanded');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  } else {
    card.classList.remove('expanded');
    if (btn) btn.setAttribute('aria-expanded', 'false');
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

  // 初始化计算器折叠状态
  initCalcCardState();

  // 初始化交易表格列显示状态（精简 / 全部）
  if (typeof initTableColumnsState === 'function') {
    initTableColumnsState();
  }

  // 加载计算器中的交易纪律提醒
  if (typeof loadCalcDisciplineReminder === 'function') {
    loadCalcDisciplineReminder();
  }
  // 监听 localStorage 跨页面变化（在其他页面编辑纪律后自动刷新）
  window.addEventListener('storage', function(e) {
    if (e.key === 'daily_discipline_rules' && typeof loadCalcDisciplineReminder === 'function') {
      loadCalcDisciplineReminder();
    }
    if (e.key === 'last_sync_time' && typeof syncModule !== 'undefined' && syncModule.refreshSyncIndicatorTooltip) {
      syncModule.refreshSyncIndicatorTooltip();
    }
  });

  // 每 30 秒刷新一次同步指示器的相对时间 tooltip
  setInterval(function() {
    if (typeof syncModule !== 'undefined' && syncModule.refreshSyncIndicatorTooltip) {
      syncModule.refreshSyncIndicatorTooltip();
    }
  }, 30000);

  // 初始化数据库，然后加载数据
  initStorage().then(function() {
    loadAccountParams();
    loadFunds();
    initModalDatePicker();
    initCalcDate();
    initCalcSelectButtons();
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
    initCalcDate();
    initCalcSelectButtons();
    updateAll();
  });
});
