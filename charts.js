// ===== 图表绘制 =====

var PIE_COLORS = ['#0a84ff', '#ff9f0a', '#ff453a', '#30d158', '#bf5af2', '#5e5ce6', '#ff375f', '#64d2ff', '#a2845e', '#ff6482', '#8e8e93', '#636366', '#aeaeb2', '#48484a', '#c7c7cc'];

// 获取当前主题颜色
function getThemeColors() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark: isDark,
    gridLine: isDark ? '#3a3a3c' : '#f0f0f0',
    axisLine: isDark ? '#48484a' : '#e8e8ed',
    axisLabel: isDark ? '#98989d' : '#6e6e73',
    pieCenter: isDark ? '#2c2c2e' : '#ffffff',
    pieEmpty: isDark ? '#3a3a3c' : '#e8e8ed',
    pieEmptyStroke: isDark ? '#48484a' : '#d1d1d6',
    pieSliceStroke: isDark ? '#2c2c2e' : '#ffffff',
    legendText: isDark ? '#e5e5ea' : '#3a3a3c',
    legendMuted: isDark ? '#98989d' : '#8e8e93',
    noDataText: isDark ? '#636366' : '#aeaeb2',
    noDataSubText: isDark ? '#98989d' : '#8e8e93',
    noDataCenterText: isDark ? '#98989d' : '#6e6e73',
    sliceLabel: isDark ? '#ffffff' : '#ffffff',
    curveUp: isDark ? '#ff453a' : '#ff3b30',
    curveDown: isDark ? '#30d158' : '#34c759',
    dotBorder: isDark ? '#2c2c2e' : '#ffffff',
    fillUpStart: isDark ? 'rgba(255,69,58,0.25)' : 'rgba(255,59,48,0.2)',
    fillDownStart: isDark ? 'rgba(48,209,88,0.25)' : 'rgba(52,199,89,0.2)',
    fillEnd: isDark ? 'rgba(44,44,46,0)' : 'rgba(255,255,255,0)',
    refLine: isDark ? '#48484a' : '#d1d1d6',
    refLabel: isDark ? '#98989d' : '#8e8e93',
    blue: isDark ? '#0a84ff' : '#007aff'
  };
}

function drawPositionPie() {
  var canvas = document.getElementById('positionPie');
  if (!canvas) return;

  var cap = getCurrentCapital();
  if (!cap || cap <= 0) cap = 100000;

  var openTrades = (trades || []).filter(function(t) {
    return t.status === 'open' && t.posSize && !isNaN(parseFloat(t.posSize));
  });

  var pieCardEl = document.getElementById('pieCard');
  if (pieCardEl) pieCardEl.style.display = '';

  // 固定尺寸
  var W = 260;
  var H = 150;

  canvas.width = W;
  canvas.height = H;

  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  ctx.clearRect(0, 0, W, H);

  var cx = W / 2;
  var cy = H / 2 - 3;
  var r = Math.min(cx, cy) - 12;

  var tc = getThemeColors();

  var symMap = {};
  for (var i = 0; i < openTrades.length; i++) {
    var s = openTrades[i].symbol || '未命名';
    var v = parseFloat(openTrades[i].posSize) || 0;
    symMap[s] = (symMap[s] || 0) + v;
  }

  var labels = Object.keys(symMap);
  var values = labels.map(function(k) { return symMap[k]; });
  var totalPos = values.reduce(function(a, b) { return a + b; }, 0);

  // 饼图起始角度（12点钟方向）
  var startAngle = -Math.PI / 2;

  if (labels.length === 0) {
    // 无数据 - 显示空状态
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = tc.pieEmpty;
    ctx.fill();
    ctx.strokeStyle = tc.pieEmptyStroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 中心圆
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = tc.pieCenter;
    ctx.fill();

    // 文字
    ctx.fillStyle = tc.noDataCenterText;
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('0% 持仓', cx, cy - 6);

    ctx.fillStyle = tc.noDataSubText;
    ctx.font = '11px sans-serif';
    ctx.fillText('暂无持仓', cx, cy + 12);

    var legend = document.getElementById('pieLegend');
    if (legend) {
      legend.innerHTML = '<span style="color:' + tc.legendMuted + ';font-size:12px">暂无持仓中的标的</span>';
    }
    return;
  }

  // 绘制每个扇形
  for (var j = 0; j < values.length; j++) {
    var slice = values[j] / cap * Math.PI * 2;
    
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = PIE_COLORS[j % PIE_COLORS.length];
    ctx.fill();
    ctx.strokeStyle = tc.pieSliceStroke;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 百分比标签
    var midAngle = startAngle + slice / 2;
    var tx = cx + r * 0.68 * Math.cos(midAngle);
    var ty = cy + r * 0.68 * Math.sin(midAngle);
    var pct = (values[j] / cap * 100).toFixed(1);
    
    if (slice > 0.18) {
      ctx.fillStyle = tc.sliceLabel;
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pct + '%', tx, ty);
    }

    startAngle += slice;
  }

  // 现金部分（空仓）
  var cashSlice = Math.PI * 2 - startAngle + Math.PI / 2;
  if (cashSlice > 0.01) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, Math.PI * 2 + (-Math.PI / 2));
    ctx.closePath();
    ctx.fillStyle = tc.pieEmpty;
    ctx.fill();
    ctx.strokeStyle = tc.pieSliceStroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 中心圆
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = tc.pieCenter;
  ctx.fill();

  // 中心文字
  ctx.fillStyle = tc.noDataCenterText;
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('已用仓位', cx, cy - 8);

  ctx.fillStyle = tc.blue;
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText((totalPos / cap * 100).toFixed(1) + '%', cx, cy + 10);

  // 图例
  var legend = document.getElementById('pieLegend');
  if (!legend) return;
  
  legend.innerHTML = '';
  for (var k = 0; k < labels.length; k++) {
    var pctL = (values[k] / cap * 100).toFixed(1);
    var item = document.createElement('span');
    item.style.cssText = 'display:flex;align-items:center;gap:4px';
    item.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + PIE_COLORS[k % PIE_COLORS.length] + ';flex-shrink:0"></span><span style="color:' + tc.legendText + '">' + labels[k] + '</span><span style="color:' + tc.blue + ';font-weight:600">' + pctL + '%</span><span style="color:' + tc.legendMuted + ';font-size:10px">(' + CNY(values[k]) + ')</span>';
    legend.appendChild(item);
  }
  var cashItem = document.createElement('span');
  cashItem.style.cssText = 'display:flex;align-items:center;gap:4px';
  var cashPct = Math.max(0, (cap - totalPos) / cap * 100).toFixed(1);
  cashItem.innerHTML = '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + tc.pieEmpty + ';border:1px solid ' + tc.pieEmptyStroke + ';flex-shrink:0"></span><span style="color:' + tc.legendMuted + '">空仓</span><span style="color:' + tc.legendMuted + ';font-weight:600">' + cashPct + '%</span><span style="color:' + tc.noDataSubText + ';font-size:10px">(' + CNY(Math.max(0, cap - totalPos)) + ')</span>';
  legend.appendChild(cashItem);
}

// ===== 收益曲线 =====
function drawEquityCurve() {
  var canvas = document.getElementById('equityCurve');
  if (!canvas) return;

  // 固定尺寸
  var W = 260;
  var H = 150;

  canvas.width = W;
  canvas.height = H;

  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  var init = getInitCapital();
  var tc = getThemeColors();

  ctx.clearRect(0, 0, W, H);

  // 边距定义（紧凑，适配"X.X万"格式）
  var padL = 40;
  var padR = 6;
  var padT = 8;
  var padB = 24;
  var cW = W - padL - padR;
  var cH = H - padT - padB;

  // 计算数据点
  var points = [{ date: '起点', capital: init, pct: 0 }];
  var run = init;

  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    if (t.status !== 'open' && t.pnl !== '' && !isNaN(parseFloat(t.pnl))) {
      run += parseFloat(t.pnl);
      points.push({ date: t.date, capital: run, pct: (run - init) / init * 100 });
    }
  }

  // 无数据时显示提示
  if (points.length < 2) {
    ctx.strokeStyle = tc.axisLine;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, H / 2);
    ctx.lineTo(W - padR, H / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = tc.noDataSubText;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('开仓并记录盈亏后，曲线将自动生成', W / 2, H / 2 + 16);
    return;
  }

  // 数据范围
  var minC = Math.min.apply(null, points.map(function(p) { return p.capital; }));
  var maxC = Math.max.apply(null, points.map(function(p) { return p.capital; }));
  var range = maxC - minC || maxC * 0.01;
  var minY = minC - range * 0.1;
  var maxY = maxC + range * 0.1;

  // 坐标转换函数
  function toX(idx) {
    return padL + (idx / Math.max(1, points.length - 1)) * cW;
  }
  function toY(val) {
    return padT + cH - ((val - minY) / (maxY - minY || 1)) * cH;
  }

  // 水平网格线
  for (var g = 0; g <= 5; g++) {
    var gy = padT + (g / 5) * cH;
    ctx.strokeStyle = tc.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(W - padR, gy);
    ctx.stroke();
  }

  // 初始资金参考线
  var iy = toY(init);
  ctx.strokeStyle = tc.refLine;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, iy);
  ctx.lineTo(W - padR, iy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = tc.refLabel;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(CNYW(init), padL - 4, iy + 4);

  // 最终收益率决定颜色
  var fp = points[points.length - 1].pct;
  var curveColor = fp >= 0 ? tc.curveUp : tc.curveDown;

  // 绘制填充区域
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0].capital));
  for (var j = 1; j < points.length; j++) {
    ctx.lineTo(toX(j), toY(points[j].capital));
  }
  ctx.lineTo(toX(points.length - 1), padT + cH);
  ctx.lineTo(toX(0), padT + cH);
  ctx.closePath();

  var gr = ctx.createLinearGradient(0, padT, 0, padT + cH);
  gr.addColorStop(0, fp >= 0 ? tc.fillUpStart : tc.fillDownStart);
  gr.addColorStop(1, tc.fillEnd);
  ctx.fillStyle = gr;
  ctx.fill();

  // 绘制曲线
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(points[0].capital));
  for (var k = 1; k < points.length; k++) {
    ctx.lineTo(toX(k), toY(points[k].capital));
  }
  ctx.strokeStyle = curveColor;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 数据点
  for (var d = 0; d < points.length; d++) {
    var px = toX(d);
    var py = toY(points[d].capital);
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = points[d].pct >= 0 ? tc.curveUp : tc.curveDown;
    ctx.fill();
    ctx.strokeStyle = tc.dotBorder;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Y轴标签（万元单位）
  ctx.fillStyle = tc.axisLabel;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (var m = 0; m <= 5; m++) {
    var val = minY + (m / 5) * (maxY - minY);
    var y2 = padT + (1 - m / 5) * cH;
    var lbl = CNYW(val);
    if (!lbl || lbl.length > 8) lbl = CNYW(Math.round(val));
    ctx.fillText(lbl, padL - 4, y2 + 4);
    ctx.strokeStyle = tc.axisLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL - 3, y2);
    ctx.lineTo(padL, y2);
    ctx.stroke();
  }

  // X轴标签
  ctx.fillStyle = tc.axisLabel;
  ctx.textAlign = 'center';
  var stp = Math.max(1, Math.floor(points.length / 6));
  for (var n = 0; n < points.length; n += stp) {
    var lbl = points[n].date;
    if (lbl.length > 10) lbl = lbl.slice(5);
    ctx.fillText(lbl, toX(n), padT + cH + 18);
  }

  // 更新最大回撤统计
  updateDrawdownStats(points);
}

// ===== 计算最大回撤统计 =====
function updateDrawdownStats(points) {
  var el = function(id) { 
    try { return document.getElementById(id); } catch(e) { return null; } 
  };

  if (points.length < 2) {
    if (el('maxDrawdownPct')) el('maxDrawdownPct').textContent = '-';
    if (el('maxDrawdownAmt')) el('maxDrawdownAmt').textContent = '-';
    if (el('peakCapital')) el('peakCapital').textContent = '-';
    if (el('valleyCapital')) el('valleyCapital').textContent = '-';
    return;
  }

  var peak = points[0].capital;
  var maxDrawdown = 0;
  var maxDrawdownAmt = 0;
  var finalPeak = peak;
  var finalValley = peak;

  for (var i = 1; i < points.length; i++) {
    var capital = points[i].capital;

    if (capital > peak) {
      peak = capital;
    }

    var drawdown = (peak - capital) / peak;
    var drawdownAmt = peak - capital;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownAmt = drawdownAmt;
      finalPeak = peak;
      finalValley = capital;
    }
  }

  if (el('maxDrawdownPct')) {
    el('maxDrawdownPct').textContent = (maxDrawdown * 100).toFixed(2) + '%';
  }
  if (el('maxDrawdownAmt')) {
    el('maxDrawdownAmt').textContent = CNY(maxDrawdownAmt);
  }
  if (el('peakCapital')) {
    el('peakCapital').textContent = CNY(finalPeak);
  }
  if (el('valleyCapital')) {
    el('valleyCapital').textContent = CNY(finalValley);
  }
}
