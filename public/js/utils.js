// ===== 工具函数 =====

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

// HTML转义
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 转义单引号，用于JavaScript字符串
function sqesc(s) {
  return "'" + String(s).replace(/'/g, "\\'") + "'";
}

// 获取某年某月的天数（被 table.js 的 onDatePickerChange 使用）
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
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