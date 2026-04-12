// ===== 工具函数 =====

// 获取当天日期 YYYY-MM-DD
function getToday() {
  return new Date().toISOString().slice(0, 10);
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
    // 超过1亿用亿
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
// idPrefix: 输入框ID前缀，tradeId: 交易ID，field: 字段名，currentValue: 当前值(YYYY-MM-DD格式)
function createDatePicker(idPrefix, tradeId, field, currentValue) {
  var today = new Date();
  var y = today.getFullYear();
  var m = today.getMonth() + 1;
  var d = today.getDate();

  // 解析当前值
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

// 日期选择器变化时更新隐藏字段并触发更新
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

// 更新日期选择器的天数（当年或月变化时调用）
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

// 快速设置日期按钮
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

// 创建简单日期选择器（用于弹窗等场景）
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

// 同步简单日期选择器到隐藏输入框
function syncSimpleDate(inputId) {
  var year = document.getElementById(inputId + '_year').value;
  var month = document.getElementById(inputId + '_month').value;
  var day = document.getElementById(inputId + '_day').value;
  var dateValue = year + '-' + month + '-' + day;
  document.getElementById(inputId).value = dateValue;
}

// 初始化简单日期选择器（页面加载时调用）
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

// 创建简单日期输入组件
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

// 设置今天日期
function setSimpleDateToday(inputId) {
  var today = getToday();
  var parts = today.split('-');
  document.getElementById(inputId + '_year').value = parts[0];
  document.getElementById(inputId + '_month').value = parts[1];
  document.getElementById(inputId + '_day').value = parts[2];
  document.getElementById(inputId).value = today;
  // 触发原生date input的onchange
  var event = new Event('change', { bubbles: true });
  document.getElementById(inputId).dispatchEvent(event);
}

// 计算止盈距离百分比
function calcTpDist(t) {
  if (!t.entry || !t.target || !parseFloat(t.entry) || !parseFloat(t.target)) return '-';
  return (Math.abs(parseFloat(t.target) - parseFloat(t.entry)) / parseFloat(t.entry) * 100).toFixed(2) + '%';
}

// 计算出场距离百分比
function calcExitDist(t) {
  if (!t.entry || !t.exit || !parseFloat(t.entry) || !parseFloat(t.exit)) return '-';
  var raw = parseFloat(t.exit) - parseFloat(t.entry);
  return (raw >= 0 ? '+' : '-') + (Math.abs(raw) / parseFloat(t.entry) * 100).toFixed(2) + '%';
}

// 计算持仓时间
function calcHoldDuration(t) {
  if (!t.openTime) {
    return t.status === 'open' ? '<span style="color:#ffd740">持仓中</span>' : '-';
  }
  
  var openDate = new Date(t.openTime);
  
  // 优先使用手动填写的出场日期
  if (t.exitDate) {
    var endDate = new Date(t.exitDate + 'T23:59:59');
    var diffMs = endDate - openDate;
    var diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) {
      return '<span style="color:#ff5252">异常</span>';
    } else if (diffDays === 0) {
      return '<span style="color:#aaa">当天</span>';
    } else if (diffDays === 1) {
      return '<span style="color:#00d4ff">1天</span>';
    } else if (diffDays < 7) {
      return '<span style="color:#00d4ff">' + diffDays + '天</span>';
    } else if (diffDays < 30) {
      var weeks = Math.floor(diffDays / 7);
      var days = diffDays % 7;
      return '<span style="color:#00d4ff">' + weeks + '周</span><span style="color:#888">' + days + '天</span>';
    } else {
      var months = (diffDays / 30).toFixed(1);
      return '<span style="color:#ce93d8">' + months + '月</span>';
    }
  }
  
  // 如果有出场价但没有出场日期，使用交易日期
  if (t.exit && t.date && t.status !== 'open') {
    var endDate2 = new Date(t.date + 'T23:59:59');
    var diffMs2 = endDate2 - openDate;
    var diffDays2 = Math.floor(diffMs2 / (1000 * 60 * 60 * 24));
    
    if (diffDays2 < 0) {
      return '<span style="color:#ff5252">异常</span>';
    } else if (diffDays2 === 0) {
      return '<span style="color:#aaa">当天</span>';
    } else if (diffDays2 === 1) {
      return '<span style="color:#00d4ff">1天</span>';
    } else if (diffDays2 < 7) {
      return '<span style="color:#00d4ff">' + diffDays2 + '天</span>';
    } else if (diffDays2 < 30) {
      var weeks2 = Math.floor(diffDays2 / 7);
      var days2 = diffDays2 % 7;
      return '<span style="color:#00d4ff">' + weeks2 + '周</span><span style="color:#888">' + days2 + '天</span>';
    } else {
      var months2 = (diffDays2 / 30).toFixed(1);
      return '<span style="color:#ce93d8">' + months2 + '月</span>';
    }
  }
  
  // 持仓中，计算到当前时间
  if (t.status === 'open') {
    var now = new Date();
    var diffMs3 = now - openDate;
    var diffDays3 = Math.floor(diffMs3 / (1000 * 60 * 60 * 24));
    
    if (diffDays3 === 0) {
      return '<span style="color:#ffd740">持仓中(&lt;1天)</span>';
    } else if (diffDays3 === 1) {
      return '<span style="color:#ffd740">持仓中(1天)</span>';
    } else if (diffDays3 < 7) {
      return '<span style="color:#ffd740">持仓中(' + diffDays3 + '天)</span>';
    } else if (diffDays3 < 30) {
      var weeks3 = Math.floor(diffDays3 / 7);
      return '<span style="color:#ffd740">持仓中(' + weeks3 + '周+)</span>';
    } else {
      var months3 = (diffDays3 / 30).toFixed(1);
      return '<span style="color:#ffd740">持仓中(' + months3 + '月)</span>';
    }
  }
  
  return '-';
}
