// ===== 工具函数 =====

// 买点类型选项（开仓计算器 与 每日复盘交易复盘 共用，修改此数组即可同步两处）
var BUY_TYPES = [
  '一类买点: 单周期15分钟回踩突破',
  '二类买点: 上升趋势缩量回踩支撑:10-20多头,量比小于0.75',
  '三类买点: 上升趋势波段底部放量支撑位置缩量企稳:10日线斜率平缓向上',
];

// 生成UUID v4
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 把 Date 对象格式化为本地时区的 YYYY-MM-DD
// ★ 不能用 toISOString()：它按 UTC 输出，在 UTC+8 会导致每天 00:00–08:00
//   期间拿到的还是"昨天"，使今日开仓/盈亏、计算器默认日期、导出文件名全部错位。
function formatLocalDate(d) {
  var date = d || new Date();
  var y = date.getFullYear();
  var m = String(date.getMonth() + 1).padStart(2, '0');
  var day = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

// 解析 YYYY-MM-DD 为本地时区当天 00:00 的 Date
// （new Date('2024-01-01') 会被当作 UTC 午夜，在东八区实际是当天 08:00，导致天数算错）
function parseLocalDate(str) {
  var s = String(str || '').slice(0, 10);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// 获取当天日期 YYYY-MM-DD（本地时区）
function getToday() {
  return formatLocalDate(new Date());
}

// 格式化数字（用于收益曲线弹窗）
function formatNumber(n) {
  if (isNaN(n) || n === null || n === undefined) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// 格式化货币
function CNY(n) {
  if (isNaN(n) || n === null || n === undefined) return '-';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ￥';
}

// 格式化货币（万元，用于图表坐标轴）
function CNYW(n) {
  if (isNaN(n) || n === null || n === undefined) return '-';
  var w = n / 10000;
  if (Math.abs(w) >= 10000) {
    return (w / 10000).toFixed(2) + '亿';
  }
  if (w === 0) return '0';
  if (Math.abs(w) < 0.01) return w.toFixed(4) + '万';
  if (Math.abs(w) < 1) return w.toFixed(2) + '万';
  return w.toFixed(1) + '万';
}

// 格式化R值
function fmtR(n) {
  if (isNaN(n) || n === null) return '-';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
}

// HTML转义（P0-2: 补全单引号转义，统一作为全局唯一的转义函数）
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 转义单引号，用于JavaScript字符串
function sqesc(s) {
  return "'" + String(s).replace(/'/g, "\\'") + "'";
}

// 获取某年某月的天数（用于日期相关计算）
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 注：getYearRange() 已删除——它服务于自造年/月/日三联动下拉（onDatePickerChange），
//     该方案已被原生 type="date" 取代且无任何调用方（连同 table.js 的死代码一并清理）。

function calcTpDist(t) {
  if (!t.entry || !t.target || !parseFloat(t.entry) || !parseFloat(t.target)) return '-';
  return (Math.abs(parseFloat(t.target) - parseFloat(t.entry)) / parseFloat(t.entry) * 100).toFixed(2) + '%';
}

function calcExitDist(t) {
  if (!t.entry || !t.exit || !parseFloat(t.entry) || !parseFloat(t.exit)) return '-';
  var raw = parseFloat(t.exit) - parseFloat(t.entry);
  return (raw >= 0 ? '+' : '-') + (Math.abs(raw) / parseFloat(t.entry) * 100).toFixed(2) + '%';
}

// P1-4: 计算单笔交易的净盈亏（毛盈亏 - 开仓/出场手续费）
// 消除 table.js 中 updateTrade 与 saveTradeFromModal 的重复计算逻辑
// 入参 trade：需含 entry, exit, posSize, actualLots, dir
//   - dir '多': (exit - entry) / entry；dir '空': (entry - exit) / entry
//   - 手续费：开仓 = pos * feeRate；出场 = lots>0 ? exit*lots*feeRate : pos*feeRate
// 返回：净盈亏（四舍五入到 2 位小数）；入参不全或无意义时返回 null
// 依赖全局 getFeeRate()（storage.js，运行时存在）；缺失时按 0 费率计算
function calcPnl(trade) {
  if (!trade) return null;
  var e = parseFloat(trade.entry),
      ex = parseFloat(trade.exit),
      pos = parseFloat(trade.posSize) || 0,
      lots = parseFloat(trade.actualLots) || 0;
  if (isNaN(e) || isNaN(ex) || pos <= 0 || e === 0) return null;
  var pct = trade.dir === '多' ? (ex - e) / e : (e - ex) / e;
  var grossPnl = pos * pct;
  var feeRate = (typeof getFeeRate === 'function' ? getFeeRate() : 0) / 100;
  var openFee = pos * feeRate;
  var exitFee = lots > 0 ? (ex * lots * feeRate) : (pos * feeRate);
  var totalFees = openFee + exitFee;
  return Math.round((grossPnl - totalFees) * 100) / 100;
}

// 计算持仓时间（使用出场日期减去开仓日期）
// ★ 统一用 parseLocalDate 解析，避免 new Date('YYYY-MM-DD') 按 UTC 解析、
//   而 new Date('YYYY-MM-DD' + 'T23:59:59') 按本地解析造成的一天偏差。
function calcHoldDuration(t) {
  if (t.status === 'open') {
    if (!t.date) {
      return '<span style="color:#ffd740">持仓中</span>';
    }

    var openDateOpen = parseLocalDate(t.date);
    if (!openDateOpen) return '<span style="color:#ffd740">持仓中</span>';
    var today = parseLocalDate(getToday());
    var diffDaysOpen = Math.round((today - openDateOpen) / (1000 * 60 * 60 * 24));
    if (diffDaysOpen < 0) diffDaysOpen = 0;

    return '<span style="color:#ffd740">持仓中(' + diffDaysOpen + '天)</span>';
  }

  if (!t.date) {
    return '-';
  }

  var openDate = parseLocalDate(t.date);
  var endDate = parseLocalDate(t.exitDate || t.date);
  if (!openDate || !endDate) {
    return '-';
  }

  var diffDays = Math.round((endDate - openDate) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return '<span style="color:#ff5252">异常</span>';
  }

  return diffDays + '天';
}

// ===== 回测练习：两版共用的标的记忆 =====
// backtest.html（ECharts）和 backtest-kc.html（klinecharts）是两个独立页面。
// K 线本来就取自同一张 stock_kline 表，但标的记忆原先各存各的
// （bt_state_form / btk_settings），换个页面就得重新输代码。
// 这里统一成一对共享 key：谁用过哪只票，另一个页面直接接上。
// 登录状态下再同步一份到 DataStore（collection=backtest_symbols），换设备也能带走。

var BT_SHARED_SYMBOL_KEY = 'bt_shared_symbol';
var BT_SHARED_RECENT_KEY = 'bt_shared_recent';
var BT_SHARED_RECENT_MAX = 12;

// 读「最后一次用的标的」：{ symbol, name, at } 或 null
function btSharedGetSymbol() {
  try {
    var raw = localStorage.getItem(BT_SHARED_SYMBOL_KEY);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    return obj && obj.symbol ? obj : null;
  } catch (e) { return null; }
}

// 读共享的「最近标的」列表（最新的在前）
function btSharedGetRecent() {
  try {
    var arr = JSON.parse(localStorage.getItem(BT_SHARED_RECENT_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter(function (x) { return x && x.symbol; });
  } catch (e) { return []; }
}

// 记录「刚用过的标的」：写当前标的 + 更新最近列表 + 尽力同步到服务器
function btSharedSetSymbol(symbol, name) {
  if (!symbol) return;
  symbol = String(symbol).toLowerCase();
  var entry = { symbol: symbol, name: name || '', at: Date.now() };
  try { localStorage.setItem(BT_SHARED_SYMBOL_KEY, JSON.stringify(entry)); } catch (e) { }

  var recent = btSharedGetRecent().filter(function (x) { return x.symbol !== symbol; });
  recent.unshift({ symbol: symbol, name: entry.name });
  recent = recent.slice(0, BT_SHARED_RECENT_MAX);
  try { localStorage.setItem(BT_SHARED_RECENT_KEY, JSON.stringify(recent)); } catch (e) { }

  // DataStore 未加载 / 未登录时静默跳过，下次记录会再推一遍（本地已存好）
  try {
    if (typeof DataStore !== 'undefined' && DataStore.collection) {
      DataStore.collection('backtest_symbols').save({
        id: 'shared',
        current: entry,
        recent: recent
      });
    }
  } catch (e) { }
}

// 从服务器补齐共享标的（跨设备）。store.js 在 utils.js 之后加载，所以只能异步做，
// 且必须比时间戳：本地更新更晚就保留本地，避免旧数据把刚操作的标的顶掉。
function btSharedPull() {
  if (typeof DataStore === 'undefined' || !DataStore.collection) return Promise.resolve(null);
  return DataStore.collection('backtest_symbols').get('shared').then(function (row) {
    if (!row || !row.current || !row.current.symbol) return null;
    var local = btSharedGetSymbol();
    if (local && local.at && row.current.at && local.at >= row.current.at) return local;
    try { localStorage.setItem(BT_SHARED_SYMBOL_KEY, JSON.stringify(row.current)); } catch (e) { }
    if (Array.isArray(row.recent) && row.recent.length) {
      try {
        localStorage.setItem(BT_SHARED_RECENT_KEY, JSON.stringify(row.recent.slice(0, BT_SHARED_RECENT_MAX)));
      } catch (e) { }
    }
    return row.current;
  }).catch(function () { return null; });
}

// ===== 回测练习：累计战绩聚合（两版共用一个函数，各自分版本统计） =====
//
// 背景：ECharts 版（backtest.html）和 klinecharts 版（backtest-kc.html）
// 都往 DataStore 的 **同一份** backtest_history 里写记录（跨版共享历史、
// 跨版接续标的，这是有意的），但**累计战绩要各算各的**——
// 两版的玩法差异很大（kc 是逐根揭示 + R 计法，旧版是全量回测看收益），
// 混在一起平均出来的胜率/收益没有意义。
// 所以这个函数带一个 engine 参数，按版本过滤后再聚合，
// 两个页面各自传自己的引擎名，口径实现仍然只有一份。
//
// ★ 关键口径说明（改这里之前先看）：
//   1) **胜率按「笔」加权，不是「按局平均」**。
//      winRate 是每局内部的平仓胜率，直接对 12 个百分比求平均是错的
//      （练了 1 笔的一局和练了 30 笔的一局会被等同对待）。
//      所以先用 closedCount × winRate 反算每局胜/负笔数再汇总。
//      每局四舍五入会带来 ±1 笔误差，可接受；要精确必须逐笔扫 trades，
//      而两版的 trades 结构不同（ECharts: action/price/pnl；kc: entry/target/pnlR），
//      判型成本高且容易错，不值得。
//   2) **每局是独立的**（各自 initCapital），所以不做复利拼接，
//      收益给「平均每局」而不是"累计收益率"；回撤给「最差单局」而不是全局回撤。
//   3) R 值只有 klinecharts 版写（ECharts 版的历史没有 totalR 字段），
//      用 rSessions 记录"有多少局带 R"，前端据此决定要不要显示 R 格子。
//
// @param {Array} list backtest_history 的记录数组（顺序无所谓）
// @param {string} [engine] 只统计某个版本：'klinecharts' / 'echarts'；
//        不传 = 全部记录都算（保留给"总计"场景）
//        ★ 老记录没有 engine 字段（标记功能上线前只有 ECharts 版），一律算 'echarts'
// @returns {Object} 累计战绩
function btHistoryAggregate(list, engine) {
  var a = {
    sessions: 0,          // 局数
    trades: 0,            // 总交易笔数（开+平都算，与列表里的"交易数"同口径）
    closed: 0,            // 已平仓笔数（胜率的基数）
    wins: 0, losses: 0, winRate: 0,
    winSessions: 0, winSessionRate: 0,
    totalPnl: 0,          // 累计已实现盈亏（元）
    avgReturn: 0,         // 平均每局收益率（%）
    bestReturn: null, worstReturn: null,
    maxDrawdown: 0,       // 最差单局回撤（%）
    maxConsecLoss: 0,
    avgPF: null,          // 平均盈亏比
    totalR: 0, rSessions: 0, avgR: 0, bestR: null, worstR: null,
    distinctSymbols: 0,
    byEngine: {}, bySymbol: {},
    firstAt: null, lastAt: null
  };
  if (!Array.isArray(list) || !list.length) return a;

  var retSum = 0, retN = 0, pfSum = 0, pfN = 0;

  var wantEngine = engine ? String(engine).toLowerCase() : null;

  list.forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    var eng = (s.engine === 'klinecharts') ? 'klinecharts' : 'echarts';
    // 按引擎过滤：传 'klinecharts' 只要 kc 局，传 'echarts' 只要 ECharts 局
    if (wantEngine) {
      if (wantEngine === 'klinecharts' ? eng !== 'klinecharts' : eng === 'klinecharts') return;
    }
    a.sessions++;

    var closed = Number(s.closedCount) || 0;
    a.trades += Number(s.tradeCount) || 0;
    a.closed += closed;
    var wr = Number(s.winRate);
    if (closed > 0 && isFinite(wr)) {
      var w = Math.round(closed * Math.min(100, Math.max(0, wr)) / 100);
      if (w > closed) w = closed;
      a.wins += w;
      a.losses += closed - w;
    }

    var pnl = Number(s.realized);
    if (isFinite(pnl)) a.totalPnl += pnl;

    var ret = Number(s.totalReturn);
    if (isFinite(ret)) {
      retSum += ret; retN++;
      if (a.bestReturn === null || ret > a.bestReturn) a.bestReturn = ret;
      if (a.worstReturn === null || ret < a.worstReturn) a.worstReturn = ret;
      if (ret > 0) a.winSessions++;
    }

    var dd = Number(s.maxDrawdown);
    if (isFinite(dd) && dd > a.maxDrawdown) a.maxDrawdown = dd;
    var mcl = Number(s.maxConsecLoss);
    if (isFinite(mcl) && mcl > a.maxConsecLoss) a.maxConsecLoss = mcl;

    if (s.profitFactor !== null && s.profitFactor !== undefined) {
      var pf = Number(s.profitFactor);
      if (isFinite(pf)) { pfSum += pf; pfN++; }
    }

    // R 值（只有 klinecharts 版有）
    if (s.totalR !== null && s.totalR !== undefined && isFinite(Number(s.totalR))) {
      a.totalR += Number(s.totalR);
      a.rSessions++;
      var bR = Number(s.bestR), wR = Number(s.worstR);
      if (isFinite(bR) && (a.bestR === null || bR > a.bestR)) a.bestR = bR;
      if (isFinite(wR) && (a.worstR === null || wR < a.worstR)) a.worstR = wR;
    }

    a.byEngine[eng] = (a.byEngine[eng] || 0) + 1;
    if (s.symbol) a.bySymbol[s.symbol] = (a.bySymbol[s.symbol] || 0) + 1;

    var at = String(s.finishedAt || '');
    if (at) {
      if (!a.firstAt || at < a.firstAt) a.firstAt = at;
      if (!a.lastAt || at > a.lastAt) a.lastAt = at;
    }
  });

  a.winRate = a.closed > 0 ? a.wins / a.closed * 100 : 0;
  a.winSessionRate = a.sessions > 0 ? a.winSessions / a.sessions * 100 : 0;
  a.avgReturn = retN > 0 ? retSum / retN : 0;
  a.avgPF = pfN > 0 ? pfSum / pfN : null;
  a.avgR = a.rSessions > 0 ? a.totalR / a.rSessions : 0;
  a.distinctSymbols = Object.keys(a.bySymbol).length;

  // 最近一次练习距今天数（null = 没记录）
  if (a.lastAt) {
    var t = Date.parse(a.lastAt);
    a.daysSinceLast = isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  } else {
    a.daysSinceLast = null;
  }
  return a;
}

// 按引擎数局数：用于"本版还没有记录，另一版有 N 局"这类提示。
// 两版共用同一份 history，但累计战绩各算各的，空状态必须说清楚
// 是"真的没练过"还是"练在另一版了"。
// @param {Array} list backtest_history 的记录数组
// @returns {{echarts:number, klinecharts:number, total:number}}
function btHistoryEngineCounts(list) {
  var c = { echarts: 0, klinecharts: 0, total: 0 };
  (Array.isArray(list) ? list : []).forEach(function (s) {
    if (!s || typeof s !== 'object') return;
    if (s.engine === 'klinecharts') c.klinecharts++; else c.echarts++;
    c.total++;
  });
  return c;
}
