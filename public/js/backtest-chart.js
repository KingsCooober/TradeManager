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
var BT_showFlags = { ma: true, macd: true, vol: true, equity: true };  // 显示开关
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

  // 初始化时按当前 BT_maPeriods 把右栏两个 MA 容器填上（避免空白）
  // 后续 BT_updateMAPeriods / 数据加载时会刷新里面的数值
  BT_renderMaList('curMa', 'cur');
  BT_renderMaList('idxMa', 'idx');

  // 监听光标移动 → 更新底部 actionbar
  // 关键：同时监听 'mousemove'（直接派发 + 包含 dataIndex）和 'updateAxisPointer'（带 axesInfo）
  //   之前只监听 updateAxisPointer，但 link 配置错误导致 axesInfo=[]，事件回调拿不到 idx
  //   现在 mousemove 作为主驱动，updateAxisPointer 作为补充
  BT_chart.on('mousemove', function(params) {
    if (!params || params.dataIndex == null) return;
    if (!BT_klineData) return;
    var idx = params.dataIndex;
    if (idx >= 0 && idx < BT_klineData.dates.length && idx !== BT_currentIdx) {
      BT_currentIdx = idx;
      BT_currentDate = BT_klineData.dates[idx];
      BT_currentClose = BT_klineData.ohlc[idx][1];
      BT_updateCursorDisplay();
      BT_renderStats();
      // 同步指数图光标
      if (typeof BT_syncIndexCursor === 'function') BT_syncIndexCursor(idx);
      // 同步右侧指数面板
      if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();
    }
  });
  BT_chart.on('updateAxisPointer', function(event) {
    // 兼容：有些 ECharts 版本走 updateAxisPointer 事件（axesInfo 带 value）
    var xAxisInfo = event.axesInfo && event.axesInfo[0];
    if (xAxisInfo && xAxisInfo.value !== undefined && BT_klineData) {
      var idx = xAxisInfo.value;
      if (idx >= 0 && idx < BT_klineData.dates.length && idx !== BT_currentIdx) {
        BT_currentIdx = idx;
        BT_currentDate = BT_klineData.dates[idx];
        BT_currentClose = BT_klineData.ohlc[idx][1];
        BT_updateCursorDisplay();
        BT_renderStats();
        // 同步指数图光标
        if (typeof BT_syncIndexCursor === 'function') BT_syncIndexCursor(idx);
        // 同步右侧指数面板
        if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();
      }
    }
  });

  // 监听用户拖动 dataZoom（slider / inside）→ 同步 BT_userZoomRange 和 BT_visibleBars
  // 这样后续 +/- 按钮和 select 切换都能尊重用户手动调整的窗口位置，不再粗暴重置
  // ECharts 5.x 的 dataZoom 事件 params 结构在不同场景下不一样：
  //   - 真实拖动 slider：{ start, end, from, dataZoomId, ... }（顶层属性）
  //   - 批量操作（多个 dataZoom 联动）：{ batch: [{ start, end, ... }] }（batch 数组）
  // 所以两种格式都要兼容
  BT_chart.on('dataZoom', function(params) {
    if (_inDataZoomApply) return;   // 我们自己 setOption 触发的，跳过
    if (!BT_klineData) return;
    var s, e;
    if (params && Array.isArray(params.batch) && params.batch[0]) {
      s = params.batch[0].start; e = params.batch[0].end;
    } else if (params && typeof params.start === 'number') {
      s = params.start; e = params.end;
    } else {
      return;
    }
    if (typeof s !== 'number' || typeof e !== 'number') return;
    // 同步指数图（先做，避免被下面的 width check 阻断）
    if (typeof BT_syncIndexZoom === 'function') BT_syncIndexZoom();
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
      trigger: 'axis'
      // 注意：tooltip.show=false 时，下面的 axisPointer 配置也会失效
      // 十字光标必须放在顶层 axisPointer（见下），并显式指定 type='cross'
    },
    // 顶层 axisPointer（独立于 tooltip）—— 控制十字光标显示
    //   type='cross' → 十字（横线+竖线）
    //   link → 4 个 grid 同步（K线/量/MACD/资金）
    //   lineStyle → 浅灰半透明（不抢眼但能看清位置）
    //   label.backgroundColor → 关掉默认灰色背景（之前总有个灰块跟着鼠标走）
    //   show='auto' → 鼠标 hover 时显示（默认行为）
    axisPointer: {
      type: 'cross',
      link: { xAxisIndex: 'all' },
      show: 'auto',
      lineStyle: { color: 'rgba(128,128,128,0.5)', type: 'dashed', width: 1 },
      label: { backgroundColor: 'transparent', color: 'transparent', borderWidth: 0 }
    },
    grid: [
      { left: 60, right: 30, top: 18,   height: 360 },   // K线 360px
      { left: 60, right: 30, top: 383,  height: 90 },    // 成交量 90px
      { left: 60, right: 30, top: 478,  height: 90 },    // MACD 90px
      { left: 60, right: 30, top: 573,  height: 120 }    // 资金曲线 120px
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
        axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 3, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
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
        splitLine: { show: false } },
      { gridIndex: 3, scale: true, splitNumber: 3,
        position: 'left',
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666', fontSize: 10,
                     formatter: function(v) { return v >= 10000 ? (v/10000).toFixed(1) + '万' : v.toFixed(0); } },
        splitLine: { show: false } }
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2, 3],
        disabled: true,             // 禁用 inside（鼠标/滚轮拖动）
        zoomLock: true,
        moveOnMouseMove: false,
        moveOnMouseWheel: false,
        zoomOnMouseWheel: false,
        start: 0, end: 100
      },
      { show: true, xAxisIndex: [0, 1, 2, 3], type: 'slider', bottom: 16, height: 18,
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
// 关键：后端返回的 volumes[idx] 单位是"手"（market-quote.js L103 注释：// 手）
//   1 手 = 100 股，所以股数 = vol × 100
//   显示策略：>=100 手（≥1 万股）时用"万股"为主单位，否则用"股"
function BT_formatVolume(vol) {
  if (!vol || vol <= 0) return '0 股';
  var shares = vol * 100;   // 手 → 股
  if (vol >= 100) {
    // 万股为主单位 + 精确股数作为次单位
    var wanShares = (shares / 10000).toFixed(2);
    return wanShares + ' 万股 <span style="color:#999;font-size:11px;">(' + shares.toLocaleString() + ' 股)</span>';
  }
  return shares.toLocaleString() + ' 股';
}

// 格式化成交额（入参单位：万元）
//   - 跌入小幅金额才用 万元
//   - 几千亿用 亿元
//   - 万亿以上加 '万亿'
function BT_formatAmount(wanAmount) {
  if (!wanAmount || wanAmount <= 0) return '0 万元';
  if (wanAmount >= 1e8) {
    // 万亿级（如成交额万亿，罕见但不为0）
    return (wanAmount / 1e8).toFixed(2) + ' 万亿元';
  }
  if (wanAmount >= 1e4) {
    // 千亿级 → 亿元
    return (wanAmount / 1e4).toFixed(2) + ' 亿元';
  }
  return wanAmount.toFixed(0) + ' 万元';
}

// 按当前 BT_maPeriods 动态生成 MA 行 DOM
//   - container = 容器元素 id（'curMa' 或 'idxMa'）
//   - prefix    = id 前缀（'cur' 或 'idx'），用于构造内部 <b id> 名
//   关键：MA 周期完全跟图表一致，改 ma1=7/ma2=14 后右栏立刻显示 MA7/MA14，不再硬编码 5/10/20/60
function BT_renderMaList(containerId, prefix) {
  var box = document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  for (var i = 0; i < BT_maPeriods.length; i++) {
    var p = BT_maPeriods[i];
    var div = document.createElement('div');
    div.dataset.maIdx = String(i);
    div.innerHTML = '<span>MA' + p + '</span><b id="' + prefix + 'MaP_' + i + '">--</b>';
    box.appendChild(div);
    // 给 span 上色（dot 颜色与图表 MA 线一致）
    var span = div.querySelector('span');
    if (span) span.style.color = BT_MA_COLORS[i] || '#666';
  }
}

// 按当前 BT_maPeriods 把 MA 值写到对应容器里
//   - data = 主图（BT_klineData）或 指数图（BT_indexData）
function BT_fillMaValues(containerId, prefix, data, idx) {
  var box = document.getElementById(containerId);
  if (!box || !data) return;
  for (var i = 0; i < BT_maPeriods.length; i++) {
    var p = BT_maPeriods[i];
    var arr = BT_computeMAFromCloses(data.ohlc, p);
    var v = arr[idx];
    var el = document.getElementById(prefix + 'MaP_' + i);
    if (el) {
      el.textContent = v != null ? v.toFixed(2) : '--';
      el.style.color = BT_MA_COLORS[i] || '#666';
    }
  }
}

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

  var lines = [
    '<div style="font-weight:600;margin-bottom:6px;font-size:13px;">' + date + '</div>',
    '<div style="line-height:1.7;">' +
      '<div>开 <b>' + ohlc[0].toFixed(2) + '</b>　收 <b style="color:' + riseColor + '">' + ohlc[1].toFixed(2) + '</b>' + pctHtml + '</div>' +
      '<div>高 <b>' + ohlc[3].toFixed(2) + '</b>　低 <b>' + ohlc[2].toFixed(2) + '</b></div>' +
      '<div>成交量 <b style="color:' + riseColor + '">' + BT_formatVolume(vol) + '</b></div>' +
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
    lines.push('<div style="line-height:1.7;border-top:1px dashed #555;margin-top:4px;padding-top:4px;"><span style="color:#374151">●</span> VOL5: <b>' + BT_formatVolume(v5) + '</b></div>');

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

  // 资金曲线（可选）：显示当日总资金 + 累计收益率
  if (BT_klineData._equity && BT_klineData._equity[idx] != null) {
    var eq = BT_klineData._equity[idx];
    var initCap2 = (typeof BT_initCapital === 'number' && BT_initCapital > 0) ? BT_initCapital : 100000;
    var eqPct = (eq - initCap2) / initCap2 * 100;
    var eqCol = eqPct >= 0 ? colUp : colDown;
    lines.push(
      '<div style="border-top:1px dashed rgba(128,128,128,0.3);margin-top:4px;padding-top:4px;line-height:1.7;font-size:12px;">' +
        '<span style="color:#7c5cff;">●</span> 资金 <b>¥' + eq.toLocaleString() + '</b>　' +
        '<span style="color:#999;">收益率</span> <b style="color:' + eqCol + '">' + (eqPct >= 0 ? '+' : '') + eqPct.toFixed(2) + '%</b>' +
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

// 按时间模拟所有交易，生成资金曲线（每日总资金 = 现金 + 持仓股数 × 当日收盘价）
// 入参：ohlc = [[open, close, low, high], ...]，dates = [dateStr, ...]，trades = [{date, action, price, volume, fee?}, ...]
// 出参：equity[i] = 第 i 天结束时总资金（保留 2 位小数）
function BT_buildEquityCurve(ohlc, dates, trades) {
  var initCap = (typeof BT_initCapital === 'number' && BT_initCapital > 0) ? BT_initCapital : 100000;
  var cash = initCap;
  var posVol = 0, posCost = 0;
  var equity = new Array(dates.length);

  // 拷贝并按日期升序排序（防止 trades 乱序）
  var sortedTrades = (trades || []).slice().sort(function(a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });

  var ti = 0;
  for (var i = 0; i < dates.length; i++) {
    // 处理"日期 <= dates[i]"的所有交易
    while (ti < sortedTrades.length && sortedTrades[ti].date <= dates[i]) {
      var t = sortedTrades[ti];
      if (t.action === 'buy') {
        cash -= t.price * t.volume + (t.fee || 0);
        var nv = posVol + t.volume;
        if (nv > 0) posCost = (posVol * posCost + t.volume * t.price) / nv;
        posVol = nv;
      } else {
        var sv = Math.min(t.volume, posVol);
        if (sv > 0) {
          cash += t.price * sv - (t.fee || 0);
          posVol -= sv;
          if (posVol === 0) posCost = 0;
        }
      }
      ti++;
    }
    // 当日总资金 = 现金 + 持仓股数 × 收盘价
    var close = ohlc[i][1];
    equity[i] = +(cash + posVol * close).toFixed(2);
  }
  return equity;
}

// 增量刷新资金曲线（买卖后调用，不重画整个 K线）
// 重新计算 equity 数组 → 更新 data._equity + ECharts series + tooltip
function BT_refreshEquityCurve() {
  if (!BT_chart || !BT_klineData) return;
  if (!BT_showFlags.equity) return;
  var ohlc = BT_klineData.ohlc;
  var dates = BT_klineData.dates;
  if (!ohlc || !dates) return;
  // 重算 equity
  var newEquity = BT_buildEquityCurve(ohlc, dates, BT_trades || []);
  BT_klineData._equity = newEquity;
  // 更新 ECharts series（资金曲线是 series 数组的最后一个）
  var opt = BT_chart.getOption();
  var series = opt.series || [];
  // 找 equity series（按 name 匹配更稳）
  var equityIdx = -1;
  for (var i = 0; i < series.length; i++) {
    if (series[i] && series[i].name === '资金') { equityIdx = i; break; }
  }
  if (equityIdx < 0) {
    // 资金 series 还没渲染（初始没开显示？）→ 跳过
    return;
  }
  // 用 series[i] 引用更新（ECharts 会响应式更新）
  if (typeof series[equityIdx].data !== 'undefined') {
    series[equityIdx].data = newEquity;
  }
  _inDataZoomApply = true;
  try {
    BT_chart.setOption({ series: series });
  } finally {
    setTimeout(function() { _inDataZoomApply = false; }, 0);
  }
  // 刷新当前 hover 的 tooltip
  if (BT_currentIdx != null && BT_renderCustomTooltip) {
    BT_renderCustomTooltip(BT_currentIdx);
  }
  // 刷新 stats 卡片（资金、总资产等）
  if (typeof BT_renderStats === 'function') BT_renderStats();
}

// 渲染 K 线主图
function BT_renderKLine(data) {
  if (!BT_chart) BT_initChart();
  BT_klineData = data;
  // 切换标的 / 重新加载 → 清掉"用户自定义窗口"，回到 pinRight 默认（光标钉在窗口最右）
  BT_userZoomRange = null;
  // 检测是否月线降级数据（后端因接口限制自动降级）→ 显示顶部 banner
  if (data && data.__period === 'month') {
    BT_showPeriodBanner('📅 当前为月线模式（接口不支持日级 10 年，月线可展示 17+ 年长期趋势）');
  } else {
    BT_hidePeriodBanner();
  }

  // ★ BT_visibleBars 由 select 选项决定（60/90/120），不要在这里覆盖
  //   如果 select 还没初始化（页面刷新早于 BT_initUI），用默认值 120
  var visEl = document.getElementById('btVisibleBars');
  if (visEl) {
    BT_visibleBars = parseInt(visEl.value) || 120;
  } else if (!BT_visibleBars) {
    BT_visibleBars = 120;
  }

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

  // 成交量 5 日均线（VOL MA5）—— 黑色普通线
  // 同时也作为"前5日均量（不含当日）"用于计算柱高亮的量比
  //   备注：之前用 volMA5（含当日）算 ratio，会让成交量柱和 tooltip 显示的量比值不一致
  //   现在改用"前 5 日均量（不含当日）"算 ratio（与 tooltip 公式一致），
  //   保证用户看到的 ratio 值和柱子的高亮判断 100% 一致
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

  // 同时计算"前 5 日均量（不含当日）"数组，给柱高亮判断用
  //   prev5Avg[i] = mean(vols[i-5..i-1])，i < 5 时 = null（数据不足）
  //   与 tooltip 中的算法（line 393-395）保持完全一致
  //   关键修正：必须从 idx=5 开始（前 5 日均量至少有 5 个值）
  //   旧 bug：从 idx=4 开始且滑动增量加减错位，导致 prev5Avg 偏大、ratio 偏小 → 误高亮
  var prev5Avg = new Array(vols.length).fill(null);
  if (vols.length >= 6) {   // 至少需要 idx=5 才能计算前 5 日均量
    var pSum = 0;
    for (var k = 0; k < 5; k++) pSum += (vols[k] || 0);   // pSum = vols[0..4]
    prev5Avg[5] = pSum / 5;                                 // prev5Avg[5] = mean(vols[0..4])
    for (var i = 6; i < vols.length; i++) {
      pSum += (vols[i - 1] || 0) - (vols[i - 6] || 0);     // pSum 滑动：加最新，减最旧
      prev5Avg[i] = pSum / 5;                               // prev5Avg[i] = mean(vols[i-5..i-1])
    }
  }
  data._prev5Avg = prev5Avg;

  // 成交量（颜色规则）
  //   1. 当日收盘 vs 昨收（首日用 open）—— 涨红跌绿（基础色）
  //        涨（close >= prevClose）→ 红 #ef476f
  //        跌（close <  prevClose）→ 绿 #2d9f7f
  //   2. 量比 > 1.71 → 同色系高亮（保持原色：红柱红高亮 / 绿柱绿高亮）
  //      不区分上涨/下跌，单纯的"放量"告警
  //      量比 = 当日成交量 / 前 5 日均量（不含当日，与 tooltip 一致）
  //   3. 前 5 根（数据不足）即使放量也不高亮
  //   配色：红柱放量 = #ff1744 亮红 + #d50000 边框 + 红色发光
  //         绿柱放量 = #00e676 亮绿 + #00c853 边框 + 绿色发光
  var volData = vols.map(function(v, i) {
    var close = ohlc[i][1];
    var prevClose = i > 0 ? ohlc[i - 1][1] : ohlc[i][0];   // 首日 fallback 到 open
    var isUpBar = close >= prevClose;   // 基础红涨：含十字星（A 股惯例）
    var avg5 = prev5Avg[i];
    var ratio = (avg5 && avg5 > 0) ? (v / avg5) : 0;
    // 量比 > 1.71：同色系高亮（红柱红 / 绿柱绿）
    if (ratio > 1.71) {
      return {
        value: v,
        itemStyle: {
          color:      isUpBar ? '#ff1744' : '#00e676',  // 亮红 / 亮绿
          borderColor: isUpBar ? '#d50000' : '#00c853', // 深红 / 深绿
          borderWidth: 1.2,
          shadowColor: isUpBar ? '#ff1744' : '#00e676', // 发光颜色跟随原色
          shadowBlur: 6
        }
      };
    }
    return {
      value: v,
      itemStyle: { color: isUpBar ? BT_COLOR_UP : BT_COLOR_DOWN }
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

  // 成交量的 5 日均线（VOL MA5）—— 黑色普通线，叠加在成交量柱状图上
  var volMA5Series = {
    name: 'VOL5',
    type: 'line',
    xAxisIndex: 1,
    yAxisIndex: 1,
    data: volMA5,
    smooth: true,
    symbol: 'none',
    lineStyle: { color: '#374151', width: 1.5 },   // 深灰黑，普通线样式
    itemStyle: { color: '#374151' },
    emphasis: { lineStyle: { width: 2 } },
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

  // 资金曲线：按时间模拟所有交易，得出每日总资金（现金 + 持仓市值）
  // 视觉：紫色 line + 渐变 area + 初始资金水平线
  var equityArr = BT_buildEquityCurve(ohlc, dates, BT_trades);
  data._equity = equityArr;   // 存到 data 供 tooltip 读取
  var initCap = (typeof BT_initCapital === 'number' && BT_initCapital > 0) ? BT_initCapital : 100000;
  var equitySeries = {
    name: '资金',
    type: 'line',
    xAxisIndex: 3,
    yAxisIndex: 3,
    data: equityArr,
    smooth: true,
    showSymbol: false,
    lineStyle: { color: '#7c5cff', width: 1.8 },
    itemStyle: { color: '#7c5cff' },
    areaStyle: {
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: 'rgba(124, 92, 255, 0.30)' },
          { offset: 1, color: 'rgba(124, 92, 255, 0.02)' }
        ]
      }
    },
    markLine: {
      symbol: 'none',
      silent: true,
      label: { show: true, color: '#999', fontSize: 10, position: 'insideEndTop',
               formatter: '初始资金 ¥' + (initCap / 10000).toFixed(1) + '万' },
      lineStyle: { color: '#999', type: 'dashed', width: 1 },
      data: [{ yAxis: initCap }]
    },
    z: 3
  };

  // 应用到图表
  BT_chart.setOption({
    xAxis: [{ data: dates }, { data: dates }, { data: dates }, { data: dates }],
    series: [klineSeries].concat(maLines).concat([volSeries, volMA5Series]).concat(macdSeries).concat([equitySeries])
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
// 高度分配：K线 400px（最大，看 K线主体），量 80px / MACD 60px / 资金 60px（紧凑）
function BT_updateVisibleGrids() {
  if (!BT_chart) return;
  var showVol    = BT_showFlags.vol;
  var showMacd   = BT_showFlags.macd;
  var showEquity = BT_showFlags.equity;

  // 固定像素高度（与 #btChart { height: 730px } 配套：18+360+5+90+5+90+5+120+18+16 = 727）
  var KLINE_PX  = 360;   // K线主图
  var VOL_PX    = 90;    // 成交量
  var MACD_PX   = 90;    // MACD
  var EQUITY_PX = 120;   // 资金曲线
  var GAP = 5;           // 子图间 gap
  var TOP_PX = 18;       // 顶部 18px 留白（容 Y轴 label）

  var mainTop = TOP_PX;
  var volTop = mainTop + KLINE_PX + GAP;
  var macdTop = volTop + (showVol ? VOL_PX : 0) + GAP;
  var equityTop = macdTop + (showMacd ? MACD_PX : 0) + GAP;

  var grids = [
    { left: 60, right: 30, top: mainTop,    height: KLINE_PX },
    { left: 60, right: 30, top: volTop,      height: showVol ? VOL_PX : 0 },
    { left: 60, right: 30, top: macdTop,     height: showMacd ? MACD_PX : 0 },
    { left: 60, right: 30, top: equityTop,   height: showEquity ? EQUITY_PX : 0 }
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
  // v=70：去掉浮动 tooltip，数据全部显示在右侧 panel（curPanel/idxPanel）
  // 保留函数作为占位，避免外部调用报错
  if (BT_chart && !BT_chart._customTooltipInited) {
    BT_chart._customTooltipInited = true;
  }
  return;

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
  BT_renderCustomTooltip = function() {
    // v=70：去掉了浮动 tooltip，数据全部写到右侧 panel
    // （保留 BT_renderCustomTooltip 接口作为占位，避免破坏外部调用）
  };
}

// 指数图的自定义 tooltip（结构与主图类似，但不显示资金曲线，且显示在哪都行）
function BT_setupIndexTooltip() {
  // v=70：去掉浮动 tooltip（指数 K线 数据合并到右侧 idxPanel）
  // 保留函数作为占位
  if (BT_indexChart && !BT_indexChart._customTooltipInited) {
    BT_indexChart._customTooltipInited = true;
  }
  return;

  // === 以下代码保留但不再创建 DOM ===
  var tt = document.createElement('div');
  tt.className = 'bt-custom-tooltip bt-index-tooltip';
  tt.style.cssText = [
    'position: fixed',
    'z-index: 999',
    'min-width: 180px',
    'max-width: 240px',
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
    if (!BT_indexData || !BT_indexData.ohlc || !BT_indexData.ohlc[idx]) {
      tt.style.display = 'none';
      return;
    }
    var ohlc = BT_indexData.ohlc[idx];    // [open, close, low, high]
    var date = BT_indexData.dates[idx];
    var vol  = BT_indexData.volumes && BT_indexData.volumes[idx] || 0;
    var isUp = ohlc[1] >= ohlc[0];
    var colUp   = '#ef476f';
    var colDown = '#2d9f7f';
    var riseColor = isUp ? colUp : colDown;

    var pctHtml = '';
    if (idx > 0) {
      var prevClose = BT_indexData.ohlc[idx - 1] && BT_indexData.ohlc[idx - 1][1];
      if (prevClose) {
        var pct = (ohlc[1] - prevClose) / prevClose * 100;
        pctHtml = '<span style="color:' + riseColor + ';font-weight:600;margin-left:6px;">' +
          (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
      }
    }

    var lines = [
      '<div style="font-weight:600;margin-bottom:6px;font-size:13px;">📈 ' + date + '</div>',
      '<div style="line-height:1.7;">' +
        '<div>开 <b>' + ohlc[0].toFixed(2) + '</b>　收 <b style="color:' + riseColor + '">' + ohlc[1].toFixed(2) + '</b>' + pctHtml + '</div>' +
        '<div>高 <b>' + ohlc[3].toFixed(2) + '</b>　低 <b>' + ohlc[2].toFixed(2) + '</b></div>' +
        (vol > 0 ? '<div>成交额 <b>' + vol.toLocaleString() + ' 万元</b></div>' : '') +
      '</div>'
    ];

    // MA 数据
    for (var i = 0; i < BT_maPeriods.length; i++) {
      var p = BT_maPeriods[i];
      var arr = BT_computeMAFromCloses(BT_indexData.ohlc, p);
      if (arr[idx] != null) {
        lines.push('<div style="line-height:1.7;"><span style="color:' + BT_MA_COLORS[i] + '">●</span> MA' + p + ': <b>' + arr[idx].toFixed(2) + '</b></div>');
      }
    }

    // MACD 数据
    var m = BT_indexData.macd;
    if (m && m.dif && m.dif[idx] != null && m.dif[idx] !== undefined) {
      var dif = m.dif[idx];
      var dea = m.dea[idx];
      var macdV = m.macd[idx];
      var macdCol = (macdV != null && macdV >= 0) ? colUp : colDown;
      lines.push(
        '<div style="border-top:1px dashed rgba(128,128,128,0.3);margin-top:4px;padding-top:4px;line-height:1.7;">' +
          '<span style="color:#ffd166;">DIF</span> <b>' + dif.toFixed(3) + '</b>　' +
          '<span style="color:#5c7cfa;">DEA</span> <b>' + dea.toFixed(3) + '</b>　' +
          '<b style="color:' + macdCol + '">MACD ' + (macdV != null && macdV >= 0 ? '+' : '') + (macdV != null ? macdV.toFixed(3) : '--') + '</b>' +
        '</div>'
      );
    }

    tt.innerHTML = lines.join('');
    tt.style.display = 'block';
    var chartDom = document.getElementById('btChartIndex');
    if (!chartDom) return;
    var rect = chartDom.getBoundingClientRect();
    var ttW = tt.offsetWidth, ttH = tt.offsetHeight;
    var x = rect.left + 8;
    var y = rect.top + 8;
    if (x + ttW > rect.right - 4) x = rect.right - ttW - 4;
    if (y + ttH > rect.bottom - 4) y = rect.bottom - ttH - 4;
    tt.style.left = x + 'px';
    tt.style.top  = y + 'px';
  }

  BT_indexChart.on('mousemove', function(params) {
    if (params && params.dataIndex != null) {
      renderTooltip(params.dataIndex);
    }
  });
  BT_indexChart.on('mouseout', function() { tt.style.display = 'none'; });
  BT_indexChart.on('globalout', function() { tt.style.display = 'none'; });
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
  // 右栏 MA 行也要跟着改：用户改了 ma1=7，右栏立刻显示 MA7 而不是 MA5
  BT_renderMaList('curMa', 'cur');
  BT_renderMaList('idxMa', 'idx');
  if (BT_klineData && typeof BT_currentIdx !== 'undefined' && BT_currentIdx != null) {
    BT_fillMaValues('curMa', 'cur', BT_klineData, BT_currentIdx);
  }
  if (BT_indexData && typeof BT_currentIdx !== 'undefined' && BT_currentIdx != null) {
    var idx2 = Math.min(BT_currentIdx, BT_indexData.dates.length - 1);
    BT_fillMaValues('idxMa', 'idx', BT_indexData, idx2);
  }
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
function BT_toggleShowEquity() {
  BT_showFlags.equity = document.getElementById('showEquity').checked;
  BT_updateVisibleGrids();
}

// 窗口尺寸变化时重排
window.addEventListener('resize', function() {
  if (BT_chart) BT_chart.resize();
});

// ===== 光标 / 固定缩放 工具函数 =====

// 更新底部 actionbar 的光标显示（日期 + 收盘价）
// 工具：把数字格式化成 %.2f 字符串（null 安全）
function _fmt(v, digits) {
  if (v == null || v === undefined || isNaN(v)) return '--';
  return Number(v).toFixed(digits != null ? digits : 2);
}

// 把主图光标对应的 K线 数据写入右侧 panel（替代浮动 tooltip）
function BT_updateCursorDisplay() {
  if (!BT_klineData || BT_currentIdx == null) return;
  var idx = BT_currentIdx;
  if (idx < 0 || idx >= BT_klineData.dates.length) return;
  var ohlc = BT_klineData.ohlc[idx];
  var vols = BT_klineData.volumes || [];
  var dates = BT_klineData.dates;

  var set = function(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('curDate', dates[idx]);
  set('curOpen',  _fmt(ohlc[0], 2));
  set('curClose', _fmt(ohlc[1], 2));
  set('curHigh',  _fmt(ohlc[2], 2));
  set('curLow',   _fmt(ohlc[3], 2));
  // 涨跌幅
  var pct = '';
  var pctEl = document.getElementById('curPct');
  if (idx > 0 && BT_klineData.ohlc[idx - 1]) {
    var prev = BT_klineData.ohlc[idx - 1][1];
    if (prev) {
      var ch = (ohlc[1] - prev) / prev * 100;
      pct = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
      if (pctEl) pctEl.style.color = ch >= 0 ? BT_COLOR_UP : BT_COLOR_DOWN;
    }
  } else if (pctEl) {
    pctEl.style.color = '#666';
  }
  set('curPct', pct || '--');
  var volVal = vols[idx] || 0;
  set('curVol', volVal ? volVal.toLocaleString() : '--');
  // VOL5（成交量 5 日均线，包含当日，与 tooltip 一致）
  var volMa5El = document.getElementById('curVolMa5');
  if (volMa5El) {
    var volMa5Arr = BT_klineData._volMA5;
    var v5 = volMa5Arr ? volMa5Arr[idx] : null;
    volMa5El.textContent = v5 != null ? v5.toLocaleString() : '--';
  }
  // 量比 = 当日成交量 / 前 5 日均量（不含当日），idx >= 5 时计算
  var ratioEl = document.getElementById('curRatio');
  if (ratioEl) {
    var prev5Arr = BT_klineData._prev5Avg;
    var avg5 = prev5Arr ? prev5Arr[idx] : null;
    if (volVal && avg5 && idx >= 5) {
      var ratio = volVal / avg5;
      ratioEl.textContent = ratio.toFixed(2);
      // 与 tooltip 一致：≥2 放量（红）/ ≥1.5 偏多（红）/ <0.5 缩量（绿）/ <0.8 偏少（绿）
      if (ratio >= 2)        ratioEl.style.color = BT_COLOR_UP;     // 放量红
      else if (ratio >= 1.5) ratioEl.style.color = BT_COLOR_UP;     // 偏多红
      else if (ratio < 0.5)  ratioEl.style.color = BT_COLOR_DOWN;   // 缩量绿
      else if (ratio < 0.8)  ratioEl.style.color = BT_COLOR_DOWN;   // 偏少绿
      else                   ratioEl.style.color = '#666';          // 正常灰
    } else {
      ratioEl.textContent = '--';
      ratioEl.style.color = '#666';
    }
  }
  // MA（动态：按 BT_maPeriods 当前值生成 / 写值，硬编码的 curMa5/10/20/60 已废弃）
  BT_fillMaValues('curMa', 'cur', BT_klineData, idx);
  // MACD
  var m = BT_klineData.macd;
  if (m && m.dif) {
    var dif = m.dif[idx], dea = m.dea[idx], macd = m.macd[idx];
    set('curDif', _fmt(dif, 3));
    set('curDea', _fmt(dea, 3));
    var macdEl = document.getElementById('curMacdVal');
    if (macdEl) {
      macdEl.textContent = macd != null ? (macd >= 0 ? '+' : '') + macd.toFixed(3) : '--';
      macdEl.style.color = (macd != null && macd >= 0) ? BT_COLOR_UP : BT_COLOR_DOWN;
    }
  }
}

// 指数图光标位置同步显示（与主图光标 idx 对齐）
function BT_updateIndexInfo() {
  if (!BT_indexData || BT_currentIdx == null) return;
  var idx = BT_currentIdx;
  if (idx < 0 || idx >= BT_indexData.dates.length) {
    // 指数图根数不够时的兜底：用最后根
    idx = BT_indexData.dates.length - 1;
  }
  var ohlc = BT_indexData.ohlc[idx];
  var dates = BT_indexData.dates;

  var set = function(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set('idxDate',  dates[idx] || '--');
  set('idxOpen',  _fmt(ohlc[0], 2));
  set('idxClose', _fmt(ohlc[1], 2));
  set('idxHigh',  _fmt(ohlc[3], 2));
  set('idxLow',   _fmt(ohlc[2], 2));
  var pct = '';
  var pctEl = document.getElementById('idxPct');
  if (idx > 0 && BT_indexData.ohlc[idx - 1]) {
    var prev = BT_indexData.ohlc[idx - 1][1];
    if (prev) {
      var ch = (ohlc[1] - prev) / prev * 100;
      pct = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
      if (pctEl) pctEl.style.color = ch >= 0 ? BT_COLOR_UP : BT_COLOR_DOWN;
    }
  }
  set('idxPct', pct || '--');

  // 成交额（指数图后端 volumes 字段实际是 amount 万元）
  var amountVal = (BT_indexData.volumes && BT_indexData.volumes[idx]) || 0;
  var volEl = document.getElementById('idxVol');
  if (volEl) {
    volEl.innerHTML = BT_formatAmount(amountVal);
  }

  // MA（动态：跟图表 MA 周期对齐，不再写死 5/10/20/60）
  BT_fillMaValues('idxMa', 'idx', BT_indexData, idx);

  // MACD
  var m = BT_indexData.macd;
  if (m && m.dif) {
    var dif = m.dif[idx], dea = m.dea[idx], macd = m.macd[idx];
    set('idxDif', _fmt(dif, 3));
    set('idxDea', _fmt(dea, 3));
    var macdEl = document.getElementById('idxMacdVal');
    if (macdEl) {
      macdEl.textContent = macd != null ? (macd >= 0 ? '+' : '') + macd.toFixed(3) : '--';
      macdEl.style.color = (macd != null && macd >= 0) ? BT_COLOR_UP : BT_COLOR_DOWN;
    }
  }
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
  // 同步指数图（先同步 zoom 窗口 → 再同步光标位置）
  // 关键：BT_setCursor 自己 setOption 主图 dataZoom，_inDataZoomApply 屏蔽了 dataZoom 事件，
  //       所以 BT_syncIndexZoom 不会自动触发 → 必须手动调
  if (typeof BT_syncIndexZoom === 'function') BT_syncIndexZoom();
  if (typeof BT_syncIndexCursor === 'function') BT_syncIndexCursor(idx);

  BT_updateCursorDisplay();
  BT_updateIndexInfo();      // 同步指数右栏
  BT_renderStats();
  if (typeof BT_renderCustomTooltip === 'function') BT_renderCustomTooltip(idx);
}

// 应用"显示根数"变更：调整 dataZoom，不重画
// 模式：保持光标在窗口最右（pinRight），这样 +/- 后光标不会跳
// 改进：如果用户拖动过 slider（BT_userZoomRange != null），保留 start 位置只调整 end
// 注意：BT_visibleBars 已经由调用方设置好（包括 BT_renderKLine 自动扩窗逻辑），
//       这里只读 select 同步一次（用户主动改 select 时），如果值已匹配则跳过
function BT_applyVisibleBars() {
  if (!BT_chart || !BT_klineData) return;
  // 先从 select 读最新值（用户主动改 select / BT_renderKLine 自动扩窗 / +/- 后等场景）
  var selVis = BT_getVisibleBars();
  if (selVis !== BT_visibleBars) {
    BT_visibleBars = selVis;
  }
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
  // 同步指数图（窗口宽度）
  if (typeof BT_syncIndexZoom === 'function') BT_syncIndexZoom();
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

// ===== K线周期 banner（月线降级提示） =====
// 后端 count > 640 时自动降级到月线 → 在 chart 上方显示提示横幅
function BT_showPeriodBanner(msg) {
  var el = document.getElementById('btPeriodBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'btPeriodBanner';
    el.style.cssText = [
      'position: absolute',
      'top: 6px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 99',
      'background: rgba(124, 92, 255, 0.92)',
      'color: #fff',
      'padding: 4px 14px',
      'border-radius: 4px',
      'font-size: 12px',
      'font-weight: 600',
      'box-shadow: 0 2px 6px rgba(0,0,0,0.2)',
      'pointer-events: none'
    ].join(';');
    var wrap = document.querySelector('.bt-chart-wrap');
    if (wrap) {
      if (getComputedStyle(wrap).position === 'static') wrap.style.position = 'relative';
      wrap.appendChild(el);
    } else {
      document.body.appendChild(el);
    }
  }
  el.textContent = msg;
  el.style.display = 'block';
}
function BT_hidePeriodBanner() {
  var el = document.getElementById('btPeriodBanner');
  if (el) el.style.display = 'none';
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

// ==================== 大盘指数走势图（复用主图完整组件：K线 + MA + 成交量 + MACD） ====================

var BT_indexChart = null;   // 指数图表 ECharts 实例
var BT_indexData = null;    // 指数 K线数据

// 初始化指数图表：复用主图基础配置（4 grid），但只启用 K线/量/MACD（3 grid）
// 资金曲线 grid 留空但保留位置，保证 series 索引稳定
function BT_initIndexChart() {
  if (BT_indexChart) return;
  var dom = document.getElementById('btChartIndex');
  if (!dom) return;
  BT_indexChart = echarts.init(dom, null, { renderer: 'canvas' });
  var baseOption = BT_getBaseOption();
  // 调整 grid 比例：K线 300 / 量 80 / MACD 80（绝对像素，容器 480px）
  //   10 + 300 + 5 + 80 + 5 + 80 = 480，刚好填满
  baseOption.grid = [
    { left: 50, right: 20, top: 10,   height: 300 },   // K线 300px
    { left: 50, right: 20, top: 315,  height: 80 },    // 成交量 80px
    { left: 50, right: 20, top: 400,  height: 80 },    // MACD 80px
    { left: 50, right: 20, top: '100%', height: '0%' } // 资金曲线（隐藏）
  ];
  // 资金曲线 yAxis 也隐藏
  baseOption.yAxis[3] = Object.assign({}, baseOption.yAxis[3], { show: false });
  baseOption.xAxis[3] = Object.assign({}, baseOption.xAxis[3], { show: false });
  // 关键：把 dataZoom[1] slider 隐藏（height: 0 + show: false）
  //   两图共用主图的 slider 控制，指数图只显示时间轴标签
  baseOption.dataZoom[1] = Object.assign({}, baseOption.dataZoom[1], { show: false, height: 0, bottom: 0 });
  BT_indexChart.setOption(baseOption);
  // 启用指数图的自定义 tooltip
  BT_setupIndexTooltip();
}

// 渲染指数图表（接 fetchKLine 的返回数据 → K线 + MA + 成交量 + MACD）
// 与主图共用同样的 4 grid 布局、同样的 axisPointer 十字光标、同样的时间轴
function BT_renderIndexChart(data, indexName) {
  if (!BT_indexChart) BT_initIndexChart();
  if (!BT_indexChart) return;

  BT_indexData = data;
  var dates = data.dates || [];
  var ohlc = data.ohlc || [];
  var vols = data.volumes || [];
  if (dates.length === 0) return;

  // MA 4 条（与主图一致，从 BT_maPeriods 读）
  var maLines = [];
  for (var i = 0; i < 4; i++) {
    if (i < BT_maPeriods.length) {
      maLines.push({
        name: 'MA' + BT_maPeriods[i],
        type: 'line',
        data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 1, color: BT_MA_COLORS[i] },
        z: 5
      });
    } else {
      maLines.push({ name: '__MA_empty_' + i, type: 'line', data: [], showSymbol: false, z: 5 });
    }
  }

  // 成交量柱（按涨跌着色：红涨绿跌）
  var volData = vols.map(function(v, i) {
    var close = ohlc[i] ? ohlc[i][1] : 0;
    var prev  = (i > 0 && ohlc[i - 1]) ? ohlc[i - 1][1] : close;
    var isUp  = close >= prev;
    return {
      value: v,
      itemStyle: { color: isUp ? BT_COLOR_UP : BT_COLOR_DOWN }
    };
  });

  // MACD（DIF/DEA 折线 + MACD 柱）
  var macdData = data.macd || { dif: [], dea: [], macd: [] };
  var macdBarData = (macdData.macd || []).map(function(v) {
    return { value: v, itemStyle: { color: v >= 0 ? BT_COLOR_UP : BT_COLOR_DOWN } };
  });

  BT_indexChart.setOption({
    xAxis: [{ data: dates }, { data: dates }, { data: dates }, { data: dates }],
    series: [
      // K线（grid 0）
      {
        name: 'K线', type: 'candlestick', data: ohlc,
        xAxisIndex: 0, yAxisIndex: 0,
        itemStyle: {
          color: BT_COLOR_UP, color0: BT_COLOR_DOWN,
          borderColor: BT_COLOR_UP, borderColor0: BT_COLOR_DOWN
        },
        z: 2
      },
      // MA × 4（grid 0）
      maLines[0], maLines[1], maLines[2], maLines[3],
      // 成交量（grid 1）
      {
        name: '成交', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
        data: volData, z: 1
      },
      // MACD（grid 2：DIF/DEA 折线 + MACD 柱）
      {
        name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
        data: macdData.dif || [], smooth: true, showSymbol: false,
        lineStyle: { width: 1, color: '#ffd166' }, z: 3
      },
      {
        name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2,
        data: macdData.dea || [], smooth: true, showSymbol: false,
        lineStyle: { width: 1, color: '#5c7cfa' }, z: 3
      },
      {
        name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2,
        data: macdBarData, z: 1
      }
    ]
  });

  // 顶部标题
  var title = document.getElementById('indexTitle');
  if (title) title.textContent = '📈 ' + (indexName || '');

  // 同步右栏指数面板
  if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();

  // 同步缩放窗口（与主图一致）
  BT_syncIndexZoom();
}

// 同步指数图表的 dataZoom（4 grid 全部同步主图：inside + slider 隐藏）
// 两图共用主图的 slider 控制——指数图不显示自己的 slider，避免重复控件
function BT_syncIndexZoom() {
  if (!BT_indexChart || !BT_chart) return;
  if (!BT_klineData || !BT_indexData) return;
  // 主图 slider 在 dataZoom[1]
  var mainDz = BT_chart.getOption().dataZoom[1];
  if (!mainDz) return;

  // 关键：按"日期范围"对齐，而不是按 idx 比例对齐
  // 原因：主图和指数图的数据范围可能不同（API 限制 / 上市时间不同 / 缺失数据等）
  //       同样 idx 在两图里对应的日期不同 → 视觉上"日期窗口不同步"
  // 算法：在指数图里查主图 startDate/endDate 对应的 idx，按这个 idx 设 zoom
  var mainDates = BT_klineData.dates;
  var idxDates  = BT_indexData.dates;
  var mainTotal = mainDates.length;
  var idxTotal  = idxDates.length;
  if (mainTotal === 0 || idxTotal === 0) return;

  var mainStartIdx = Math.floor(mainDz.start / 100 * (mainTotal - 1));
  var mainEndIdx   = Math.floor(mainDz.end   / 100 * (mainTotal - 1));
  var mainStartDate = mainDates[mainStartIdx];
  var mainEndDate   = mainDates[mainEndIdx];

  // 二分查找：在 idxDates 中找 >= mainStartDate 的第一个 idx
  function lowerBound(arr, target) {
    var lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  // 上界：找 <= mainEndDate 的最后一个 idx
  function upperBound(arr, target) {
    var lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;  // 上取整，避免死循环
      if (arr[mid] > target) hi = mid - 1; else lo = mid;
    }
    return lo;
  }

  var idxStartIdx = lowerBound(idxDates, mainStartDate);
  var idxEndIdx   = upperBound(idxDates, mainEndDate);
  // 兜底：start 不能超过 end
  if (idxStartIdx > idxEndIdx) idxStartIdx = idxEndIdx;
  // 至少 1 根宽度
  if (idxEndIdx <= idxStartIdx) idxEndIdx = Math.min(idxTotal - 1, idxStartIdx + 1);

  // 转百分比（ECharts dataZoom 的 start/end 含义是数据范围百分比）
  var start = idxStartIdx / Math.max(1, idxTotal - 1) * 100;
  var end   = idxEndIdx   / Math.max(1, idxTotal - 1) * 100;

  BT_indexChart.setOption({
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2, 3], disabled: true,
        start: start, end: end },
      { show: false, xAxisIndex: [0, 1, 2, 3], type: 'slider',   // show: false 关键：隐藏指数图自己的 slider
        height: 0, bottom: 0,
        start: start, end: end }
    ]
  });
}

// 同步指数图光标（让指数图显示与主图一致的十字光标位置）
// 调用方：BT_setCursor（程序化移动光标）、mousemove（鼠标 hover）、updateAxisPointer
// 关键：指数图 series 顺序：K线=0, MA1=1, MA2=2, MA3=3, MA4=4, 成交=5, DIF=6, DEA=7, MACD=8
function BT_syncIndexCursor(idx) {
  if (!BT_indexChart || !BT_indexData) return;
  if (typeof idx !== 'number' || idx < 0 || idx >= BT_indexData.dates.length) return;
  // dispatchAction 触发指数图的 axisPointer 显示（与主图共享 xAxis idx 范围）
  BT_indexChart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: idx });
}

// 同步主图 + 指数图的可见根数（当主图 visibleBars 变化时）
// 调用方：BT_applyVisibleBars、用户拖动 slider
function BT_syncIndexVisibleBars() {
  if (!BT_indexChart) return;
  BT_indexChart.resize();
}
