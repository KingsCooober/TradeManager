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

// 获取某年某月的天数（被 table.js 的 onDatePickerChange 使用）
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 获取年份范围（当前年前后各 5 年，共 11 年），用于日期选择器的年份下拉
function getYearRange() {
  var currentYear = new Date().getFullYear();
  var years = [];
  for (var y = currentYear - 5; y <= currentYear + 5; y++) {
    years.push(y);
  }
  return years;
}

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