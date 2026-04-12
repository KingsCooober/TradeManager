// ===== 交易表格管理 =====

// 计算交易的实际可能止损金额（用于显示风险R和计算盈亏R）
function calcActualRisk(trade) {
  var entry = parseFloat(trade.entry);
  var stop = parseFloat(trade.stop);
  var posSize = parseFloat(trade.posSize);
  if (entry && stop && posSize && entry > 0) {
    return posSize * Math.abs(entry - stop) / entry;
  }
  // 回退到存储的 riskAmount
  if (trade.riskAmount && !isNaN(parseFloat(trade.riskAmount))) {
    return parseFloat(trade.riskAmount);
  }
  return 0;
}

function addEmptyTrade() {
  var today = getToday();
  trades.push({
    id: Date.now(),
    date: today,
    exitDate: today,
    openTime: new Date().toISOString(),
    symbol: '',
    buyType: '15分钟回踩',
    dir: '多',
    entry: '',
    stop: '',
    target: '',
    rrTarget: 0,
    posSize: '',
    actualLots: null,
    riskAmount: '',
    exit: '',
    pnl: '',
    pnlR: '',
    status: 'open',
    followedPlan: '是',
    note: ''
  });
  save().then(function() {
    renderTableWithSelects();
  });
}

var pendingDeleteTradeId = null;

function openDeleteConfirm(id, symbol, dir, entry) {
  pendingDeleteTradeId = id;
  
  document.getElementById('deleteSymbol').textContent = symbol || '-';
  document.getElementById('deleteDir').textContent = dir || '-';
  document.getElementById('deleteEntry').textContent = entry || '-';
  
  document.getElementById('deleteConfirmModal').style.display = 'flex';
}

function closeDeleteConfirmModal() {
  pendingDeleteTradeId = null;
  document.getElementById('deleteConfirmModal').style.display = 'none';
}

function confirmDeleteTrade() {
  if (!pendingDeleteTradeId) return;
  
  var id = pendingDeleteTradeId;
  closeDeleteConfirmModal();
  
  // 将ID转为字符串比较，兼容数字和字符串ID
  var idStr = String(id);
  trades = trades.filter(function(t) { return String(t.id) !== idStr; });
  
  // 更新界面
  updateAll();
  
  // 自动保存到数据库（带防抖）
  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }
  
  // 如果已登录，同时删除服务器上的记录
  if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
    syncModule.deleteTradeFromServer(idStr).then(function(success) {
      if (success) {
        console.log('已从服务器删除交易记录');
      } else {
        console.warn('服务器删除可能失败，将在下次同步时处理');
      }
    }).catch(function(err) {
      console.error('删除服务器记录失败:', err);
    });
  }
}

function deleteTrade(id) {
  // 直接删除（用于内部调用）
  var idStr = String(id);
  trades = trades.filter(function(t) { return String(t.id) !== idStr; });
  
  var savePromise = save();
  
  if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
    savePromise = savePromise.then(function() {
      return syncModule.deleteTradeFromServer(idStr);
    }).then(function(success) {
      if (success) {
        console.log('已从服务器删除交易记录');
      } else {
        console.warn('服务器删除可能失败，将在下次同步时处理');
      }
    }).catch(function(err) {
      console.error('删除服务器记录失败:', err);
    });
  }
  
  savePromise.then(function() {
    updateAll();
  }).catch(function(err) {
    console.error('删除保存失败:', err);
    updateAll();
  });
}

function updateTrade(id, field, value) {
  var t = null;
  var idStr = String(id);
  for (var i = 0; i < trades.length; i++) {
    if (String(trades[i].id) === idStr) {
      t = trades[i];
      break;
    }
  }
  if (!t) return;

  t[field] = value;

  // 当填写出场价、入场价、仓位时自动计算盈亏（扣除手续费）
  if ((field === 'exit' || field === 'entry' || field === 'posSize' || field === 'actualLots') && t.exit && t.entry && t.posSize) {
    var e = parseFloat(t.entry),
        ex = parseFloat(t.exit),
        pos = parseFloat(t.posSize),
        lots = parseFloat(t.actualLots) || 0;
    if (!isNaN(e) && !isNaN(ex) && !isNaN(pos) && e !== 0) {
      var pct = t.dir === '多' ? (ex - e) / e : (e - ex) / e;
      var grossPnl = pos * pct; // 毛盈亏
      
      // 计算手续费（开仓 + 出场）
      var feeRate = getFeeRate() / 100;
      var openFee = pos * feeRate; // 开仓手续费
      var exitFee = lots > 0 ? (ex * lots * feeRate) : (pos * feeRate); // 出场手续费
      var totalFees = openFee + exitFee;
      
      // 净盈亏 = 毛盈亏 - 手续费
      t.pnl = Math.round((grossPnl - totalFees) * 100) / 100;
      
      if (t.riskAmount && !isNaN(parseFloat(t.riskAmount)) && parseFloat(t.riskAmount) !== 0) {
        var riskForPnlR = calcActualRisk(t) || parseFloat(t.riskAmount);
        t.pnlR = Math.round(parseFloat(t.pnl) / riskForPnlR * 100) / 100;
      }
      var oldStatus = t.status;
      if (t.pnl >= 0) {
        t.status = t.pnl > 0 ? 'win' : 'be';
      } else {
        t.status = 'loss';
      }
      if (oldStatus === 'open') {
        t.closeTime = new Date().toISOString();
      }
    }
  }

  // 手动修改盈亏金额时也自动更新状态
  if (field === 'pnl') {
    var riskForPnlR2 = calcActualRisk(t) || (t.riskAmount && !isNaN(parseFloat(t.riskAmount)) ? parseFloat(t.riskAmount) : 0);
    if (riskForPnlR2 !== 0) {
      t.pnlR = Math.round(parseFloat(value) / riskForPnlR2 * 100) / 100;
    }
    if (value !== '') {
      var oldStatus2 = t.status;
      if (parseFloat(value) > 0) {
        t.status = 'win';
      } else if (parseFloat(value) < 0) {
        t.status = 'loss';
      } else {
        t.status = 'be';
      }
      if (oldStatus2 === 'open') {
        t.closeTime = new Date().toISOString();
      }
    }
  }
  
  // 手动修改状态时也要记录平仓时间
  if (field === 'status') {
    if (value !== 'open' && t.status === 'open') {
      t.closeTime = new Date().toISOString();
    }
  }

  updateAll();
  
  // 自动保存到数据库（带防抖）
  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }
}

function renderTable() {
  var tbody = document.getElementById('tradeBody');
  if (trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="21" style="color:var(--text-tertiary);padding:30px;text-align:center">暂无交易记录</td></tr>';
    return;
  }
  var html = '';
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    var pC = t.pnl === '' ? '' : (parseFloat(t.pnl) >= 0 ? 'color:var(--color-red)' : 'color:var(--color-green)');
    var pRC = t.pnlR === '' ? '' : (parseFloat(t.pnlR) >= 0 ? 'color:var(--color-red)' : 'color:var(--color-green)');
    var badge = t.status === 'open' ? '<span class="badge badge-open">持仓中</span>' :
                t.status === 'win' ? '<span class="badge badge-win">盈利</span>' :
                t.status === 'loss' ? '<span class="badge badge-loss">亏损</span>' :
                '<span class="badge badge-be">保本</span>';
    var rrL = t.rrTarget > 0 ? '<span style="font-size:10px;color:var(--text-secondary);display:block">' + t.rrTarget + 'R</span>' : '';
    var dC = t.dir === '多' ? 'var(--color-red)' : 'var(--color-green)';
    var tpD = calcTpDist(t);
    var exD = calcExitDist(t);
    var exDC = exD.startsWith('-') ? 'color:var(--color-green)' : exD === '-' ? '' : 'color:var(--color-red)';

    // 风险R使用实际可能止损金额显示
    var actRisk = calcActualRisk(t);
    var riskDisplay = actRisk > 0 ? actRisk.toFixed(2) + ' ￥' : (t.riskAmount ? parseFloat(t.riskAmount).toFixed(2) + ' ￥' : '-');

    // 获取状态显示文本
      var statusText = { 'open': '持仓', 'win': '盈利', 'loss': '亏损', 'be': '保本' }[t.status] || '持仓';
      // 获取状态对应的CSS类
      var statusClass = 'status-' + t.status;
      
      // 状态下拉框
      var statusSelect = '<div class="table-select-wrapper">' +
        '<div class="table-select ' + statusClass + '" tabindex="0" data-trade-id="' + esc(t.id) + '" data-field="status">' +
        '<span class="table-select-value">' + statusText + '</span>' +
        '<span class="table-select-arrow">▼</span>' +
        '</div>' +
        '<ul class="table-select-options" data-trade-id="' + esc(t.id) + '" data-field="status">' +
        '<li data-value="open"' + (t.status === 'open' ? ' class="selected"' : '') + '>持仓</li>' +
        '<li data-value="win"' + (t.status === 'win' ? ' class="selected"' : '') + '>盈利</li>' +
        '<li data-value="loss"' + (t.status === 'loss' ? ' class="selected"' : '') + '>亏损</li>' +
        '<li data-value="be"' + (t.status === 'be' ? ' class="selected"' : '') + '>保本</li>' +
        '</ul>' +
        '</div>';
      
      // 是否按计划执行下拉框
      var planSelect = '<div class="table-select-wrapper">' +
        '<div class="table-select plan-select ' + (t.followedPlan === '是' ? 'plan-yes' : 'plan-no') + '" tabindex="0" data-trade-id="' + esc(t.id) + '" data-field="followedPlan">' +
        '<span class="table-select-value">' + (t.followedPlan || '否') + '</span>' +
        '<span class="table-select-arrow">▼</span>' +
        '</div>' +
        '<ul class="table-select-options" data-trade-id="' + esc(t.id) + '" data-field="followedPlan">' +
        '<li data-value="是"' + (t.followedPlan === '是' ? ' class="selected"' : '') + '>是</li>' +
        '<li data-value="否"' + (t.followedPlan === '否' ? ' class="selected"' : '') + '>否</li>' +
        '</ul>' +
        '</div>';
      
      html += '<tr><td style="color:var(--text-tertiary);text-align:center">' + (i + 1) + '</td>' +
      '<td style="text-align:center;color:var(--text-primary)">' + (t.date || '-') + '</td>' +
      '<td style="text-align:center;color:var(--text-primary);font-weight:500">' + (t.symbol || '-') + '</td>' +
      '<td style="text-align:center;color:var(--text-secondary)">' + (t.buyType || '-') + '</td>' +
      '<td style="text-align:center;color:' + dC + ';font-weight:600">' + t.dir + '</td>' +
      '<td style="text-align:center;color:var(--text-primary);font-weight:500">' + (t.entry || '-') + '</td>' +
      '<td style="text-align:right;color:var(--color-green)">' + (t.stop ? parseFloat(t.stop).toFixed(2) : '-') + '</td>' +
      '<td style="text-align:right;color:var(--color-red)">' + (t.target ? parseFloat(t.target).toFixed(2) : '-') + rrL + '</td>' +
      '<td style="text-align:right;color:var(--color-red)">' + tpD + '</td>' +
      '<td style="text-align:right;color:var(--color-blue)">' + (t.posSize ? parseFloat(t.posSize).toLocaleString() + ' ￥' : '-') + '</td>' +
      '<td style="text-align:right;color:var(--color-purple)">' + riskDisplay + '</td>' +
      '<td><input type="number" class="in-exit" value="' + t.exit + '" placeholder="出场" step="0.1" onchange="updateTrade(' + t.id + ',\'exit\',this.value)"></td>' +
      '<td><input type="date" class="in-date" value="' + t.exitDate + '" onchange="updateTrade(' + sqesc(t.id) + ',\'exitDate\',this.value)"></td>' +
      '<td style="' + exDC + ';text-align:right">' + exD + '</td>' +
      '<td style="' + pC + ';text-align:right">' + (t.pnl !== '' && !isNaN(t.pnl) ? CNY(parseFloat(t.pnl)) : '-') + '</td>' +
      '<td style="' + pRC + ';text-align:right">' + (t.pnlR !== '' && !isNaN(t.pnlR) ? fmtR(parseFloat(t.pnlR)) : '-') + '</td>' +
      '<td style="text-align:center;white-space:nowrap">' + calcHoldDuration(t) + '</td>' +
      '<td style="text-align:center">' + statusSelect + '</td>' +
      '<td style="text-align:center">' + planSelect + '</td>' +
      '<td><input type="text" class="in-note" value="' + esc(t.note || '') + '" placeholder="备注" onchange="updateTrade(' + sqesc(t.id) + ',\'note\',this.value)"></td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="openDeleteConfirm(' + sqesc(t.id) + ', ' + sqesc(t.symbol || '') + ', ' + sqesc(t.dir || '') + ', ' + sqesc(t.entry || '') + ')">删除</button></td></tr>';
  }
  tbody.innerHTML = html;
}

// 日期选择器变化时更新天数选项
function onDatePickerChange(prefix, tradeId, field) {
  var yearId = prefix + '_year_' + tradeId;
  var monthId = prefix + '_month_' + tradeId;
  var dayId = prefix + '_day_' + tradeId;

  var year = parseInt(document.getElementById(yearId).value);
  var month = parseInt(document.getElementById(monthId).value);

  // 更新天数选项
  var days = getDaysInMonth(year, month);
  var daySelect = document.getElementById(dayId);
  var currentDay = parseInt(daySelect.value) || 1;
  var html = '';
  for (var i = 1; i <= days; i++) {
    var val = i < 10 ? '0' + i : i;
    html += '<option value="' + val + '"' + (i === Math.min(currentDay, days) ? ' selected' : '') + '>' + i + '日</option>';
  }
  daySelect.innerHTML = html;

  // 更新交易数据
  var dateValue = year + '-' + 
    (month < 10 ? '0' + month : month) + '-' + 
    (currentDay > days ? (days < 10 ? '0' + days : days) : daySelect.value);
  updateTrade(tradeId, field, dateValue);
}

// ===== 表格下拉框交互 =====
var tableSelectEventsBound = false;

function initTableSelects() {
  // 只绑定一次事件
  if (tableSelectEventsBound) {
    // 更新键盘事件绑定（因为表格内容变化了）
    bindTableSelectKeyboardEvents();
    return;
  }
  
  tableSelectEventsBound = true;
  
  // 使用事件委托处理下拉框点击（绑定到 document）
  document.addEventListener('click', function(e) {
    // 点击下拉框
    var selectEl = e.target.closest('.table-select');
    if (selectEl) {
      e.stopPropagation();
      var tradeId = selectEl.dataset.tradeId;
      var field = selectEl.dataset.field;
      var optionsEl = document.querySelector('.table-select-options[data-trade-id="' + tradeId + '"][data-field="' + field + '"]');
      if (optionsEl) {
        toggleTableSelect(selectEl, optionsEl);
      }
      return;
    }
    
    // 点击选项
    var optionEl = e.target.closest('.table-select-options li');
    if (optionEl) {
      e.stopPropagation();
      var optionsEl = optionEl.closest('.table-select-options');
      var tradeId = optionsEl.dataset.tradeId;
      var field = optionsEl.dataset.field;
      var selectEl = document.querySelector('.table-select[data-trade-id="' + tradeId + '"][data-field="' + field + '"]');
      var value = optionEl.dataset.value;
      if (selectEl) {
        updateTableSelectValue(selectEl, optionsEl, value, tradeId, field);
        closeTableSelect(selectEl, optionsEl);
      }
      return;
    }
    
    // 点击外部关闭所有下拉框
    if (!e.target.closest('.table-select-wrapper')) {
      document.querySelectorAll('.table-select').forEach(function(el) {
        el.classList.remove('open');
      });
      document.querySelectorAll('.table-select-options').forEach(function(el) {
        el.classList.remove('open');
      });
    }
  });
  
  // 初始绑定键盘事件
  bindTableSelectKeyboardEvents();
}

function bindTableSelectKeyboardEvents() {
  // 先移除旧的事件监听器（通过重新绑定到新元素）
  var selects = document.querySelectorAll('.table-select');
  selects.forEach(function(selectEl) {
    // 克隆元素来移除所有事件监听器
    var newSelectEl = selectEl.cloneNode(true);
    selectEl.parentNode.replaceChild(newSelectEl, selectEl);
    
    var tradeId = newSelectEl.dataset.tradeId;
    var field = newSelectEl.dataset.field;
    var optionsEl = document.querySelector('.table-select-options[data-trade-id="' + tradeId + '"][data-field="' + field + '"]');
    var options = optionsEl ? optionsEl.querySelectorAll('li') : [];
    var selectedIndex = 0;
    
    // 查找当前选中的索引
    options.forEach(function(opt, index) {
      if (opt.classList.contains('selected')) {
        selectedIndex = index;
      }
    });
    
    newSelectEl.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, options.length - 1);
          updateTableSelectHighlight(options, selectedIndex);
          if (!optionsEl.classList.contains('open')) {
            openTableSelect(newSelectEl, optionsEl);
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateTableSelectHighlight(options, selectedIndex);
          break;
        case 'Enter':
          e.preventDefault();
          if (optionsEl.classList.contains('open')) {
            options[selectedIndex].click();
          } else {
            openTableSelect(newSelectEl, optionsEl);
          }
          break;
        case 'Escape':
          e.preventDefault();
          closeTableSelect(newSelectEl, optionsEl);
          break;
      }
    });
  });
}

function toggleTableSelect(selectEl, optionsEl) {
  if (optionsEl.classList.contains('open')) {
    closeTableSelect(selectEl, optionsEl);
  } else {
    openTableSelect(selectEl, optionsEl);
  }
}

function openTableSelect(selectEl, optionsEl) {
  selectEl.classList.add('open');
  optionsEl.classList.add('open');
  selectEl.focus();
}

function closeTableSelect(selectEl, optionsEl) {
  selectEl.classList.remove('open');
  optionsEl.classList.remove('open');
}

function updateTableSelectHighlight(options, index) {
  options.forEach(function(opt, i) {
    opt.classList.remove('hover-highlight');
    if (i === index) {
      opt.classList.add('hover-highlight');
      opt.scrollIntoView({ block: 'nearest' });
    }
  });
}

function updateTableSelectValue(selectEl, optionsEl, value, tradeId, field) {
  // 更新显示值
  var valueEl = selectEl.querySelector('.table-select-value');
  if (valueEl) {
    optionsEl.querySelectorAll('li').forEach(function(opt) {
      if (opt.dataset.value === value) {
        valueEl.textContent = opt.textContent;
      }
    });
  }
  
  // 更新选中状态
  optionsEl.querySelectorAll('li').forEach(function(opt) {
    opt.classList.remove('selected');
    if (opt.dataset.value === value) {
      opt.classList.add('selected');
    }
  });
  
  // 更新下拉框样式类
  if (field === 'status') {
    selectEl.classList.remove('status-open', 'status-win', 'status-loss', 'status-be');
    selectEl.classList.add('status-' + value);
  } else if (field === 'followedPlan') {
    selectEl.classList.remove('plan-yes', 'plan-no');
    selectEl.classList.add('plan-' + (value === '是' ? 'yes' : 'no'));
  }
  
  // 更新交易数据
  updateTrade(tradeId, field, value);
}

// 在渲染表格后初始化下拉框
function renderTableWithSelects() {
  renderTable();
  // 使用 requestAnimationFrame 确保 DOM 渲染完成
  requestAnimationFrame(function() {
    initTableSelects();
  });
}

// ===== 排序功能 =====
var currentSortField = 'date';
var currentSortOrder = 'desc'; // 'asc' 或 'desc'

function sortTrades(field) {
  currentSortField = field;
  
  // 更新按钮状态
  document.querySelectorAll('.sort-btn').forEach(function(btn) {
    btn.classList.remove('active');
  });
  
  if (field === 'date') {
    document.getElementById('sortDate').classList.add('active');
  } else if (field === 'symbol') {
    document.getElementById('sortSymbol').classList.add('active');
  } else if (field === 'buyType') {
    document.getElementById('sortBuyType').classList.add('active');
  }
  
  // 执行排序并重新渲染
  applySort();
  renderTableWithSelects();
}

function toggleSortOrder() {
  currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
  
  var orderBtn = document.getElementById('sortOrder');
  if (currentSortOrder === 'asc') {
    orderBtn.textContent = '↑ 升序';
  } else {
    orderBtn.textContent = '↓ 降序';
  }
  
  // 重新排序并渲染
  applySort();
  renderTableWithSelects();
}

function applySort() {
  trades.sort(function(a, b) {
    var aVal, bVal;
    
    switch (currentSortField) {
      case 'date':
        aVal = a.date || '';
        bVal = b.date || '';
        break;
      case 'symbol':
        aVal = (a.symbol || '').toLowerCase();
        bVal = (b.symbol || '').toLowerCase();
        break;
      case 'buyType':
        aVal = (a.buyType || '').toLowerCase();
        bVal = (b.buyType || '').toLowerCase();
        break;
      default:
        aVal = a.date || '';
        bVal = b.date || '';
    }
    
    if (aVal < bVal) {
      return currentSortOrder === 'asc' ? -1 : 1;
    }
    if (aVal > bVal) {
      return currentSortOrder === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

// 初始化排序按钮状态
function initSortButtons() {
  // 默认按日期降序排序
  document.getElementById('sortDate').classList.add('active');
  document.getElementById('sortOrder').textContent = '↓ 降序';
}

// 页面加载时初始化排序
document.addEventListener('DOMContentLoaded', function() {
  initSortButtons();
});
