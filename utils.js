// ===== 工具函数 =====

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

// ===== 日期选择器组件 =====

// 年份范围（前后各5年）
function getYearRange() {
  var y = new Date().getFullYear();
  var years = [];
  for (var i = y - 5; i <= y + 5; i++) {
    years.push(i);
  }
  return years;
}

// 获取某年某月的天数
function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// 生成年月日下拉选择器HTML
function createDatePicker(idPrefix, tradeId, field, currentValue) {
  var today = new Date();
  var y = today.getFullYear();
  var m = today.getMonth() + 1;
  var d = today.getDate();

  if (currentValue) {
    var parts = currentValue.split('-');
    if (parts.length === 3) {
      y = parseInt(parts[0]);
      m = parseInt(parts[1]);
      d = parseInt(parts[2]);
    }
  }

  var years = getYearRange();
  var yearsHtml = years.map(function(year) {
    return '<option value="' + year + '"' + (year === y ? ' selected' : '') + '>' + year + '</option>';
  }).join('');

  var monthsHtml = '';
  for (var i = 1; i <= 12; i++) {
    var val = i < 10 ? '0' + i : i;
    monthsHtml += '<option value="' + val + '"' + (i === m ? ' selected' : '') + '>' + val + '</option>';
  }

  var days = getDaysInMonth(y, m);
  var daysHtml = '';
  for (var i = 1; i <= days; i++) {
    var val = i < 10 ? '0' + i : i;
    daysHtml += '<option value="' + val + '"' + (i === d ? ' selected' : '') + '>' + val + '</option>';
  }

  var yearId = idPrefix + '_year_' + tradeId;
  var monthId = idPrefix + '_month_' + tradeId;
  var dayId = idPrefix + '_day_' + tradeId;
  var hiddenId = idPrefix + '_hidden_' + tradeId;

  var html = '<div class="date-picker-inline" data-trade="' + tradeId + '" data-field="' + field + '">' +
    '<select id="' + yearId + '" class="date-select date-year" onchange="onDatePickerChange(\'' + idPrefix + '\', ' + tradeId + ', \'' + field + '\')">' + yearsHtml + '</select>' +
    '<select id="' + monthId + '" class="date-select date-month" onchange="onDatePickerChange(\'' + idPrefix + '\', ' + tradeId + ', \'' + field + '\')">' + monthsHtml + '</select>' +
    '<select id="' + dayId + '" class="date-select date-day" onchange="onDatePickerChange(\'' + idPrefix + '\', ' + tradeId + ', \'' + field + '\')">' + daysHtml + '</select>' +
    '<input type="hidden" id="' + hiddenId + '" value="">' +
    '</div>';
  return html;
}

function onDatePickerChange(prefix, tradeId, field) {
  var yearId = prefix + '_year_' + tradeId;
  var monthId = prefix + '_month_' + tradeId;
  var dayId = prefix + '_day_' + tradeId;
  var hiddenId = prefix + '_hidden_' + tradeId;

  var year = document.getElementById(yearId).value;
  var month = document.getElementById(monthId).value;
  var day = document.getElementById(dayId).value;
  var dateValue = year + '-' + month + '-' + day;

  document.getElementById(hiddenId).value = dateValue;
  updateTrade(tradeId, field, dateValue);
}

function updateDaysOptions(prefix, tradeId) {
  var yearId = prefix + '_year_' + tradeId;
  var monthId = prefix + '_month_' + tradeId;
  var dayId = prefix + '_day_' + tradeId;

  var year = parseInt(document.getElementById(yearId).value);
  var month = parseInt(document.getElementById(monthId).value);
  var currentDay = parseInt(document.getElementById(dayId).value);

  var days = getDaysInMonth(year, month);
  var daySelect = document.getElementById(dayId);
  var dayOptions = '';
  for (var i = 1; i <= days; i++) {
    var val = i < 10 ? '0' + i : i;
    dayOptions += '<option value="' + val + '"' + (i === Math.min(currentDay, days) ? ' selected' : '') + '>' + i + '日</option>';
  }
  daySelect.innerHTML = dayOptions;
}

function setTodayDate(prefix, tradeId, field) {
  var today = getToday();
  var yearId = prefix + '_year_' + tradeId;
  var monthId = prefix + '_month_' + tradeId;
  var dayId = prefix + '_day_' + tradeId;

  var parts = today.split('-');
  document.getElementById(yearId).value = parts[0];
  document.getElementById(monthId).value = parts[1];
  document.getElementById(dayId).value = parts[2];

  updateTrade(tradeId, field, today);
}

function createSimpleDatePicker(inputId, currentValue) {
  var today = getToday();
  var y = today.substring(0, 4);
  var m = today.substring(5, 7);
  var d = today.substring(8, 10);

  if (currentValue) {
    var parts = currentValue.split('-');
    if (parts.length === 3) {
      y = parts[0];
      m = parts[1];
      d = parts[2];
    }
  }

  var years = getYearRange();
  var yearsHtml = years.map(function(year) {
    return '<option value="' + year + '"' + (year === y ? ' selected' : '') + '>' + year + '</option>';
  }).join('');

  var monthsHtml = '';
  for (var i = 1; i <= 12; i++) {
    var val = i < 10 ? '0' + i : i;
    monthsHtml += '<option value="' + val + '"' + (i === parseInt(m) ? ' selected' : '') + '>' + val + '</option>';
  }

  var daysHtml = '';
  for (var i = 1; i <= 31; i++) {
    var val = i < 10 ? '0' + i : i;
    daysHtml += '<option value="' + val + '"' + (i === parseInt(d) ? ' selected' : '') + '>' + val + '</option>';
  }

  return '<div class="date-picker-inline">' +
    '<select id="' + inputId + '_year" class="date-select date-year" onchange="syncSimpleDate(\'' + inputId + '\')">' + yearsHtml + '</select>' +
    '<span class="date-sep">-</span>' +
    '<select id="' + inputId + '_month" class="date-select date-month" onchange="syncSimpleDate(\'' + inputId + '\')">' + monthsHtml + '</select>' +
    '<span class="date-sep">-</span>' +
    '<select id="' + inputId + '_day" class="date-select date-day" onchange="syncSimpleDate(\'' + inputId + '\')">' + daysHtml + '</select>' +
    '</div>';
}

function syncSimpleDate(inputId) {
  var year = document.getElementById(inputId + '_year').value;
  var month = document.getElementById(inputId + '_month').value;
  var day = document.getElementById(inputId + '_day').value;
  var dateValue = year + '-' + month + '-' + day;
  document.getElementById(inputId).value = dateValue;
}

function initSimpleDatePickers() {
  var dateInputs = document.querySelectorAll('input[type="date"]');
  dateInputs.forEach(function(input) {
    if (input.id && (input.id.includes('Date') || input.id.includes('date'))) { 
      var wrapper = document.createElement('div');
      wrapper.className = 'simple-date-wrapper';
      wrapper.style.cssText = 'display:flex;align-items:center;gap:2px;';       
      var currentValue = input.value || getToday();
      input.style.display = 'none';
      wrapper.innerHTML = createSimpleDateDateInputs(input.id, currentValue) +  
        '<button type="button" class="btn btn-sm" style="margin-left:4px;padding:2px 8px;font-size:11px" onclick="setSimpleDateToday(\'' + input.id + '\')">今天</button>';
      input.parentNode.insertBefore(wrapper, input);
    }
  });
}

function createSimpleDateDateInputs(inputId, currentValue) {
  var today = getToday();
  var y = today.substring(0, 4);
  var m = today.substring(5, 7);
  var d = today.substring(8, 10);

  if (currentValue) {
    var parts = currentValue.split('-');
    if (parts.length === 3) {
      y = parts[0];
      m = parts[1];
      d = parts[2];
    }
  }

  var years = getYearRange();
  var yearsHtml = years.map(function(year) {
    return '<option value="' + year + '"' + (year === y ? ' selected' : '') + '>' + year + '</option>';
  }).join('');

  var monthsHtml = '';
  for (var i = 1; i <= 12; i++) {
    var val = i < 10 ? '0' + i : i;
    monthsHtml += '<option value="' + val + '"' + (i === parseInt(m) ? ' selected' : '') + '>' + val + '</option>';
  }

  var daysHtml = '';
  for (var i = 1; i <= 31; i++) {
    var val = i < 10 ? '0' + i : i;
    daysHtml += '<option value="' + val + '"' + (i === parseInt(d) ? ' selected' : '') + '>' + val + '</option>';
  }

  return '<select id="' + inputId + '_year" class="date-select date-year" style="width:70px" onchange="syncSimpleDate(\'' + inputId + '\')">' + yearsHtml + '</select>' +
    '<span style="color:#888;margin:0 1px">-</span>' +
    '<select id="' + inputId + '_month" class="date-select date-month" style="width:55px" onchange="syncSimpleDate(\'' + inputId + '\')">' + monthsHtml + '</select>' +
    '<span style="color:#888;margin:0 1px">-</span>' +
    '<select id="' + inputId + '_day" class="date-select date-day" style="width:55px" onchange="syncSimpleDate(\'' + inputId + '\')">' + daysHtml + '</select>';
}

function setSimpleDateToday(inputId) {
  var today = getToday();
  var parts = today.split('-');
  document.getElementById(inputId + '_year').value = parts[0];
  document.getElementById(inputId + '_month').value = parts[1];
  document.getElementById(inputId + '_day').value = parts[2];
  document.getElementById(inputId).value = today;
  var event = new Event('change', { bubbles: true });
  document.getElementById(inputId).dispatchEvent(event);
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