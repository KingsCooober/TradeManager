// ===== 开仓计算器 =====

// 四舍五入到指定倍数的函数
function roundToMultiple(num, multiple) {
  return Math.round(num / multiple) * multiple;
}

// 用户手动输入实际手数时的处理
function onActualLotsInput() {
  calcPosition();
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
  var today = getToday();
  
  // 计算开仓手续费
  var feeRate = getFeeRate() / 100;
  var openFee = actualPos * feeRate;

  var calcSymbolEl = g('calcSymbol');
  var calcBuyTypeEl = g('calcBuyType');

  trades.push({
    id: Date.now(),
    date: today,
    exitDate: today,
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

  save().then(function() {
    updateAll();
    clearCalc();
  });
}

function clearCalc() {
  ['calcSymbol', 'calcEntry', 'calcStop'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
  document.getElementById('calcTargetR').value = '2';
  document.getElementById('calcActualLots').value = '200';
  document.getElementById('calcRecoLots').value = '';
  document.getElementById('lotHint').textContent = '';
  calcPosition();
}
