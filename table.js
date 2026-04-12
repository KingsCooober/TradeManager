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
    renderTable();
  });
}

function deleteTrade(id) {
  if (!confirm('确认删除？')) return;
  // 将ID转为字符串比较，兼容数字和字符串ID
  var idStr = String(id);
  trades = trades.filter(function(t) { return String(t.id) !== idStr; });
  
  // 保存到本地
  var savePromise = save();
  
  // 如果已登录，同时删除服务器上的记录
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
  
  // 等待所有操作完成后再更新界面
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

  save().then(function() {
    updateAll();
  });
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

    // 出场日期使用自定义日期选择器
    var exitDatePicker = createDatePicker('exit', t.id, 'exitDate', t.exitDate);

    // 风险R使用实际可能止损金额显示
    var actRisk = calcActualRisk(t);
    var riskDisplay = actRisk > 0 ? actRisk.toFixed(2) + ' ￥' : (t.riskAmount ? parseFloat(t.riskAmount).toFixed(2) + ' ￥' : '-');

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
      '<td><div class="date-cell">' + exitDatePicker + '</div></td>' +
      '<td style="' + exDC + ';text-align:right">' + exD + '</td>' +
      '<td style="' + pC + ';text-align:right">' + (t.pnl !== '' && !isNaN(t.pnl) ? CNY(parseFloat(t.pnl)) : '-') + '</td>' +
      '<td style="' + pRC + ';text-align:right">' + (t.pnlR !== '' && !isNaN(t.pnlR) ? fmtR(parseFloat(t.pnlR)) : '-') + '</td>' +
      '<td style="text-align:center;white-space:nowrap">' + calcHoldDuration(t) + '</td>' +
      '<td><select class="in-status" data-status="' + t.status + '" onchange="updateTrade(' + sqesc(t.id) + ',\'status\',this.value);this.setAttribute(\'data-status\',this.value)"><option value="open"' + (t.status === 'open' ? ' selected' : '') + '>持仓中</option><option value="win"' + (t.status === 'win' ? ' selected' : '') + '>盈利</option><option value="loss"' + (t.status === 'loss' ? ' selected' : '') + '>亏损</option><option value="be"' + (t.status === 'be' ? ' selected' : '') + '>保本</option></select></td>' +
      '<td><select class="in-followedPlan" onchange="updateTrade(' + sqesc(t.id) + ',\'followedPlan\',this.value)"><option value="是"' + (t.followedPlan === '是' ? ' selected' : '') + '>是</option><option value="否"' + (t.followedPlan === '否' ? ' selected' : '') + '>否</option></select></td>' +
      '<td><input type="text" class="in-note" value="' + esc(t.note || '') + '" placeholder="备注" onchange="updateTrade(' + sqesc(t.id) + ',\'note\',this.value)"></td>' +
      '<td><button class="btn btn-danger btn-sm" onclick="deleteTrade(' + sqesc(t.id) + ')">删除</button></td></tr>';
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
