// ===== 工具函数 =====

// 买点类型选项（开仓计算器 与 每日复盘交易复盘 共用，修改此数组即可同步两处）
var BUY_TYPES = [
  '一类买点：单周期15分钟回踩突破',
  '二类买点：双周期60分钟回踩突破+日线5-10金叉',
  '三类买点：三周期日线回踩突破+日线金叉+60分钟+15分钟共振',
  '四类买点：波段底部放量锤头线|反包阳线|小阳线'
];

// 生成UUID v4
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    var r = Math.random() * 16 | 0;
    var v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// 获取当天日期 YYYY-MM-DD
function getToday() {
  return new Date().toISOString().slice(0, 10);
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
function calcHoldDuration(t) {
  if (t.status === 'open') {
    if (!t.date) {
      return '<span style="color:#ffd740">持仓中</span>';
    }
    
    var openDate = new Date(t.date);
    var now = new Date();
    var diffMs = now - openDate;
    var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    return '<span style="color:#ffd740">持仓中(' + diffDays + '天)</span>';
  }
  
  if (!t.date) {
    return '-';
  }
  
  var openDate = new Date(t.date);
  var endDate;
  
  if (t.exitDate) {
    endDate = new Date(t.exitDate + 'T23:59:59');
  } else {
    endDate = new Date(t.date + 'T23:59:59');
  }
  
  var diffMs = endDate - openDate;
  var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) {
    return '<span style="color:#ff5252">异常</span>';
  }
  
  return diffDays + '天';
}