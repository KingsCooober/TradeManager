/**
 * 回测页 — ECharts 图表（K线 + MA + 成交量 + MACD + 买卖标记）
 *
 * 单个 ECharts 实例 + 3 个 grid（xAxis 联动共享）:
 *   - 主图 (60% 高): 蜡烛 + MA1~MA4
 *   - 成交量 (15% 高): 红涨绿跌柱状图
 *   - MACD (25% 高): DIF/DEA 折线 + MACD 柱
 *
 * 关键设计：
 *   - 自定义均线：MA1~MA4 周期从页面输入框读取
 *   - 买卖标记：通过 markPoint 叠加，BT_refreshChartMarkers() 增量刷新
 *   - 光标：监听 'updateAxisPointer' 事件，实时把光标日期+收盘价写到底部 actionbar
 */

var BT_chart = null;            // ECharts 实例
var BT_renderCustomTooltip = null;  // 自定义 DOM tooltip 渲染函数（由 BT_setupCustomTooltip 初始化）
var BT_klineData = null;        // 当前 K 线完整数据 {dates, ohlc, volumes, ma5/10/20, macd, count, ...}
var BT_maPeriods = [5, 10, 20, 60];  // MA 周期（从输入框实时读取）
var BT_showFlags = { ma: true, macd: true, vol: true };  // 显示开关
var BT_currentIdx = null;       // 光标所在的 K 线索引（也存 localStorage）
var BT_visibleBars = 250;       // 固定显示的 K 线根数（缩放比例）
var BT_zoomLocked = false;      // 比例锁定：true 时 setCursor 不调整 dataZoom
var BT_userZoomRange = null;    // 用户拖动 slider 自定义的窗口 {start: %, end: %}；null 表示用默认 pinRight
var _inDataZoomApply = false;   // 死循环保护：我们自己 setOption 时阻断 dataZoom 回调

// 缩放档位（+/- 每次变化的倍率）
var BT_ZOOM_STEP = 1.25;        // 1.25 比 1.5 更平滑，连续点 20+ 次仍可缩放
var BT_VISIBLE_BARS_MIN = 20;   // 最少 20 根（再小 K 线太挤）
var BT_VISIBLE_BARS_MAX = 1500; // 最多 1500 根（≈ 全量）

// 恢复锁定状态
try { BT_zoomLocked = JSON.parse(localStorage.getItem('bt_state_zoomLocked') || 'false') === true; } catch (e) { BT_zoomLocked = false; }

// 从输入框读取 BT_visibleBars
function BT_getVisibleBars() {
  var el = document.getElementById('btVisibleBars');
  var v = el ? parseInt(el.value) : 250;
  return (v && v > 0) ? v : 250;
}

// 计算 zoom 范围（百分比）
// mode = 'center' → idx 居中（默认，兼容旧逻辑）
// mode = 'pinRight' → idx 落在窗口最右边缘（"下一根K线" 用这个）
// mode = 'pinLeft' → idx 落在窗口最左边缘
function BT_calcZoomRange(idx, mode) {
  if (!BT_klineData) return { start: 0, end: 100 };
  var total = BT_klineData.dates.length;
  if (total <= 0) return { start: 0, end: 100 };
  var vis = Math.min(BT_visibleBars, total);
  if (idx == null) idx = (BT_currentIdx == null ? total - 1 : BT_currentIdx);
  mode = mode || 'center';
  var startIdx, endIdx;
  if (mode === 'pinRight') {
    endIdx   = Math.min(total, idx + 1);     // idx 在窗口最右（含 idx 自身）
    startIdx = Math.max(0, endIdx - vis);
    // 若窗口左端还能再扩（idx 距左端 > vis），保持窗口宽度不变
    if (endIdx - startIdx < vis && startIdx > 0) {
      startIdx = Math.max(0, endIdx - vis);
    }
  } else if (mode === 'pinLeft') {
    startIdx = Math.max(0, idx);
    endIdx   = Math.min(total, startIdx + vis);
  } else {
    // center: idx 居中
    var half = vis / 2;
    startIdx = Math.max(0, Math.min(total - vis, idx - half));
    endIdx   = startIdx + vis;
  }
  // 转百分比（ECharts dataZoom 的 start/end 对应索引百分比）
  var denom = Math.max(1, total - 1);
  var sPct = (startIdx / denom) * 100;
  var ePct = (endIdx   / denom) * 100;
  return { start: sPct, end: ePct };
}

// 颜色（与项目内其他图表保持一致）
var BT_COLOR_UP   = '#ef476f';  // A 股红涨
var BT_COLOR_DOWN = '#2d9f7f';  // A 股绿跌
var BT_MA_COLORS  = ['#ffd166', '#5c7cfa', '#7209b7', '#ff8c42'];  // MA1~MA4

// 初始化图表实例
function BT_initChart() {
  var dom = document.getElementById('btChart');
  if (!dom) return;
  BT_chart = echarts.init(dom, null, { renderer: 'canvas' });
  BT_chart.setOption(BT_getBaseOption());  // 先设个空骨架

  // 监听光标移动 → 更新底部 actionbar
  BT_chart.on('updateAxisPointer', function(event) {
    var xAxisInfo = event.axesInfo && event.axesInfo[0];
    if (xAxisInfo && xAxisInfo.value !== undefined && BT_klineData) {
      var idx = xAxisInfo.value;
      if (idx >= 0 && idx < BT_klineData.dates.length) {
        BT_currentIdx = idx;
        BT_currentDate = BT_klineData.dates[idx];
        BT_currentClose = BT_klineData.ohlc[idx][1]; // [open, close, low, high]
        BT_updateCursorDisplay();
        // 同时刷新浮动盈亏
        BT_renderStats();
      }
    }
  });

  // 监听用户拖动 dataZoom（slider / inside）→ 同步 BT_userZoomRange 和 BT_visibleBars
  // 这样后续 +/- 按钮和 select 切换都能尊重用户手动调整的窗口位置，不再粗暴重置
  BT_chart.on('dataZoom', function(params) {
    if (_inDataZoomApply) return;   // 我们自己 setOption 触发的，跳过
    if (!BT_klineData) return;
    var batch = params && params.batch && params.batch[0];
    if (!batch) return;
    var s = batch.start, e = batch.end;
    if (typeof s !== 'number' || typeof e !== 'number') return;
    // 记录用户自定义窗口
    BT_userZoomRange = { start: s, end: e };
    // 反算窗口宽度（约多少根 K 线）→ 同步 BT_visibleBars
    var total = BT_klineData.dates.length;
    if (total > 1) {
      var bars = Math.max(1, Math.round((e - s) / 100 * (total - 1)));
      bars = Math.max(BT_VISIBLE_BARS_MIN, Math.min(BT_VISIBLE_BARS_MAX, bars));
      if (bars !== BT_visibleBars) {
        BT_visibleBars = bars;
        BT_syncVisibleBarsSelect();   // 同步下拉框显示（不触发 change）
      }
    }

    // 关键：ECharts slider moveHandle 拖到边界时会把窗口压扁（start/end 趋近相同）
    // 检测到宽度 < 1.5% 时立即强制重置为标准宽度
    var MIN_WIDTH = 1.5;
    if (e - s < MIN_WIDTH) {
      var total = BT_klineData.dates.length;
      var correctVisPct = BT_visibleBars / (total - 1) * 100;
      var newStart = Math.max(0, Math.min(s, 100 - correctVisPct));
      var newEnd = Math.min(100, newStart + correctVisPct);
      BT_userZoomRange = { start: newStart, end: newEnd };
      _inDataZoomApply = true;
      BT_chart.setOption({ dataZoom: [
        { start: newStart, end: newEnd },
        { start: newStart, end: newEnd }
      ]});
      setTimeout(function() { _inDataZoomApply = false; }, 0);
    }

    // 窗口变化时刷新 max/min 标记
    BT_refreshChartMarkers();
  });

  // 主题切换时重绘
  window.addEventListener('storage', function(e) {
    if (e.key === 'app_theme') BT_applyTheme();
  });

  // Slider 区域 cursor 切换：hover 时 grab，拖动时 grabbing，其他区域默认
  BT_setupChartCursor();

  // 自定义 DOM tooltip（不挡 K线，显示在 chart 右上角空白区）
  BT_setupCustomTooltip();
}

// Slider cursor 切换：图表底部 ~34px（bottom=16 + height=18）是 slider 区域
// 关键：ECharts 用 canvas 渲染，canvas 内 cursor 由 zrender 控制，必须用 zr.handler.setCursorStyle()
//       单纯的 DOM style.cursor 会被 ECharts 内部覆盖
function BT_setupChartCursor() {
  if (!BT_chart) return;
  var chartDom = document.getElementById('btChart');
  if (!chartDom || chartDom._cursorInited) return;
  chartDom._cursorInited = true;

  var SLIDER_BOTTOM = 16;
  var SLIDER_HEIGHT = 18;
  function inSlider(y, h) { return y >= (h - SLIDER_BOTTOM - SLIDER_HEIGHT); }
  function setZrCursor(cursor) {
    var zr = BT_chart && BT_chart.getZr && BT_chart.getZr();
    if (zr && zr.handler && typeof zr.handler.setCursorStyle === 'function') {
      zr.handler.setCursorStyle(cursor);
    }
  }

  // 1) ECharts 内的 mousemove：根据 offsetY 切换 canvas cursor（grab / default）
  BT_chart.on('mousemove', function(params) {
    if (!params || params.offsetY == null) return;
    var h = BT_chart.getHeight();
    setZrCursor(inSlider(params.offsetY, h) ? 'grab' : 'default');
  });

  // 2) mousedown 在 slider 区域 → grabbing（按下时变抓手）
  BT_chart.on('mousedown', function(params) {
    if (!params || params.offsetY == null) return;
    var h = BT_chart.getHeight();
    if (inSlider(params.offsetY, h)) {
      setZrCursor('grabbing');
      if (params.event && params.event.preventDefault) params.event.preventDefault();
    }
  });

  // 3) mouseup 后还原成 grab（仍在 slider 内）或 default（已移出）
  BT_chart.on('mouseup', function(params) {
    if (!params || params.offsetY == null) { setZrCursor('default'); return; }
    var h = BT_chart.getHeight();
    setZrCursor(inSlider(params.offsetY, h) ? 'grab' : 'default');
  });

  // 4) 鼠标离开 chart → 恢复默认 cursor
  BT_chart.on('globalout', function() { setZrCursor('default'); });

  // 5) DOM 备份：canvas 元素本身的 cursor（防止 zr.setCursorStyle 在某些边界场景失效）
  chartDom.addEventListener('mouseleave', function() { chartDom.style.cursor = ''; });
}

// 主题适配：根据当前 data-theme 切换网格/坐标轴颜色
function BT_applyTheme() {
  if (!BT_chart) return;
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  BT_chart.setOption({
    backgroundColor: 'transparent',
    textStyle: { color: isDark ? '#ddd' : '#333' }
  });
}

// 基础 option 框架（不依赖具体数据，初始化时调用一次）
function BT_getBaseOption() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    backgroundColor: 'transparent',
    animation: false,  // 关动画，K线滑动更顺畅
    textStyle: { color: isDark ? '#ddd' : '#333', fontSize: 12 },
    tooltip: {
      show: false,   // 禁用 ECharts 内置 tooltip，改用自定义 DOM tooltip（不挡 K线）
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        link: [{ xAxisIndex: 'all' }],
        label: {
          backgroundColor: 'rgba(85,85,85,0.95)',
          borderColor: '#777',
          borderWidth: 1,
          color: '#fff',
          fontSize: 12,
          fontWeight: 'bold',
          padding: [4, 8],
          borderRadius: 3
        }
      }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 60, right: 30, top: 18,  height: '68%' },   // K线（主图）  ≈ 18~526
      { left: 60, right: 30, top: '72%', height: '9%' },  // 量          ≈ 518~582
      { left: 60, right: 30, top: '83%', height: '7%' }   // MACD        ≈ 598~648
    ],
    xAxis: [
      { type: 'category', data: [], gridIndex: 0, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 1, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 2, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: true, color: isDark ? '#aaa' : '#666', margin: 4 },   // margin 控制与 grid 底部距离，避免被 slider 挡
        axisTick: { show: false }, splitLine: { show: false } }
    ],
    yAxis: [
      { gridIndex: 0, scale: true, splitArea: { show: false },
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666' },
        splitLine: { lineStyle: { color: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' } } },
      { gridIndex: 1, min: 0, splitNumber: 2,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666', fontSize: 10 },
        splitLine: { show: false } },
      { gridIndex: 2, scale: true, splitNumber: 2,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666', fontSize: 10 },
        splitLine: { show: false } }
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2],
        disabled: true,             // 禁用 inside（鼠标/滚轮拖动）
        zoomLock: true,
        moveOnMouseMove: false,
        moveOnMouseWheel: false,
        zoomOnMouseWheel: false,
        start: 0, end: 100
      },
      { show: true, xAxisIndex: [0, 1, 2], type: 'slider', bottom: 16, height: 18,
        // 关键：禁用所有改窗口宽度的路径
        //   brushSelect: false → 禁用"鼠标框选调整宽度"（Ctrl+拖动框选）
        //   zoomLock: true    → 锁定窗口大小，handle 不能改宽度
        //   handle: show: false → 隐藏两端把手，物理上不可拖
        brushSelect: false,
        zoomLock: true,
        handle:     { show: false },     // 隐藏两端把手 → 无法改变窗口宽度
        moveHandle: { show: true,        // 显示中间可移动把手 → 可拖动平移窗口
                      style: { color: 'rgba(100,100,100,0.25)', borderColor: '#888', borderWidth: 1 } },
        start: 0, end: 100,
        showDetail: false,
        showDataShadow: false,
        textStyle: { color: isDark ? '#aaa' : '#666', fontSize: 10 },
        borderColor: isDark ? '#555' : '#ccc' }
    ],
    series: []
  };
}

// 自定义 tooltip（鼠标 hover 时显示：日期+OHLC+涨跌+成交量+MA+MACD）
// 关键：成交量单位是"手"（后端 market-quote.js L103 注释：// 手），1手=100股
function BT_tooltipFormatter(params) {
  if (!params || params.length === 0) return '';
  var idx = params[0].dataIndex;
  if (!BT_klineData || !BT_klineData.ohlc[idx]) return '';
  var ohlc = BT_klineData.ohlc[idx];    // [open, close, low, high]
  var date = BT_klineData.dates[idx];
  var vol  = BT_klineData.volumes[idx] || 0;
  var isUp = ohlc[1] >= ohlc[0];
  var colUp   = '#ef476f';   // A 股红涨
  var colDown = '#2d9f7f';   // A 股绿跌
  var riseColor = isUp ? colUp : colDown;

  // 涨跌幅（与前一收盘比较；idx=0 是首根数据，无前值）
  var pctHtml = '';
  if (idx > 0) {
    var prevClose = BT_klineData.ohlc[idx - 1] && BT_klineData.ohlc[idx - 1][1];
    if (prevClose) {
      var pct = (ohlc[1] - prevClose) / prevClose * 100;
      pctHtml = '<span style="color:' + riseColor + ';font-weight:600;margin-left:6px;">' +
        (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
    }
  }

  // 成交量：>= 10000 手时换算成"X.XX 万手"，否则原样显示
  var volText = vol.toLocaleString() + ' 手';
  if (vol >= 10000) {
    volText += ' <span style="color:#999;font-size:11px;">(≈ ' + (vol / 10000).toFixed(2) + ' 万手)</span>';
  }

  var lines = [
    '<div style="font-weight:600;margin-bottom:6px;font-size:13px;">' + date + '</div>',
    '<div style="line-height:1.7;">' +
      '<div>开 <b>' + ohlc[0].toFixed(2) + '</b>　收 <b style="color:' + riseColor + '">' + ohlc[1].toFixed(2) + '</b>' + pctHtml + '</div>' +
      '<div>高 <b>' + ohlc[3].toFixed(2) + '</b>　低 <b>' + ohlc[2].toFixed(2) + '</b></div>' +
      '<div>成交量 <b style="color:' + riseColor + '">' + volText + '</b></div>' +
    '</div>'
  ];

  // MA 数据
  for (var i = 0; i < BT_maPeriods.length; i++) {
    var p = BT_maPeriods[i];
    var arr = BT_computeMAFromCloses(BT_klineData.ohlc, p);
    if (arr[idx] != null) {
      lines.push('<div style="line-height:1.7;"><span style="color:' + BT_MA_COLORS[i] + '">●</span> MA' + p + ': <b>' + arr[idx].toFixed(2) + '</b></div>');
    }
  }

  // VOL5：成交量 5 日均线（与 K线 MA 区分）
  if (BT_klineData._volMA5 && BT_klineData._volMA5[idx] != null) {
    var v5 = BT_klineData._volMA5[idx];
    var v5Text = v5.toLocaleString() + ' 手';
    if (v5 >= 10000) v5Text += ' <span style="color:#999;font-size:11px;">(≈ ' + (v5 / 10000).toFixed(2) + ' 万手)</span>';
    lines.push('<div style="line-height:1.7;border-top:1px dashed #555;margin-top:4px;padding-top:4px;"><span style="color:#ffffff">●</span> VOL5: <b>' + v5Text + '</b></div>');

    // 量比：当日成交量 / 前 5 日均量（不含当日）
    //   ≥2 倍：放量（红色）  0.5-2 倍：正常（白色）  <0.5 倍：缩量（绿色）
    if (idx >= 5) {
      var sum5 = 0;
      for (var p = idx - 5; p < idx; p++) sum5 += (BT_klineData.volumes[p] || 0);
      var avg5 = sum5 / 5;
      if (avg5 > 0) {
        var ratio = vol / avg5;
        var ratioColor = '#ddd';                          // 正常
        var ratioTag = '';
        if (ratio >= 2) { ratioColor = '#ef476f'; ratioTag = '<span style="color:#999;font-size:11px;"> 放量</span>'; }
        else if (ratio >= 1.5) { ratioColor = '#ef476f'; ratioTag = '<span style="color:#999;font-size:11px;"> 偏多</span>'; }
        else if (ratio < 0.5) { ratioColor = '#2d9f7f'; ratioTag = '<span style="color:#999;font-size:11px;"> 缩量</span>'; }
        else if (ratio < 0.8) { ratioColor = '#2d9f7f'; ratioTag = '<span style="color:#999;font-size:11px;"> 偏少</span>'; }
        lines.push('<div style="line-height:1.7;"><span style="color:#999">●</span> 量比: <b style="color:' + ratioColor + '">' + ratio.toFixed(2) + '</b>' + ratioTag + '</div>');
      }
    }
  }

  // MACD 数据（可选）
  var m = BT_klineData.macd;
  if (m && m.dif && m.dif[idx] != null && m.dif[idx] !== undefined) {
    var dif = m.dif[idx];
    var dea = m.dea[idx];
    var macd = m.macd[idx];
    var macdCol = (macd != null && macd >= 0) ? colUp : colDown;
    lines.push(
      '<div style="border-top:1px dashed rgba(128,128,128,0.3);margin-top:4px;padding-top:4px;line-height:1.7;font-size:12px;">' +
        '<span style="color:#ffd166;">DIF</span> <b>' + dif.toFixed(3) + '</b>　' +
        '<span style="color:#5c7cfa;">DEA</span> <b>' + dea.toFixed(3) + '</b>　' +
        '<b style="color:' + macdCol + '">MACD ' + (macd != null && macd >= 0 ? '+' : '') + (macd != null ? macd.toFixed(3) : '--') + '</b>' +
      '</div>'
    );
  }
  return lines.join('');
}

// 从 ohlc 数组里取收盘价序列
function BT_getCloses() {
  if (!BT_klineData) return [];
  return BT_klineData.ohlc.map(function(o) { return o[1]; });
}

// 前端计算 N 周期 MA（输入 OHLC 数组和周期 N，返回数组，前 N-1 项为 null）
function BT_computeMAFromCloses(ohlc, n) {
  var result = new Array(ohlc.length).fill(null);
  if (ohlc.length < n) return result;
  var sum = 0;
  for (var i = 0; i < n; i++) sum += ohlc[i][1];
  result[n - 1] = sum / n;
  for (var j = n; j < ohlc.length; j++) {
    sum += ohlc[j][1] - ohlc[j - n][1];
    result[j] = sum / n;
  }
  return result;
}

// 渲染 K 线主图
function BT_renderKLine(data) {
  if (!BT_chart) BT_initChart();
  BT_klineData = data;
  // 切换标的 / 重新加载 → 清掉"用户自定义窗口"，回到 pinRight 默认（光标钉在窗口最右）
  BT_userZoomRange = null;

  var dates = data.dates;
  var ohlc  = data.ohlc;
  var vols  = data.volumes;

  // 计算 4 条 MA
  var closes = ohlc.map(function(o) { return o[1]; });
  var maLines = [];
  for (var i = 0; i < 4; i++) {
    if (i < BT_maPeriods.length) {
      maLines.push({
        name: 'MA' + BT_maPeriods[i],
        type: 'line',
        data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
        smooth: true,
        lineStyle: { width: 1, color: BT_MA_COLORS[i] },
        showSymbol: false,
        z: 5
      });
    } else {
      // 空 slot：保证 series index 稳定（清空的 MA 不画线，但保留位置）
      maLines.push({ name: '__MA_empty_' + i, type: 'line', data: [], showSymbol: false, z: 5 });
    }
  }

  // K 线 + 量 + MACD
  var klineSeries = {
    name: 'K线',
    type: 'candlestick',
    data: ohlc,
    itemStyle: {
      color: BT_COLOR_UP,        // 阳线（收>开）
      color0: BT_COLOR_DOWN,     // 阴线（收<开）
      borderColor: BT_COLOR_UP,
      borderColor0: BT_COLOR_DOWN
    },
    markPoint: { data: [] },  // 买卖标记
    z: 2
  };

  // 成交量（颜色跟随涨跌）
  var volData = vols.map(function(v, i) {
    var rise = ohlc[i][1] >= ohlc[i][0];
    return {
      value: v,
      itemStyle: { color: rise ? BT_COLOR_UP : BT_COLOR_DOWN }
    };
  });
  var volSeries = {
    name: '成交',
    type: 'bar',
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: volData,
    z: 1
  };

  // 成交量的 5 日均线（VOL MA5）—— 白色折线 + 阴影，叠加在成交量柱状图上
  var volMA5 = new Array(vols.length).fill(null);
  if (vols.length >= 5) {
    var volSum = 0;
    for (var k = 0; k < 5; k++) volSum += (vols[k] || 0);
    volMA5[4] = volSum / 5;
    for (var m = 5; m < vols.length; m++) {
      volSum += (vols[m] || 0) - (vols[m - 5] || 0);
      volMA5[m] = volSum / 5;
    }
  }
  // 存到 data 供 tooltip 读取
  data._volMA5 = volMA5;
  var volMA5Series = {
    name: 'VOL5',
    type: 'line',
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: volMA5,
    smooth: true,
    symbol: 'none',
    lineStyle: { color: '#ffffff', width: 1.8, shadowColor: '#333', shadowBlur: 2 },   // 白色 + 阴影，与 K线 MA 区分
    itemStyle: { color: '#ffffff' },
    emphasis: { lineStyle: { width: 2.5 } },
    z: 10
  };

  // MACD：DIF/DEA 折线 + MACD 柱
  var macdData = data.macd || { dif: [], dea: [], macd: [] };
  var macdBarData = (macdData.macd || []).map(function(v, i) {
    return {
      value: v,
      itemStyle: { color: v >= 0 ? BT_COLOR_UP : BT_COLOR_DOWN }
    };
  });
  var macdSeries = [
    {
      name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
      data: macdData.dif || [], smooth: true, lineStyle: { width: 1, color: '#ffd166' },
      showSymbol: false, z: 3
    },
    {
      name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
      data: macdData.dea || [], smooth: true, lineStyle: { width: 1, color: '#5c7cfa' },
      showSymbol: false, z: 3
    },
    {
      name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2,
      data: macdBarData, z: 1
    }
  ];

  // 应用到图表
  BT_chart.setOption({
    xAxis: [{ data: dates }, { data: dates }, { data: dates }],
    series: [klineSeries].concat(maLines).concat([volSeries, volMA5Series]).concat(macdSeries)
  });

  // 显示/隐藏子图（通过 grid 的 height 控制）
  BT_updateVisibleGrids();

  // 同步底部光标 + 标记
  BT_refreshChartMarkers();

  // 默认光标：最后一根
  if (BT_currentIdx == null || BT_currentIdx >= dates.length || BT_currentIdx < 0) {
    BT_currentIdx = dates.length - 1;
  }
  BT_currentDate = dates[BT_currentIdx];
  BT_currentClose = ohlc[BT_currentIdx][1];

  // 根据"显示根数"应用固定缩放：加载后把光标钉在窗口最右（让用户立刻看到最新K线在最右边缘）
  // 注意：BT_visibleBars 不在这里从 select 同步，避免 +/- 调整后被 select 默认值覆盖
  //       初始化时由 BT_init() 在 BT_loadState 之后统一同步一次；BT_userZoomRange 已在函数顶部清空
  // 走 BT_applyVisibleBars() 是为了与 +/-/dataZoom 事件走相同路径（带防死循环保护）
  BT_applyVisibleBars();

  // 通过 dispatchAction 把 axisPointer 移到 BT_currentIdx
  BT_chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: BT_currentIdx });

  // 同步底部光标显示
  BT_updateCursorDisplay();
  BT_renderStats();
}

// 切换显示/隐藏子图
// 关键：5:1:1 比例（K线 : 量 : MACD），子图固定 100px，K线 = 5×100 = 500px，顶部不留白
function BT_updateVisibleGrids() {
  if (!BT_chart) return;
  var showVol  = BT_showFlags.vol;
  var showMacd = BT_showFlags.macd;
  var chartH = BT_chart.getHeight() || 720;
  var SUB_PX = 100;       // 量 + MACD 固定 100px
  var GAP = 4;            // 子图间 gap
  var TOP_PX = 0;         // 顶部不留白

  // K线高度 = 5 × 100 = 500px（5:1:1 比例）
  var mainH = 5 * SUB_PX;
  var mainTop = TOP_PX;
  var volTop = mainTop + mainH + GAP;
  var macdTop = volTop + (showVol ? SUB_PX : 0) + GAP;

  var grids = [
    { left: 60, right: 30, top: mainTop,    height: mainH },
    { left: 60, right: 30, top: volTop,      height: showVol ? SUB_PX : 0 },
    { left: 60, right: 30, top: macdTop,     height: showMacd ? SUB_PX : 0 }
  ];
  BT_chart.setOption({ grid: grids });
}

// 刷新买卖标记（增量更新，不重画全图）
function BT_refreshChartMarkers() {
  if (!BT_chart || !BT_klineData) return;
  var dateIndex = {};
  for (var i = 0; i < BT_klineData.dates.length; i++) {
    dateIndex[BT_klineData.dates[i]] = i;
  }
  var points = [];
  for (var j = 0; j < BT_trades.length; j++) {
    var t = BT_trades[j];
    var idx = dateIndex[t.date];
    if (idx === undefined) continue;  // 落在当前显示范围外
    // 标在最低价下方 1% 处，避免遮挡 K 线
    var low = BT_klineData.ohlc[idx][2];
    var offset = low * 0.01;
    points.push({
      name: t.action === 'buy' ? '买' : '卖',
      coord: [idx, low - offset],
      value: t.action === 'buy' ? 'B' : 'S',
      symbol: t.action === 'buy' ? 'triangle' : 'arrow',
      symbolSize: 12,
      symbolRotate: t.action === 'buy' ? 0 : 180,
      itemStyle: { color: t.action === 'buy' ? BT_COLOR_UP : BT_COLOR_DOWN },
      label: { show: true, fontSize: 10, fontWeight: 'bold', color: '#fff', formatter: '{c}' }
    });
  }

  // max/min 标记已移除（用户要求）
  var setOptionObj = {
    series: [{
      name: 'K线',
      markPoint: {
        data: points,
        animation: false,
        silent: true
      }
    }]
  };
  BT_chart.setOption(setOptionObj);
}

// 自定义 DOM tooltip：监听 mousemove 事件，固定显示在 chart 右上角
// 不跟随鼠标，不挡 K线
function BT_setupCustomTooltip() {
  if (!BT_chart) return;
  if (BT_chart._customTooltipInited) return;
  BT_chart._customTooltipInited = true;

  // 创建 tooltip DOM
  var tt = document.createElement('div');
  tt.className = 'bt-custom-tooltip';
  tt.style.cssText = [
    'position: fixed',
    'z-index: 999',
    'min-width: 200px',
    'max-width: 280px',
    'background: rgba(255,255,255,0.97)',
    'border: 1px solid #ccc',
    'border-radius: 4px',
    'padding: 8px 10px',
    'font-size: 12px',
    'line-height: 1.6',
    'color: #333',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.18)',
    'pointer-events: none',
    'display: none',
    'transition: opacity 0.1s'
  ].join(';');
  document.body.appendChild(tt);

  function renderTooltip(idx) {
    if (!BT_klineData || !BT_klineData.ohlc[idx]) { tt.style.display = 'none'; return; }
    tt.innerHTML = BT_tooltipFormatter([{ dataIndex: idx }]);
    tt.style.display = 'block';
    var chartDom = document.getElementById('btChart');
    if (!chartDom) return;
    var rect = chartDom.getBoundingClientRect();
    var ttW = tt.offsetWidth, ttH = tt.offsetHeight;
    var x = rect.left + 8;     // 左上角固定
    var y = rect.top + 8;
    if (x + ttW > rect.right - 4) x = rect.right - ttW - 4;
    if (y + ttH > rect.bottom - 4) y = rect.bottom - ttH - 4;
    tt.style.left = x + 'px';
    tt.style.top  = y + 'px';
  }

  // 监听 mousemove 事件（最可靠，ECharts 内部直接派发）
  BT_chart.on('mousemove', function(params) {
    if (params && params.dataIndex != null) {
      renderTooltip(params.dataIndex);
    }
  });

  // 鼠标移出 chart 隐藏
  BT_chart.on('mouseout', function() { tt.style.display = 'none'; });
  BT_chart.on('globalout', function() { tt.style.display = 'none'; });

  // 暴露给外部调用（程序触发时也能更新）
  BT_renderCustomTooltip = renderTooltip;
}

// 用绝对定位的 DOM 浮层渲染当前窗口的 max/min 标签
// 优势：完全可控样式、不受 ECharts markLine 渲染 bug 影响
function BT_renderWindowExtremaDOM(extrema) {
  // 移除旧标签
  var old = document.querySelectorAll('.bt-extrema-label');
  for (var i = 0; i < old.length; i++) old[i].remove();
  if (!extrema || !BT_chart) return;

  var chartDom = document.getElementById('btChart');
  if (!chartDom) return;
  // chart 内坐标 → 像素坐标
  var ptMax = BT_chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 },
                                      [extrema.maxIdx, BT_klineData.ohlc[extrema.maxIdx][3]]);
  var ptMin = BT_chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 },
                                      [extrema.minIdx, BT_klineData.ohlc[extrema.minIdx][2]]);
  if (!ptMax || !ptMin || isNaN(ptMax[0])) return;

  var rect = chartDom.getBoundingClientRect();
  var offsetX = rect.left;  // chart 相对视口的位置
  var offsetY = rect.top;

  function createLabel(text, x, y, color) {
    var el = document.createElement('div');
    el.className = 'bt-extrema-label';
    el.textContent = text;
    el.style.cssText = [
      'position: fixed',
      'left: ' + (offsetX + x - 28) + 'px',
      'top: ' + (offsetY + y - 10) + 'px',
      'background: ' + color,
      'color: #fff',
      'padding: 2px 6px',
      'border-radius: 3px',
      'font-size: 11px',
      'font-weight: bold',
      'pointer-events: none',
      'z-index: 1000',
      'box-shadow: 0 1px 3px rgba(0,0,0,0.3)',
      'white-space: nowrap'
    ].join(';');
    document.body.appendChild(el);
  }

  createLabel('高 ' + BT_klineData.ohlc[extrema.maxIdx][3].toFixed(2), ptMax[0], ptMax[1] - 12, '#ef476f');
  createLabel('低 ' + BT_klineData.ohlc[extrema.minIdx][2].toFixed(2), ptMin[0], ptMin[1] + 8, '#2d9f7f');
}

// 计算当前可见窗口（dataZoom）的最高 / 最低价
// 返回 { maxIdx, minIdx, maxPrice, minPrice } 或 null（数据不足）
function BT_calcWindowExtrema() {
  if (!BT_chart || !BT_klineData) return null;
  var opt = BT_chart.getOption();
  if (!opt.dataZoom || !opt.dataZoom[1]) return null;
  var z = opt.dataZoom[1];
  var total = BT_klineData.dates.length;
  if (total < 2) return null;
  // 百分比 → idx 范围
  var startIdx = Math.max(0, Math.floor((z.start || 0) / 100 * (total - 1)));
  var endIdx   = Math.min(total - 1, Math.ceil((z.end || 100) / 100 * (total - 1)));
  if (endIdx <= startIdx) return null;
  var maxIdx = startIdx, minIdx = startIdx;
  var maxPrice = BT_klineData.ohlc[startIdx][3]; // high
  var minPrice = BT_klineData.ohlc[startIdx][2]; // low
  for (var i = startIdx + 1; i <= endIdx; i++) {
    var hi = BT_klineData.ohlc[i][3];
    var lo = BT_klineData.ohlc[i][2];
    if (hi > maxPrice) { maxPrice = hi; maxIdx = i; }
    if (lo < minPrice) { minPrice = lo; minIdx = i; }
  }
  return { maxIdx: maxIdx, minIdx: minIdx, maxPrice: maxPrice, minPrice: minPrice };
}

// 切换 MA 周期后重画（从输入框读）
// 修改 MA 周期：保留空 slot（用户可清空），但**不**重画整个图，只更新 MA 系列 → 不动 xAxis/dataZoom/grid
function BT_updateMAPeriods() {
  var inputs = [document.getElementById('ma1'), document.getElementById('ma2'),
                document.getElementById('ma3'), document.getElementById('ma4')];
  var newPeriods = [];
  for (var i = 0; i < 4; i++) {
    var raw = inputs[i] && inputs[i].value && String(inputs[i].value).trim();
    if (!raw) continue;   // 空字符串 → 跳过（清空该 slot）
    var v = parseInt(raw);
    if (v && v > 0 && v <= 250) newPeriods.push(v);
  }
  if (newPeriods.length === 0) {
    BT_toast('至少需要 1 条均线', 'warn');
    return;
  }
  BT_maPeriods = newPeriods;
  if (BT_klineData) BT_renderMAOnly();   // 不重画 K 线 → 保留窗口位置
  BT_saveState();
}

// 只更新 MA 系列，不重画 xAxis / dataZoom / grid（窗口位置不动）
// 关键：series 数组必须以 K线占位开头（不传 data / itemStyle），与旧 K线 series merge 时保留其所有属性
function BT_renderMAOnly() {
  if (!BT_chart || !BT_klineData) return;
  var ohlc = BT_klineData.ohlc;
  var allSeries = [
    { name: 'K线', type: 'candlestick' }   // 占位：与旧 K线 series 按 index 合并，保留 data/itemStyle/markPoint
  ];
  for (var i = 0; i < 4; i++) {
    if (i < BT_maPeriods.length) {
      allSeries.push({
        name: 'MA' + BT_maPeriods[i],
        type: 'line',
        data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
        smooth: true,
        lineStyle: { width: 1, color: BT_MA_COLORS[i] },
        showSymbol: false,
        z: 5
      });
    } else {
      // 空 slot：data 为空数组 → 该 MA 不显示
      allSeries.push({ name: '__MA_empty_' + i, type: 'line', data: [], showSymbol: false, z: 5 });
    }
  }
  // 按 series index 合并（merge 模式默认），不重置 K线/量/MACD
  BT_chart.setOption({ series: allSeries });
}

// 切换显示开关
function BT_toggleShowMA() {
  BT_showFlags.ma = document.getElementById('showMA').checked;
  if (BT_klineData) BT_renderKLine(BT_klineData);
}
function BT_toggleShowMACD() {
  BT_showFlags.macd = document.getElementById('showMACD').checked;
  BT_updateVisibleGrids();
}
function BT_toggleShowVol() {
  BT_showFlags.vol = document.getElementById('showVol').checked;
  BT_updateVisibleGrids();
}

// 窗口尺寸变化时重排
window.addEventListener('resize', function() {
  if (BT_chart) BT_chart.resize();
});

// ===== 光标 / 固定缩放 工具函数 =====

// 更新底部 actionbar 的光标显示（日期 + 收盘价）
function BT_updateCursorDisplay() {
  var elDate = document.getElementById('curDate');
  var elClose = document.getElementById('curClose');
  if (elDate && BT_currentDate)  elDate.textContent = BT_currentDate;
  if (elClose && BT_currentClose != null) elClose.textContent = BT_currentClose.toFixed(2);
}

// 设置光标到指定索引（被 BT_nextBar/BT_prevBar/外部调用）
// mode: 'auto' = 居中（默认，鼠标 hover 时光标在窗口中间）
//       'pinRight' = 钉到窗口最右（"下一根K线"专用）
//       'pinLeft'  = 钉到窗口最左
// 锁定时（BT_zoomLocked=true）一律不调整 dataZoom
// 用户曾拖动 slider（BT_userZoomRange != null）时，保留窗口宽度、让 idx 落在最右
function BT_setCursor(idx, mode) {
  if (!BT_chart || !BT_klineData) return;
  var total = BT_klineData.dates.length;
  if (total === 0) return;
  if (idx < 0) idx = 0;
  if (idx >= total) idx = total - 1;
  BT_currentIdx = idx;
  BT_currentDate = BT_klineData.dates[idx];
  BT_currentClose = BT_klineData.ohlc[idx][1];

  // 调整 dataZoom（锁定时不调，保持用户当前视野）
  if (!BT_zoomLocked) {
    var zr;
    if (BT_userZoomRange && BT_userZoomRange.end > BT_userZoomRange.start) {
      // 用户曾拖动 slider → 保留窗口宽度，让 idx 落在最右（与"下一根/上一根"按钮语义一致）
      zr = BT_calcZoomRangeForIdx(idx, BT_visibleBars, BT_userZoomRange);
    } else {
      // 默认行为：按 mode 计算（pinRight/auto/pinLeft）
      zr = BT_calcZoomRange(idx, mode || 'auto');
    }
    _inDataZoomApply = true;
    try {
      BT_chart.setOption({ dataZoom: [{ start: zr.start, end: zr.end }, { start: zr.start, end: zr.end }] });
      BT_userZoomRange = { start: zr.start, end: zr.end };
    } finally {
      setTimeout(function() { _inDataZoomApply = false; }, 0);
    }
  }
  BT_chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: idx });

  BT_updateCursorDisplay();
  BT_renderStats();
  if (typeof BT_renderCustomTooltip === 'function') BT_renderCustomTooltip(idx);
}

// 应用"显示根数"变更：调整 dataZoom，不重画
// 模式：保持光标在窗口最右（pinRight），这样 +/- 后光标不会跳
// 改进：如果用户拖动过 slider（BT_userZoomRange != null），保留 start 位置只调整 end
function BT_applyVisibleBars() {
  if (!BT_chart || !BT_klineData) return;
  BT_visibleBars = BT_getVisibleBars();
  var zr;
  if (BT_userZoomRange && BT_userZoomRange.end > BT_userZoomRange.start) {
    // 用户曾拖动 slider → 保留 start 位置，调整 end 让窗口宽度 = BT_visibleBars
    zr = BT_calcZoomRangeFromRange(BT_userZoomRange, BT_visibleBars);
  } else {
    zr = BT_calcZoomRange(BT_currentIdx, 'pinRight');
  }
  _inDataZoomApply = true;
  try {
    BT_chart.setOption({ dataZoom: [{ start: zr.start, end: zr.end }, { start: zr.start, end: zr.end }] });
    BT_userZoomRange = { start: zr.start, end: zr.end };   // 同步回全局，供后续 +/- 沿用
  } finally {
    setTimeout(function() { _inDataZoomApply = false; }, 0);
  }
}

// 基于给定的 {start,end} 窗口和目标宽度 vis，保留 start 调整 end；边界自动收紧
function BT_calcZoomRangeFromRange(range, vis) {
  if (!BT_klineData || vis < 1) return { start: 0, end: 100 };
  var total = BT_klineData.dates.length;
  if (total <= 1) return { start: 0, end: 100 };
  var visPct = vis / (total - 1) * 100;   // vis 根对应的百分比宽度
  var maxStart = Math.max(0, 100 - visPct);
  var startPct = Math.min(range.start, maxStart);
  var endPct   = Math.min(100, startPct + visPct);
  return { start: startPct, end: endPct };
}

// 让 idx 落在窗口最右，窗口宽度 = vis（"下一根/上一根 K线"按钮用）
// 关键：传入 currentRange 时保留用户拖到的窗口宽度，避免 idx 接近 0 时窗口被压扁
function BT_calcZoomRangeForIdx(idx, vis, currentRange) {
  if (!BT_klineData || vis < 1) return { start: 0, end: 100 };
  var total = BT_klineData.dates.length;
  if (total <= 1) return { start: 0, end: 100 };

  // 优先用 currentRange 宽度（保留用户拖动 slider 后的窗口宽度）
  var visPct;
  if (currentRange && currentRange.end > currentRange.start) {
    visPct = currentRange.end - currentRange.start;
  } else {
    visPct = vis / (total - 1) * 100;
  }

  var idxPct = idx / (total - 1) * 100;
  // 边界保护：idx 太靠左（idxPct < visPct），窗口装不下完整宽度 → 左对齐、保留宽度
  if (idxPct < visPct) {
    return { start: 0, end: visPct };
  }
  // 边界保护：idx 太靠右，窗口不能超出 100% → 右对齐
  if (idxPct > 100) {
    return { start: Math.max(0, 100 - visPct), end: 100 };
  }
  var endPct = idxPct;
  var startPct = Math.max(0, Math.min(endPct - visPct, 100 - visPct));
  return { start: startPct, end: endPct };
}

// ===== 缩放 +/- 与比例锁定 =====

// 放大（K 线更密，显示更少根数）
function BT_zoomIn() {
  if (!BT_klineData) { BT_toast('请先加载 K 线', 'warn'); return; }
  var newBars = Math.max(BT_VISIBLE_BARS_MIN, Math.round(BT_visibleBars / BT_ZOOM_STEP));
  if (newBars >= BT_visibleBars) {
    BT_toast('已经放到最大（' + BT_VISIBLE_BARS_MIN + ' 根）', 'warn');
    return;
  }
  BT_visibleBars = newBars;
  // 顺序：先同步下拉框 → 再调 applyVisibleBars（applyVisibleBars 会从下拉框读回新值）
  BT_syncVisibleBarsSelect();
  BT_applyVisibleBars();
  BT_saveState();
}

// 缩小（K 线更疏，显示更多根数）
function BT_zoomOut() {
  if (!BT_klineData) { BT_toast('请先加载 K 线', 'warn'); return; }
  var total = BT_klineData.dates.length;
  var maxBars = Math.min(BT_VISIBLE_BARS_MAX, total);
  var newBars = Math.min(maxBars, Math.round(BT_visibleBars * BT_ZOOM_STEP));
  if (newBars <= BT_visibleBars) {
    BT_toast('已经缩到最小（' + maxBars + ' 根）', 'warn');
    return;
  }
  BT_visibleBars = newBars;
  // 顺序：先同步下拉框 → 再调 applyVisibleBars
  BT_syncVisibleBarsSelect();
  BT_applyVisibleBars();
  BT_saveState();
}

// 把当前 BT_visibleBars 同步到下拉框（去重：先清理旧的"手动"option，再查重插入）
function BT_syncVisibleBarsSelect() {
  var el = document.getElementById('btVisibleBars');
  if (!el) return;
  var targetVal = String(BT_visibleBars);

  // 1) 先清理所有旧的"手动"option（防止跨多次 +/- 后累积几十个重复项）
  for (var i = el.options.length - 1; i >= 0; i--) {
    if (el.options[i].dataset && el.options[i].dataset.manual === '1') {
      el.remove(i);
    }
  }

  // 2) 查重：若 select 里已有匹配项（标称档位或手动档位），直接选中
  var matchIdx = -1;
  for (var j = 0; j < el.options.length; j++) {
    if (parseInt(el.options[j].value) === BT_visibleBars) { matchIdx = j; break; }
  }
  if (matchIdx >= 0) {
    el.value = targetVal;
  } else {
    // 3) 没有匹配项则新增一个"手动"option（带 data-manual 标识，便于下次清理）
    var opt = document.createElement('option');
    opt.value = targetVal;
    opt.textContent = BT_visibleBars + ' 根（手动）';
    opt.dataset.manual = '1';
    el.appendChild(opt);
    el.value = targetVal;
  }
}

// 切换比例锁定
function BT_toggleZoomLock() {
  BT_zoomLocked = !BT_zoomLocked;
  try { localStorage.setItem('bt_state_zoomLocked', JSON.stringify(BT_zoomLocked)); } catch (e) {}
  var btn = document.getElementById('btnZoomLock');
  if (btn) {
    btn.textContent = BT_zoomLocked ? '🔒 锁定' : '🔓 锁定';
    btn.classList.toggle('active', BT_zoomLocked);
    btn.title = BT_zoomLocked
      ? '已锁定比例：拖动滑块 / 下一根K线 都不会改变窗口'
      : '未锁定：拖动 / 推进光标时会自动调整窗口';
  }
  BT_toast(BT_zoomLocked ? '已锁定比例' : '已解锁比例', BT_zoomLocked ? 'success' : 'warn');
}

// 初始化锁定按钮的 UI 状态（页面加载时调用）
function BT_initZoomLockUI() {
  var btn = document.getElementById('btnZoomLock');
  if (!btn) return;
  if (BT_zoomLocked) {
    btn.textContent = '🔒 锁定';
    btn.classList.add('active');
    btn.title = '已锁定比例：拖动滑块 / 下一根K线 都不会改变窗口';
  } else {
    btn.textContent = '🔓 锁定';
    btn.title = '未锁定：拖动 / 推进光标时会自动调整窗口';
  }
}
