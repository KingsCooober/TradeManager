/**
 * 回测页 — 虚拟交易 + 指标计算
 *
 * 核心数据：BT_trades (Array<{id,date,action:'buy'|'sell',price,volume,fee,note}>)
 *           BT_position ({volume, cost, realized}) 当前持仓 & 已实现盈亏
 *           BT_initCapital 初始资金
 *
 * 算法：
 *   - 买入：扣资金 = price*volume*(1+fee)，加持仓 = volume，加权平均成本 = ((旧持仓*旧成本)+本次金额)/(旧持仓+本次)
 *   - 卖出：减持仓 = volume（不允许卖空），加已实现盈亏 = (price-cost)*volume - fee
 *   - 胜率 = 盈利平仓笔数 / 总平仓笔数
 *   - 盈亏比 = 平均盈利 / 平均亏损（绝对值）
 *
 * 持久化：localStorage 按 symbol 分键（bt_trades_<symbol>），切换标的互不干扰
 */

// 全局状态（加 BT_ 前缀避免与主页 trades 冲突）
var BT_initCapital = 100000;        // 初始资金（元），可由用户调整
var BT_cash = BT_initCapital;       // 当前现金余额（buy 扣、sell 加净 P&L）
var BT_feeRate = 0.0003;            // 手续费率（万三）
var BT_trades = [];                 // 当前标的的全部成交记录
var BT_currentSymbol = null;        // 当前加载的标的
var BT_position = { volume: 0, cost: 0, realized: 0 };  // 当前持仓 + 已实现盈亏
var BT_currentDate = null;          // 光标所在日期
var BT_currentClose = null;         // 光标所在日的收盘价

// 简易 ID 生成
function BT_genId() {
  return 'bt_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

// 用户调整初始资金：仅修改初始资金，不重置已有交易和现金
// 累计收益率 = (当前资金 - 初始资金) / 初始资金，初始资金改动会直接影响这个比率
function BT_setInitCapital() {
  var el = document.getElementById('btInitCapital');
  if (!el) return;
  var v = parseFloat(el.value);
  if (!isFinite(v) || v <= 0) {
    BT_toast('初始资金必须大于 0', 'warn');
    el.value = BT_initCapital;
    return;
  }
  BT_initCapital = v;
  BT_renderStats();
}

// 重置资金（含现金），用于切标的时
function BT_resetCapital() {
  BT_cash = BT_initCapital;
  BT_position = { volume: 0, cost: 0, realized: 0 };
  BT_trades = [];
}

// 持久化键
function BT_storageKey(symbol) {
  return 'bt_trades_' + (symbol || 'unknown');
}

// 加载某标的的历史成交记录
function BT_loadTrades(symbol) {
  try {
    var raw = localStorage.getItem(BT_storageKey(symbol));
    var trades = raw ? JSON.parse(raw) : [];
    BT_trades = trades;
    // 如果有持久化的 cash，恢复；否则重置为初始资金
    var cashRaw = localStorage.getItem(BT_storageKey(symbol) + '_cash');
    BT_cash = cashRaw != null ? parseFloat(cashRaw) : BT_initCapital;
    if (!isFinite(BT_cash)) BT_cash = BT_initCapital;
  } catch (e) {
    BT_trades = [];
    BT_cash = BT_initCapital;
  }
  BT_recomputePosition();
  BT_recomputeCash();
}

// 保存到 localStorage
function BT_saveTrades() {
  if (!BT_currentSymbol) return;
  try {
    localStorage.setItem(BT_storageKey(BT_currentSymbol), JSON.stringify(BT_trades));
    localStorage.setItem(BT_storageKey(BT_currentSymbol) + '_cash', String(BT_cash));
  } catch (e) {
    console.warn('[backtest] 保存交易记录失败:', e);
  }
}

// 清空当前标的的交易记录
function BT_clearAllTrades() {
  BT_trades = [];
  BT_position = { volume: 0, cost: 0, realized: 0 };
  BT_cash = BT_initCapital;   // 现金重置回初始资金
  BT_saveTrades();
  BT_renderTrades();
  BT_renderStats();
  BT_refreshChartMarkers();
  if (typeof BT_refreshEquityCurve === 'function') BT_refreshEquityCurve();
}

// 重新计算当前持仓 + 已实现盈亏
// 算法：顺序遍历 trades，buy 加仓并更新加权成本，sell 减仓并按当前成本结转盈亏
function BT_recomputePosition() {
  BT_position = { volume: 0, cost: 0, realized: 0 };
  for (var i = 0; i < BT_trades.length; i++) {
    var t = BT_trades[i];
    if (t.action === 'buy') {
      var newVol = BT_position.volume + t.volume;
      if (newVol > 0) {
        BT_position.cost = (BT_position.volume * BT_position.cost + t.volume * t.price) / newVol;
      }
      BT_position.volume = newVol;
    } else if (t.action === 'sell') {
      // 按当前成本结转已实现盈亏
      var sellVol = Math.min(t.volume, BT_position.volume);
      if (sellVol > 0) {
        BT_position.realized += (t.price - BT_position.cost) * sellVol;
        BT_position.volume -= sellVol;
        if (BT_position.volume === 0) BT_position.cost = 0;
      }
    }
  }
}

// 重算现金余额（基于初始资金 + 全部交易的现金流，兜底防 cash 漂移）
// 公式：cash = init - sum(buy_paid) + sum(sell_received)
//   buy_paid = price*volume + fee
//   sell_received = price*volume - fee
function BT_recomputeCash() {
  var cash = BT_initCapital;
  for (var i = 0; i < BT_trades.length; i++) {
    var t = BT_trades[i];
    var fee = t.fee || 0;
    if (t.action === 'buy') {
      cash -= t.price * t.volume + fee;
    } else if (t.action === 'sell') {
      cash += t.price * t.volume - fee;
    }
  }
  BT_cash = cash;
}

// 买入
function BT_doBuy(date, price, volume) {
  if (!date || !price || !volume) {
    BT_toast('请先在 K 线上移动光标', 'warn');
    return;
  }
  if (volume <= 0) {
    BT_toast('数量必须大于 0', 'warn');
    return;
  }
  var fee = price * volume * BT_feeRate;
  var cost = price * volume + fee;
  // 资金不足保护
  if (cost > BT_cash) {
    BT_toast('资金不足：需要 ¥' + cost.toFixed(0) + '，可用 ¥' + BT_cash.toFixed(0), 'error');
    return;
  }
  BT_cash -= cost;   // 实时扣现金
  BT_trades.push({
    id: BT_genId(),
    date: date,
    action: 'buy',
    price: price,
    volume: volume,
    fee: fee,
    note: ''
  });
  BT_recomputePosition();
  BT_saveTrades();
  BT_renderTrades();
  BT_renderStats();
  BT_refreshChartMarkers();
  if (typeof BT_refreshEquityCurve === 'function') BT_refreshEquityCurve();
  BT_toast('买入 ' + volume + ' 股 @ ' + price.toFixed(2) + ' (' + date + ')', 'success');
}

// 卖出
function BT_doSell(date, price, volume) {
  if (!date || !price || !volume) {
    BT_toast('请先在 K 线上移动光标', 'warn');
    return;
  }
  if (volume <= 0) {
    BT_toast('数量必须大于 0', 'warn');
    return;
  }
  if (volume > BT_position.volume) {
    BT_toast('当前持仓只有 ' + BT_position.volume + ' 股，无法卖出 ' + volume, 'error');
    return;
  }
  var fee = price * volume * BT_feeRate;
  var pnl = (price - BT_position.cost) * volume - fee;
  BT_cash += price * volume - fee;   // 实时加现金（净收入）
  BT_trades.push({
    id: BT_genId(),
    date: date,
    action: 'sell',
    price: price,
    volume: volume,
    fee: fee,
    pnl: pnl,
    note: ''
  });
  BT_recomputePosition();
  BT_saveTrades();
  BT_renderTrades();
  BT_renderStats();
  BT_refreshChartMarkers();
  if (typeof BT_refreshEquityCurve === 'function') BT_refreshEquityCurve();
  BT_toast((pnl >= 0 ? '盈利 ' : '亏损 ') + pnl.toFixed(2) + ' @ ' + price.toFixed(2) + ' (' + date + ')', pnl >= 0 ? 'success' : 'error');
}

// 一键清仓
function BT_clearPosition() {
  if (BT_position.volume === 0) {
    BT_toast('当前无持仓', 'warn');
    return;
  }
  if (!BT_currentDate || !BT_currentClose) {
    BT_toast('请先在 K 线上移动光标', 'warn');
    return;
  }
  if (!confirm('确定以 ' + BT_currentClose.toFixed(2) + ' 的价格清仓 ' + BT_position.volume + ' 股？')) return;
  BT_doSell(BT_currentDate, BT_currentClose, BT_position.volume);
}

// 删除最后一笔（撤销）
function BT_deleteLastTrade() {
  if (BT_trades.length === 0) {
    BT_toast('没有可撤销的交易', 'warn');
    return;
  }
  if (!confirm('确定删除最后一笔交易（' + BT_trades[BT_trades.length - 1].date + ' ' +
    (BT_trades[BT_trades.length - 1].action === 'buy' ? '买入' : '卖出') + '）？')) return;
  BT_trades.pop();
  BT_recomputePosition();
  BT_saveTrades();
  BT_renderTrades();
  BT_renderStats();
  BT_refreshChartMarkers();
  BT_toast('已撤销最后一笔', 'success');
}

// 统计指标
function BT_computeStats(currentClosePrice) {
  // 平仓盈亏列表（每个 sell 对应一次平仓盈亏）
  var closed = []; // {pnl, pnlPct}
  var pos = { volume: 0, cost: 0 };
  for (var i = 0; i < BT_trades.length; i++) {
    var t = BT_trades[i];
    if (t.action === 'buy') {
      var nv = pos.volume + t.volume;
      if (nv > 0) pos.cost = (pos.volume * pos.cost + t.volume * t.price) / nv;
      pos.volume = nv;
    } else {
      var sv = Math.min(t.volume, pos.volume);
      if (sv > 0) {
        closed.push({ pnl: (t.price - pos.cost) * sv - (t.fee || 0), pnlPct: (t.price - pos.cost) / pos.cost });
        pos.volume -= sv;
        if (pos.volume === 0) pos.cost = 0;
      }
    }
  }

  // 胜率
  var wins = closed.filter(function(c) { return c.pnl > 0; }).length;
  var winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;

  // 盈亏比
  var avgWin = 0, avgLoss = 0;
  if (wins > 0) {
    avgWin = closed.filter(function(c) { return c.pnl > 0; }).reduce(function(s, c) { return s + c.pnl; }, 0) / wins;
  }
  var losses = closed.filter(function(c) { return c.pnl < 0; });
  if (losses.length > 0) {
    avgLoss = Math.abs(losses.reduce(function(s, c) { return s + c.pnl; }, 0) / losses.length);
  }
  var profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);

  // 最大连续亏损次数：扫描 closed 数组，连续亏损累加计数
  var maxConsecLoss = 0;
  var curConsecLoss = 0;
  for (var ci = 0; ci < closed.length; ci++) {
    if (closed[ci].pnl < 0) {
      curConsecLoss++;
      if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
    } else {
      curConsecLoss = 0;
    }
  }

  // 最大回撤（基于"累计已实现 P&L"权益曲线）
  // 简化版：曲线 = [初始资金, 初始+pnl1, 初始+pnl1+pnl2, ...]
  // 只统计 sell 后的已实现盈亏——未平仓持仓的浮动盈亏已包含在当前总资金里
  var peak = BT_initCapital;
  var maxDrawdown = 0;
  var cumPnl = 0;
  for (var di = 0; di < closed.length; di++) {
    cumPnl += closed[di].pnl;
    var equity = BT_initCapital + cumPnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      var dd = (peak - equity) / peak * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // 浮动盈亏（基于当前光标日的收盘价）
  var unrealized = 0;
  if (pos.volume > 0 && currentClosePrice && currentClosePrice > 0) {
    unrealized = (currentClosePrice - pos.cost) * pos.volume;
  }

  // 持仓市值 = 持仓股数 × 当前收盘价
  var positionValue = 0;
  if (pos.volume > 0 && currentClosePrice && currentClosePrice > 0) {
    positionValue = pos.volume * currentClosePrice;
  }
  // 当前总资金 = 现金余额 + 持仓市值
  var currentCapital = BT_cash + positionValue;
  // 累计收益率 = (当前资金 - 初始资金) / 初始资金
  var totalReturn = BT_initCapital > 0 ? (currentCapital - BT_initCapital) / BT_initCapital * 100 : 0;
  // 当前仓位 % = 持仓市值 / 当前总资金
  var positionPct = currentCapital > 0 ? positionValue / currentCapital * 100 : 0;

  return {
    totalReturn: totalReturn,
    realized: BT_position.realized,
    unrealized: unrealized,
    winRate: winRate,
    profitFactor: profitFactor,
    avgWin: avgWin,
    avgLoss: avgLoss,
    tradeCount: BT_trades.length,
    closedCount: closed.length,
    position: pos.volume,
    cost: pos.cost,
    currentCapital: currentCapital,
    cash: BT_cash,
    positionValue: positionValue,
    positionPct: positionPct,
    maxDrawdown: maxDrawdown,
    maxConsecLoss: maxConsecLoss
  };
}

// 渲染交易明细表
function BT_renderTrades() {
  var tbody = document.getElementById('btTradesBody');
  if (!tbody) return;
  if (BT_trades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="bt-empty">还没有交易记录，加载 K 线后开始模拟买卖吧 👆</td></tr>';
    return;
  }

  // 计算每笔的"本笔盈亏"（仅 sell 显示，buy 显示 -）
  var pos = { volume: 0, cost: 0 };
  var rows = [];
  for (var i = 0; i < BT_trades.length; i++) {
    var t = BT_trades[i];
    var pnlCell = '<td style="text-align: right; color: var(--text-secondary, #999);">-</td>';
    if (t.action === 'buy') {
      var nv = pos.volume + t.volume;
      if (nv > 0) pos.cost = (pos.volume * pos.cost + t.volume * t.price) / nv;
      pos.volume = nv;
    } else {
      var sv = Math.min(t.volume, pos.volume);
      var pnl = 0;
      if (sv > 0) {
        pnl = (t.price - pos.cost) * sv - (t.fee || 0);
        pos.volume -= sv;
        if (pos.volume === 0) pos.cost = 0;
      }
      var color = pnl > 0 ? 'var(--color-red, #ef476f)' : 'var(--color-green, #2d9f7f)';
      pnlCell = '<td style="text-align: right; color: ' + color + '; font-weight: 600;">' +
        (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '</td>';
    }
    var actionLabel = t.action === 'buy' ? '<span class="bt-buy">🟥 买入</span>' : '<span class="bt-sell">🟩 卖出</span>';
    rows.push(
      '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + t.date + '</td>' +
        '<td>' + actionLabel + '</td>' +
        '<td style="text-align: right;">' + t.price.toFixed(2) + '</td>' +
        pnlCell +
        '<td style="text-align: center;">' + (i === BT_trades.length - 1 ? '<button class="bt-del" title="删除最后一笔" onclick="BT_deleteLastTrade()">✕</button>' : '') + '</td>' +
      '</tr>'
    );
  }
  tbody.innerHTML = rows.join('');
}

// 渲染顶部统计卡
function BT_renderStats() {
  var stats = BT_computeStats(BT_currentClose);
  function setText(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }
  function setClass(id, cls) { var el = document.getElementById(id); if (el) el.className = 'bt-stat-value ' + cls; }

  // 初始资金
  setText('statInitCapital', '¥' + BT_initCapital.toLocaleString());

  // 累计收益率
  if (BT_trades.length === 0) {
    setText('statTotalReturn', '0.00%');
  } else {
    setText('statTotalReturn', (stats.totalReturn >= 0 ? '+' : '') + stats.totalReturn.toFixed(2) + '%');
    setClass('statTotalReturn', stats.totalReturn >= 0 ? 'up' : 'down');
  }

  // 当前仓位
  if (stats.position === 0) {
    setText('statPosition', '空仓');
  } else {
    setText('statPosition', stats.positionPct.toFixed(1) + '%  (' + stats.position + '股@¥' + stats.cost.toFixed(2) + ')');
  }

  // 当前资金 = 现金 + 持仓市值
  setText('statCurrentCapital', '¥' + stats.currentCapital.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ','));

  // 胜率
  setText('statWinRate', stats.closedCount > 0 ? stats.winRate.toFixed(1) + '%' + ' (' + stats.closedCount + ')' : '--');

  // 盈亏比
  if (stats.profitFactor === Infinity) {
    setText('statProfitFactor', '∞');
  } else if (stats.profitFactor > 0) {
    setText('statProfitFactor', stats.profitFactor.toFixed(2));
  } else {
    setText('statProfitFactor', '--');
  }

  // 交易次数
  setText('statTradeCount', BT_trades.length + ' 笔');

  // 最大回撤（>10% 高亮红色提示风险）
  setText('statMaxDrawdown', stats.maxDrawdown > 0 ? stats.maxDrawdown.toFixed(2) + '%' : '0.00%');
  setClass('statMaxDrawdown', stats.maxDrawdown > 10 ? 'down' : '');

  // 最大连续亏损（≥3 次高亮提示）
  setText('statMaxConsecLoss', stats.maxConsecLoss + ' 次');
  setClass('statMaxConsecLoss', stats.maxConsecLoss >= 3 ? 'down' : '');
}

// 简易 toast 提示
function BT_toast(msg, type) {
  var el = document.getElementById('btToast');
  if (!el) { console.log('[backtest]', msg); return; }
  el.textContent = msg;
  el.className = 'bt-toast show ' + (type || 'success');
  setTimeout(function() { el.className = 'bt-toast ' + (type || 'success'); }, 2200);
}
