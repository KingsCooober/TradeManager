// ===== 开仓计算器 =====

// 四舍五入到指定倍数的函数
function roundToMultiple(num, multiple) {
  return Math.round(num / multiple) * multiple;
}

// 用户手动输入实际手数时的处理
function onActualLotsInput() {
  calcPosition();
}

// 初始化开仓日期为当天
function initCalcDate() {
  var dateInput = document.getElementById('calcOpenDate');
  if (dateInput) {
    dateInput.value = getToday();
  }
}

// 更新日期（可选扩展）
function updateCalcDate() {
  // 可以在这里添加日期验证等逻辑
}

// 设置买点类型
function setBuyType(buyType) {
  var hiddenInput = document.getElementById('calcBuyType');
  if (hiddenInput) {
    hiddenInput.value = buyType;
  }
  
  // 更新下拉框显示值
  var selectEl = document.getElementById('buyTypeSelect');
  var valueEl = selectEl ? selectEl.querySelector('.custom-select-value') : null;
  if (valueEl) {
    // 根据值获取显示文本
    var options = document.querySelectorAll('#buyTypeOptions li');
    options.forEach(function(opt) {
      if (opt.dataset.value === buyType) {
        valueEl.textContent = opt.textContent;
      }
    });
  }
  
  // 更新选项选中状态
  var optionEls = document.querySelectorAll('#buyTypeOptions li');
  optionEls.forEach(function(opt) {
    opt.classList.remove('selected');
    if (opt.dataset.value === buyType) {
      opt.classList.add('selected');
    }
  });
  
  calcPosition();
}

// 初始化自定义下拉框
function initCustomSelect() {
  var selectEl = document.getElementById('buyTypeSelect');
  var optionsEl = document.getElementById('buyTypeOptions');
  var options = optionsEl ? optionsEl.querySelectorAll('li') : [];
  var selectedIndex = 0;
  
  // 点击下拉框展开/收起
  if (selectEl) {
    selectEl.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleSelect();
    });
  }
  
  // 点击选项
  options.forEach(function(option, index) {
    option.addEventListener('click', function(e) {
      e.stopPropagation();
      var value = this.dataset.value;
      setBuyType(value);
      closeSelect();
    });
    
    // 鼠标悬停时更新选中索引（用于键盘导航）
    option.addEventListener('mouseenter', function() {
      selectedIndex = index;
    });
  });
  
  // 键盘操作
  if (selectEl) {
    selectEl.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, options.length - 1);
          updateSelectedHighlight();
          // 如果下拉框未展开，自动展开
          if (!optionsEl.classList.contains('open')) {
            openSelect();
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateSelectedHighlight();
          break;
        case 'Enter':
          e.preventDefault();
          if (optionsEl.classList.contains('open')) {
            // 确认选择
            options[selectedIndex].click();
          } else {
            openSelect();
          }
          break;
        case 'Escape':
          e.preventDefault();
          closeSelect();
          break;
      }
    });
  }
  
  // 点击外部关闭下拉框
  document.addEventListener('click', function(e) {
    if (!e.target.closest('.custom-select-wrapper')) {
      closeSelect();
    }
  });
  
  function toggleSelect() {
    if (optionsEl.classList.contains('open')) {
      closeSelect();
    } else {
      openSelect();
    }
  }
  
  function openSelect() {
    selectEl.classList.add('open');
    optionsEl.classList.add('open');
    // 聚焦到下拉框以便键盘操作
    selectEl.focus();
  }
  
  function closeSelect() {
    selectEl.classList.remove('open');
    optionsEl.classList.remove('open');
  }
  
  function updateSelectedHighlight() {
    options.forEach(function(opt, index) {
      opt.classList.remove('hover-highlight');
      if (index === selectedIndex) {
        opt.classList.add('hover-highlight');
        // 滚动到可见区域
        opt.scrollIntoView({ block: 'nearest' });
      }
    });
  }
}

// 设置方向
function setDirection(dir) {
  var hiddenInput = document.getElementById('calcDir');
  if (hiddenInput) {
    hiddenInput.value = dir;
  }
  
  // 更新下拉框显示值
  var selectEl = document.getElementById('dirSelect');
  var valueEl = selectEl ? selectEl.querySelector('.custom-select-value') : null;
  if (valueEl) {
    valueEl.textContent = dir;
  }
  
  // 更新选项选中状态
  var optionEls = document.querySelectorAll('#dirOptions li');
  optionEls.forEach(function(opt) {
    opt.classList.remove('selected');
    if (opt.dataset.value === dir) {
      opt.classList.add('selected');
    }
  });
  
  // 更新下拉框样式（多/空不同颜色）
  if (selectEl) {
    selectEl.classList.remove('dir-long', 'dir-short');
    selectEl.classList.add(dir === '多' ? 'dir-long' : 'dir-short');
  }
  
  calcPosition();
}

// 初始化计算器选择控件
function initCalcSelectButtons() {
  // 初始化买点类型默认选中
  setBuyType('15分钟回踩');
  
  // 初始化方向默认选中
  setDirection('多');
  
  // 初始化买点类型下拉框
  initCustomSelect('buyType');
  
  // 初始化方向下拉框
  initCustomSelect('dir');
}

// 初始化自定义下拉框（支持多个下拉框）
function initCustomSelect(type) {
  var selectId = type === 'dir' ? 'dirSelect' : 'buyTypeSelect';
  var optionsId = type === 'dir' ? 'dirOptions' : 'buyTypeOptions';
  
  var selectEl = document.getElementById(selectId);
  var optionsEl = document.getElementById(optionsId);
  var options = optionsEl ? optionsEl.querySelectorAll('li') : [];
  var selectedIndex = 0;
  
  // 点击下拉框展开/收起
  if (selectEl) {
    selectEl.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleSelect();
    });
  }
  
  // 点击选项
  options.forEach(function(option, index) {
    option.addEventListener('click', function(e) {
      e.stopPropagation();
      var value = this.dataset.value;
      if (type === 'dir') {
        setDirection(value);
      } else {
        setBuyType(value);
      }
      closeSelect();
    });
    
    // 鼠标悬停时更新选中索引（用于键盘导航）
    option.addEventListener('mouseenter', function() {
      selectedIndex = index;
    });
  });
  
  // 键盘操作
  if (selectEl) {
    selectEl.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, options.length - 1);
          updateSelectedHighlight();
          if (!optionsEl.classList.contains('open')) {
            openSelect();
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          updateSelectedHighlight();
          break;
        case 'Enter':
          e.preventDefault();
          if (optionsEl.classList.contains('open')) {
            options[selectedIndex].click();
          } else {
            openSelect();
          }
          break;
        case 'Escape':
          e.preventDefault();
          closeSelect();
          break;
      }
    });
  }
  
  // 点击外部关闭下拉框（只关闭当前类型的下拉框）
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#' + selectId) && !e.target.closest('#' + optionsId)) {
      closeSelect();
    }
  });
  
  function toggleSelect() {
    if (optionsEl.classList.contains('open')) {
      closeSelect();
    } else {
      openSelect();
    }
  }
  
  function openSelect() {
    selectEl.classList.add('open');
    optionsEl.classList.add('open');
    selectEl.focus();
  }
  
  function closeSelect() {
    selectEl.classList.remove('open');
    optionsEl.classList.remove('open');
  }
  
  function updateSelectedHighlight() {
    options.forEach(function(opt, index) {
      opt.classList.remove('hover-highlight');
      if (index === selectedIndex) {
        opt.classList.add('hover-highlight');
        opt.scrollIntoView({ block: 'nearest' });
      }
    });
  }
}

function calcPosition() {
  var cap = getCurrentCapital(),
      rPct = getRiskPct();
  
  // 获取输入元素，不存在则返回
  function g(id) { return document.getElementById(id); }
  var calcEntryEl = g('calcEntry');
  var calcStopEl = g('calcStop');
  var calcTargetREl = g('calcTargetR');
  var calcDirEl = g('calcDir');
  var calcActualLotsEl = g('calcActualLots');
  
  if (!calcEntryEl || !calcStopEl || !calcTargetREl || !calcDirEl) return;
  
  var entry = parseFloat(calcEntryEl.value);
  var stop = parseFloat(calcStopEl.value);
  var targetR = parseFloat(calcTargetREl.value) || 2;
  var dir = calcDirEl.value;
  var actualLotsRaw = calcActualLotsEl ? calcActualLotsEl.value : '';
  var actualLots = actualLotsRaw !== '' ? parseInt(actualLotsRaw) : null;
  var rAmt = cap * rPct / 100;

  var resR = g('res_R');
  if (resR) resR.textContent = CNY(rAmt);

  if (!entry || !stop || entry === stop) {
    ['res_stopPct', 'res_tpDist', 'res_posSize', 'res_posPct', 'res_tp', 'res_actualLots', 'res_actualPos', 'res_recoLots', 'res_actualRisk', 'res_breakeven'].forEach(function(id) {
      var el = g(id);
      if (el) el.textContent = '-';
    });
    var lotHint = g('lotHint');
    if (lotHint) lotHint.textContent = '';
    var calcRecoLots = g('calcRecoLots');
    if (calcRecoLots) calcRecoLots.value = '';
    return;
  }

  var stopDist = Math.abs(entry - stop),
      stopPct = (stopDist / entry) * 100;
  var sugPos = rAmt / (stopPct / 100);
  var recoLots = Math.round(sugPos / entry * 10) / 10;

  var calcRecoLotsEl = g('calcRecoLots');
  if (calcRecoLotsEl) calcRecoLotsEl.value = recoLots.toFixed(1);

  // 如果用户没有输入实际手数，使用默认值 200
  if (actualLots === null) {
    actualLots = 200;
    if (calcActualLotsEl) calcActualLotsEl.value = actualLots;
  }

  var actualPos = actualLots * entry;
  var posPct = (actualPos / cap) * 100;

  // 计算实际可能止损金额 = 实际买入手数 × 止损距离
  var actualRisk = actualLots * stopDist;

  var tpDist = stopDist * targetR;
  var tp = dir === '多' ? entry + tpDist : entry - tpDist;
  var tpDistPct = (tpDist / entry) * 100;
  
  // 平报价：价格上涨1R时的价格（做多时为止损移到成本价的位置）
  var breakeven = dir === '多' ? entry + stopDist : entry - stopDist;

  var diff = (actualLots * entry - sugPos);
  var hint = '（偏离理论 ' + diff.toFixed(2) + ' ￥）';

  function setVal(id, val) { var el = g(id); if (el) el.textContent = val; }
  
  setVal('res_stopPct', stopPct.toFixed(2) + '%');
  setVal('res_tpDist', tpDistPct.toFixed(2) + '%');
  setVal('res_posSize', CNY(sugPos));
  setVal('res_posPct', posPct.toFixed(1) + '%');
  var posPctEl = g('res_posPct');
  if (posPctEl) posPctEl.className = 'r-val ' + (posPct > 50 ? 'glow-red' : posPct > 25 ? 'glow-yellow' : '');
  setVal('res_tp', tp.toFixed(2));
  setVal('res_breakeven', breakeven.toFixed(2));
  setVal('res_recoLots', recoLots.toFixed(1));
  setVal('res_actualLots', actualLots);
  setVal('res_actualPos', CNY(actualPos));
  setVal('res_actualRisk', CNY(actualRisk));
  var lotHint = g('lotHint');
  if (lotHint) lotHint.textContent = hint;
}

function addTradeFromCalc() {
  function g(id) { return document.getElementById(id); }
  
  var calcEntryEl = g('calcEntry');
  var calcStopEl = g('calcStop');
  if (!calcEntryEl || !calcStopEl) return;
  
  var entry = parseFloat(calcEntryEl.value);
  var stop = parseFloat(calcStopEl.value);
  if (!entry || !stop) {
    alert('请填写入场价和止损价');
    return;
  }
  var cap = getCurrentCapital(),
      rPct = getRiskPct();
  var rAmt = cap * rPct / 100,
      stopDist = Math.abs(entry - stop),
      stopPct = stopDist / entry;
  var calcDirEl = g('calcDir');
  var dir = calcDirEl ? calcDirEl.value : '多';
  var calcTargetREl = g('calcTargetR');
  var targetR = calcTargetREl ? (parseFloat(calcTargetREl.value) || 2) : 2;
  var calcActualLotsEl = g('calcActualLots');
  var actualLotsRaw = calcActualLotsEl ? calcActualLotsEl.value : '';
  var sugPos = rAmt / (stopPct);
  var recoLots = Math.round(sugPos / entry * 10) / 10;
  var actualLots = actualLotsRaw !== '' ? parseInt(actualLotsRaw) : 200;
  var tp = dir === '多' ? entry + stopDist * targetR : entry - stopDist * targetR;
  var actualPos = Math.round(actualLots * entry * 100) / 100;
  
  // 获取用户选择的开仓日期，默认为当天
  var calcOpenDateEl = g('calcOpenDate');
  var openDate = calcOpenDateEl && calcOpenDateEl.value ? calcOpenDateEl.value : getToday();
  
  // 计算开仓手续费
  var feeRate = getFeeRate() / 100;
  var openFee = actualPos * feeRate;

  var calcSymbolEl = g('calcSymbol');
  var calcBuyTypeEl = g('calcBuyType');

  trades.push({
    id: Date.now(),
    date: openDate,
    exitDate: openDate,
    openTime: new Date().toISOString(),
    symbol: calcSymbolEl ? calcSymbolEl.value || '' : '',
    buyType: calcBuyTypeEl ? calcBuyTypeEl.value || '15分钟回踩' : '15分钟回踩',
    dir: dir,
    entry: entry,
    stop: stop,
    target: parseFloat(tp.toFixed(4)),
    rrTarget: targetR || 0,
    posSize: actualPos,
    actualLots: actualLots,
    riskAmount: Math.round(rAmt * 100) / 100,
    openFee: Math.round(openFee * 100) / 100,
    exit: '',
    pnl: '',
    pnlR: '',
    status: 'open',
    followedPlan: '是',
    note: ''
  });

  updateAll();
  clearCalc();
  
  // 自动保存到数据库（带防抖）
  if (typeof triggerAutoSave === 'function') {
    triggerAutoSave();
  }
}

function clearCalc() {
  ['calcSymbol', 'calcEntry', 'calcStop'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
  document.getElementById('calcTargetR').value = '2';
  document.getElementById('calcActualLots').value = '200';
  document.getElementById('calcRecoLots').value = '';
  document.getElementById('lotHint').textContent = '';
  // 重置开仓日期为当天
  document.getElementById('calcOpenDate').value = getToday();
  calcPosition();
}
