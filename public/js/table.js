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

var EXIT_TYPES = ['', '止损', '目标止盈', '移动止盈', '平保'];
var EXIT_TYPE_LABELS = { '': '-', '止损': '止损', '目标止盈': '目标止盈', '移动止盈': '移动止盈', '平保': '平保' };
var EXIT_TYPE_COLORS = { '止损': 'var(--color-green)', '目标止盈': 'var(--color-red)', '移动止盈': 'var(--color-orange, #f97316)', '平保': 'var(--color-blue)' };

function getExitTypeSelect(trade) {
  var cur = trade.exitType || '';
  var color = EXIT_TYPE_COLORS[cur] || 'var(--text-primary)';
  var html = '<div class="table-select-wrapper">' +
    '<div class="table-select exittype-select" tabindex="0" data-trade-id="' + esc(trade.id) + '" data-field="exitType" style="border-color:' + color + '">' +
    '<span class="table-select-value" style="color:' + color + '">' + esc(EXIT_TYPE_LABELS[cur] || '-') + '</span>' +
    '<span class="table-select-arrow">▼</span>' +
    '</div>' +
    '<ul class="table-select-options" data-trade-id="' + esc(trade.id) + '" data-field="exitType">';
  EXIT_TYPES.forEach(function(t) {
    var label = EXIT_TYPE_LABELS[t] || '-';
    var c = EXIT_TYPE_COLORS[t] || '';
    html += '<li data-value="' + esc(t) + '"' + (cur === t ? ' class="selected"' : '') + (c ? ' style="color:' + c + ';font-weight:600"' : '') + '>' + esc(label) + '</li>';
  });
  html += '</ul></div>';
  return html;
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
  
  // 标记为待删除
  markTradeDeleted(idStr);
  
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

  // 标记为待同步
  markTradeDirty(idStr);

  // 如果清空了出场价，意味着交易回退到未平仓状态
  // 联动清空盈亏金额、pnlR、出场日期、出场类型、closeTime
  if (field === 'exit' && (value === '' || value === null || value === undefined)) {
    t.pnl = '';
    t.pnlR = '';
    t.exitDate = '';
    t.exitType = '';
    t.status = 'open';
    t.closeTime = '';
    updateAll();
    try { localStorage.setItem('trades_v4', JSON.stringify(trades)); } catch(e) {}
    return;
  }

  // 当填写出场价、入场价、仓位时自动计算盈亏（扣除手续费）
  if (field === 'exit' || field === 'entry' || field === 'posSize' || field === 'actualLots') {
    var e = parseFloat(t.entry),
        ex = parseFloat(t.exit),
        lots = parseFloat(t.actualLots) || 0;

    // 如果posSize为空但有actualLots和entry，自动计算posSize
    if ((!t.posSize || isNaN(parseFloat(t.posSize))) && lots > 0 && !isNaN(e) && e > 0) {
      t.posSize = Math.round(e * lots * 100) / 100;
    }

    var pos = parseFloat(t.posSize) || 0;
    if (!isNaN(e) && !isNaN(ex) && pos > 0 && e !== 0) {
      // P1-4: 净盈亏计算抽离到 utils.js 的 calcPnl()（含手续费）
      var pnl = calcPnl(t);
      if (pnl !== null) t.pnl = pnl;

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

  // 同步保存到localStorage（确保不丢失）
  try { localStorage.setItem('trades_v4', JSON.stringify(trades)); } catch(e) {}

  // 立即把这条 trade 写回 IndexedDB（不等防抖）
  // 防止用户快速刷新页面时，防抖 save() 未触发导致 IDB 旧数据覆盖新数据
  if (typeof saveTradeToDB === 'function' && typeof db !== 'undefined' && db) {
    try { saveTradeToDB(t); } catch(e) { console.warn('IDB 即时写入失败:', e); }
  }

  // 自动保存到数据库（带防抖，用于触发服务器同步等）
  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }
}

// ===== 状态筛选功能 =====
var currentStatusFilter = 'all'; // 'all' | 'open' | 'win' | 'loss' | 'be'
var STATUS_FILTER_KEY = 'trade_status_filter';

function setStatusFilter(status) {
  var allowed = ['all', 'open', 'win', 'loss', 'be'];
  if (allowed.indexOf(status) < 0) status = 'all';
  currentStatusFilter = status;

  // 更新按钮高亮
  document.querySelectorAll('.filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.status === status);
  });

  // 持久化用户偏好
  try { localStorage.setItem(STATUS_FILTER_KEY, status); } catch(e) {}

  // 重新渲染表格
  renderTableWithSelects();
}

// 取筛选后的子集
function getFilteredTrades() {
  if (currentStatusFilter === 'all') return trades;
  var list = [];
  for (var i = 0; i < trades.length; i++) {
    if (trades[i].status === currentStatusFilter) list.push(trades[i]);
  }
  return list;
}

// 先筛选后排序，返回显示用列表（不修改原始 trades）
function getDisplayedTrades() {
  var list = getFilteredTrades().slice();
  list.sort(function(a, b) {
    var aVal, bVal;
    switch (currentSortField) {
      case 'date': aVal = a.date || ''; bVal = b.date || ''; break;
      case 'symbol': aVal = (a.symbol || '').toLowerCase(); bVal = (b.symbol || '').toLowerCase(); break;
      case 'buyType': aVal = (a.buyType || '').toLowerCase(); bVal = (b.buyType || '').toLowerCase(); break;
      default: aVal = a.date || ''; bVal = b.date || '';
    }
    if (aVal < bVal) return currentSortOrder === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSortOrder === 'asc' ? 1 : -1;
    return 0;
  });
  return list;
}

// 更新各状态按钮上的计数徽章
function updateFilterCounts() {
  var counts = { all: trades.length, open: 0, win: 0, loss: 0, be: 0 };
  for (var i = 0; i < trades.length; i++) {
    var s = trades[i].status || 'open';
    if (counts[s] !== undefined) counts[s]++;
  }
  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }
  setText('filterCountAll', counts.all);
  setText('filterCountOpen', counts.open);
  setText('filterCountWin', counts.win);
  setText('filterCountLoss', counts.loss);
  setText('filterCountBe', counts.be);
}

function initStatusFilter() {
  var saved = null;
  try { saved = localStorage.getItem(STATUS_FILTER_KEY); } catch(e) {}
  setStatusFilter(saved || 'all');
}

function renderTable() {
  var tbody = document.getElementById('tradeBody');
  if (trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="color:var(--text-tertiary);padding:30px;text-align:center">暂无交易记录</td></tr>';
    updateFilterCounts();
    return;
  }
  var displayTrades = getDisplayedTrades();
  if (displayTrades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="23" style="color:var(--text-tertiary);padding:30px;text-align:center">当前筛选下无交易记录</td></tr>';
    updateFilterCounts();
    return;
  }
  var html = '';
  for (var i = 0; i < displayTrades.length; i++) {
    var t = displayTrades[i];
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

      html += '<tr data-trade-id="' + esc(t.id) + '">' +
      '<td class="col-num" style="color:var(--text-tertiary);text-align:center">' + (i + 1) + '</td>' +
      '<td class="col-date" style="text-align:center;color:var(--text-primary)">' + (t.date || '-') + '</td>' +
      '<td class="col-symbol" style="text-align:center;color:var(--text-primary);font-weight:500">' + (t.symbol || '-') + '</td>' +
      '<td class="col-buytype col-secondary" style="text-align:center;color:var(--color-purple);font-weight:500">' + (t.buyType || '-') + '</td>' +
      '<td class="col-dir" style="text-align:center;color:' + dC + ';font-weight:600">' + t.dir + '</td>' +
      '<td class="col-entry" style="text-align:center;color:var(--text-primary);font-weight:500">' + (t.entry || '-') + '</td>' +
      '<td class="col-stop col-secondary" style="text-align:center;color:var(--color-green)">' + (t.stop ? parseFloat(t.stop).toFixed(2) : '-') + '</td>' +
      '<td class="col-breakeven col-secondary" style="text-align:center;color:var(--color-purple);font-weight:500">' + (t.breakEvenPrice ? parseFloat(t.breakEvenPrice).toFixed(2) : '-') + '</td>' +
      '<td class="col-target col-secondary" style="text-align:center;color:var(--color-red)">' + (t.target ? parseFloat(t.target).toFixed(2) : '-') + rrL + '</td>' +
      '<td class="col-tpdist col-secondary" style="text-align:center;color:var(--color-red)">' + tpD + '</td>' +
      '<td class="col-possize col-secondary" style="text-align:center;color:var(--color-blue)">' + (t.posSize ? parseFloat(t.posSize).toLocaleString() + ' ￥' : '-') + '</td>' +
      '<td class="col-risk col-secondary" style="text-align:center;color:var(--color-purple)">' + riskDisplay + '</td>' +
      '<td class="col-exit" style="text-align:center"><input type="number" class="in-exit" value="' + t.exit + '" placeholder="出场" step="0.1" onchange="updateTrade(' + sqesc(t.id) + ',\'exit\',this.value)"></td>' +
      '<td class="col-exitdate col-secondary" style="text-align:center"><input type="date" class="in-date" value="' + t.exitDate + '" onchange="updateTrade(' + sqesc(t.id) + ',\'exitDate\',this.value)"></td>' +
      '<td class="col-exittype col-secondary" style="text-align:center">' + getExitTypeSelect(t) + '</td>' +
      '<td class="col-exitdist col-secondary" style="' + exDC + ';text-align:center">' + exD + '</td>' +
      '<td class="col-pnl" style="' + pC + ';text-align:center">' + (t.pnl !== '' && !isNaN(t.pnl) ? CNY(parseFloat(t.pnl)) : '-') + '</td>' +
      '<td class="col-pnlr" style="' + pRC + ';text-align:center">' + (t.pnlR !== '' && !isNaN(t.pnlR) ? fmtR(parseFloat(t.pnlR)) : '-') + '</td>' +
      '<td class="col-hold col-secondary" style="text-align:center;white-space:nowrap">' + calcHoldDuration(t) + '</td>' +
      '<td class="col-status" style="text-align:center">' + statusSelect + '</td>' +
      '<td class="col-plan col-secondary" style="text-align:center">' + planSelect + '</td>' +
      '<td class="col-note col-secondary"><textarea class="in-note" rows="2" placeholder="备注" onchange="updateTrade(' + sqesc(t.id) + ',\'note\',this.value)">' + esc(t.note || '') + '</textarea></td>' +
      '<td class="col-actions" style="text-align:center;white-space:nowrap">' +
        // P2-3: 改用事件委托（data-action + data-trade-id），不再用内联 onclick 字符串拼装
        '<button class="btn btn-sm btn-ghost" data-action="detail" data-trade-id="' + esc(t.id) + '" title="查看 / 编辑详情" aria-label="详情">🔍</button>' +
        '<button class="btn btn-danger btn-sm" data-action="delete" data-trade-id="' + esc(t.id) + '" title="删除" aria-label="删除">🗑</button>' +
      '</td></tr>';
  }
  tbody.innerHTML = html;
  updateFilterCounts();
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

// 排序逻辑已下沉到 getDisplayedTrades() 内（先筛选后排序，不修改原 trades）
// 此函数保留为占位/兼容入口，调用 renderTableWithSelects 时会自动按当前 sort 状态排序
function applySort() {
  // no-op: 排序在 renderTable → getDisplayedTrades 中完成
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
  initStatusFilter();
  // P2-3: 一次性事件委托，避免 renderTable 重新设置 innerHTML 后丢失按钮 onclick
  bindTradeTableDelegation();
});

// P2-3: 交易表格容器上的事件委托
// 取代表格行内 onclick="..." 字符串拼装，支持 innerHTML 重置后按钮仍可点击
// 约定：按钮 data-action="detail"|"delete"、data-trade-id="..."
function bindTradeTableDelegation() {
  var table = document.getElementById('tradeTable');
  if (!table) return;
  // 防止重复绑定（多次触发 DOMContentLoaded 也不应重复挂监听）
  if (table.__delegationBound) return;
  table.__delegationBound = true;

  table.addEventListener('click', function(e) {
    var btn = e.target && e.target.closest && e.target.closest('[data-action]');
    if (!btn || !table.contains(btn)) return;
    var action = btn.dataset.action;
    var tradeId = btn.dataset.tradeId;
    if (!action || !tradeId) return;

    if (action === 'detail') {
      if (typeof openTradeDetail === 'function') openTradeDetail(tradeId);
    } else if (action === 'delete') {
      // 从 trades 中查询展示信息（openDeleteConfirm 需要 symbol/dir/entry）
      var trade = (typeof trades !== 'undefined' && Array.isArray(trades))
        ? trades.find(function(t) { return String(t.id) === String(tradeId); })
        : null;
      if (typeof openDeleteConfirm === 'function') {
        openDeleteConfirm(
          tradeId,
          trade ? (trade.symbol || '') : '',
          trade ? (trade.dir || '') : '',
          trade ? (trade.entry || '') : ''
        );
      }
    }
  });
}

// ===== 表格列显示切换 =====
function toggleTableColumns() {
  var table = document.getElementById('tradeTable');
  if (!table) return;
  var showAll = table.classList.toggle('show-all-columns');
  var btn = document.getElementById('toggleColumnsBtn');
  if (btn) {
    btn.textContent = showAll ? '收敛列' : '展开全部列';
    btn.setAttribute('aria-pressed', showAll ? 'true' : 'false');
  }
  // 持久化用户偏好
  try { localStorage.setItem('trade_table_show_all', showAll ? '1' : '0'); } catch(e) {}
}

function initTableColumnsState() {
  var table = document.getElementById('tradeTable');
  if (!table) return;
  var pref = null;
  try { pref = localStorage.getItem('trade_table_show_all'); } catch(e) {}
  if (pref === '1') {
    table.classList.add('show-all-columns');
    var btn = document.getElementById('toggleColumnsBtn');
    if (btn) {
      btn.textContent = '收敛列';
      btn.setAttribute('aria-pressed', 'true');
    }
  }
}

// ===== 交易详情弹窗 =====
function openTradeDetail(id) {
  var t = null;
  var idStr = String(id);
  for (var i = 0; i < trades.length; i++) {
    if (String(trades[i].id) === idStr) { t = trades[i]; break; }
  }
  if (!t) return;

  var html = '';
  function row(label, val, color) {
    var c = color ? ' style="color:' + color + '"' : '';
    html += '<div class="trade-detail-row"><span class="trade-detail-label">' + esc(label) + '</span><span class="trade-detail-val"' + c + '>' + (val === undefined || val === '' || val === null ? '—' : val) + '</span></div>';
  }
  function num(v, decimals) {
    if (v === '' || v === undefined || v === null || isNaN(parseFloat(v))) return '—';
    return decimals !== undefined ? parseFloat(v).toFixed(decimals) : v;
  }

  row('品种', t.symbol || '—');
  row('买点类型', t.buyType || '—', 'var(--color-purple)');
  row('方向', t.dir, t.dir === '多' ? 'var(--color-red)' : 'var(--color-green)');
  row('开仓日期', t.date || '—');
  row('出场日期', t.exitDate || '—');
  row('持仓天数', calcHoldDuration(t));
  row('入场价', num(t.entry, 4));
  row('止损价', num(t.stop, 4), 'var(--color-green)');
  row('平保价', num(t.breakEvenPrice, 4), 'var(--color-purple)');
  row('止盈目标', t.target ? parseFloat(t.target).toFixed(4) + (t.rrTarget ? ' (' + t.rrTarget + 'R)' : '') : '—', 'var(--color-red)');
  row('止盈距离', calcTpDist(t), 'var(--color-red)');
  row('出场价', num(t.exit, 4));
  row('出场距离', calcExitDist(t));
  row('卖点类型', t.exitType || '—');
  row('仓位金额', t.posSize ? '￥' + parseFloat(t.posSize).toLocaleString() : '—', 'var(--color-blue)');
  row('实际买入股数', t.actualLots ? t.actualLots + ' 股' : '—');
  row('风险 R 金额', (function() {
    var ar = calcActualRisk(t);
    return ar > 0 ? '￥' + ar.toFixed(2) : (t.riskAmount ? '￥' + parseFloat(t.riskAmount).toFixed(2) : '—');
  })(), 'var(--color-purple)');
  row('开仓手续费', t.openFee ? '￥' + parseFloat(t.openFee).toFixed(2) : '—');
  row('盈亏金额', t.pnl !== '' && !isNaN(t.pnl) ? CNY(parseFloat(t.pnl)) : '—', parseFloat(t.pnl) >= 0 ? 'var(--color-red)' : 'var(--color-green)');
  row('盈亏 R', t.pnlR !== '' && !isNaN(t.pnlR) ? fmtR(parseFloat(t.pnlR)) : '—', parseFloat(t.pnlR) >= 0 ? 'var(--color-red)' : 'var(--color-green)');
  row('状态', { 'open': '持仓中', 'win': '盈利', 'loss': '亏损', 'be': '保本' }[t.status] || '—');
  row('是否按计划执行', t.followedPlan || '—');
  if (t.note) row('备注', esc(t.note));

  var body = document.getElementById('tradeDetailBody');
  if (body) body.innerHTML = html;

  var titleEl = document.getElementById('tradeDetailTitle');
  if (titleEl) titleEl.textContent = '🔍 交易详情' + (t.symbol ? ' - ' + t.symbol : '');

  // 保存当前详情对应的 trade id
  var modal = document.getElementById('tradeDetailModal');
  if (modal) {
    modal.dataset.tradeId = idStr;
    modal.style.display = 'flex';
    // 绑定编辑按钮事件
    var editBtn = document.getElementById('tradeDetailEditBtn');
    if (editBtn) {
      editBtn.onclick = function() { openEditTradeModal(idStr); };
    }
  }
}

function closeTradeDetailModal() {
  var modal = document.getElementById('tradeDetailModal');
  if (modal) modal.style.display = 'none';
}

// ===== 交易编辑弹窗（新增 / 编辑） =====
function openAddTradeModal() {
  // 重置所有字段
  var fields = ['te_id', 'te_symbol', 'te_dir', 'te_buyType', 'te_entry', 'te_stop',
    'te_breakEvenPrice', 'te_target', 'te_rrTarget', 'te_posSize', 'te_actualLots',
    'te_riskAmount', 'te_openFee', 'te_date', 'te_exit', 'te_exitDate', 'te_exitType',
    'te_pnl', 'te_pnlR', 'te_status', 'te_followedPlan', 'te_note'];
  fields.forEach(function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.tagName === 'SELECT') {
      el.value = (id === 'te_dir' ? '多' : id === 'te_status' ? 'open' : id === 'te_followedPlan' ? '是' : id === 'te_exitType' ? '' : '');
    } else if (el.type === 'date') {
      el.value = getToday();
    } else {
      el.value = '';
    }
  });
  // 默认目标 R 倍数
  var rrEl = document.getElementById('te_rrTarget');
  if (rrEl) rrEl.value = '3';
  var actualLotsEl = document.getElementById('te_actualLots');
  if (actualLotsEl) actualLotsEl.value = '200';

  var titleEl = document.getElementById('tradeEditTitle');
  if (titleEl) titleEl.textContent = '＋ 新增交易';
  var delBtn = document.getElementById('te_deleteBtn');
  if (delBtn) delBtn.style.display = 'none';

  // 升级弹窗内所有原生 select 为 custom-select（视觉与"买点类型"统一）
  upgradeTradeEditSelects();

  var modal = document.getElementById('tradeEditModal');
  if (modal) modal.style.display = 'flex';
}

function openEditTradeModal(id) {
  var t = null;
  var idStr = String(id);
  for (var i = 0; i < trades.length; i++) {
    if (String(trades[i].id) === idStr) { t = trades[i]; break; }
  }
  if (!t) return;

  // 关闭详情弹窗（如果有）
  closeTradeDetailModal();

  function setVal(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val === undefined || val === null) ? '' : val;
  }
  setVal('te_id', t.id);
  setVal('te_symbol', t.symbol || '');
  setVal('te_dir', t.dir || '多');
  setVal('te_buyType', t.buyType || '');
  setVal('te_entry', t.entry !== '' ? t.entry : '');
  setVal('te_stop', t.stop !== '' ? t.stop : '');
  setVal('te_breakEvenPrice', t.breakEvenPrice !== '' ? t.breakEvenPrice : '');
  setVal('te_target', t.target !== '' ? t.target : '');
  setVal('te_rrTarget', t.rrTarget !== '' && t.rrTarget !== undefined ? t.rrTarget : 3);
  setVal('te_posSize', t.posSize !== '' ? t.posSize : '');
  setVal('te_actualLots', t.actualLots !== '' && t.actualLots !== undefined ? t.actualLots : '');
  setVal('te_riskAmount', t.riskAmount !== '' ? t.riskAmount : '');
  setVal('te_openFee', t.openFee !== '' ? t.openFee : '');
  setVal('te_date', t.date || getToday());
  setVal('te_exit', t.exit !== '' ? t.exit : '');
  setVal('te_exitDate', t.exitDate || t.date || getToday());
  setVal('te_exitType', t.exitType || '');
  setVal('te_pnl', t.pnl !== '' ? t.pnl : '');
  setVal('te_pnlR', t.pnlR !== '' ? t.pnlR : '');
  setVal('te_status', t.status || 'open');
  setVal('te_followedPlan', t.followedPlan || '是');
  setVal('te_note', t.note || '');

  var titleEl = document.getElementById('tradeEditTitle');
  if (titleEl) titleEl.textContent = '✏️ 编辑交易' + (t.symbol ? ' - ' + t.symbol : '');
  var delBtn = document.getElementById('te_deleteBtn');
  if (delBtn) delBtn.style.display = 'inline-block';

  // 绑定出场价联动逻辑：清空出场价时同步清空盈亏相关字段
  bindExitPriceLiveClear();

  // 升级弹窗内所有原生 select 为 custom-select（视觉与"买点类型"统一）
  upgradeTradeEditSelects();

  var modal = document.getElementById('tradeEditModal');
  if (modal) modal.style.display = 'flex';
}

// 把交易编辑弹窗内的所有原生 <select> 升级为 custom-select
// 升级本身有幂等保护（dataset.csUpgraded 标记），多次调用安全
function upgradeTradeEditSelects() {
  if (typeof upgradeSelectToCustom !== 'function') return;
  var modal = document.getElementById('tradeEditModal');
  if (!modal) return;
  modal.querySelectorAll('select').forEach(upgradeSelectToCustom);
}

// 当用户清空出场价时，实时清空盈亏金额、盈亏R、出场日期、出场类型
// 因为出场价空了意味着这笔交易未平仓，盈亏相关字段不应再有值
function bindExitPriceLiveClear() {
  var exitEl = document.getElementById('te_exit');
  if (!exitEl) return;
  // 移除旧监听器（避免重复绑定）
  if (exitEl._liveClearHandler) {
    exitEl.removeEventListener('input', exitEl._liveClearHandler);
  }
  var handler = function() {
    var val = exitEl.value.trim();
    if (val === '') {
      var fieldsToClear = ['te_pnl', 'te_pnlR', 'te_exitDate', 'te_exitType'];
      fieldsToClear.forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      var statusEl = document.getElementById('te_status');
      if (statusEl) statusEl.value = 'open';
    }
  };
  exitEl._liveClearHandler = handler;
  exitEl.addEventListener('input', handler);
}

function closeTradeEditModal() {
  var modal = document.getElementById('tradeEditModal');
  if (modal) modal.style.display = 'none';
}

function saveTradeFromModal() {
  function getVal(id) {
    var el = document.getElementById(id);
    if (!el) return '';
    var v = el.value;
    return v === null ? '' : v;
  }
  function num(id) {
    var v = getVal(id);
    if (v === '' || v === undefined || v === null) return '';
    var n = parseFloat(v);
    return isNaN(n) ? '' : n;
  }

  var id = getVal('te_id');
  var symbol = getVal('te_symbol').trim();
  var entry = num('te_entry');
  var stop = num('te_stop');

  if (!symbol && !entry) {
    showToast('请至少填写品种或入场价', 'error');
    return;
  }

  var tradeData = {
    symbol: symbol,
    dir: getVal('te_dir') || '多',
    buyType: getVal('te_buyType').trim(),
    entry: entry,
    stop: stop,
    breakEvenPrice: num('te_breakEvenPrice'),
    target: num('te_target'),
    rrTarget: num('te_rrTarget') !== '' ? num('te_rrTarget') : 0,
    posSize: num('te_posSize'),
    actualLots: num('te_actualLots') !== '' ? parseInt(getVal('te_actualLots')) : '',
    riskAmount: num('te_riskAmount'),
    openFee: num('te_openFee'),
    date: getVal('te_date') || getToday(),
    exit: num('te_exit'),
    exitDate: getVal('te_exitDate') || getVal('te_date') || getToday(),
    exitType: getVal('te_exitType'),
    pnl: num('te_pnl'),
    pnlR: num('te_pnlR'),
    status: getVal('te_status') || 'open',
    followedPlan: getVal('te_followedPlan') || '是',
    note: getVal('te_note').trim()
  };

  // 如果出场价被清空，意味着交易回退到未平仓状态
  // 此时盈亏金额、pnlR、出场日期、出场类型应一并清空，状态改回 open
  // 但仅当原 trade 已有出场价（用户主动从有 → 无）时才联动清空
  // 如果原本就是 open（无出场价），保留用户填写的 exitType（事后补全场景）
  var oldExit = '';
  if (id) {
    var oldTrade = null;
    for (var i = 0; i < trades.length; i++) {
      if (String(trades[i].id) === String(id)) { oldTrade = trades[i]; break; }
    }
    oldExit = oldTrade && oldTrade.exit !== '' ? oldTrade.exit : '';
  } else {
    oldExit = 'new';  // 新增模式，标记一下
  }
  if (tradeData.exit === '' && oldExit !== '' && oldExit !== 'new') {
    // 用户主动清空已有出场价 → 联动清空相关字段
    tradeData.pnl = '';
    tradeData.pnlR = '';
    tradeData.exitDate = '';
    tradeData.exitType = '';
    tradeData.status = 'open';
  }

  // 自动计算盈亏（如果入场价、出场价、仓位金额齐全且用户未填盈亏）
  // P1-4: 净盈亏计算抽离到 utils.js 的 calcPnl()（含手续费），与 updateTrade 共用同一逻辑
  if (tradeData.entry !== '' && tradeData.exit !== '' && tradeData.posSize !== '' && tradeData.pnl === '') {
    var pnl = calcPnl(tradeData);
    if (pnl !== null) tradeData.pnl = pnl;
  }
  // 自动计算 pnlR（如果风险金额存在且 pnl 已知）
  if (tradeData.pnl !== '' && tradeData.riskAmount !== '' && parseFloat(tradeData.riskAmount) !== 0 && tradeData.pnlR === '') {
    tradeData.pnlR = Math.round(parseFloat(tradeData.pnl) / parseFloat(tradeData.riskAmount) * 100) / 100;
  }

  if (id) {
    // 编辑模式：更新现有 trade
    var idStr = String(id);
    for (var i = 0; i < trades.length; i++) {
      if (String(trades[i].id) === idStr) {
        Object.keys(tradeData).forEach(function(k) { trades[i][k] = tradeData[k]; });
        // 编辑后记录 closeTime 如果状态从 open 变为非 open
        if (trades[i].status !== 'open' && !trades[i].closeTime) {
          trades[i].closeTime = new Date().toISOString();
        }
        markTradeDirty(idStr);
        break;
      }
    }
  } else {
    // 新增模式
    tradeData.id = generateUUID();
    tradeData.openTime = new Date().toISOString();
    trades.push(tradeData);
    markTradeDirty(tradeData.id);
  }

  updateAll();

  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }

  // 显示保存成功提示
  var el = document.getElementById('syncStatus');
  if (el) {
    el.textContent = '✓ 已保存交易：' + (tradeData.symbol || '未命名');
    el.style.color = '#00e676';
    setTimeout(function() { el.textContent = ''; }, 3000);
  }

  closeTradeEditModal();
}

function deleteTradeFromEditModal() {
  var id = document.getElementById('te_id').value;
  if (!id) return;
  // P1-2: 用 showConfirm 替代原生 confirm（异步）
  showConfirm({
    title: '删除确认',
    message: '确认删除此交易记录？此操作不可撤销。',
    confirmText: '删除',
    type: 'warning'
  }).then(function(ok) {
    if (!ok) return;
    __proceedDeleteTrade(id);
  });
}

// P1-2: 删除交易的实际逻辑（confirm 通过后调用）
function __proceedDeleteTrade(id) {
  var idStr = String(id);
  // 先关闭编辑弹窗
  closeTradeEditModal();

  // 找到对应 trade 取信息用于删除确认
  var t = trades.find(function(x) { return String(x.id) === idStr; });
  var symbol = t ? (t.symbol || '') : '';
  var dir = t ? (t.dir || '') : '';
  var entry = t ? (t.entry || '') : '';

  // 复用现有删除流程
  pendingDeleteTradeId = id;
  // 直接执行删除（用户已确认）
  trades = trades.filter(function(x) { return String(x.id) !== idStr; });
  markTradeDeleted(idStr);
  updateAll();
  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }
  if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
    syncModule.deleteTradeFromServer(idStr).catch(function(err) {
      console.error('删除服务器记录失败:', err);
    });
  }
  var el = document.getElementById('syncStatus');
  if (el) {
    el.textContent = '✓ 已删除交易：' + (symbol || '未命名');
    el.style.color = '#ff5252';
    setTimeout(function() { el.textContent = ''; }, 3000);
  }
}

// 在详情弹窗中快速跳转到该交易的编辑（聚焦表格行）
function focusTradeInTable(id) {
  closeTradeDetailModal();
  var row = document.querySelector('tr[data-trade-id="' + CSS.escape(String(id)) + '"]');
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row-highlight');
    setTimeout(function() { row.classList.remove('row-highlight'); }, 2000);
  }
}
