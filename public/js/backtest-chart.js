/**
 * 回测页 — ECharts 图表（K线 + MA + 成交量 + MACD + 买卖标记）
 *
 * 单个 ECharts 实例 + 3 个 grid（xAxis 联动共享）:
 *   - 主图: 蜡烛 + MA1~MA3
 *   - 成交量 (15% 高): 红涨绿跌柱状图
 *   - MACD (25% 高): DIF/DEA 折线 + MACD 柱
 *
 * 关键设计：
 *   - 自定义均线：MA1~MA3 周期从页面输入框读取
 *   - 买卖标记：通过 markPoint 叠加，BT_refreshChartMarkers() 增量刷新
 *   - 光标：监听 'updateAxisPointer' 事件，实时把光标日期+收盘价写到底部 actionbar
 */

var BT_chart = null;            // ECharts 实例
var BT_renderCustomTooltip = null;  // 自定义 DOM tooltip 渲染函数（由 BT_setupCustomTooltip 初始化）
var BT_klineData = null;        // 当前 K 线完整数据 {dates, ohlc, volumes, ma5/10/20, macd, count, ...}
// MA 周期默认值：单一来源（HTML 里的 ma1~ma3 初始 value 需与其保持一致）
var BT_MA_DEFAULT = [5, 10, 20];
var BT_maPeriods = BT_MA_DEFAULT.slice();  // MA 周期（从输入框实时读取）
var BT_showFlags = { ma: true, vol: true };  // MACD/资金面板已按用户要求移除  // 显示开关
var BT_currentIdx = null;       // 光标所在的 K 线索引（也存 localStorage）
// 默认 90 根（与 HTML 下拉的 selected 一致）。根数只允许 90/120 两档，
// 由 BT_ALLOWED_VISIBLE_BARS 白名单校验（见下方），不再支持连续缩放。
var BT_DEFAULT_VISIBLE_BARS = 90;   // 默认可见根数（唯一来源）
var BT_visibleBars = BT_DEFAULT_VISIBLE_BARS;   // 固定显示的 K 线根数
// 窗口左右边界改用数据索引维护（BT_winStartIdx / BT_winEndIdx，见下方定义），
// 不再保存成 dataZoom 百分比。原 BT_zoomLocked / BT_userZoomRange 均已移除。
var _inDataZoomApply = false;   // 死循环保护：我们自己 setOption 时阻断 dataZoom 回调

// ===== 光标渲染的 rAF 合并 =====
// 鼠标移动事件频率远高于渲染帧率，一帧内可能触发多次（mousemove + updateAxisPointer）。
// 把"面板 + 统计 + 指数图同步"合并到下一帧只执行一次，避免同帧重复重活。
var _cursorRafId = null;
function BT_scheduleCursorRender() {
  if (_cursorRafId != null) return;   // 本帧已排期
  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (cb) { return setTimeout(cb, 16); };
  _cursorRafId = raf(function () {
    _cursorRafId = null;
    if (BT_currentIdx == null) return;
    if (typeof BT_updateCursorDisplay === 'function') BT_updateCursorDisplay();
    if (typeof BT_renderStats === 'function') BT_renderStats();
    // 同步指数图光标 + 右侧指数面板
    if (typeof BT_syncIndexCursor === 'function') BT_syncIndexCursor(BT_currentIdx);
    if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();
    // ★ 十字光标常驻：hover 结束后不再消失
    if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
  });
}

// ===== 可见窗口（用「数据索引」表达，不用百分比）=====
// 原实现把窗口存成 dataZoom 的百分比（BT_userZoomRange），再反复换算回索引，
// 每层换算都引入取整误差，导致：
//   - 光标在窗口中间时点「下一根」，窗口会跟着平移（用户要的是"先走光标，到头再动窗口"）
//   - 窗口宽度在 90/120 之间漂移，肉眼可见 K 线根数与下拉档位不一致
// 现在统一以索引维护：窗口 = [winStartIdx, winStartIdx + vis)，vis 固定 90/120。
var BT_winStartIdx = 0;        // 当前窗口左端对应的数据索引（含）
var BT_winEndIdx = 0;          // 当前窗口右端对应的数据索引（不含）
var BT_initialWindowDone = false;  // 数据首次加载后是否已初始化过窗口

/** 当前窗口可见的数据索引区间 [start, end)（end 不含） */
function BT_getWindowRange() {
  return { start: BT_winStartIdx, end: BT_winEndIdx };
}

/** 按索引窗口写 dataZoom；同时把相同窗口同步到指数图 */
function BT_applyWindow() {
  if (!BT_chart || !BT_klineData) return;
  var total = BT_klineData.dates.length;
  if (total <= 0) return;
  var vis = Math.min(BT_visibleBars, total);
  // 钳制：start 不能 < 0，end 不能超过 total，且宽度恒定 = vis
  var start = Math.max(0, Math.min(BT_winStartIdx, total - vis));
  BT_winStartIdx = start;
  BT_winEndIdx = Math.min(total, start + vis);

  var denom = Math.max(1, total - 1);
  var sPct = start / denom * 100;
  var ePct = BT_winEndIdx / denom * 100;

  _inDataZoomApply = true;
  try {
    BT_chart.setOption({ dataZoom: [{ start: sPct, end: ePct }, { start: sPct, end: ePct }] });
  } finally {
    setTimeout(function () { _inDataZoomApply = false; }, 0);
  }
  // 同步指数图的窗口（按日期对齐，见 BT_syncIndexZoom）
  if (typeof BT_syncIndexZoom === 'function') BT_syncIndexZoom();
}

/**
 * 初始化/重置可见窗口：光标钉在最右一根，窗口展示最近 vis 根。
 * 数据首次加载、切换标的、时间范围变化时调用。
 */
function BT_initWindow(cursorIdx) {
  if (!BT_klineData) return;
  var total = BT_klineData.dates.length;
  var vis = Math.min(BT_visibleBars, total);
  if (cursorIdx == null || cursorIdx < 0 || cursorIdx >= total) cursorIdx = total - 1;
  BT_currentIdx = cursorIdx;
  BT_currentDate = BT_klineData.dates[cursorIdx];
  BT_currentClose = BT_klineData.ohlc[cursorIdx][1];
  // pinRight：光标在窗口最右一根
  BT_winStartIdx = Math.max(0, Math.min(total - vis, cursorIdx - vis + 1));
  BT_applyWindow();
  BT_initialWindowDone = true;
}

/**
 * 移动光标到 targetIdx —— 「上一根 / 下一根」的唯一入口。
 *
 * ★ 窗口策略（本次重构的核心）：
 *   1. 光标在窗口内部 → 只移动光标，窗口**不动**（这样连续点按能逐根细看）
 *   2. 光标到达/越过窗口右端 → 窗口右移一根（光标始终贴在右边缘）
 *   3. 光标到达/越过窗口左端 → 窗口左移一根（光标始终贴在左边缘）
 *
 * 旧实现每次都用 pinRight 重算窗口，等于"每点一次整屏平移一根"，
 * 光标永远贴在最右边，中间 K 线一根都停不下来。
 */
function BT_moveCursorTo(targetIdx) {
  if (!BT_klineData) return;
  var total = BT_klineData.dates.length;
  if (total === 0) return;
  if (targetIdx < 0) targetIdx = 0;
  if (targetIdx > total - 1) targetIdx = total - 1;

  // 窗口未初始化（例如加载后立刻点按）→ 先按当前光标初始化
  if (!BT_initialWindowDone) {
    BT_initWindow(targetIdx);
  } else {
    BT_currentIdx = targetIdx;
    BT_currentDate = BT_klineData.dates[targetIdx];
    BT_currentClose = BT_klineData.ohlc[targetIdx][1];

    var win = BT_getWindowRange();
    // 右侧越界 → 整体右移，光标贴右缘
    if (targetIdx >= win.end) {
      BT_winStartIdx = targetIdx - Math.min(BT_visibleBars, total) + 1;
      BT_applyWindow();
    } else if (targetIdx < win.start) {
      // 左侧越界 → 整体左移，光标贴左缘
      BT_winStartIdx = targetIdx;
      BT_applyWindow();
    }
    // 其余情况：光标在窗口内 → 窗口完全不动
  }

  // 数据栏 / 统计 / 指数图 / 十字光标统一刷新
  BT_updateCursorDisplay();
  if (typeof BT_renderStats === 'function') BT_renderStats();
  if (typeof BT_syncIndexCursor === 'function') BT_syncIndexCursor(BT_currentIdx);
  if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();
  if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
  if (typeof BT_saveState === 'function') BT_saveState();
}

/**
 * 主图光标位置变更入口（hover / 两图同步共用同一条链路）
 * 只更新状态并排期渲染，不直接动 DOM —— 渲染统一收敛到下一帧。
 *
 * ★ 说明：本函数必须定义在顶层（而非 BT_initChart 内部闭包），
 *   否则指数图 hover → BT_hoverSyncFrom → 驱动主图数据栏这条链路会断开。
 */
function BT_onCursorMove(idx) {
  if (idx == null || !BT_klineData) return;
  if (!(idx >= 0 && idx < BT_klineData.dates.length)) return;
  if (idx === BT_currentIdx) return;
  BT_currentIdx = idx;
  BT_currentDate = BT_klineData.dates[idx];
  BT_currentClose = BT_klineData.ohlc[idx][1];
  BT_scheduleCursorRender();
}

// K 线显示根数：改为固定档位（只允许 90 / 120，默认 90），不再支持连续缩放。
//   ★ 原为 20~350 连续缩放（+/- 按钮 + 比例锁定），按用户要求取消，
//     因为窗口宽度固定后，"看多少根"只需两档即可，缩放反而增加误操作。
var BT_ALLOWED_VISIBLE_BARS = [90, 120];
// 保留 MIN/MAX 常量供兜底钳制（applyVisibleBars / setCursor 仍在用）
var BT_VISIBLE_BARS_MIN = 90;
var BT_VISIBLE_BARS_MAX = 120;
// BT_ZOOM_STEP 已废弃（缩放按钮移除），保留变量避免旧代码引用报错
var BT_ZOOM_STEP = 1.25;

// 从输入框读取 BT_visibleBars（仅允许档位内的值）
function BT_getVisibleBars() {
  var el = document.getElementById('btVisibleBars');
  var v = el ? parseInt(el.value) : BT_DEFAULT_VISIBLE_BARS;
  if (!v || v <= 0) return BT_DEFAULT_VISIBLE_BARS;
  // 只接受白名单档位，其余回落到默认，避免旧存档写入任意值
  return (BT_ALLOWED_VISIBLE_BARS.indexOf(v) >= 0) ? v : BT_DEFAULT_VISIBLE_BARS;
}

// 计算 zoom 范围（百分比）
// 颜色（与项目内其他图表保持一致）
var BT_COLOR_UP   = '#ef476f';  // A 股红涨
var BT_COLOR_DOWN = '#2d9f7f';  // A 股绿跌
// MA 色板按主题取值：原先固定 '#000000'，暗色主题下 MA1 线与图例全是黑色不可见。
//   共 3 条均线，配色语义（按用户指定）：
//     MA1 黑灰色   MA2 深黄色   MA3 蓝色
//   亮色主题用较深的黑/黄/蓝，暗色主题相应提亮，保证在两种背景上都清晰可辨。
//   消费点统一走 BT_maColors()，主题切换时由 BT_applyTheme 触发重绘。
function BT_maColors() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return isDark
    ? ['#CBD5E1', '#E0A800', '#5B8DEF']   // 暗色：浅灰 / 深黄提亮 / 蓝提亮
    : ['#374151', '#C99700', '#2563EB'];  // 亮色：黑灰 / 深黄 / 蓝
}

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

  // 监听光标移动 → 更新右侧 K线 数据栏
  // ★★ 实测（本页 tooltip.show=false 时）：
  //   - chart 'mousemove'：0 次触发（拿不到 dataIndex）
  //   - chart 'updateAxisPointer'：能触发，但 axesInfo 实测为空数组 []（拿不到 value）
  //     → 两者都无法驱动右侧数据栏，表现为 hover 时右栏一直是 "--"
  //   改为直接监听 **zrender 的 mousemove**，用 offsetX + convertFromPixel 自行换算索引。
  //   这与自绘十字光标（backtest-crosshair.js）用同一个数据源，两者天然同步。
  //
  // ★ 性能：鼠标移动频率远高于渲染帧率，统一收敛到一个 rAF 合并处理器，
  //   一帧内无论触发多少次，只渲染一次。

  // 主驱动：zrender mousemove → offsetX 换算索引
  // ★ 与自绘十字光标（backtest-crosshair.js）保持同一套钳制规则：
  //   鼠标落在绘图区外（y 轴刻度 / 右侧留白 / 底部滑块）时**忽略**本次移动，
  //   光标停在原位。否则 convertFromPixel 仍能换算出窗口外的索引，
  //   光标会"吸附"到不可见的 K 线上，与十字光标的实际位置对不上。
  var _zrMain = BT_chart.getZr();
  if (_zrMain && _zrMain.on) {
    _zrMain.on('mousemove', function (e) {
      var offX = e && e.offsetX;
      if (offX == null) return;
      var offY = e && e.offsetY;
      if (!BT_isInsidePlot(BT_chart, offX, offY)) return;
      var raw = BT_chart.convertFromPixel({ xAxisIndex: 0 }, offX);
      if (raw == null || isNaN(raw)) return;
      BT_onCursorMove(Math.round(raw));
    });
  }

  // 兼容兜底：若某些场景下 ECharts 事件恢复可用，仍走同一条路径
  BT_chart.on('mousemove', function (params) {
    if (params && params.dataIndex != null) BT_onCursorMove(params.dataIndex);
  });
  BT_chart.on('updateAxisPointer', function (event) {
    var xAxisInfo = event && event.axesInfo && event.axesInfo[0];
    if (xAxisInfo && xAxisInfo.value !== undefined) BT_onCursorMove(xAxisInfo.value);
  });

  // 监听用户拖动 dataZoom（slider / inside）→ 把百分比窗口换算回索引窗口
  // 缩放已取消，宽度只允许 90/120：拖动后根数会漂移，必须吸附回最近档位，
  // 否则出现"下拉框显示 90，实际显示 137 根"的不一致。
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

    var total = BT_klineData.dates.length;
    if (total <= 1) return;
    // 换算成索引窗口（对端取整，保证覆盖足量可见根）
    var startIdx = Math.max(0, Math.floor(s / 100 * (total - 1)));
    var endIdx   = Math.min(total, Math.ceil(e / 100 * (total - 1)));
    var bars = Math.max(1, endIdx - startIdx);
    // 吸附到最近的允许档位
    var snapped = BT_ALLOWED_VISIBLE_BARS[0];
    var best = Infinity;
    for (var bi = 0; bi < BT_ALLOWED_VISIBLE_BARS.length; bi++) {
      var d = Math.abs(BT_ALLOWED_VISIBLE_BARS[bi] - bars);
      if (d < best) { best = d; snapped = BT_ALLOWED_VISIBLE_BARS[bi]; }
    }
    var vis = Math.min(snapped, total);
    // 用吸附后的窗口覆盖状态，再走统一的 setOption 通道
    BT_winStartIdx = Math.max(0, Math.min(startIdx, total - vis));
    if (snapped !== BT_visibleBars) {
      BT_visibleBars = snapped;
      BT_syncVisibleBarsSelect();   // 同步下拉框显示（不触发 change）
    }
    BT_applyWindow();

    // 窗口变化时刷新买卖标记
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

  // 十字光标（自绘 canvas 覆盖层；ECharts 内置 axisPointer 在 tooltip.show=false 下不生效）
  // 4th arg：hover 索引回传 → 驱动指数图光标 + 两侧数据栏（两图同步）
  BT_attachCrosshair('btChart', BT_chart, true, function (idx) {
    BT_hoverSyncFrom(idx, 'main');
  });
}

/**
 * 计算某张图的绘图区几何信息（绘图区矩形 + 对应的数据索引区间）。
 * 十字光标覆盖层与"光标数据栏"驱动共用它，保证两边的钳制规则永远一致。
 *
 * @param {object} chart ECharts 实例
 * @param {boolean} isMain 主图（成交量在最底部）；指数图无成交量
 */
function BT_getPlotGeom(chart, isMain) {
  if (!chart) return null;
  var opt = chart.getOption();
  var grids = opt.grid || [];
  var g0 = grids[0] || { top: 18, left: 60, right: 30 };
  var gVol = grids[1];
  // 竖线底端：主图到成交量底；指数图只有 K线（grid[1] 在指数图是量，若存在则到底，否则到 K线底）
  var plotBottom;
  if (gVol && gVol.height > 0) {
    plotBottom = gVol.top + gVol.height;
  } else {
    plotBottom = g0.top + (g0.height || 0);
  }
  var width = chart.getWidth();
  var left = typeof g0.left === 'number' ? g0.left : (g0.left || 60);
  var right = typeof g0.right === 'number' ? (width - g0.right) : width - 30;
  var minIdx = chart.convertFromPixel({ xAxisIndex: 0 }, left);
  var maxIdx = chart.convertFromPixel({ xAxisIndex: 0 }, right);
  return {
    plotTop: g0.top,
    plotBottom: plotBottom,
    plotLeft: left,
    plotRight: right,
    // 绘图区左/右边界对应的数据索引：鼠标在留白处时索引会"越界"到不可见的 K 线，
    // 用它作为上下界钳制（这正是"没有 K 线的地方也出现光标"的根因）。
    minIdx: minIdx,
    maxIdx: maxIdx,
    data: (isMain ? window.BT_klineData : window.BT_indexData)
  };
}

/**
 * 判断 (offX, offY) 是否落在某张图的绘图区内（K线 + 成交量区域，不含滑块）。
 * 用在"光标数据栏"的驱动上，与十字光标覆盖层同一套规则。
 */
function BT_isInsidePlot(chart, offX, offY) {
  var g = BT_getPlotGeom(chart, chart === BT_chart);
  if (!g) return false;
  if (g.plotLeft != null && g.plotRight != null) {
    if (offX < g.plotLeft || offX > g.plotRight) return false;
  }
  if (g.plotBottom != null && offY != null && offY > g.plotBottom) return false;
  return true;
}

/**
 * 绑定十字光标并提供绘图区几何信息
 * @param {string} domId 容器 id
 * @param {object} chart ECharts 实例
 * @param {boolean} isMain 主图（成交量在最底部）；指数图无成交量，绘图区只到 K线底部
 * @param {function} [onHoverIdx] hover 出的索引回调（驱动两图同步）
 */
function BT_attachCrosshair(domId, chart, isMain, onHoverIdx) {
  if (typeof BT_crosshair === 'undefined') return;
  var hasCb = (typeof onHoverIdx === 'function');
  BT_crosshair.attach(domId, chart, function () {
    var g = BT_getPlotGeom(chart, isMain) || {};
    return {
      plotTop: g.plotTop,
      plotBottom: g.plotBottom,
      plotLeft: g.plotLeft,
      plotRight: g.plotRight,
      minIdx: g.minIdx,
      maxIdx: g.maxIdx,
      data: g.data,
      // onHoverIdx：让本图 hover 出的索引回传给共享光标状态，
      //   从而驱动另一张图的光标 + 两侧数据栏（两图互相同步）
      onHoverIdx: hasCb ? onHoverIdx : null
    };
  });
}

/**
 * 两张图共享的光标同步：任一图 hover 到某根 K 线，
 * 另一张图的光标与两侧数据栏都要跟着走。
 *
 * @param {number} idx   数据索引
 * @param {string} from  'main' | 'index' —— 事件来源图
 */
function BT_hoverSyncFrom(idx, from) {
  if (typeof idx !== 'number' || idx < 0) return;
  if (from === 'main') {
    // 主图 hover：更新主图光标状态（含两侧数据栏），并把光标同步到指数图
    if (typeof BT_onCursorMove === 'function') BT_onCursorMove(idx);
    var iIdx = BT_mapMainIdxToIndex(idx);
    if (iIdx != null) {
      BT_crosshairMoveTo('btChartIndex', iIdx);
    } else {
      BT_hideCrosshairAt('btChartIndex');
    }
  } else {
    // 指数图 hover：先把指数索引映射回主图索引（两图日期可能不同长），
    // 再走同一条主图链路，保证两侧数据栏都刷新
    var mainIdx = BT_mapIndexIdxToMain(idx);
    if (mainIdx != null) {
      if (typeof BT_onCursorMove === 'function') BT_onCursorMove(mainIdx);
      // 主图自身的光标：指数图 hover 时主图没有鼠标事件，必须显式补画
      BT_crosshairMoveTo('btChart', mainIdx);
    } else {
      // 该日期在主图数据里不存在 → 主图光标不应停留在上一根造成误导
      BT_hideCrosshairAt('btChart');
    }
    // 指数图自身的光标 + 指数右栏（用指数的 idx，映射失败也要能显示）
    BT_crosshairMoveTo('btChartIndex', idx);
    if (typeof BT_updateIndexInfo === 'function') BT_scheduleIndexInfoRender(idx);
  }
}

/**
 * 把主图索引映射为指数图索引（按日期对齐；找不到返回 null）
 */
function BT_mapMainIdxToIndex(idx) {
  if (!BT_indexData || !BT_klineData) return null;
  var d = BT_klineData.dates[idx];
  if (!d) return null;
  var i = BT_indexData.dates.indexOf(d);
  return i >= 0 ? i : null;
}

/**
 * 把指数图索引映射为主图索引（按日期对齐；找不到就返回 null）
 */
function BT_mapIndexIdxToMain(idx) {
  if (!BT_indexData || !BT_klineData) return null;
  var d = BT_indexData.dates[idx];
  if (!d) return null;
  var i = BT_klineData.dates.indexOf(d);
  return i >= 0 ? i : null;
}

/**
 * 把指定图的光标画到 idx 处（不触发数据栏更新，避免循环）
 */
function BT_crosshairMoveTo(domId, idx) {
  if (typeof BT_crosshair === 'undefined' || !BT_crosshair.drawAt) return;
  BT_crosshair.drawAt(domId, idx);
}

/** 隐藏指定图的光标 */
function BT_hideCrosshairAt(domId) {
  if (typeof BT_crosshair === 'undefined' || !BT_crosshair.hideAt) return;
  BT_crosshair.hideAt(domId);
}

/**
 * 按 BT_currentIdx 重绘两张图的光标。
 *
 * ★ 光标常驻：鼠标移出图表后不再消失（此前 globalout 会清掉覆盖层，
 *   表现为"没鼠标的时候图上什么都没有"）。这里把"光标位置"
 *   和"鼠标是否在图上"解耦 —— 只有数据变更/窗口滚动/主题切换才需要重绘。
 */
function BT_paintCrosshair() {
  if (typeof BT_crosshair === 'undefined' || BT_currentIdx == null) return;
  // 主图：光标必须落在当前窗口内，否则画出去会误导
  if (BT_klineData) {
    var win = BT_getWindowRange();
    if (BT_currentIdx >= win.start && BT_currentIdx < win.end) {
      BT_crosshairMoveTo('btChart', BT_currentIdx);
    } else {
      BT_hideCrosshairAt('btChart');
    }
  }
  // 指数图：按日期把主图索引换算过去
  if (BT_indexData && BT_klineData) {
    var iIdx = BT_mapMainIdxToIndex(BT_currentIdx);
    if (iIdx != null) {
      BT_crosshairMoveTo('btChartIndex', iIdx);
    } else {
      BT_hideCrosshairAt('btChartIndex');
    }
  }
}

// 指数右栏刷新也走 rAF 合并：与主图右栏同一帧输出，避免 hover 时两栏错帧闪烁
var _idxInfoRafId = null;
function BT_scheduleIndexInfoRender(idx) {
  if (_idxInfoRafId != null) return;
  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (cb) { return setTimeout(cb, 16); };
  _idxInfoRafId = raf(function () {
    _idxInfoRafId = null;
    if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo(idx);
  });
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
  // ★ MA 线颜色按主题取值（BT_maColors），切换主题后需重画 MA 系列才可见；
  //   只更新 MA 系列（不重拉数据），代价极小
  if (BT_klineData && BT_klineData.ohlc && BT_klineData.ohlc.length) {
    try { BT_renderMAOnly(); } catch (e) { /* 无数据时忽略 */ }
  }
  // 右栏 MA 数值文字也按主题换色
  // ★ 修复：BT_renderMaList 会**重建** DOM 行（旧节点被清空），因此必须随后回填数值，
  //   否则切换主题后右栏 MA 值会全部变成 "--"（此前漏了这一步回填）。
  try {
    BT_renderMaList('curMa', 'cur');
    BT_renderMaList('idxMa', 'idx');
    if (BT_klineData && BT_currentIdx != null) {
      BT_fillMaValues('curMa', 'cur', BT_klineData, BT_currentIdx);
    }
    if (BT_indexData && BT_currentIdx != null && BT_indexData.dates.length) {
      var _idxClamp = Math.min(BT_currentIdx, BT_indexData.dates.length - 1);
      if (_idxClamp >= 0) BT_fillMaValues('idxMa', 'idx', BT_indexData, _idxClamp);
    }
  } catch (e) { /* 无数据时忽略 */ }
  // 主题切换后图表重绘，十字光标覆盖层需按当前光标重画（常驻）
  if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
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
    },
    // 顶层 axisPointer：仅作为 hover 时的轴向提示兜底。
    // ★ 注意：本页 tooltip.show=false，ECharts 5 的 axisPointer 展示链路会因此被跳过
    //   （实测 hover 时 canvas 像素完全不变）。真正的十字光标由 BT_setupCrosshairOverlay()
    //   用独立 canvas 自绘，不依赖 ECharts 内部行为。
    axisPointer: {
      type: 'cross',
      link: { xAxisIndex: 'all' },
      show: 'auto',
      lineStyle: { color: 'rgba(128,128,128,0.5)', type: 'dashed', width: 1 },
      label: { backgroundColor: 'transparent', color: 'transparent', borderWidth: 0 }
    },
    grid: [
      { left: 60, right: 30, top: 18,   height: 300 },   // K线 300px
      { left: 60, right: 30, top: 323,  height: 60 },    // 成交量 60px（日期标签显示在其下方）
      // MACD 与资金曲线均已移除：grid[2]/grid[3] 保留占位（height 0）以维持
      // series/xAxis/yAxis 索引稳定（指数图复用本 option，按下标访问，删元素会错位）
      { left: 60, right: 30, top: 383,  height: 0 },
      { left: 60, right: 30, top: 383,  height: 0 }
    ],
    xAxis: [
      { type: 'category', data: [], gridIndex: 0, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 1, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        // ★ MACD 移除后成交量是最底部 grid，日期标签移到这里显示
        axisLabel: { show: true, color: isDark ? '#aaa' : '#666', margin: 6 },
        axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 2, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
      { type: 'category', data: [], gridIndex: 3, scale: true, boundaryGap: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false }, axisTick: { show: false }, splitLine: { show: false } }
    ],
    yAxis: [
      { gridIndex: 0, scale: true, splitArea: { show: false },
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666' },
        splitLine: { lineStyle: { color: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' } } },
      // 成交量：按用户要求不再显示纵轴数值（避免与上方价格轴标签挤在一起）
      //   仍保留 min:0 / splitNumber 以维持柱状图的缩放基准
      { gridIndex: 1, min: 0, splitNumber: 2,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { show: false },
        splitLine: { show: false } },
      // 第 3 个 yAxis 原属 MACD，现已隐藏（保留占位维持索引稳定）
      { gridIndex: 2, show: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666', fontSize: 10 },
        splitLine: { show: false } },
      // 第 4 个 yAxis 原属资金曲线，现已隐藏（保留占位维持索引稳定）
      { gridIndex: 3, show: false,
        axisLine: { lineStyle: { color: isDark ? '#555' : '#ccc' } },
        axisLabel: { color: isDark ? '#aaa' : '#666', fontSize: 10 },
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
      { show: true, xAxisIndex: [0, 1, 2, 3], type: 'slider', bottom: 6, height: 18,
        // 关键：禁用所有改窗口宽度的路径
        //   brushSelect: false → 禁用"鼠标框选调整宽度"（Ctrl+拖动框选）
        //   zoomLock: true    → 锁定窗口大小，handle 不能改宽度
        //   handle: show: false → 隐藏两端把手，物理上不可拖
        brushSelect: false,
        zoomLock: true,
        handle:     { show: false },     // 隐藏两端把手 → 无法改变窗口宽度
        moveHandle: { show: true,        // 显示中间可移动把手 → 可拖动平移窗口
                      style: { color: 'rgba(100,100,100,0.25)', borderColor: '#888', borderWidth: 1 } },
        // 固定显示窗口：默认只显示最近 60 根 K线（单根 K线 视觉宽度固定）
        // start 会在 BT_renderKLineChart 中根据数据长度动态计算
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
    if (span) span.style.color = BT_maColors()[i] || '#666';
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
      el.style.color = BT_maColors()[i] || '#666';
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
      lines.push('<div style="line-height:1.7;"><span style="color:' + BT_maColors()[i] + '">●</span> MA' + p + ': <b>' + arr[idx].toFixed(2) + '</b></div>');
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

  // MACD 已移除（原此处显示 DIF/DEA/MACD 数值）。

  // 资金曲线已移除（原此处显示"当日总资金 + 累计收益率"）。
  //   资金数据本身仍可用（统计卡里显示当前资金/收益率），只是不再进 tooltip。
  return lines.join('');
}

// 从 ohlc 数组里取收盘价序列
function BT_getCloses() {
  if (!BT_klineData) return [];
  return BT_klineData.ohlc.map(function(o) { return o[1]; });
}

// 前端计算 N 周期 MA（输入 OHLC 数组和周期 N，返回数组，前 N-1 项为 null）
// ★ 性能：该函数是 O(n)（n 最多 2500），而光标每次跨 1 根 K 线都会为每条 MA
//   （主图 4 条 + 指数图 4 条）各调一次，即每次鼠标移动重建 8 条全序列。
//   这里按「数据数组引用 + 周期」做记忆化：同一份数据只算一次，
//   换标的/换周期时数据引用变化，缓存自动失效（无需手动清理）。
var _maCache = new WeakMap();   // ohlc 数组 → { n: 结果数组 }
function BT_computeMAFromCloses(ohlc, n) {
  if (!ohlc || !ohlc.length) return [];
  var byPeriod = _maCache.get(ohlc);
  if (byPeriod && byPeriod[n]) return byPeriod[n];
  var result = new Array(ohlc.length).fill(null);
  if (ohlc.length >= n) {
    var sum = 0;
    for (var i = 0; i < n; i++) sum += ohlc[i][1];
    result[n - 1] = sum / n;
    for (var j = n; j < ohlc.length; j++) {
      sum += ohlc[j][1] - ohlc[j - n][1];
      result[j] = sum / n;
    }
  }
  if (!byPeriod) { byPeriod = {}; _maCache.set(ohlc, byPeriod); }
  byPeriod[n] = result;
  return result;
}

// BT_buildEquityCurve 已移除（资金曲线按用户要求删除）。
//   注：收益率/最大回撤的计算在 backtest-trade.js 的 BT_computeStats /
//   BT_computeRiskFromTrades 中独立实现，不依赖本函数。

// 买卖/清空/撤销后的图表与统计刷新入口。
// ★ 资金曲线已按用户要求移除，本函数不再重绘任何 series，
//   只保留"刷新统计卡 + 当前 tooltip"的职责。
//   函数名与签名保持不变——backtest-trade.js 有 5 处调用，改名会牵动多处。
function BT_refreshEquityCurve() {
  if (!BT_chart || !BT_klineData) return;
  // 刷新当前 hover 的 tooltip（OHLC/MA/MACD 仍会随交易变化间接更新）
  if (BT_currentIdx != null && typeof BT_renderCustomTooltip === 'function') {
    BT_renderCustomTooltip(BT_currentIdx);
  }
  // 刷新 stats 卡片（当前资金、总资产、收益率等仍由 BT_renderStats 计算，与图表无关）
  if (typeof BT_renderStats === 'function') BT_renderStats();
}

// 渲染 K 线主图
function BT_renderKLine(data) {
  if (!BT_chart) BT_initChart();
  BT_klineData = data;
  // 切换标的 / 重新加载 → 窗口回到默认（光标钉在窗口最右），见 BT_initWindow
  BT_initialWindowDone = false;
  // 检测是否月线降级数据（后端因接口限制自动降级）→ 显示顶部 banner
  if (data && data.__period === 'month') {
    BT_showPeriodBanner('📅 当前为月线模式（接口不支持日级 10 年，月线可展示 17+ 年长期趋势）');
  } else {
    BT_hidePeriodBanner();
  }

  // ★ BT_visibleBars 由 select 选项决定（只允许 90 / 120），不要在这里覆盖
  //   如果 select 还没初始化（页面刷新早于 BT_initUI），用默认值兜底
  var visEl = document.getElementById('btVisibleBars');
  if (visEl) {
    BT_visibleBars = parseInt(visEl.value) || BT_DEFAULT_VISIBLE_BARS;
  }
  // 吸附到允许档位：旧存档可能存着任意值（如 350），缩放已取消只能落在 90/120
  if (BT_ALLOWED_VISIBLE_BARS.indexOf(BT_visibleBars) < 0) {
    BT_visibleBars = BT_DEFAULT_VISIBLE_BARS;
  }

  var dates = data.dates;
  var ohlc  = data.ohlc;
  var vols  = data.volumes;

  // 计算 N 条 MA（数量由 BT_maPeriods 决定，支持 1-6 条）
  var closes = ohlc.map(function(o) { return o[1]; });
  var maLines = [];
  for (var i = 0; i < BT_maPeriods.length; i++) {
    maLines.push({
      name: 'MA' + BT_maPeriods[i],
      type: 'line',
      data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
      smooth: true,
      lineStyle: { width: 1.5, color: BT_maColors()[i] },
      showSymbol: false,
      z: 5
    });
  }

  // K 线 + 量 + MACD
  var klineSeries = {
    name: 'K线',
    type: 'candlestick',
    data: ohlc,
    // ★ 蜡烛宽度：此前完全交给 ECharts 自动计算，在"可见根数多"时会细到看不清——
    //   实测（绘图区约 1168px）：250 根时蜡烛体仅 2.8px、500 根 1.4px、1200 根 0.6px，
    //   视觉上就是"发虚/糊成一条线"。而缩放上限 1500 根时更细。
    //   这里给一个上限，避免少根数时蜡烛过胖；配合把缩放上限收到 500 根（见 BT_VISIBLE_BARS_MAX），
    //   保证蜡烛体宽始终 ≥ 约 2.3px（500 根时）。
    barMaxWidth: 14,
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

  // MACD 已移除（用户要求，主图与指数图都不要）：
  //   原 DIF/DEA/MACD 三个 series 不再构建。
  //   注意：grid[2]/xAxis[2]/yAxis[2] 仍保留占位（height 0 / show false），
  //   维持 series 与轴的索引稳定，指数图复用本 option 不受影响。

  // 资金曲线已移除（用户要求）：不再构建 equity series。
  //   注意：grid / xAxis / yAxis 仍保留第 4 个占位（height 0、show false），
  //   因为指数图复用 BT_getBaseOption() 并按下标访问 yAxis[3]/xAxis[3]，删掉会错位。

  // 应用到图表
  BT_chart.setOption({
    xAxis: [{ data: dates }, { data: dates }, { data: dates }, { data: dates }],
    series: [klineSeries].concat(maLines).concat([volSeries, volMA5Series])
  });

  // 显示/隐藏子图（通过 grid 的 height 控制）
  BT_updateVisibleGrids();

  // 同步底部光标 + 标记
  BT_refreshChartMarkers();

  // 初始化可见窗口：默认光标 = 最后一根（最新K线），窗口展示最近 vis 根
  BT_initWindow(BT_currentIdx);

  // 通过 dispatchAction 把 axisPointer 移到 BT_currentIdx
  BT_chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: BT_currentIdx });

  // 同步底部光标显示 + 十字光标常驻
  BT_updateCursorDisplay();
  if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
  BT_renderStats();
}

// 切换显示/隐藏子图
// 高度分配：K线 400px（主体），量 80px，MACD 120px（资金曲线已移除）
function BT_updateVisibleGrids() {
  if (!BT_chart) return;
  var showVol    = BT_showFlags.vol;

  // ★ 高度不再写死 432/300/60，而是按当前容器高度等比分配。
  //   原因：以前容器固定 432px，两张图 864px 加边距让页面总高 1474px，
  //   任何视口都要滚动才能点到交易栏的「上一根/下一根」按钮 ——
  //   用户反馈"点了没反应"，其实是点到了首屏外。
  //   现在容器高度由 BT_fitChartHeights() 按视口剩余空间设定，
  //   这里只负责把该高度拆分给 K线 / 成交量两块。
  var H = BT_chart.getHeight() || 432;
  // 预留：顶部 18（y 轴标签）+ 底部约 38（x 轴日期标签 + 底部留白）
  var TOP_PX = 18;
  var BOTTOM_PX = 38;
  var usable = Math.max(180, H - TOP_PX - BOTTOM_PX);
  var showVolPx = showVol;
  var GAP = showVolPx ? 5 : 0;
  var VOL_PX = showVolPx ? Math.round(usable * 0.16) : 0;   // 成交量约占 16%
  var KLINE_PX = usable - GAP - VOL_PX;

  var mainTop = TOP_PX;
  var volTop  = mainTop + KLINE_PX + GAP;
  var bottomY = volTop + (showVolPx ? VOL_PX : 0);

  var volGrid = showVolPx ? { left: 60, right: 30, top: volTop, height: VOL_PX }
                          : { top: mainTop + KLINE_PX, height: 0 };
  // grid[2]/grid[3] 始终 height 0（保留占位维持 series/xAxis/yAxis 索引稳定）
  var macdGrid   = { top: bottomY, height: 0 };
  var equityGrid = { top: bottomY, height: 0 };

  var grids = [
    { left: 60, right: 30, top: mainTop, height: KLINE_PX },
    volGrid,
    macdGrid,
    equityGrid
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
        lines.push('<div style="line-height:1.7;"><span style="color:' + BT_maColors()[i] + '">●</span> MA' + p + ': <b>' + arr[idx].toFixed(2) + '</b></div>');
      }
    }

    // MACD 数据已移除（用户要求）

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

// 切换 MA 周期后重画（从输入框读）
// 修改 MA 周期：保留空 slot（用户可清空），但**不**重画整个图，只更新 MA 系列 → 不动 xAxis/dataZoom/grid
function BT_updateMAPeriods() {
  var inputs = [document.getElementById('ma1'), document.getElementById('ma2'),
                document.getElementById('ma3')];
  var newPeriods = [];
  for (var i = 0; i < 3; i++) {
    var raw = inputs[i] && inputs[i].value && String(inputs[i].value).trim();
    if (!raw) continue;   // 空字符串 → 跳过（清空该 slot）
    var v = parseInt(raw);
    if (v && v > 0 && v <= 400) newPeriods.push(v);
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
  for (var i = 0; i < BT_maPeriods.length; i++) {
    allSeries.push({
      name: 'MA' + BT_maPeriods[i],
      type: 'line',
      data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
      smooth: true,
      lineStyle: { width: 1.5, color: BT_maColors()[i] },
      showSymbol: false,
      z: 5
    });
  }
  // 按 series index 合并（merge 模式默认），不重置 K线/量/MACD
  BT_chart.setOption({ series: allSeries });
  // ★ 同时刷新指数图：MA 周期变化时指数图也要按新周期重画
  if (typeof BT_indexData === 'undefined' || !BT_indexData) return;
  if (BT_indexChart && typeof BT_renderIndexChart === 'function') {
    BT_renderIndexChart(BT_indexData, document.getElementById('indexTitle') ? document.getElementById('indexTitle').textContent.replace(/^📈\s*/, '') : '');
  }
}

// 切换显示开关
function BT_toggleShowMA() {
  BT_showFlags.ma = document.getElementById('showMA').checked;
  if (BT_klineData) BT_renderKLine(BT_klineData);
}
// BT_toggleShowMACD 已移除（MACD 面板按用户要求删除）
function BT_toggleShowVol() {
  BT_showFlags.vol = document.getElementById('showVol').checked;
  BT_updateVisibleGrids();
}
// BT_toggleShowEquity 已移除（资金曲线按用户要求删除）

// 显示/隐藏大盘指数走势图（上方窗口）
// 关闭时：wrapper 隐藏，主图 K 线自动占满空间；同时取消指数数据请求（避免无意义拉数据）
// 开启时：wrapper 显示，重新拉指数 + 触发 ECharts resize
function BT_toggleShowIndex() {
  var checkbox = document.getElementById('showIndex');
  if (!checkbox) return;
  var enabled = checkbox.checked;
  var section = document.getElementById('btIndexSection');
  if (section) {
    section.style.display = enabled ? '' : 'none';
  }
  // 隐藏/显示后 ECharts 容器尺寸变化，需要 resize
  // ★ 必须先重算图表高度（指数图隐藏后主图可以独享空间），再 resize 才准确
  BT_scheduleFitChartHeights();
  if (BT_chart) {
    setTimeout(function() { BT_chart.resize(); }, 50);
  }
  if (BT_indexChart) {
    if (enabled) {
      // 开启：若未初始化则先初始化 ECharts
      if (typeof BT_initIndexChart === 'function' && !BT_indexChart) {
        BT_initIndexChart();
      }
      // 重新拉指数数据
      if (typeof BT_loadIndex === 'function') BT_loadIndex(/*silent*/ true);
    }
    setTimeout(function() { BT_indexChart.resize(); }, 50);
  } else if (enabled) {
    // BT_indexChart 还不存在（页面打开时 showIndex=false 跳过了初始化）
    if (typeof BT_initIndexChart === 'function') {
      BT_initIndexChart();
      if (typeof BT_loadIndex === 'function') BT_loadIndex(/*silent*/ true);
    }
  }
}

// ===== 图表高度自适应（保证「上一根/下一根」按钮始终在首屏内）=====
// 以前两张图各写死 432px，左列 979px，页面总高 1474px —— 任何视口都要滚动，
// 交易栏被推到首屏外，用户点按钮"没反应"（实际点在页面外）。
// 现在按视口剩余空间反算图表高度：优先保证交易栏 + 控制栏完整可见。
var BT_MIN_CHART_H = 240;      // 图表最小高度（低于此高度 K 线就看不清了）
var BT_MAX_CHART_H = 432;      // 图表最大高度（高于此宽度收益递减）
var _fitRafId = null;

function BT_fitChartHeights() {
  var wrapIdx = document.getElementById('btIndexSection');
  var domIdx = document.getElementById('btChartIndex');
  var domMain = document.getElementById('btChart');
  if (!domIdx || !domMain) return;

  // 可用高度 = 视口 - 头部 - 控制栏 - 交易栏 - 底部两个列表各自的外边距
  // 关键：左右两列的数据栏**不允许**撑高 wrap，所以这里直接把侧栏高度锁死，
  // 由 JS 设定的图表高度唯一决定布局高度。
  var vh = window.innerHeight || 800;
  var top = 0;
  var el;
  el = document.getElementById('appHeader');      if (el) top += el.getBoundingClientRect().height;
  el = document.querySelector('.bt-controlbar');  if (el) top += el.getBoundingClientRect().height + 12;
  var tradebar = document.querySelector('.bt-tradebar');
  var tradebarH = tradebar ? tradebar.getBoundingClientRect().height : 51;
  var bottom = 24 + 12;   // .bt-page 底部内边距 + .bt-main-layout 外边距

  var idxVisible = !!(wrapIdx && wrapIdx.style.display !== 'none');
  var slots = idxVisible ? 2 : 1;
  // .bt-chart-wrap 自身有 1px border + 8px padding（上下共 18px）会把图表撑高，
  // 图表设定 240px 时整个 wrap 实际 258px。这里用真实 chrome 高度修正。
  var chrome = 0;
  if (wrapIdx) {
    var cs = getComputedStyle(wrapIdx);
    var bt = parseFloat(cs.borderTopWidth) || 0;
    var bb = parseFloat(cs.borderBottomWidth) || 0;
    var pt = parseFloat(cs.paddingTop) || 0;
    var pb = parseFloat(cs.paddingBottom) || 0;
    chrome = bt + bb + pt + pb;
  }
  var mainWrap = domMain.parentNode;
  if (mainWrap && mainWrap !== wrapIdx) {
    var cs2 = getComputedStyle(mainWrap);
    chrome = Math.max(chrome, (parseFloat(cs2.borderTopWidth) || 0) + (parseFloat(cs2.borderBottomWidth) || 0) +
      (parseFloat(cs2.paddingTop) || 0) + (parseFloat(cs2.paddingBottom) || 0));
  }
  var mbIdx = wrapIdx ? (parseFloat(getComputedStyle(wrapIdx).marginBottom) || 0) : 0;
  var mbMain = mainWrap ? (parseFloat(getComputedStyle(mainWrap).marginBottom) || 0) : 0;
  var gap = mbIdx + mbMain;

  var avail = vh - top - tradebarH - bottom - gap - chrome * slots;
  var each = Math.floor(avail / slots);
  each = Math.max(BT_MIN_CHART_H, Math.min(BT_MAX_CHART_H, each));

  // 侧栏锁死到图表高度，防止内容把 wrap 撑高
  ['.bt-index-actionbar', '.bt-cursor-bar'].forEach(function (sel) {
    var bars = document.querySelectorAll(sel);
    for (var i = 0; i < bars.length; i++) {
      bars[i].style.maxHeight = each + 'px';
      bars[i].style.height = each + 'px';
    }
  });

  var changed = false;
  if (domIdx.style.height !== each + 'px') { domIdx.style.height = each + 'px'; changed = true; }
  if (domMain.style.height !== each + 'px') { domMain.style.height = each + 'px'; changed = true; }
  if (!changed) return;

  if (BT_chart) { BT_chart.resize(); BT_updateVisibleGrids(); }
  if (BT_indexChart) {
    BT_indexChart.resize();
    if (typeof BT_updateIndexGrids === 'function') BT_updateIndexGrids();
  }
  if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
}

// 防抖：resize 期间连续触发，合并到一帧
function BT_scheduleFitChartHeights() {
  if (_fitRafId != null) return;
  var raf = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : function (cb) { return setTimeout(cb, 16); };
  _fitRafId = raf(function () {
    _fitRafId = null;
    BT_fitChartHeights();
  });
}

// 窗口尺寸变化时重排
window.addEventListener('resize', function() {
  BT_scheduleFitChartHeights();
  if (BT_chart) BT_chart.resize();
  // 图表容器尺寸变了，十字光标覆盖层需同步（否则拉伸/偏移会错位）
  if (typeof BT_crosshair !== 'undefined' && BT_crosshair.redraw) BT_crosshair.redraw();
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
  // 标的名称（如 浦发银行）：加载数据时由后端返回，显示在面板标题下
  var nameEl = document.getElementById('curSymbolName');
  if (nameEl) {
    var symTxt = (typeof BT_currentSymbol !== 'undefined' && BT_currentSymbol) ? BT_currentSymbol : '';
    var nm = (typeof BT_currentSymbolName !== 'undefined' && BT_currentSymbolName) ? BT_currentSymbolName : '';
    var label = nm ? (nm + (symTxt ? ' ' + symTxt : '')) : (symTxt || '');
    nameEl.textContent = label;
  }
  set('curOpen',  _fmt(ohlc[0], 2));
  set('curClose', _fmt(ohlc[1], 2));
  // ★ ohlc 数组顺序是 [open, close, low, high]（见 server/market-quote.js:596），
  //   此前这里写反了（把 ohlc[2]=low 显示成"高"），用户会按错误的最高/最低价下单。
  //   同文件 tooltip(476) 与指数面板(1365-1366) 的取值一直是对的，只有此处错。
  set('curHigh',  _fmt(ohlc[3], 2));
  set('curLow',   _fmt(ohlc[2], 2));
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
  // MACD 面板已移除（用户要求）
}

// 指数图光标位置同步显示（默认与主图光标 idx 对齐）
// @param {number} forceIdx 明确指定的指数索引（hover 指数图时两图日期不同长，不能盲用主图 idx）
function BT_updateIndexInfo(forceIdx) {
  if (!BT_indexData || BT_currentIdx == null) return;
  var idx = forceIdx;
  if (typeof idx !== 'number' || idx < 0 || idx >= BT_indexData.dates.length) {
    // 指数图根数不够时的兜底：用最后根
    idx = Math.min(BT_currentIdx, BT_indexData.dates.length - 1);
  }
  if (idx < 0) idx = 0;
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
  // MACD 面板已移除（用户要求）
}

// 设置光标到指定索引（外部调用入口：Home/End 键、加载后定位等）
// 语义 = 移动光标 + 按需滚动窗口，与「上一根/下一根」完全同一条链路。
//
// ★★ 历史教训（保留注释，避免有人改回去）：
//    - 曾用 `if (!BT_zoomLocked)` 守卫窗口更新，取消缩放后 BT_zoomLocked 恒 true，
//      导致窗口永不滚动，用户看到"按钮失效"。
//    - 又曾改成"每次都用 pinRight 重算窗口"，光标永远贴最右，
//      中间 K 线一根都停不下来（本次重构解决的问题）。
//    现在窗口边界用索引维护，光标在窗口内时窗口完全不动。
function BT_setCursor(idx, mode) {
  if (!BT_chart || !BT_klineData) return;
  var total = BT_klineData.dates.length;
  if (total === 0) return;
  // ★ 可见根数吸附到允许档位（90 / 120）——所有窗口变更路径的必经收口点
  //   （下拉切换、拖 slider、数据加载后的自动定位）。
  //   缩放已取消：任何来源的越界值（如旧存档 350）都会被吸附回 90/120。
  if (BT_ALLOWED_VISIBLE_BARS.indexOf(BT_visibleBars) < 0) {
    BT_visibleBars = BT_DEFAULT_VISIBLE_BARS;
    BT_syncVisibleBarsSelect();
  }
  if (idx < 0) idx = 0;
  if (idx >= total) idx = total - 1;

  // 'pinRight' 是「下一根」语义；其余 mode 一概按"光标到目标位置，窗口按需滚动"处理
  BT_moveCursorTo(idx);

  BT_chart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: BT_currentIdx });
  if (typeof BT_renderCustomTooltip === 'function') BT_renderCustomTooltip(BT_currentIdx);
}

// 应用"显示根数"变更：调整窗口宽度，尽量保持光标可见
// 注意：BT_visibleBars 已由调用方设置好（select change / dataZoom 吸附），这里只负责落地
function BT_applyVisibleBars() {
  if (!BT_chart || !BT_klineData) return;
  // select change 到达时 value 已更新 → 从 select 读最新档位
  var selVis = BT_getVisibleBars();
  if (selVis !== BT_visibleBars) BT_visibleBars = selVis;
  var total = BT_klineData.dates.length;
  if (total === 0) return;
  var vis = Math.min(BT_visibleBars, total);
  if (BT_currentIdx == null) BT_currentIdx = total - 1;
  // 优先保证光标仍在窗口内；窗口尽量保持原位（不硬跳回最右）
  var start = BT_winStartIdx;
  if (BT_currentIdx < start) {
    start = BT_currentIdx;
  } else if (BT_currentIdx >= start + vis) {
    start = BT_currentIdx - vis + 1;
  }
  start = Math.max(0, Math.min(start, total - vis));
  BT_winStartIdx = start;
  BT_applyWindow();
  // 窗口宽度变了，光标覆盖层要重画
  if (typeof BT_paintCrosshair === 'function') BT_paintCrosshair();
}

// ===== 缩放已取消（按用户要求）=====
// 原 BT_zoomIn / BT_zoomOut / BT_syncVisibleBarsSelect / BT_toggleZoomLock 均移除：
//   - 显示根数只允许 90 / 120 两档，通过下拉框切换即可；
//   - 缩放按钮与比例锁定按钮已从控制栏删除，窗口宽度恒定。

// 兼容占位：若有旧代码/旧存档仍调用缩放函数，给个明确提示而不是报错
function BT_zoomIn()  { BT_toast('已取消缩放，请在「显示」里选择 90 / 120 根', 'warn'); }
function BT_zoomOut() { BT_toast('已取消缩放，请在「显示」里选择 90 / 120 根', 'warn'); }
function BT_toggleZoomLock() { /* 缩放取消后锁定恒为 true，无操作 */ }
// 兼容占位：旧的"同步下拉框"逻辑（缩放时才需要），现在只保证选中值合法
function BT_syncVisibleBarsSelect() {
  var el = document.getElementById('btVisibleBars');
  if (!el) return;
  var v = (BT_ALLOWED_VISIBLE_BARS.indexOf(BT_visibleBars) >= 0) ? BT_visibleBars : BT_DEFAULT_VISIBLE_BARS;
  BT_visibleBars = v;
  el.value = String(v);
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
    // ★ 修复：'.bt-chart-wrap' 在页面里有两个（#btIndexSection 在前，主 K 线 wrap 在后），
    //   querySelector 取第一个 → banner 会浮在指数图上方，而它描述的是主图的月线降级。
    //   改为挂在主图 canvas 的父容器上。
    var chartEl = document.getElementById('btChart');
    var wrap = chartEl ? chartEl.parentNode : null;
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
// 缩放功能已取消，锁定按钮不再存在；保留空实现避免调用点报错。
function BT_initZoomLockUI() {
  /* 缩放已取消：无锁定按钮 */
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
  // grid 高度不写死：由 BT_updateIndexGrids() 按容器实际高度拆分
  //   （以前写死 300/60，容器固定 432px，两张图把交易栏挤出首屏）
  //   MACD 已移除：grid[2] 收起；grid[3]（原资金）保持隐藏占位
  baseOption.grid = [
    { left: 50, right: 20, top: 10,   height: 300 },   // K线（随后按容器高度重算）
    { left: 50, right: 20, top: 315,  height: 60 },    // 成交量（同上）
    { left: 50, right: 20, top: 375,  height: 0 },     // MACD（隐藏占位）
    { left: 50, right: 20, top: 375,  height: 0 }      // 资金曲线（隐藏占位）
  ];
  // MACD 与资金曲线的 yAxis/xAxis 均隐藏
  baseOption.yAxis[2] = Object.assign({}, baseOption.yAxis[2], { show: false });
  baseOption.yAxis[3] = Object.assign({}, baseOption.yAxis[3], { show: false });
  baseOption.xAxis[2] = Object.assign({}, baseOption.xAxis[2], { show: false });
  baseOption.xAxis[3] = Object.assign({}, baseOption.xAxis[3], { show: false });
  // 关键：把 dataZoom[1] slider 隐藏（height: 0 + show: false）
  //   两图共用主图的 slider 控制，指数图只显示时间轴标签
  baseOption.dataZoom[1] = Object.assign({}, baseOption.dataZoom[1], { show: false, height: 0, bottom: 0 });
  BT_indexChart.setOption(baseOption);
  // 启用指数图的自定义 tooltip
  BT_setupIndexTooltip();
  // 指数图同样绑定自绘十字光标
  // 4th arg：hover 索引回传 → 驱动主图光标 + 两侧数据栏（两图同步）
  BT_attachCrosshair('btChartIndex', BT_indexChart, false, function (idx) {
    BT_hoverSyncFrom(idx, 'index');
  });
  // 按当前容器高度拆分 grid
  BT_updateIndexGrids();
}

// 指数图 grid 高度拆分（容器高度由 BT_fitChartHeights 设定）
function BT_updateIndexGrids() {
  if (!BT_indexChart) return;
  var H = BT_indexChart.getHeight() || 432;
  var TOP_PX = 10;
  var BOTTOM_PX = 34;   // x 轴日期标签 + 底部留白
  var usable = Math.max(160, H - TOP_PX - BOTTOM_PX);
  var GAP = 5;
  var VOL_PX = Math.round(usable * 0.16);
  var KLINE_PX = Math.max(80, usable - GAP - VOL_PX);
  var volTop = TOP_PX + KLINE_PX + GAP;
  BT_indexChart.setOption({
    grid: [
      { left: 50, right: 20, top: TOP_PX,  height: KLINE_PX },
      { left: 50, right: 20, top: volTop,  height: VOL_PX },
      { left: 50, right: 20, top: volTop + VOL_PX, height: 0 },
      { left: 50, right: 20, top: volTop + VOL_PX, height: 0 }
    ]
  });
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

  // MA N 条（与主图一致，从 BT_maPeriods 读）
  var maLines = [];
  for (var i = 0; i < BT_maPeriods.length; i++) {
    maLines.push({
      name: 'MA' + BT_maPeriods[i],
      type: 'line',
      data: BT_computeMAFromCloses(ohlc, BT_maPeriods[i]),
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1.5, color: BT_maColors()[i] },
      z: 5
    });
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

  // MACD 数据构建已移除（用户要求）：指数图只保留 K线 + MA + 成交量

  // ★ 显式构造 series 数组（不能用 ES6 spread：ECharts setOption 不支持）
  //   顺序：K线 → MA×N → 成交 → DIF/DEA/MACD柱
  var seriesArr = [
    // K线（grid 0）
    {
      name: 'K线', type: 'candlestick', data: ohlc,
      xAxisIndex: 0, yAxisIndex: 0,
      itemStyle: {
        color: BT_COLOR_UP, color0: BT_COLOR_DOWN,
        borderColor: BT_COLOR_UP, borderColor0: BT_COLOR_DOWN
      },
      z: 2
    }
  ];
  // MA × N（grid 0，数量由 BT_maPeriods 决定，支持 1-6 条）
  for (var _m = 0; _m < maLines.length; _m++) seriesArr.push(maLines[_m]);
  // 成交量（grid 1）
  seriesArr.push({ name: '成交', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volData, z: 1 });
  // MACD 已移除（用户要求）：指数图只保留 K线 + MA + 成交量

  BT_indexChart.setOption({
    xAxis: [{ data: dates }, { data: dates }, { data: dates }, { data: dates }],
    series: seriesArr
  });

  // 顶部标题
  var title = document.getElementById('indexTitle');
  if (title) title.textContent = '📈 ' + (indexName || '');

  // 同步右栏指数面板
  if (typeof BT_updateIndexInfo === 'function') BT_updateIndexInfo();

  // 同步缩放窗口（与主图一致）
  BT_syncIndexZoom();

  // ★ 兜底：主图尚未加载时，BT_syncIndexZoom 会直接 return（它以主图日期为锚点），
  //   导致指数图铺满全部数据（如 250 根），与「显示 90 根」的默认观感不一致。
  //   这里按当前档位根数，把指数图自行定位到"最近 N 根"。
  if (!BT_klineData) BT_pinIndexZoomToLatest();
}

// 主图无数据时：让指数图按当前显示档位定位到最近 N 根
function BT_pinIndexZoomToLatest() {
  if (!BT_indexChart || !BT_indexData) return;
  var total = BT_indexData.dates.length;
  if (total <= 1) return;
  var vis = (BT_ALLOWED_VISIBLE_BARS.indexOf(BT_visibleBars) >= 0) ? BT_visibleBars : BT_DEFAULT_VISIBLE_BARS;
  var visPct = Math.min(100, vis / (total - 1) * 100);
  var start = Math.max(0, 100 - visPct);
  _inDataZoomApply = true;
  try {
    BT_indexChart.setOption({ dataZoom: [{ start: start, end: 100 }, { start: start, end: 100 }] });
  } finally {
    setTimeout(function() { _inDataZoomApply = false; }, 0);
  }
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
// 关键：指数图 series 顺序：K线=0, MA1=1, MA2=2, MA3=3, 成交=4=8
function BT_syncIndexCursor(idx) {
  if (!BT_indexChart || !BT_indexData) return;
  if (typeof idx !== 'number' || idx < 0 || idx >= BT_indexData.dates.length) return;
  // dispatchAction 触发指数图的 axisPointer 显示（与主图共享 xAxis idx 范围）
  BT_indexChart.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: idx });
}
