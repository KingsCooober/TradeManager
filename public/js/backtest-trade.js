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
var BT_initCapital = 100000;        // 初始资金（元）
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

// 持久化键
function BT_storageKey(symbol) {
  return 'bt_trades_' + (symbol || 'unknown');
}

// 加载某标的的历史成交记录
function BT_loadTrades(symbol) {
  try {
    var raw = localStorage.getItem(BT_storageKey(symbol));
    BT_trades = raw ? JSON.parse(raw) : [];
  } catch (e) {
    BT_trades = [];
  }
  BT_recomputePosition();
}

// 保存到 localStorage
function BT_saveTrades() {
  if (!BT_currentSymbol) return;
  try {
    localStorage.setItem(BT_storageKey(BT_currentSymbol), JSON.stringify(BT_trades));
  } catch (e) {
    console.warn('[backtest] 保存交易记录失败:', e);
  }
}

// 清空当前标的的交易记录
function BT_clearAllTrades() {
  BT_trades = [];
  BT_position = { volume: 0, cost: 0, realized: 0 };
  BT_saveTrades();
  BT_renderTrades();
  BT_renderStats();
  BT_refreshChartMarkers();
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

  // 浮动盈亏（基于当前光标日的收盘价）
  var unrealized = 0;
  if (pos.volume > 0 && currentClosePrice && currentClosePrice > 0) {
    unrealized = (currentClosePrice - pos.cost) * pos.volume;
  }

  // 总收益率 = (已实现 + 浮动) / 初始资金
  var totalReturn = (BT_position.realized + unrealized) / BT_initCapital * 100;

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
    cost: pos.cost
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

  setText('statWinRate', stats.closedCount > 0 ? stats.winRate.toFixed(1) + '%' + ' (' + stats.closedCount + ')' : '--');

  if (stats.profitFactor === Infinity) {
    setText('statProfitFactor', '∞');
  } else if (stats.profitFactor > 0) {
    setText('statProfitFactor', stats.profitFactor.toFixed(2));
  } else {
    setText('statProfitFactor', '--');
  }

  setText('statTradeCount', BT_trades.length + ' 笔');
}

// 简易 toast 提示
function BT_toast(msg, type) {
  var el = document.getElementById('btToast');
  if (!el) { console.log('[backtest]', msg); return; }
  el.textContent = msg;
  el.className = 'bt-toast show ' + (type || 'success');
  setTimeout(function() { el.className = 'bt-toast ' + (type || 'success'); }, 2200);
}
