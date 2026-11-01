/* ==========================================================================
 * 回测练习（Klinecharts 版） — backtest-kc.js
 * --------------------------------------------------------------------------
 * 干的事：拿项目库里的**真实历史日 K**（/api/market/kline-stock），随机截取一段，
 *        只给你看到起点之前的走势，然后你一根一根「下一根」，并当场做买卖决策，
 *        最后按 R 值结算（胜率 / 累计 R / 最大回撤），练的是「盘感 + 纪律」。
 *
 * 为什么单独一版：项目里已有 backtest.html（ECharts 多 grid 手写版）。
 *   这一版换 klinecharts v10，副图指标（VOL/MACD/KDJ/振幅）是引擎内置能力，
 *   不用自己手算公式、不用手动管理 grid 高度；用来对比两个引擎的工程量与手感。
 *
 * ★ klinecharts v10 的 4 个坑（参考 kline-replay-poc 的踩坑记录 + 本地实测）：
 *   1) 版本必须锁死：用本地 vendor/klinecharts.min.js（10.0.2）。曾出现 CDN 给到
 *      不带 setDataLoader 的旧版本 → 报 "chart.setDataLoader is not a function"。
 *   2) 光调 setDataLoader 不够！必须先 setSymbol() + setPeriod()，getBars 才会被触发。
 *      漏了这两行**不报错**，图表只是空着（默认刻度 2/6/10），很难定位。
 *   3) subscribeBar 收到的第一个参数是 params 对象（形如 { callback }），
 *      不是回调函数本身；写成 `subscribeBar: (cb) => {...}` 会拿到一个普通对象，
 *      后面调用时抛 "barPushCallback is not a function"。
 *   4) klinecharts 是「单容器多 pane」架构：所有副图都堆在 init() 绑定的那一个 DOM 里，
 *      不要给每个指标各建一个 <div>（那些容器它根本不画）。
 *   5) ★ removeIndicator 在 v10.0.2 上双向踩雷（用户反馈"副图取消选择没反应、越点越多"）：
 *        removeIndicator({ paneId }) → 恒返回 false，pane 纹丝不动；
 *        removeIndicator(paneId)     → 返回 true，但把所有 pane 一起清掉（连主图 MA 都没了）。
 *      连带 createIndicator() 的返回值也不是真实 paneId（"KDJ_xxx_1" vs 实际
 *      "indicator_pane_xxx_2"），拿它调 setPaneOptions/removeIndicator 都不匹配。
 *      对策：指标开关一律「重建图表」（paneIds 从零开始，无状态漂移）；
 *      真实 paneId 用 getIndicators() 反查（见 btkPaneIdsOf）。
 *
 * ★ 项目内特有约束：
 *   - 成交量：volumes / volumesRaw **都是「手」**（实际手数）。2026-10-24 起数据层不再提供
 *     「万手」口径 —— 万手天生要取整（1.234 万手 → 1.23 万手 → 界面 toFixed(0) 变 1），
 *     小盘股连续几天量不同却显示同一个数。界面一律直接给千分位手数（见 btkFmtVolume）。
 *   - 后端不返回成交额，所以自定义副图用「振幅(high-low)/prevClose」而不是「成交额」。
 *
 * ★ 历史数据窗口（与原版 backtest.html 共用同一条链路，口径完全一致）：
 *   - 后端 /api/market/kline-stock 的 count 上限 3500，并支持 ?from=YYYY-MM-DD。
 *   - market-quote.js 里有个「全局数据窗口」决策：任何标的落库时一律从 2016-01-04
 *     拉全量（约 2600 根）存进本地 stock_kline 表，count 只影响「返回给前端的裁剪」。
 *     所以前端选 1 年还是 10 年都是从本地库直接裁，不必回源；库未命中的标的
 *     （首次访问）会回源拉一次全量。
 *   - 年份→根数映射（BTK_YEARS_TO_COUNT）与原版 BT_YEARS_TO_COUNT 保持同规则，
 *     保证两版选「近 5 年」拿到的是同一段数据。
 *
 * ★ 复权口径（长窗口最关键的坑，实测数据）：
 *   前复权以「最新价」为基准向前缩放，多年高分红/送股会把早期价格压到 0 以下。
 *   2500 根窗口实测：格力电器 56 根负价（最低 -5.657）、贵州茅台 11 根（-13.555）、
 *   宁德时代 2 根。负价会直接毁掉止损/止盈百分比与 R 值计算，所以：
 *     - 默认 qfq（前复权）：价格贴近真实交易价，3 年以内窗口安全；长窗口会出负价 → 弹告警
 *     - hfq 是长期回测的标准口径：价格单调递增，涨跌幅真实（茅台 1727 → 9192）
 *     - raw 零负价但除权日跳空，收益率不真实，只适合看价格
 *   可选值只有上面三种（'auto' 曾作为"后端按长度择优"的选项，因与两版统一口径的要求
 *   冲突已被移除，见 BTK_ADJUST_ALLOWED）。
 *   不论选哪个口径，只要逐根检测到非正价格，页面都会弹告警条 + 一键切 hfq。
 * ========================================================================== */

/* ============================ 均线默认配置 ============================
 * 最多 6 根。周期留空 = 该根不画；颜色可以点色块改。
 *
 * ★ 为什么颜色要在前端自己定而不是用 klinecharts 的默认色板：
 *   klinecharts 的 indicator.lines 是**全局共享**的数组，MA 用完前两个颜色，
 *   副图 MACD/KDJ 就接着往后取 —— 6 根均线会把色板吃光，副图全变成兜底色。
 *   所以 MA 的线色必须通过 overrideIndicator 只作用于 candle_pane 这一个指标。
 *
 * ★ 默认色（大官人指定）：黑 / 黄 / 浅灰 / 深灰 / 浅黄 / 深黄。
 *   黑和深灰在暗色主题下几乎看不见，所以 btkMaColorForTheme() 会在暗色下
 *   把亮度不足的颜色整体提亮（保留色相），见该函数注释。
 */
var BTK_MA_COUNT = 6;
var BTK_MA_DEFAULT_PERIODS = [5, 10, 20, '', '', ''];
var BTK_MA_DEFAULT_COLORS = ['#000000', '#ffd400', '#c0c0c0', '#666666', '#ffe9a3', '#c99700'];

var BTK = {
  KC: null,                 // klinecharts 命名空间
  chart: null,              // 图表实例
  pushBar: null,            // subscribeBar 拿到的推送回调
  paneIds: {},              // 副图 key -> paneId（显示/隐藏用）
  amplRegistered: false,    // 自定义指标只允许注册一次（重复注册会抛错）
  bars: [],                 // 全量日 K（含未来，前端严格按 revealIdx 截断）
  name: '',
  symbol: '',
  dataRange: '',            // 已加载数据的日期跨度（head 里展示，如 2016-06-29 ~ 2026-10-16）
  effectiveAdjust: '',      // 后端实际采用的复权口径
  useRawVol: false,         // 本批数据是否带精确成交量（手）：量比口径开关
  // 注：预热/揭示根数只存在 BTK.settings.warmup / .future（此处曾有一份同名字段副本，
  //     从未被读取，且默认值与 settings 不一致易误导，已删）
  randomStart: true,        // 是否随机起点
  startIdx: 0,              // 练习起点（该索引之后的 K 线是"未来"）
  endIdx: 0,                // 练习终点（含）
  revealIdx: 0,             // 已揭示到哪一根（bar 数）
  position: null,           // 当前持仓
  trades: [],               // 已完成交易
  finished: false,
  finishReason: '',
  indicators: { ma: true, vol: true, macd: true, boll: false, kdj: false, ampl: false },
  // 自动播放：每 BTK_AUTO_MS 毫秒推进一根，再点一下暂停
  auto: { on: false, timer: null },
  searchSeq: 0,
  settings: {
    symbol: 'sh600519', years: 10, adjust: 'qfq', warmup: 90, future: 60,
    amount: 200000, stopPct: 7, targetR: 2, randomStart: true,
    // 均线：周期与颜色一一对应，留空字符串 = 该根不显示
    maPeriods: BTK_MA_DEFAULT_PERIODS.slice(),
    maColors: BTK_MA_DEFAULT_COLORS.slice()
  }
};

// ===== 年份 → K 线根数 映射（与原版 backtest.html 的 BT_YEARS_TO_COUNT 保持一致）=====
// 约 250 个交易日/年。后端 /api/market/kline-stock 的 count 上限是 3500，
// 本地库统一保存 2016-01-04 起至今（约 2600 根），所以 10 年（2500）完全够用。
var BTK_YEARS_TO_COUNT = { '1': 250, '2': 500, '3': 750, '5': 1200, '7': 1750, '8': 2000, '10': 2500 };
var BTK_DEFAULT_YEARS = 10;

// ===== 复权口径约束（长周期回测的关键）=====
// 前复权以「最新价」为基准向前缩放，多年高分红/送股会把早期价格压到 0 以下。
// 实测（2500 根窗口）：格力 56 根负价、茅台 11 根、宁德 2 根 —— 负价会让
// 止损/止盈百分比与 R 值计算完全失效。
// 默认给 qfq（价格贴近真实交易价），但不靠"口径白名单"做拦截 ——
// 判定标准是**逐根检测非正价格**（见 btkLoadBars 的 negCount），
// 这样任何口径、任何标的只要真出负价都会被告警，不依赖对某个口径的预判。

var BTK_STORE_KEY = 'btk_settings';
var BTK_RECENT_KEY = 'btk_recent_symbols';

// 常见标的（全局搜索用，纯前端、不走网络）
var BTK_COMMON = [
  ['sh600519', '贵州茅台'], ['sh601318', '中国平安'], ['sh600036', '招商银行'],
  ['sh601899', '紫金矿业'], ['sh600030', '中信证券'], ['sh601138', '工业富联'],
  ['sz000001', '平安银行'], ['sz000858', '五粮液'], ['sz300750', '宁德时代'],
  ['sz002594', '比亚迪'], ['sz300059', '东方财富'], ['sz000651', '格力电器'],
  ['sh510300', '沪深300ETF'], ['sh588000', '科创50ETF']
];

/* ============================ 小工具 ============================ */

function $k(id) { return document.getElementById(id); }

function btkLog(msg, type) {
  var el = $k('btkLog');
  if (!el) return;
  var line = document.createElement('div');
  if (type) line.className = 'btk-log-' + type;
  var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = '[' + t + '] ' + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}

function btkFmt(v, d) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(d === undefined ? 2 : d);
}
function btkMoney(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '-') + Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + ' 元';
}
/** 纯金额（无正负号、带千分位）——用于"1 手需 xx 元"这类描述 */
function btkYuan(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Math.abs(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}
function btkR(v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + 'R';
}
function btkCls(v) { return v > 0 ? 'btk-up' : (v < 0 ? 'btk-down' : ''); }

function btkToast(msg, type) {
  if (typeof showToast === 'function') { showToast(msg, type || 'info'); }
  else { btkLog(msg, 'warn'); }
}

/** 带鉴权的取数（authFetch 由 sync.js 提供；拿不到就手工加 Authorization） */
function btkFetch(url) {
  if (typeof authFetch === 'function') return authFetch(url);
  var token = '';
  try { token = localStorage.getItem('sync_token') || ''; } catch (e) {}
  return fetch(url, { headers: token ? { 'Authorization': 'Bearer ' + token } : {} });
}

/* ============================ 图表引擎 ============================ */

function btkEnsureLib() {
  if (window.klinecharts && typeof window.klinecharts.init === 'function') {
    BTK.KC = window.klinecharts;
    // ★ klinecharts v10 把 version 暴露成**函数**（() => "10.0.2"），不是字符串，
    //   直接拼进日志会打出 "function(){return\"10.0.2\"}" 这种鬼东西
    var v = BTK.KC.version;
    BTK.libVersion = (typeof v === 'function' ? v() : v) || '10.x';
    return true;
  }
  var box = $k('btkLibError');
  if (box) box.style.display = 'block';
  btkLog('klinecharts 未加载：检查 vendor/klinecharts.min.js 是否 404', 'err');
  return false;
}

/** 自定义副图：振幅（后端不返回成交额，用振幅代替，同样是判断情绪的重要指标） */
function btkEnsureAmplIndicator() {
  if (BTK.amplRegistered) return;
  try {
    BTK.KC.registerIndicator({
      name: 'AMPL',
      shortName: '振幅',
      series: 'normal',
      figures: [{ key: 'ampl', title: '振幅: ', type: 'line', precision: 2 }],
      calc: function (dataList) {
        return dataList.map(function (d, i) {
          var prev = i > 0 ? dataList[i - 1].close : d.open;
          var v = prev ? (d.high - d.low) / prev * 100 : 0;
          return { ampl: Number(v.toFixed(2)) };
        });
      }
    });
    BTK.amplRegistered = true;
    btkLog('自定义副图「振幅」注册成功', 'ok');
  } catch (e) {
    btkLog('注册「振幅」指标失败: ' + e.message, 'err');
  }
}

/** 主题样式（跟随项目 app_theme，A 股红涨绿跌） */
function btkStyles() {
  var dark = document.documentElement.getAttribute('data-theme') === 'dark';
  var up = '#ef476f', down = '#2d9f7f';
  var grid = dark ? '#2a2f3a' : '#eef1f5';
  var text = dark ? '#9aa4b2' : '#8b95a5';
  var line = dark ? '#3a4150' : '#dfe4ec';
  return {
    grid: {
      show: true,
      horizontal: { color: grid, size: 1, style: 'dashed' },
      vertical: { color: grid, size: 1, style: 'dashed' }
    },
    candle: {
      type: 'candle_up_stroke',            // 涨空白心、跌实心（A 股习惯）
      bar: {
        upColor: up, downColor: down, noChangeColor: '#8c8c8c',
        upBorderColor: up, downBorderColor: down,
        upWickColor: up, downWickColor: down
      },
      priceMark: {
        last: { upColor: up, downColor: down, noChangeColor: '#8c8c8c', text: { color: '#ffffff' } }
      },
      // 默认常驻的 OHLC 图例和我们顶部自己那行重复，改成划过才显示
      tooltip: { showRule: 'follow_cross', text: { color: dark ? '#e6e8ee' : '#1f2430' } }
    },
    indicator: {
      bars: [{ style: 'fill', upColor: up, downColor: down, noChangeColor: '#8c8c8c' }],
      lines: [{ color: '#e6a23c' }, { color: '#a463f2' }, { color: '#3d7dff' }, { color: '#8b90a5' }, { color: '#01c5c4' }],
      tooltip: { showRule: 'follow_cross', text: { color: dark ? '#e6e8ee' : '#1f2430' } }
    },
    xAxis: { axisLine: { color: line }, tickLine: { color: line }, tickText: { color: text, size: 11 } },
    yAxis: { axisLine: { color: line }, tickLine: { color: line }, tickText: { color: text, size: 11 } },
    separator: { color: line },
    crosshair: {
      horizontal: { line: { color: dark ? '#6b7280' : '#9aa4b2', style: 'dashed' }, text: { color: dark ? '#e6e8ee' : '#1f2430' } },
      vertical: { line: { color: dark ? '#6b7280' : '#9aa4b2', style: 'dashed' }, text: { color: dark ? '#e6e8ee' : '#1f2430' } }
    }
  };
}

function btkToBar(b) {
  return { timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
}

/* ============================ 均线设置 ============================ */

/**
 * 暗色主题下把过暗的线色提亮。
 *
 * 「默认黑色」在浅色主题上是标准配置，但暗色主题下纯黑画在 #1a1d24 的底上
 * 等于没有这根线 —— 用户会以为设置没生效。所以暗色下按固定映射替换，
 * 映射不上的自定义深色统一提到浅灰（宁可颜色不完全是用户选的，也不能看不见）。
 */
var BTK_MA_DARK_MAP = {
  '#000000': '#e6e8ee',   // 黑 → 亮灰（暗底上最醒目的那一档）
  '#666666': '#9aa4b2',   // 深灰 → 中灰
  '#c99700': '#e0a800'    // 深黄 → 提亮一档（与 ECharts 版暗色约定一致）
};

function btkMaColorForTheme(hex) {
  var h = String(hex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(h)) return '#888888';
  if (document.documentElement.getAttribute('data-theme') !== 'dark') return h;
  if (BTK_MA_DARK_MAP[h]) return BTK_MA_DARK_MAP[h];
  var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.3 ? '#d0d6e0' : h;
}

/** 读界面上的 6 组（色块 + 周期）→ { periods: [5,10,20,'','',''], colors: [...] } */
function btkMaReadUI() {
  var periods = [], colors = [];
  for (var i = 0; i < BTK_MA_COUNT; i++) {
    var pEl = $k('btkMaP' + i);
    var cEl = $k('btkMaColor' + i);
    var v = parseInt(pEl && pEl.value, 10);
    // 空 / 0 / 非数字 → 该根不画。上限 500：防止把 5 误打成 5000，那样线会变成一条死平的直线
    periods.push(v > 0 ? Math.min(500, v) : '');
    colors.push((cEl && cEl.value) || BTK_MA_DEFAULT_COLORS[i]);
  }
  return { periods: periods, colors: colors };
}

/** 把 settings 里的均线配置回填到界面（boot / 换主题后调） */
function btkMaFillUI() {
  var s = BTK.settings;
  var ps = Array.isArray(s.maPeriods) ? s.maPeriods : BTK_MA_DEFAULT_PERIODS;
  var cs = Array.isArray(s.maColors) ? s.maColors : BTK_MA_DEFAULT_COLORS;
  for (var i = 0; i < BTK_MA_COUNT; i++) {
    var pEl = $k('btkMaP' + i);
    if (pEl) {
      var v = parseInt(ps[i], 10);
      pEl.value = v > 0 ? v : '';
    }
    var cEl = $k('btkMaColor' + i);
    var c = String(cs[i] || '');
    if (cEl && /^#[0-9a-f]{6}$/i.test(c)) cEl.value = c.toLowerCase();
  }
}

/** 当前生效的周期数组（只含有值的那些，最多 6 个） */
function btkMaCalcParams() {
  var ps = BTK.settings.maPeriods || [];
  var out = [];
  for (var i = 0; i < ps.length; i++) {
    var v = parseInt(ps[i], 10);
    if (v > 0) out.push(Math.min(500, v));
  }
  return out.length ? out : [5, 10, 20];
}

/**
 * 当前生效的线色数组 —— 必须与 btkMaCalcParams() 一一对应。
 * ★ 注意按「有值的索引」过滤：用户可能只填第 2、4 根（空 1、3、5），
 *   此时颜色也要取第 2、4 个，不能简单 slice(0, n)，否则色会错位。
 */
function btkMaLineStyles() {
  var ps = BTK.settings.maPeriods || [];
  var cs = BTK.settings.maColors || [];
  var out = [];
  for (var i = 0; i < ps.length; i++) {
    if (parseInt(ps[i], 10) > 0) {
      out.push({ color: btkMaColorForTheme(cs[i] || BTK_MA_DEFAULT_COLORS[i]), size: 1 });
    }
  }
  return out.length ? out : [{ color: '#888888', size: 1 }];
}

/**
 * 只更新主图 MA 的样式/参数，不重建整个图表（改颜色时用）。
 *
 * ★ 为什么不看返回值：实测 10.0.2 的 overrideIndicator 明明改成功了
 *   （读回指标 calcParams/lineColors 都是新值），返回的却是 false ——
 *   照返回值判断会白跑一次 btkInitChart()，日志里出现成对的
 *   「图表初始化完成」+「均线已更新」，视图也被弹回最新。
 *   这里以「调用没抛异常」为准，改周期那条路另外强制走重建（保证指标重算）。
 *
 * @returns {boolean} 是否已就地更新（false = 调用方该重建）
 */
function btkApplyMaToChart() {
  if (!BTK.chart || !BTK.indicators.ma) return false;
  try {
    BTK.chart.overrideIndicator({
      name: 'MA',
      paneId: 'candle_pane',
      calcParams: btkMaCalcParams(),
      styles: { lines: btkMaLineStyles() }
    });
    return true;
  } catch (e) {
    btkLog('更新均线失败: ' + e.message, 'warn');
    return false;
  }
}

/**
 * 真正的应用动作（防抖后执行）。
 * 判断"周期有没有变"是拿**图表里当前指标**的 calcParams 比，而不是比 settings ——
 * settings 在 btkApplyMa 里已经写成新值了，跟自己比永远相等。
 */
function btkApplyMaNow() {
  if (!BTK.chart || !BTK.bars.length) return;
  var params = btkMaCalcParams();
  var curArr = [];
  try {
    var list = BTK.chart.getIndicators({ paneId: 'candle_pane' }) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === 'MA') {
        curArr = (list[i].calcParams || []).map(function (p) { return Array.isArray(p) ? p[0] : p; });
        break;
      }
    }
  } catch (e) { /* 读不到就当周期变了，走重建 */ }

  if (curArr.join(',') !== params.join(',')) {
    // 周期变了 → 重建：override 只换参数，指标曲线不一定重算
    btkInitChart();
  } else {
    // 只改了颜色 → 就地 override，不动视图
    btkApplyMaToChart();
  }
  btkLog('均线已更新：' + params.join(' / ') + '（共 ' + params.length + ' 根）', 'ok');
  btkRenderChips();   // 底部 MA 开关按钮的文字跟着变
}

var _btkMaTimer = null;

/** 界面改动 → 立刻存 settings（防刷新丢）→ 防抖后应用到图表 */
function btkApplyMa() {
  var cfg = btkMaReadUI();
  BTK.settings.maPeriods = cfg.periods;
  BTK.settings.maColors = cfg.colors;
  btkSaveSettings();
  // 防抖 200ms：用户连着改 6 个输入框时只重建一次，
  // 否则每改一个都重建 → 视图被反复弹回最新、日志刷 6 行
  if (_btkMaTimer) clearTimeout(_btkMaTimer);
  _btkMaTimer = setTimeout(function () {
    _btkMaTimer = null;
    btkApplyMaNow();
  }, 200);
}

/**
 * 初始化（或重建）图表。
 * 重建是刻意的：klinecharts 的主图叠加指标（MA/BOLL）增删 API 不如副图稳妥，
 * 图便宜且确定 —— 反正数据是从本地 slices 里即刻拿到的，重建耗时 < 100ms。
 */
function btkInitChart() {
  if (!BTK.KC) return;
  if (BTK.chart) {
    try { BTK.KC.dispose('btkPane'); } catch (e) { /* 忽略 */ }
    BTK.chart = null;
  }
  var el = $k('btkPane');
  if (!el) return;
  el.innerHTML = '';
  BTK.paneIds = {};
  BTK.pushBar = null;
  btkEnsureAmplIndicator();

  try {
    BTK.chart = BTK.KC.init(el);
  } catch (e) {
    btkLog('klinecharts.init 失败: ' + e.message, 'err');
    return;
  }
  try { BTK.chart.setStyles(btkStyles()); } catch (e) { btkLog('setStyles 失败: ' + e.message, 'warn'); }

  // ★ 成交量纵轴要显示「实际手数」，不是 K/M 缩写。
  //   内置 VOL 指标的定义里写死了 `shouldFormatBigNumber: true`，klinecharts 会把
  //   244370 缩成 "240K" —— 这正是用户不想要的（既不是手数也不精确）。
  //   唯一的开关是 chart.setFormatter({ formatBigNumber })，因为它只在 shouldFormatBigNumber
  //   为 true 时才会被调用，替换掉就等于让缩写失效。
  //   注意：setFormatter 是"合并"语义（c(this._formatter, t)），但为防未来版本改成整体替换，
  //   这里把 formatDate / formatExtendText 原样回填，只换 formatBigNumber。
  try {
    var fmt0 = (typeof BTK.chart.getFormatter === 'function') ? BTK.chart.getFormatter() : null;
    BTK.chart.setFormatter({
      formatDate: fmt0 && fmt0.formatDate,
      formatExtendText: fmt0 && fmt0.formatExtendText,
      formatBigNumber: function (v) {
        var n = Number(v);
        if (!isFinite(n)) return String(v);
        // 手数是整数，千分位即可；不缩写、不换单位、不丢精度
        return Math.round(n).toLocaleString('zh-CN');
      }
    });
  } catch (e) { btkLog('设置成交量数字格式失败: ' + e.message, 'warn'); }

  // 主图（candle_pane）：MA 默认开，BOLL 可选
  // ★ MA 的周期与线色都来自「均线设置」（最多 6 根）。线色必须在这里按指标覆盖，
  //   不能靠 btkStyles() 的全局 indicator.lines —— 那是副图 MACD/KDJ 共用的色板，
  //   6 根均线会把色板吃光，副图就全变成兜底色了。
  if (BTK.indicators.ma) {
    var maParams = btkMaCalcParams();
    var maLines = btkMaLineStyles();
    try {
      BTK.chart.createIndicator({
        name: 'MA', paneId: 'candle_pane',
        calcParams: maParams,
        styles: { lines: maLines }
      }, true);
      // 补一次 override：createIndicator 上带的 styles 在部分 10.x 版本里不写入
      // 指标实例（走的是模板默认样式），这一步幂等，代价可忽略。
      BTK.chart.overrideIndicator({ name: 'MA', paneId: 'candle_pane', styles: { lines: maLines } });
    } catch (e) {
      btkLog('创建 MA 失败: ' + e.message, 'err');
    }
  }
  if (BTK.indicators.boll) {
    try { BTK.chart.createIndicator({ name: 'BOLL', paneId: 'candle_pane', calcParams: [20, 2] }, true); }
    catch (e) { btkLog('创建 BOLL 失败: ' + e.message, 'err'); }
  }
  // 主图（K 线）高度 320px
  try { BTK.chart.setPaneOptions({ id: 'candle_pane', height: 320 }); } catch (e) {}

  // ★ 必须先告诉图表「看哪个标的、哪个周期」，否则下面的 getBars 不会被触发（不报错，只是空白）
  try {
    BTK.chart.setSymbol({ ticker: BTK.symbol || 'PRACTICE' });
    BTK.chart.setPeriod({ span: 1, type: 'day' });
  } catch (e) {
    btkLog('setSymbol/setPeriod 异常: ' + e.message, 'err');
  }

  if (typeof BTK.chart.setDataLoader !== 'function') {
    btkLog('实例上没有 setDataLoader —— klinecharts 版本不对（需要 10.x）', 'err');
    return;
  }
  BTK.chart.setDataLoader({
    // ★ 只给到 revealIdx：这是"不能看未来"的唯一保证，所有渲染/统计都基于这个截断
    getBars: function (params) {
      params.callback(BTK.bars.slice(0, BTK.revealIdx).map(btkToBar));
    },
    // ★ 第一个参数是 params 对象，不是回调本身
    subscribeBar: function (params) { BTK.pushBar = params.callback; },
    unsubscribeBar: function () { BTK.pushBar = null; }
  });

  // hover 提示（涨跌幅 / 量比）：内置 tooltip 内容不可定制，自己订阅十字光标事件铺 DOM 浮层
  try {
    BTK.chart.subscribeAction('onCrosshairChange', function (data) { btkOnCrosshair(data); });
  } catch (e) { btkLog('订阅十字光标事件失败: ' + e.message, 'warn'); }

  btkApplySubPanes();
  btkScrollToLatest();
  btkMarkStart();
  btkLog('图表初始化完成（已揭示 ' + BTK.revealIdx + ' 根）', 'ok');
}

/**
 * 在图上标出本局起点。
 * 为什么需要：起点右侧是未揭示的未来（画不出来），所以图表**永远右对齐到起点** ——
 * 每次重开构图都长一个样，用户会觉得"随机起点不够随机"（实测 15 次跨越 2017~2026，其实很均匀）。
 * 画一条竖线 + 文字标签，把"我这次站在哪一根"变成看得见的东西。
 * ★ 图表重建会清空所有 overlay，所以每次 btkInitChart 之后都要重画。
 */
function btkMarkStart() {
  if (!BTK.chart || !BTK.bars.length) return;
  var bar = BTK.bars[BTK.startIdx];
  if (!bar) return;
  // 只画竖线：文字标签交给 head 里的 .btk-start-badge
  //（klinecharts 的 simpleAnnotation 在 v10.0.2 实测不渲染文字，试过补 value 也不行）
  try {
    BTK.chart.createOverlay({
      name: 'verticalStraightLine',
      points: [{ timestamp: bar.timestamp }],
      styles: { line: { color: '#e6a23c', size: 1.5, style: 'dashed', dashedValue: [4, 4] } },
      lock: true
    });
  } catch (e) { btkLog('起点竖线绘制失败: ' + e.message, 'warn'); }
}

/* ============================ hover 指标：涨跌幅 / 量比 ============================ */

/**
 * 取第 i 根的成交量（用于量比）。
 * ★ 后端已统一口径：volume 与 volumeRaw **都是「手」**（2026-10-24 起不再有「万手」字段）。
 *   保留 useRawVol 只是为了兼容「老接口返回的 volume 还是万手」这个历史分支，
 *   新数据两个字段恒等，取哪个都一样。
 */
function btkVolAt(i) {
  var b = BTK.bars[i];
  if (!b) return 0;
  return BTK.useRawVol ? (b.volumeRaw || 0) : (b.volume || 0);
}

/** 成交量格式化：**实际手数**，千分位，不换单位、不四舍五入。
 *
 * ★ 为什么不再转「万手」：
 *   万手这个单位天生要取整（1.234 万手 只能写 1.23 万手，再 toFixed(0) 就成了 1 万手），
 *   小盘股连续几天成交量完全不同却显示成同一个数，看起来像数据坏了。
 *   用户明确要求「用实际手数做单位」，所以这里直接给 45,638 手，一位不丢。
 */
function btkFmtVolume(bar) {
  if (!bar) return '—';
  var hand = Math.round(bar.volumeRaw > 0 ? bar.volumeRaw : (bar.volume || 0));
  if (!(hand > 0)) return '—';
  return hand.toLocaleString('zh-CN') + ' 手';
}

/** 量比 = 当日成交量 / 前 5 日成交量均值（不含当日） */
function btkVolumeRatio(i) {
  if (!BTK.bars.length || i < 5) return null;
  var cur = btkVolAt(i);
  if (!(cur > 0)) return null;
  var sum = 0, n = 0;
  for (var k = i - 5; k < i; k++) {
    var v = btkVolAt(k);
    if (v > 0) { sum += v; n++; }
  }
  if (!n) return null;
  var avg = sum / n;
  return avg > 0 ? cur / avg : null;
}

/**
 * 十字光标 hover 时的额外提示（涨跌幅 / 量比）。
 * 为什么自己画：klinecharts v10.0.2 的内置 tooltip 内容无法定制
 * （没有 formatTooltip / setCustomApi 这类钩子），只能订阅 onCrosshairChange 后铺一层 DOM 浮层。
 * 该事件只给 {x, y, paneId}，数据索引要用 convertFromPixel 从像素反算。
 */
function btkOnCrosshair(pt) {
  var el = $k('btkHoverTip');
  if (!el) return;
  // 只在主图（K 线 pane）显示；移到副图 / 离开图表就隐藏
  if (!pt || !BTK.bars.length || (pt.paneId && pt.paneId !== 'candle_pane')) {
    el.style.display = 'none';
    return;
  }
  var info = null;
  try {
    info = BTK.chart.convertFromPixel({ x: pt.x, y: pt.y }, { paneId: 'candle_pane' });
  } catch (e) { info = null; }
  if (!info || info.dataIndex == null || info.dataIndex < 0) { el.style.display = 'none'; return; }

  var i = info.dataIndex;
  var bar = BTK.bars[i];
  if (!bar) { el.style.display = 'none'; return; }

  var prev = i > 0 ? BTK.bars[i - 1] : null;
  var pct = (prev && prev.close > 0) ? (bar.close - prev.close) / prev.close * 100 : null;
  var vr = btkVolumeRatio(i);

  el.innerHTML =
    '<div class="btk-ht-row"><span class="btk-ht-k">日期</span><b>' + bar.date + '</b></div>' +
    '<div class="btk-ht-row"><span class="btk-ht-k">涨跌幅</span>' +
      (pct == null ? '<b>—</b>'
        : '<b class="' + btkCls(pct) + '">' + (pct >= 0 ? '+' : '') + btkFmt(pct) + '%</b>') +
    '</div>' +
    '<div class="btk-ht-row"><span class="btk-ht-k">成交量</span><b>' + btkFmtVolume(bar) + '</b></div>' +
    '<div class="btk-ht-row"><span class="btk-ht-k">量比</span>' +
      (vr == null ? '<b title="前 5 日数据不足">—</b>'
        : '<b class="' + btkCls(vr - 1) + '" title="当日成交量 / 前 5 日均量">' + btkFmt(vr) + '</b>') +
    '</div>';
  el.style.display = 'block';

  // 定位：跟随光标，靠近右/下边界时翻转，避免溢出容器
  var wrap = el.parentElement;
  var pane = $k('btkPane');
  var ox = pane ? pane.offsetLeft : 0, oy = pane ? pane.offsetTop : 0;
  el.style.left = '0px'; el.style.top = '0px';
  var w = el.offsetWidth, h = el.offsetHeight;
  var x = ox + pt.x + 16, y = oy + pt.y + 14;
  if (x + w > wrap.clientWidth - 4) x = ox + pt.x - w - 16;
  if (x < 4) x = 4;
  if (y + h > wrap.clientHeight - 4) y = wrap.clientHeight - h - 4;
  if (y < 4) y = 4;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

/**
 * 反查某个指标的真实 paneId。
 * ★ 坑：createIndicator() 的返回值（形如 "KDJ_1792157635059_1"）**不是**真实 paneId，
 *   真实 paneId 形如 "indicator_pane_1792157635059_2"。拿返回值去 setPaneOptions/removeIndicator
 *   都不匹配，所以必须创建后从 getIndicators() 里反查。
 */
function btkPaneIdsOf(name) {
  try {
    return (BTK.chart.getIndicators() || [])
      .filter(function (it) { return it && it.name === name && it.paneId; })
      .map(function (it) { return it.paneId; });
  } catch (e) { return []; }
}

/**
 * 副图增删（VOL / MACD / KDJ / 振幅）。
 * ★ v10.0.2 的 removeIndicator 双向踩雷（实测）：
 *     - removeIndicator({ paneId }) → 恒返回 false，pane 纹丝不动（"取消选择没反应"）
 *     - removeIndicator(paneId)     → 返回 true，但会把**所有** pane 一起清掉（连主图 MA 都没了）
 *   而旧代码在移除"看似成功"后照常 delete paneIds[key]，状态与实际 pane 漂移，
 *   于是关不掉 + 再点开启又新建 → 副图越点越多。
 *   本函数只在"图表刚重建、paneIds 为空"的场景下调用（见 btkToggleIndicator），
 *   所以只走创建分支，不依赖那个不靠谱的 removeIndicator。
 */
function btkApplySubPanes() {
  if (!BTK.chart) return;
  // 副图定义。
  // ★ vol 只要一根 MA5：klinecharts 内置 VOL 默认是 MA5/10/20 三根均线，
  //   副图本来就矮，三根线挤在一起既看不清也影响量柱辨识；量能的常用看法就是
  //   「今天比 5 日均量放了多少」，一根 MA5 足够。传 calcParams:[5] 即只算一根。
  //   其余用内置默认参数，AMPL 是自注册指标、不认 calcParams（见 btkEnsureAmplIndicator）。
  var defs = [
    { key: 'vol', name: 'VOL', calcParams: [5] },
    { key: 'macd', name: 'MACD' },
    { key: 'kdj', name: 'KDJ' },
    { key: 'ampl', name: 'AMPL' }
  ];
  for (var i = 0; i < defs.length; i++) {
    var key = defs[i].key, name = defs[i].name, calcParams = defs[i].calcParams;
    var on = !!BTK.indicators[key];
    var cur = BTK.paneIds[key];
    if (on && !cur) {
      try {
        var before = btkPaneIdsOf(name);
        BTK.chart.createIndicator(calcParams ? { name: name, calcParams: calcParams } : name);
        var after = btkPaneIdsOf(name);
        // 取本次新增的那个 paneId（同名指标只会有一次新增）
        var realId = after.filter(function (x) { return before.indexOf(x) < 0; })[0] || null;
        BTK.paneIds[key] = realId;
        if (realId) BTK.chart.setPaneOptions({ id: realId, height: 100 });
      } catch (e) { btkLog('创建副图 ' + name + ' 失败: ' + e.message, 'err'); }
    } else if (!on && cur) {
      // 正常流程不会走到这里（切换一律重建图表）。保留保守处理：
      // 不移除、也不 delete —— 宁可不生效，也不能让 paneIds 与实际状态漂移（那会越点越多）。
      btkLog('副图 ' + name + ' 需要移除但未处理，请改用 btkInitChart() 重建', 'warn');
    }
  }
}

/**
 * 切换指标开关。
 * ★ 统一走「重建图表」：主图叠加（MA/BOLL）本来就这么做，
 *   现在副图也照此办理 —— 因为 v10.0.2 的 removeIndicator 不可靠（见上），
 *   而重建把 paneIds 一并重置，状态永远从零开始，不存在漂移与叠加。耗时 <100ms。
 */
function btkToggleIndicator(key) {
  BTK.indicators[key] = !BTK.indicators[key];
  btkInitChart();
  btkRenderChips();
}

function btkScrollToLatest() {
  if (!BTK.chart) return;
  // ★ 让最后一根（=本局起点）不贴右边框：
  //   否则起点竖线与图表右边框重合，根本看不出来；留白也顺带表达了"右边是未知的未来"。
  try { BTK.chart.setOffsetRightDistance(72); } catch (e) {}
  if (typeof BTK.chart.scrollToRealTime === 'function') {
    try { BTK.chart.scrollToRealTime(0); } catch (e) {}
  }
}

/* ============================ 数据 ============================ */

function btkSaveSettings() {
  try {
    // ★ 版本号必须在每次保存时写入：否则全新用户首次保存的是"无版本号"的设置，
    //   下次加载会被误判为 v1 旧存储而触发迁移，把用户刚改的口径/止损重置掉。
    BTK.settings.__ver = BTK_SETTINGS_VER;
    localStorage.setItem(BTK_STORE_KEY, JSON.stringify(BTK.settings));
  } catch (e) {}
}
// ★ 复权口径：可选值白名单。
// 「自动」已按用户要求下线 —— 两版回测页都不再提供该选项，默认统一为「前复权」。
// 存量 localStorage 里若残留 'auto'，必须回落：<select> 里没有对应 <option> 时，
// el.value = 'auto' 赋值会失败、下拉框显示空白（虽然提交时因 '' 为 falsy 会兜到默认值，
// 但界面上是坏的），所以这里做显式白名单校验而不是只靠 falsy 兜底。
var BTK_ADJUST_ALLOWED = ['qfq', 'hfq', 'raw'];
var BTK_DEFAULT_ADJUST = 'qfq';

// ★ 预热 / 揭示根数的白名单（同理：改了选项集，存量设置里的旧值会让 <select> 空白）。
//   预热 = 起点前保留的历史根数；揭示 = 本局点「下一根」能点的次数上限。
//   揭示还支持 'all'：全量模式 —— 起点固定在第 warmup 根、不随机，揭示到数据末尾。
var BTK_WARMUP_ALLOWED = [60, 90, 120];
var BTK_FUTURE_ALLOWED = ['60', '90', '120', '200', 'all'];
var BTK_DEFAULT_WARMUP = 90;
var BTK_DEFAULT_FUTURE = 60;

// ★ 设置结构版本号。
// v1 → v2 的两处变化：默认复权从 auto 改回「前复权」、止损默认从 3% 改 7%。
// 必须做版本迁移：v1 曾把用户的 qfq **静默**迁移成 auto（那是系统行为，不是用户选择），
// 且 v1 的 localStorage 里存着旧的 stopPct=3 —— 不重置的话，这两项会在加载时把新默认盖掉，
// 用户改了默认值却看不到任何变化。
var BTK_SETTINGS_VER = 2;

function btkLoadSettings() {
  try {
    var raw = localStorage.getItem(BTK_STORE_KEY);
    if (!raw) {
      // 首次打开这一版：接上另一版（backtest.html）或本机上次用过的标的，
      // 而不是永远从默认的茅台开始 —— 两版的标的记忆是共用的（btSharedGetSymbol）
      var shared = (typeof btSharedGetSymbol === 'function') ? btSharedGetSymbol() : null;
      if (shared && shared.symbol) BTK.settings.symbol = shared.symbol;
      return;
    }
    var s = JSON.parse(raw);
    Object.keys(BTK.settings).forEach(function (k) {
      if (s[k] !== undefined && s[k] !== null) BTK.settings[k] = s[k];
    });
    if (!s.__ver || s.__ver < BTK_SETTINGS_VER) {
      BTK.settings.adjust = BTK_DEFAULT_ADJUST;
      BTK.settings.stopPct = 7;
    }
    // 口径白名单：'auto' 已下线 → 存量值回落前复权
    if (BTK_ADJUST_ALLOWED.indexOf(String(BTK.settings.adjust).toLowerCase()) < 0) {
      BTK.settings.adjust = BTK_DEFAULT_ADJUST;
    }
    // 预热 / 揭示根数白名单：选项集变动过（揭示由 20/40/60 改为 60/90/120/200），
    // 存量里的旧值（如 future=40、warmup=200）已不在选项里 → 回落默认，否则 <select> 空白
    if (BTK_WARMUP_ALLOWED.indexOf(Number(BTK.settings.warmup)) < 0) {
      BTK.settings.warmup = BTK_DEFAULT_WARMUP;
    }
    if (BTK_FUTURE_ALLOWED.indexOf(String(BTK.settings.future)) < 0) {
      BTK.settings.future = BTK_DEFAULT_FUTURE;
    }
    BTK.settings.__ver = BTK_SETTINGS_VER;
    // 年份缺省或非法 → 回落到 10 年
    if (!BTK_YEARS_TO_COUNT[String(BTK.settings.years)]) BTK.settings.years = BTK_DEFAULT_YEARS;
    btkSaveSettings();
  } catch (e) {}
}
function btkPushRecent(symbol, name) {
  try {
    var arr = JSON.parse(localStorage.getItem(BTK_RECENT_KEY) || '[]');
    arr = arr.filter(function (x) { return x.symbol !== symbol; });
    arr.unshift({ symbol: symbol, name: name });
    localStorage.setItem(BTK_RECENT_KEY, JSON.stringify(arr.slice(0, 12)));
  } catch (e) {}
  // 两版共用的标的记忆：ECharts 版（backtest.html）读的是同一份，
  // 这样在哪一版用过，切到另一版就能直接在「最近」里点到
  if (typeof btSharedSetSymbol === 'function') btSharedSetSymbol(symbol, name);
}

/** 年份 → 根数（与原版 backtest.html 同规则，保证两版取到的数据窗口一致） */
function btkYearsToCount(years) {
  return BTK_YEARS_TO_COUNT[String(years)] || BTK_YEARS_TO_COUNT[String(BTK_DEFAULT_YEARS)];
}

/** 拉真实日 K：{name, symbol, dates[], ohlc[[o,c,l,h]], volumes[]} */
async function btkLoadBars(symbol, count, adjust) {
  var url = '/api/market/kline-stock/' + symbol + '?count=' + count + '&adjust=' + adjust;
  var res = await btkFetch(url);
  if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
  var data = await res.json();
  if (!data || !data.dates || !data.ohlc || !data.ohlc.length) throw new Error('返回数据为空');
  var bars = [];
  var negCount = 0;        // 非正价格根数（前复权长窗口的典型症状）
  var firstNegDate = '';
  // ★ 成交量口径归一（2026-10-24）：后端现在 volumes / volumesRaw **都是「手」**。
  //   老接口的 volumes 是「万手」、volumesRaw 是「手」，为避免新旧混用出错，
  //   这里统一折算成手数：优先 volumesRaw；没有就看 volumes 的量级（比 raw 小 100 倍以上
  //   判定为万手口径，×10000）。bar.volume 与 bar.volumeRaw 一律是手，下游不用再判断单位。
  for (var i = 0; i < data.dates.length; i++) {
    var o = data.ohlc[i] || [];
    var vMain = Number((data.volumes && data.volumes[i]) || 0);
    var vRaw  = Number((data.volumesRaw && data.volumesRaw[i]) || 0);
    var vHand = vRaw > 0 ? vRaw : vMain;                  // 两者同单位时取哪个都一样
    if (vRaw > 0 && vMain > 0 && vRaw / vMain > 100) vHand = vRaw;   // volumes 仍是万手
    else if (vRaw <= 0 && vMain > 0 && vMain < 1000) vHand = vMain * 10000;  // 只有万手值
    vHand = Math.round(vHand);
    var bar = {
      date: data.dates[i],
      timestamp: Date.parse(data.dates[i] + 'T00:00:00+08:00'),
      open: Number(o[0]), close: Number(o[1]), low: Number(o[2]), high: Number(o[3]),
      volume: vHand,        // 手（实际手数），VOL 副图与量比都用它
      volumeRaw: vHand      // 兼容旧字段（同值）
    };
    // 负价判定用 low（最容易被压穿），同时兼看 close
    if (!(bar.low > 0) || !(bar.close > 0)) {
      negCount++;
      if (!firstNegDate) firstNegDate = bar.date;
    }
    bars.push(bar);
  }

  return {
    bars: bars,
    name: data.name || '',
    symbol: data.symbol || symbol,
    adjust: data.adjust || adjust,     // 后端实际采用的口径
    reqAdjust: adjust,
    negCount: negCount,
    firstNegDate: firstNegDate,
    useRawVol: true                    // 口径已归一，统一用手数
  };
}

/* ---- 数据质量告警条 ---- */

function btkHideDataWarn() {
  var el = $k('btkDataWarn');
  if (el) { el.style.display = 'none'; el.innerHTML = ''; }
}

/**
 * 展示数据告警。两类都会**直接毁掉练习结果**，必须显式告知并给一键修复，
 * 而不是默默画一根穿越零轴的怪线、或者让用户点了"买入"却毫无反应：
 *   A) 负价：前复权长窗口的必然产物，止损与 R 值全错
 *   B) 资金不足 1 手：后复权价格虚高（茅台后复权 6000+ 元）或标的本身贵，
 *      固定金额买不到 100 股 → 买入被拒
 * 多条告警可同时出现（负价通常伴随价格虚高，容易紧接着触发 B）。
 */
function btkShowDataWarn(info) {
  var el = $k('btkDataWarn');
  if (!el) return;
  var effAdj = String(info.effectiveAdjust || '').toLowerCase();
  var adjCN = { qfq: '前复权', hfq: '后复权', raw: '不复权', auto: '自动' }[effAdj] || effAdj;
  var items = [];   // { html, act: { id, label, fn } }

  if (info.negCount > 0) {
    items.push({
      html: '⚠️ <b>检测到 ' + info.negCount + ' 根非正价格</b>（最早 ' + info.firstNegDate + '）。' +
        '当前实际口径为「' + adjCN + '」，在 ' + info.bars + ' 根的长窗口下，' +
        '前复权会把早期价格压到 0 以下 —— <b>负价会让止损/止盈百分比和 R 值计算完全失真</b>。',
      act: {
        id: 'btkFixAdjustBtn', label: '切到后复权重开',
        fn: function () {
          var adjEl = $k('btkAdjust');
          if (adjEl) adjEl.value = 'hfq';
          BTK.settings.adjust = 'hfq';
          btkSaveSettings();
          btkStartPractice();
        }
      }
    });
  }

  if (info.amountShort) {
    var need = info.suggestAmount;
    items.push({
      html: '⚠️ <b>每笔金额买不到 1 手</b>：起点价 ' + btkFmt(info.entryPrice) + ' 元，' +
        '1 手需 <b>' + btkYuan(info.entryPrice * 100) + ' 元</b>，当前设置 ' + btkYuan(info.amount) + ' 元 —— ' +
        '点「买入」会按最小 100 股下单，实际占用资金会超出设定值。' +
        (effAdj === 'hfq' ? '（后复权价格非真实交易价，但涨跌幅真实）' : ''),
      act: {
        id: 'btkFixAmountBtn', label: '调到 ' + (need / 10000) + ' 万',
        fn: function () {
          var amtEl = $k('btkAmount');
          if (amtEl) amtEl.value = String(need);
          BTK.settings.amount = need;
          btkSaveSettings();
          btkShowDataWarn(Object.assign({}, info, {
            amount: need,
            amountShort: need < info.entryPrice * 100
          }));
        }
      }
    });
  }

  // 注：曾有一条「该标的上市较晚，数据不足 N 年」的 ℹ️ 提示，已按要求移除 ——
  //     它只是说明性信息、不构成风险，且每条标的都可能触发，反而占地方。
  //     这里只保留两类**真会影响练习结果**的告警：负价、资金买不到 1 手。

  if (!items.length) { btkHideDataWarn(); return; }
  el.innerHTML = items.map(function (it, i) {
    return '<div' + (i ? ' style="margin-top:6px"' : '') + '>' + it.html +
      (it.act ? ' <button type="button" class="btk-warn-act" id="' + it.act.id + '">' +
        it.act.label + '</button>' : '') + '</div>';
  }).join('');
  el.style.display = 'block';

  items.forEach(function (it) {
    if (!it.act) return;
    var btn = $k(it.act.id);
    if (btn) btn.addEventListener('click', it.act.fn);
  });
}

/* ============================ 练习流程 ============================ */

/* ---- 随机标的 ---- */

// 最近随机抽过的标的（仅存本地，用于"连点两次别抽到同一只"）
var BTK_RANDOM_PICKED_KEY = 'btk_random_picked';

/**
 * 从后端标的池随机取一只，填进输入框并**直接开局**。
 *
 * 池子是建池时按总市值排序固定的前 3500 只沪深 A 股（bt_universe），
 * 由 prewarm-kline.js --universe 灌满 2016-01-04 起的历史。
 * 后端在抽中时会检查数据新鲜度并同步补最新（ensure=1），
 * 所以这里拿到的标的不会因为"缺最近几根"而在开局时报数据不足。
 */
/* ============================ 练习轮次标记 ============================ */
//
// 池子里每只标的都带一个 drawn_count = "练到第几轮"。
// 后端随机抽取的 SQL 是 ORDER BY drawn_count ASC, RANDOM()，
// 所以永远先挑最小的那一档 —— 整池练完一遍之前不会重复抽到同一只。
//
// ★ 标记在**开局成功之后**才上报，不是抽中那一刻：
//   抽到了但数据加载失败（停牌、接口抖动）不该消耗掉这只票，
//   否则池子里的票会被"抽掉"却没真正练过。
// ★ 后端自带幂等（只有处于最低档的标的才 +1），所以页面刷新、
//   反复开局同一只都不会把它的标记顶到天上，这里不需要本地去重。

var BTK_UNIVERSE = { drawn: 0, untouched: 0, total: 0, round: 1, remaining: 0 };

function btkRenderUniverseHint() {
  var el = $k('btkUniverseHint');
  if (!el) return;
  var s = BTK_UNIVERSE;
  if (!s.total) { el.textContent = ''; return; }
  el.textContent = '剩 ' + s.remaining + ' 只未练 · 第 ' + s.round + ' 轮';
  el.title = '随机池共 ' + s.total + ' 只标的，累计练过 ' + s.drawn + ' 只。\n'
    + '当前第 ' + s.round + ' 轮，这一轮还剩 ' + s.remaining + ' 只没练过。\n'
    + '随机抽取只在「练得最少」的那一档里挑，所以整池过完一遍之前不会重复抽到同一只。\n'
    + '标记在开局成功后才计数（加载失败不消耗标的）。';
}

/** 拉一次池子统计（只用于展示进度，失败静默） */
function btkLoadUniverseStats() {
  var f = (typeof authFetch === 'function') ? authFetch : btkFetch;
  return f('/api/backtest/universe/stats')
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (j) {
      if (!j || !j.total) return;
      BTK_UNIVERSE = {
        drawn: j.drawn || 0, untouched: j.untouched || 0,
        total: j.total || 0, round: j.round || 1,
        remaining: j.remaining || 0
      };
      btkRenderUniverseHint();
    })
    .catch(function () { });
}

/** 给标的打「已练」标记（后端幂等，失败不影响练习） */
function btkMarkDrawn(symbol) {
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol || '')) return Promise.resolve();
  var f = (typeof authFetch === 'function') ? authFetch : btkFetch;
  return f('/api/backtest/universe/mark', {
    method: 'POST',
    body: JSON.stringify({ symbol: symbol })
  })
    .then(function (res) { return res && res.ok ? res.json() : null; })
    .then(function (j) {
      if (!j || !j.inUniverse) return;
      BTK_UNIVERSE = {
        drawn: j.drawn || 0, untouched: j.untouched || 0,
        total: j.total || 0, round: j.round || 1,
        remaining: j.remaining || 0
      };
      btkRenderUniverseHint();
      if (j.bumped) {
        btkLog('练习标记 +1：' + symbol + ' 现在记到第 ' + j.drawnCount + ' 轮'
          + '（池内已练 ' + j.drawn + ' / ' + j.total + '）', 'ok');
      }
    })
    .catch(function () { /* 标记失败不影响练习 */ });
}

async function btkRandomSymbol() {
  // 上一只还在加载时不响应：否则输入框先被改成新标的、图表却还是旧标的
  if (BTK.loading) { btkToast('正在加载上一只，稍等一秒再点', 'warn'); return; }
  var btn = $k('btkRandomSymBtn');
  var input = $k('btkSymbol');
  var oldLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '抽取中…'; }
  try {
    var recent = [];
    try { recent = JSON.parse(localStorage.getItem(BTK_RANDOM_PICKED_KEY) || '[]'); } catch (e) { recent = []; }
    if (!Array.isArray(recent)) recent = [];
    var exclude = recent.slice(0, 5);
    var cur = (input && input.value || '').trim().toLowerCase();
    if (/^(sh|sz)\d{6}$/.test(cur)) exclude.unshift(cur);

    // 本局实际需要的根数：预热 + 揭示（+5 根余量），至少 150
    var fut = String(BTK.settings.future) === 'all' ? 400 : (parseInt(BTK.settings.future, 10) || 60);
    var need = Math.max(150, (parseInt(BTK.settings.warmup, 10) || 90) + fut + 5);

    var url = '/api/backtest/universe/random?minBars=' + Math.min(need, 800) +
      (exclude.length ? '&exclude=' + encodeURIComponent(exclude.join(',')) : '');
    var res = await btkFetch(url);
    var j = null;
    try { j = await res.json(); } catch (e) { j = null; }
    if (!res || !res.ok || !j || !j.symbol) {
      throw new Error((j && j.error) || ('HTTP ' + (res && res.status)));
    }

    if (input) input.value = j.symbol;
    recent = [j.symbol].concat(recent.filter(function (s) { return s !== j.symbol; })).slice(0, 5);
    try { localStorage.setItem(BTK_RANDOM_PICKED_KEY, JSON.stringify(recent)); } catch (e) {}

    // 池子进度（响应里的 drawn/untouched 是**抽取之前**的统计，mark 完成后会再刷一次）
    if (j.total) {
      BTK_UNIVERSE = {
        drawn: j.drawn || 0, untouched: j.untouched || 0,
        total: j.total || 0, round: j.round || 1,
        remaining: j.remaining || 0
      };
      btkRenderUniverseHint();
    }
    // 轮次提示：drawnCount = 这只票此前练过几次
    var dn = j.drawnCount || 0;
    var roundTag = dn > 0
      ? '· 池里没练过的已抽空，这是第 ' + (dn + 1) + ' 次'
      : '· 首次练习';

    btkToast('🎲 抽到 ' + (j.name || j.symbol) + '（市值第 ' + j.rank + ' 名 / ' +
      (j.bars || 0) + ' 根' + (j.filled ? '，已补最新' : '') +
      (j.stale ? '，⚠️ 补数未成功' : '') + '）' + roundTag, j.stale ? 'warn' : 'info');
    btkLog('随机标的：' + (j.name || '') + '（' + j.symbol + '）市值第 ' + j.rank +
      ' 名，库内 ' + (j.bars || 0) + ' 根 ' + (j.firstDate || '') + ' ~ ' + (j.lastDate || '') +
      (j.filled ? '，已自动补最新' : '') + '，' +
      (dn > 0 ? '第 ' + (dn + 1) + ' 次练' : '首次练'), j.stale ? 'warn' : 'ok');

    await btkStartPractice();
  } catch (e) {
    btkToast('随机标的失败：' + e.message, 'error');
    btkLog('随机标的失败：' + e.message, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldLabel || '🔀 随机标的'; }
  }
}

function btkCurrentBar() {
  if (!BTK.bars.length) return null;
  var i = Math.min(BTK.revealIdx, BTK.bars.length) - 1;
  return i >= 0 ? BTK.bars[i] : null;
}

async function btkStartPractice() {
  var symbolInput = $k('btkSymbol');
  var raw = (symbolInput && symbolInput.value || '').trim().toLowerCase();
  if (!raw) { btkToast('先填标的代码', 'warn'); return; }
  // ★ 并发守卫：本函数是 async，整个加载过程要几百毫秒到两秒。
  //   期间用户再点一次「随机标的」或按 R，会起第二个实例 ——
  //   两个实例交错写 BTK.bars / BTK.symbol，结果是「输入框是 A、图表是 B」，
  //   甚至用 A 的起点去算 B 的数据。实测：连点随机按钮两次就必现。
  //   这里直接挡住后来者（前一次加载完再点即可）。
  if (BTK.loading) { btkToast('正在加载上一只，稍等一秒再点', 'warn'); return; }
  // ★ 切标的/重开一局必须先停播：否则定时器还在跑，下一根会推进到新标的的
  //   startIdx 上（数据已换，revealIdx 对不上）
  if (btkAutoPlaying()) btkStopAuto('重开一局');
  BTK.loading = true;
  // ★ 标的此前从未写进 settings —— btkSaveSettings 存的永远是默认的 sh600519，
  //   所以切完标的、刷新页面就变回茅台。
  //   注意这里**不要**先写 settings.symbol：下面的 btkSaveSettings() 会把未经验证的输入
  //   一并落盘，那样输错代码（如 zz999999）也会覆盖掉原本可用的标的，刷新后反复失败。
  //   只在「归一化 + 数据加载都成功」之后才落盘（见下方）。

  BTK.settings.adjust = ($k('btkAdjust') && $k('btkAdjust').value) || BTK_DEFAULT_ADJUST;
  // 均线：界面上的 6 组若还没触发过 change（用户填完直接点「开始」），
  // 这里补一次同步，保证落盘/绘图用的都是眼前看到的值。
  var maCfg = btkMaReadUI();
  BTK.settings.maPeriods = maCfg.periods;
  BTK.settings.maColors = maCfg.colors;
  BTK.settings.warmup = parseInt(($k('btkWarmup') && $k('btkWarmup').value) || '90', 10);
  // 揭示根数：'all' = 全量模式（从第 warmup 根一直练到数据末尾），其余为具体根数
  var futRaw = ($k('btkFuture') && $k('btkFuture').value) || String(BTK_DEFAULT_FUTURE);
  var allMode = (futRaw === 'all');
  BTK.settings.future = allMode ? 'all' : parseInt(futRaw, 10);
  if (!allMode && !(BTK.settings.future > 0)) BTK.settings.future = BTK_DEFAULT_FUTURE;
  BTK.settings.amount = parseFloat(($k('btkAmount') && $k('btkAmount').value) || '100000');
  // ★ 止损/止盈此前漏了读取（btkBuy 是现从 DOM 读的，所以当次有效，掩盖了它没进 settings 的问题）
  //   → 用户在界面上改的止损不会被保存，刷新后被打回默认值。这里补齐。
  BTK.settings.stopPct = parseFloat(($k('btkStopPct') && $k('btkStopPct').value) || '7');
  BTK.settings.targetR = parseFloat(($k('btkTargetR') && $k('btkTargetR').value) || '2');
  // 随机起点同样要进 settings，否则刷新后被打回 HTML 里的默认（勾选）。
  // ★ 全量模式起点是固定的（第 warmup 根），随机开关无意义 → 禁用 UI，且**不改**用户的随机偏好，
  //   这样切回普通模式时还能用回上次的选择。
  var rndEl = $k('btkRandom');
  if (rndEl) {
    rndEl.disabled = allMode;
    if (allMode) rndEl.checked = false;
  }
  if (!allMode) BTK.settings.randomStart = !!(rndEl && rndEl.checked);
  BTK.randomStart = allMode ? false : !!BTK.settings.randomStart;
  var years = parseInt(($k('btkYears') && $k('btkYears').value) || String(BTK_DEFAULT_YEARS), 10);
  if (!BTK_YEARS_TO_COUNT[String(years)]) years = BTK_DEFAULT_YEARS;
  BTK.settings.years = years;
  var wantBars = btkYearsToCount(years);
  btkSaveSettings();
  btkHideDataWarn();

  var btn = $k('btkStartBtn');
  if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
  try {
    // 纯数字输入 → 归一化（600519 → sh600519）
    var symbol = raw;
    if (/^\d{6}$/.test(raw) && typeof btkFetch === 'function') {
      try {
        var nr = await btkFetch('/api/market/normalize-symbol?symbol=' + encodeURIComponent(raw));
        var nj = await nr.json();
        if (nj && nj.symbol) symbol = String(nj.symbol).toLowerCase();
      } catch (e) { /* 归一化失败就按原样试 */ }
    }
    var got = await btkLoadBars(symbol, wantBars, BTK.settings.adjust);
    var needBars = BTK.settings.warmup + (allMode ? 0 : BTK.settings.future) + 5;
    if (got.bars.length < needBars) {
      // 把两个参数拆开说清楚：选了「预热 120 + 揭示 200」却把历史范围设在近 1 年（≈250 根）时，
      // 光说"需要 > 325 根"用户不知道该动哪个
      throw new Error(allMode
        ? '历史数据只有 ' + got.bars.length + ' 根，不够全量练习（预热 ' + BTK.settings.warmup +
          ' 根之后还得有数据）—— 请调小预热根数，或把「历史范围」选得更大'
        : '历史数据只有 ' + got.bars.length + ' 根，不够本局配置（预热 ' +
          BTK.settings.warmup + ' + 揭示 ' + BTK.settings.future + ' = ' + needBars +
          ' 根）—— 请调小预热/揭示根数，或把「历史范围」选得更大');
    }
    BTK.bars = got.bars;
    BTK.useRawVol = !!got.useRawVol;   // 口径已在 btkLoadBars 归一到「手」，这里恒为 true
    BTK.name = got.name;
    BTK.symbol = symbol;
    BTK.effectiveAdjust = got.adjust;
    BTK.dataRange = got.bars[0].date + ' ~ ' + got.bars[got.bars.length - 1].date;
    btkPushRecent(symbol, got.name);
    // 归一化 + 加载都成功后：把规范代码落盘，并回填输入框
    // （此前输入 600000 加载完输入框还显示 600000，与图表标的不一致）
    BTK.settings.symbol = symbol;
    if (symbolInput) symbolInput.value = symbol;
    btkSaveSettings();

    // 起点：
    //   - 全量模式：固定在第 warmup 根（前面留 warmup 根做预热），不随机，一直练到数据末尾
    //   - 普通模式：随机落在 [warmup, 末尾-future] 区间；关掉随机就取"最近一段"
    var last = BTK.bars.length - 1;
    var startIdx;
    if (allMode) {
      startIdx = BTK.settings.warmup;
    } else {
      var maxStart = last - BTK.settings.future;
      startIdx = BTK.settings.warmup;
      if (maxStart > BTK.settings.warmup) {
        startIdx = BTK.randomStart
          ? BTK.settings.warmup + Math.floor(Math.random() * (maxStart - BTK.settings.warmup))
          : maxStart;
      }
    }
    BTK.startIdx = startIdx;
    BTK.revealIdx = startIdx;
    BTK.endIdx = allMode ? BTK.bars.length : Math.min(startIdx + BTK.settings.future, BTK.bars.length);
    BTK.position = null;
    BTK.trades = [];
    BTK.finished = false;
    BTK.finishReason = '';

    // 数据质量检查（放在起点确定之后：资金够不够买 1 手要看起点的价格）
    var entryPrice = BTK.bars[startIdx].close;
    var lotCost = entryPrice * 100;
    var amountShort = BTK.settings.amount < lotCost;
    // 建议金额：够买 1 手 + 10% 余量，向上取整到万
    var suggestAmount = Math.ceil(lotCost * 1.1 / 10000) * 10000;
    btkShowDataWarn({
      negCount: got.negCount,
      firstNegDate: got.firstNegDate,
      effectiveAdjust: got.adjust,
      reqAdjust: got.reqAdjust,
      bars: got.bars.length,
      entryPrice: entryPrice,
      amount: BTK.settings.amount,
      amountShort: amountShort,
      suggestAmount: suggestAmount
    });

    btkInitChart();
    btkRenderAll();
    // 明确告知本局抽到哪里 —— 图表永远右对齐到起点、构图雷同，不给文字反馈很难感知随机性
    btkToast(allMode
      ? ('全量模式：从 ' + BTK.bars[startIdx].date + ' 一直练到数据末尾，共 ' +
         (BTK.endIdx - startIdx) + ' 根')
      : ('本局起点：' + BTK.bars[startIdx].date + '（' +
         (BTK.randomStart ? '随机' : '最近一段') + '，已隐藏其后 ' + (BTK.endIdx - startIdx) + ' 根）'),
      'info');
    btkLog('练习开始：' + (got.name || symbol) + '（' + symbol + '）' +
      ' 数据 ' + got.bars.length + ' 根 / ' + BTK.dataRange +
      ' 口径=' + (got.adjust || '-') +
      '，起点 ' + BTK.bars[startIdx].date +
      '，已隐藏其后 ' + (BTK.endIdx - startIdx) + ' 根' +
      (got.negCount ? '  ⚠️ 含 ' + got.negCount + ' 根负价' : ''), 'ok');

    // ★ 开局成功才给这只标的打「已练」标记（失败路径不会走到这里，
    //   加载失败的票不该被消耗掉）。异步 fire-and-forget，不阻塞开局。
    btkMarkDrawn(symbol);
  } catch (e) {
    btkLog('加载失败: ' + e.message, 'err');
    btkToast('加载失败：' + e.message, 'error');
  } finally {
    BTK.loading = false;   // 释放并发守卫（见函数开头）
    if (btn) { btn.disabled = false; btn.textContent = '🎲 开始 / 重开练习'; }
  }
}

function btkNextBar() {
  if (BTK.finished || !BTK.bars.length) return;
  if (BTK.revealIdx >= BTK.endIdx) { btkFinish('揭示完毕'); return; }
  var bar = BTK.bars[BTK.revealIdx];
  BTK.revealIdx++;
  if (BTK.pushBar) {
    BTK.pushBar(btkToBar(bar));
  } else {
    btkLog('pushBar 回调未就绪，重建图表兜底', 'warn');
    btkInitChart();
  }
  btkCheckStop(bar);           // 先让这根 K 线出现，再判定止损/止盈（顺序影响观感）
  btkScrollToLatest();
  if (BTK.revealIdx >= BTK.endIdx) btkFinish('揭示完毕');
  btkRenderAll();
}

/* ---------------------------- 自动播放 ---------------------------- */
//
// 需求：点「▶ 自动」后每 0.2 秒自动推进一根，再点一下暂停。
//
// ★ 为什么用 setTimeout 递归而不是 setInterval：
//   每次推进要做 pushBar + 整页重渲染（head/持仓/统计/进度/按钮），
//   慢的时候一帧可能超过 200ms。setInterval 会把错过的回调**排队补发**，
//   表现是"卡一下之后连跳好几根"，行情节奏全乱。
//   递归版只在上一根画完之后才排下一次，并按"已耗时"扣减等待，
//   渲染够快时周期间隔仍是精确的 200ms，渲染慢时自动降速不堆积。
//
// ★ 什么时候必须停：本局结束 / 揭示到上限 / 手动单步 / 买入平仓 /
//   全部揭示 / 重开一局 / 切标的。少停一个都会出现"定时器还在跑，
//   但数据已经换了"，下一根会推进到新标的的错误位置。

var BTK_AUTO_MS = 200;          // 自动播放间隔（毫秒）

function btkAutoPlaying() { return !!(BTK.auto && BTK.auto.on); }

/** 现在的局面能不能开始播放（返回 null 表示可以，否则返回提示语） */
function btkAutoBlockReason() {
  if (!BTK.bars.length) return '先点「开始 / 重开练习」加载一局';
  if (BTK.finished) return '本局已结束，重开一局再播放';
  if (BTK.revealIdx >= BTK.endIdx) return '已经揭示到本局上限了';
  return null;
}

function btkStartAuto() {
  var why = btkAutoBlockReason();
  if (why) { btkToast(why, 'warn'); return; }
  if (BTK.auto.on) return;
  BTK.auto.on = true;
  btkRenderButtons();            // 按钮立刻切成「⏸ 暂停」
  btkLog('自动播放开始：每 ' + BTK_AUTO_MS + ' 毫秒推进一根（再点一下暂停）', 'ok');
  btkAutoStep();
}

function btkAutoStep() {
  BTK.auto.timer = null;
  if (!BTK.auto.on) return;
  var why = btkAutoBlockReason();
  if (why) { btkStopAuto(why); return; }

  var t0 = Date.now();
  btkNextBar();
  if (!BTK.auto.on) return;      // btkNextBar 里可能已经结算并停了

  var spent = Date.now() - t0;
  BTK.auto.timer = setTimeout(btkAutoStep, Math.max(0, BTK_AUTO_MS - spent));
}

/** 停播（reason 为空则静默，用于切换场景时清理） */
function btkStopAuto(reason) {
  if (BTK.auto.timer) { clearTimeout(BTK.auto.timer); BTK.auto.timer = null; }
  if (!BTK.auto.on) return;
  BTK.auto.on = false;
  btkRenderButtons();
  if (reason) btkLog('自动播放已停止：' + reason, 'info');
}

function btkToggleAuto() {
  if (BTK.auto.on) btkStopAuto('手动暂停');
  else btkStartAuto();
}

/** 逐根检查止损 / 止盈（同一根同时触及按保守原则先判止损） */
function btkCheckStop(bar) {
  var p = BTK.position;
  if (!p) return;
  if (bar.low <= p.stop) { btkClose('止损触发', p.stop, bar); return; }
  if (p.target && bar.high >= p.target) { btkClose('止盈触发', p.target, bar); return; }
  // 记录最大浮盈/浮亏（以 R 为单位），复盘时看"扛了多少浮亏才止损"很有用
  var rHigh = (bar.high - p.entry) / p.risk;
  var rLow = (bar.low - p.entry) / p.risk;
  p.mfeR = Math.max(p.mfeR || 0, rHigh);
  p.maeR = Math.min(p.maeR || 0, rLow);
}

function btkBuy() {
  if (!BTK.bars.length) { btkToast('先开始练习', 'warn'); return; }
  if (BTK.finished) { btkToast('本局已结束，重开一局再买', 'warn'); return; }
  if (BTK.position) { btkToast('已有持仓，先平仓', 'warn'); return; }
  var bar = btkCurrentBar();
  if (!bar) return;

  var stopPct = parseFloat(($k('btkStopPct') && $k('btkStopPct').value) || '7');
  var targetR = parseFloat(($k('btkTargetR') && $k('btkTargetR').value) || '2');
  if (!(stopPct > 0 && stopPct < 30)) { btkToast('止损幅度要在 0~30% 之间', 'warn'); return; }
  if (!(targetR > 0 && targetR <= 20)) { btkToast('止盈倍数要在 0~20R 之间', 'warn'); return; }

  var entry = bar.close;
  var stop = Number((entry * (1 - stopPct / 100)).toFixed(2));
  var risk = entry - stop;
  if (risk <= 0) { btkToast('止损价必须低于买入价', 'warn'); return; }
  var target = Number((entry + risk * targetR).toFixed(2));
  var amount = BTK.settings.amount;
  var shares = Math.floor(amount / entry / 100) * 100;      // A 股按 100 股整数倍
  if (shares < 100) {
    // 高价股（如 1300 元的茅台）用默认金额买不到一手 —— 按最小一手 100 股下单并明确告知，
    // 否则用户点买入毫无反应，只会以为坏了
    shares = 100;
    btkToast('每笔金额买不到一手，按最小 100 股下单（占用 ' +
      Math.round(entry * 100).toLocaleString('zh-CN') + ' 元）', 'warn');
  }

  BTK.position = {
    entry: entry, stop: stop, target: target, targetR: targetR, risk: risk,
    shares: shares, cost: Number((entry * shares).toFixed(2)),
    stopPct: stopPct, entryDate: bar.date, entryIdx: BTK.revealIdx - 1, mfeR: 0, maeR: 0
  };
  btkLog('买入 @' + btkFmt(entry) + ' × ' + shares + ' 股，止损 ' + btkFmt(stop) +
    '（-' + stopPct + '%），止盈 ' + btkFmt(target) + '（+' + targetR + 'R）', 'ok');
  btkRenderAll();
}

function btkClose(reason, price, bar) {
  var p = BTK.position;
  if (!p) return;
  bar = bar || btkCurrentBar();
  // ★ A 股 T+1：当天买入当天不能卖。手动平仓时若还停在建仓那根 K 线上就直接拦掉，
  //   否则用户会在同一根 K 线里"买完立刻平"，练出手续费为 0 的假本事。
  //   （止损/止盈由后续 K 线触发，不受此限；结算强制平仓是收尾动作，也放行）
  if (reason === '手动平仓' && BTK.revealIdx - 1 === p.entryIdx) {
    btkToast('A 股 T+1：当天买入次日才能卖，先点「下一根」', 'warn');
    return;
  }
  var exit = (price !== null && price !== undefined) ? price : (bar ? bar.close : p.entry);
  var pnlR = (exit - p.entry) / p.risk;
  var pnlAmount = (exit - p.entry) * p.shares;
  BTK.trades.push({
    entryDate: p.entryDate, entry: p.entry, stop: p.stop, target: p.target,
    exitDate: bar ? bar.date : p.entryDate, exit: exit,
    pnlR: pnlR, pnlAmount: pnlAmount, shares: p.shares,
    reason: reason, mfeR: p.mfeR || 0, maeR: p.maeR || 0
  });
  BTK.position = null;
  btkLog('平仓（' + reason + '）@' + btkFmt(exit) + ' → ' + btkR(pnlR) + ' / ' + btkMoney(pnlAmount),
    pnlR >= 0 ? 'ok' : 'err');
  btkRenderAll();
}

function btkFinish(reason) {
  if (BTK.finished) return;
  if (BTK.position) btkClose('结算平仓（' + reason + '）', null);
  // 本局结束 → 自动播放没有继续的意义（内部调用时也别留个空转的定时器）
  if (btkAutoPlaying()) btkStopAuto('本局结束');
  BTK.finished = true;
  BTK.finishReason = reason;
  btkLog('本局结束：' + reason + '，共 ' + BTK.trades.length + ' 笔', 'ok');
  btkSaveHistory(reason);   // 写进与 ECharts 版共用的 backtest_history
  btkRenderAll();
}

/** 一局结束后看完整走势（包含当时没揭示的未来） */
function btkRevealAll() {
  if (!BTK.bars.length) return;
  // 会直接改 revealIdx，播放继续跑就会从跳完的位置往下推
  if (btkAutoPlaying()) btkStopAuto('已全部揭示');
  // ★ 练习中必须止步于本局上限（endIdx）：否则「揭示根数」形同虚设 ——
  //   一键就能把 2500 根全看完，而且 revealIdx 推到底后不可逆（回不到"还没偷看"的状态）。
  //   结算之后才放开到完整走势，作为复盘用。
  if (!BTK.finished) {
    var cap = BTK.endIdx || BTK.bars.length;
    var n = Math.max(0, cap - BTK.revealIdx);
    var capDesc = (String(BTK.settings.future) === 'all')
      ? '全量模式，本局到数据末尾'
      : ('本局上限 ' + BTK.settings.future + ' 根');
    BTK.revealIdx = cap;
    btkInitChart();
    btkRenderAll();
    btkLog(n > 0
      ? '已揭示本局剩余 ' + n + ' 根（' + capDesc + '；结算后可看完整走势）'
      : '本局已到揭示上限（结算后可看完整走势）', 'warn');
    return;
  }
  // 已结算 → 复盘模式
  BTK.revealIdx = BTK.bars.length;
  BTK.endIdx = BTK.bars.length;
  btkInitChart();
  btkRenderAll();
  btkLog('复盘：已揭示完整走势（' + BTK.bars.length + ' 根）', 'warn');
}

/* ============================ 统计 ============================ */

function btkStats() {
  var t = BTK.trades;
  var wins = t.filter(function (x) { return x.pnlR > 0.0001; }).length;
  var losses = t.filter(function (x) { return x.pnlR < -0.0001; }).length;
  var flats = t.length - wins - losses;                    // ±0R（保本出）单算一档，不混进"负"
  var totalR = t.reduce(function (s, x) { return s + x.pnlR; }, 0);
  var totalMoney = t.reduce(function (s, x) { return s + x.pnlAmount; }, 0);
  var best = 0, worst = 0;
  var streak = 0, maxStreak = 0;
  var peak = 0, cum = 0, maxDD = 0;
  t.forEach(function (x) {
    if (x.pnlR > best) best = x.pnlR;
    if (x.pnlR < worst) worst = x.pnlR;
    streak = x.pnlR < 0 ? streak + 1 : 0;
    if (streak > maxStreak) maxStreak = streak;
    cum += x.pnlR;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  });
  return {
    count: t.length, wins: wins, losses: losses, flats: flats,
    winRate: t.length ? wins / t.length * 100 : 0,
    totalR: totalR, totalMoney: totalMoney,
    avgR: t.length ? totalR / t.length : 0,
    best: best, worst: worst, maxLoseStreak: maxStreak, maxDD: maxDD
  };
}

/* ============================ 历史存档 ============================ */

/**
 * 本局记录写进「回测练习」的统一历史库。
 *
 * 两版（ECharts / klinecharts）共用 DataStore 的 backtest_history + backtest_trades：
 * 旧版「历史回测记录」里也能看到这里练的局，换设备也还在。
 * engine 字段标记来源版本；核心字段沿用旧版 summary 的口径，
 * R 值体系（totalR/avgR/bestR/worstR）另存，避免两套指标混在一起。
 */
function btkSaveHistory(reason) {
  if (typeof DataStore === 'undefined' || !DataStore.collection) return null;
  if (!BTK.trades || !BTK.trades.length || !BTK.symbol) return null;
  var st = btkStats();

  // ★ 必须补齐 ECharts 版 summary 的全部字段再存。
  //   旧版历史列表直接拿 s.realized.toFixed(2)、s.totalReturn >= 0 渲染，
  //   少一个字段就抛异常 → 整张历史表变空白（不只是这一行显示异常）。
  //   资金口径按「初始资金 + 每笔盈亏」推资金曲线，回撤也换算成百分比，
  //   与旧版保持一致；R 值另存 totalR/avgR/bestR/worstR，不混用。
  var initCap = +(BTK.settings.amount || 200000);
  var equity = initCap, peak = initCap, maxDDPct = 0, grossWin = 0, grossLoss = 0;
  BTK.trades.forEach(function (t) {
    var money = +(t.pnlAmount || 0);
    equity += money;
    if (money > 0) grossWin += money; else grossLoss += Math.abs(money);
    if (equity > peak) peak = equity;
    var dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
    if (dd > maxDDPct) maxDDPct = dd;
  });

  var entry = {
    id: 'btkc_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    engine: 'klinecharts',
    symbol: BTK.symbol,
    name: BTK.name || null,
    years: BTK.settings.years,
    adjust: BTK.effectiveAdjust || BTK.settings.adjust,
    dataRange: BTK.dataRange || null,
    finishedAt: new Date().toISOString(),
    finishReason: reason || null,

    // ===== 与旧版 summary 对齐（旧版历史表按这些字段渲染）=====
    initCapital: +initCap.toFixed(2),
    cash: +equity.toFixed(2),
    positionValue: 0,
    currentCapital: +equity.toFixed(2),
    positionPct: 0,
    position: 0,
    cost: 0,
    tradeCount: st.count,
    closedCount: st.count,
    winRate: +st.winRate.toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    totalReturn: +((equity / initCap - 1) * 100).toFixed(2),
    realized: +st.totalMoney.toFixed(2),
    unrealized: 0,
    maxDrawdown: +maxDDPct.toFixed(2),
    maxConsecLoss: st.maxLoseStreak,

    // ===== R 值口径（klinecharts 版特有）=====
    totalR: +st.totalR.toFixed(2),
    avgR: +st.avgR.toFixed(2),
    bestR: +st.best.toFixed(2),
    worstR: +st.worst.toFixed(2),

    trades: BTK.trades.slice()
  };
  try {
    DataStore.collection('backtest_history').save(entry);
    // ★ 不往 backtest_trades 里写明细。
    //   旧版「当前标的的交易记录」把这张表当成自己的流水直接渲染
    //   （BT_renderTrades 里大量 t.pnlAmount.toFixed / t.entry.toFixed），
    //   kc 的成交结构（entryDate/target/pnlR…）字段对不上 → 旧版整页报
    //   "Cannot read properties of undefined (reading 'toFixed')"。
    //   整局明细已经随 entry.trades 存在 history 里，旧版查看详情照样拿得到。
    btkLog('本局已存档（与 ECharts 版共用同一份历史；累计战绩按版本分开统计）', 'ok');
    // 累计战绩面板跟着更新。延迟一点：save() 是异步落盘，立刻读可能还没写进去
    setTimeout(function () { btkRenderCareer(); }, 400);
  } catch (e) {
    console.warn('[btk] 历史存档失败:', e && e.message);
  }
  return entry;
}

/* ============================ 渲染 ============================ */

function btkRenderAll() {
  btkRenderHead();
  btkRenderPosition();
  btkRenderStats();
  btkRenderTrades();
  btkRenderProgress();
  btkRenderChips();
  btkRenderButtons();
  btkRenderSettlement();
}

function btkRenderHead() {
  var el = $k('btkHead');
  if (!el) return;
  var bar = btkCurrentBar();
  if (!bar) { el.innerHTML = '<span class="btk-muted">尚未加载数据</span>'; return; }
  var i = BTK.revealIdx - 1;
  var prev = i > 0 ? BTK.bars[i - 1].close : bar.open;
  var pct = prev ? (bar.close - prev) / prev * 100 : 0;
  var ampl = prev ? (bar.high - bar.low) / prev * 100 : 0;
  // 量比：与 hover 浮层同一套算法（当日量 / 前 5 日均量），保持两处口径一致
  var vr = btkVolumeRatio(i);
  var adjCN = { qfq: '前复权', hfq: '后复权', raw: '不复权', auto: '自动' }[String(BTK.effectiveAdjust).toLowerCase()] || '';
  // 数据窗口信息靠右展示，让人一眼知道这局是在多长的历史里抽的、用的什么口径
  // 只留「根数 · 口径」：完整的日期跨度会把 head 挤成两行（当前日期和起点徽章已经给了关键时间点）
  var rangeTip = BTK.bars.length
    ? (BTK.bars.length + ' 根' + (adjCN ? ' · ' + adjCN : ''))
    : '';
  // 本局起点徽章：与图上那条橙色虚线呼应。图表永远右对齐到起点、构图雷同，
  // 不给个明确的起点显示，用户很难感知"这次抽到的是哪一段"。
  var startBar = BTK.bars[BTK.startIdx];
  var startBadge = startBar
    ? '<span class="btk-start-badge" title="本局起点（图上橙色虚线）：其后的 K 线需要你一根根揭示">' +
      '起点 ' + startBar.date + '</span>'
    : '';
  el.innerHTML =
    '<span class="btk-name">' + (BTK.name || BTK.symbol) + '</span>' +
    '<span class="btk-code">' + BTK.symbol + '</span>' +
    '<span class="btk-date">' + bar.date + '</span>' +
    '<span class="btk-muted">开</span><b>' + btkFmt(bar.open) + '</b>' +
    '<span class="btk-muted">高</span><b class="btk-up">' + btkFmt(bar.high) + '</b>' +
    '<span class="btk-muted">低</span><b class="btk-down">' + btkFmt(bar.low) + '</b>' +
    '<span class="btk-muted">收</span><b>' + btkFmt(bar.close) + '</b>' +
    '<span class="btk-pct ' + btkCls(pct) + '">' + (pct >= 0 ? '+' : '') + btkFmt(pct) + '%</span>' +
    '<span class="btk-muted">振幅</span><b>' + btkFmt(ampl) + '%</b>' +
    '<span class="btk-muted btk-small">量 ' + btkFmtVolume(bar) + '</span>' +
    '<span class="btk-muted">量比</span>' +
      (vr == null
        ? '<b title="前 5 日数据不足，无法计算">—</b>'
        : '<b class="' + btkCls(vr - 1) + '" title="当日成交量 / 前 5 日均量（不含当日）">' + btkFmt(vr) + '</b>') +
    startBadge +
    (rangeTip ? '<span class="btk-range-tip">' + rangeTip + '</span>' : '');
}

function btkRenderPosition() {
  var el = $k('btkPosition');
  if (!el) return;
  var p = BTK.position;
  var bar = btkCurrentBar();
  if (!p) {
    el.innerHTML = '<div class="btk-empty">当前空仓</div>';
    return;
  }
  var price = bar ? bar.close : p.entry;
  var floatR = (price - p.entry) / p.risk;
  var floatMoney = (price - p.entry) * p.shares;
  el.innerHTML =
    '<div class="btk-pos-row"><span>成本</span><b>' + btkFmt(p.entry) + '</b>' +
    '<span class="btk-muted">× ' + p.shares + ' 股</span></div>' +
    '<div class="btk-pos-row"><span>止损</span><b class="btk-down">' + btkFmt(p.stop) + '</b>' +
    '<span class="btk-muted">(-' + p.stopPct + '%)</span></div>' +
    '<div class="btk-pos-row"><span>止盈</span><b class="btk-up">' + btkFmt(p.target) + '</b>' +
    '<span class="btk-muted">(+' + p.targetR + 'R)</span></div>' +
    '<div class="btk-pos-row"><span>现价</span><b>' + btkFmt(price) + '</b></div>' +
    '<div class="btk-pos-row btk-pos-strong"><span>浮动</span>' +
    '<b class="' + btkCls(floatR) + '">' + btkR(floatR) + '</b>' +
    '<span class="' + btkCls(floatR) + '">' + btkMoney(floatMoney) + '</span></div>' +
    '<div class="btk-pos-row btk-small"><span>期间最大浮盈 / 浮亏</span>' +
    '<b class="btk-up">' + btkR(p.mfeR || 0) + '</b><b class="btk-down">' + btkR(p.maeR || 0) + '</b></div>' +
    '<div class="btk-pos-row btk-small"><span>持仓天数</span><b>' + (BTK.revealIdx - 1 - p.entryIdx) + ' 根</b></div>';
}

function btkRenderStats() {
  var el = $k('btkStats');
  if (!el) return;
  var s = btkStats();
  el.innerHTML =
    '<div class="btk-stat"><span>交易笔数</span><b>' + s.count + '</b></div>' +
    '<div class="btk-stat"><span>胜率</span><b>' + btkFmt(s.winRate, 1) + '%</b>' +
    '<span class="btk-muted btk-small">' + s.wins + '胜 / ' + s.losses + '负 / ' + s.flats + '平</span></div>' +
    '<div class="btk-stat"><span>累计 R</span><b class="' + btkCls(s.totalR) + '">' + btkR(s.totalR) + '</b></div>' +
    '<div class="btk-stat"><span>平均 R</span><b class="' + btkCls(s.avgR) + '">' + btkR(s.avgR) + '</b></div>' +
    '<div class="btk-stat"><span>盈亏金额</span><b class="' + btkCls(s.totalMoney) + '">' + btkMoney(s.totalMoney) + '</b></div>' +
    '<div class="btk-stat"><span>最好 / 最差</span><b class="btk-up">' + btkR(s.best) + '</b>' +
    '<b class="btk-down">' + btkR(s.worst) + '</b></div>' +
    '<div class="btk-stat"><span>最大连亏</span><b>' + s.maxLoseStreak + ' 笔</b></div>' +
    '<div class="btk-stat"><span>R 曲线最大回撤</span><b class="btk-down">' + btkFmt(s.maxDD, 2) + 'R</b></div>';
}

/* ---- 累计战绩（跨局 / 跨版本）----
 *
 * 数据源是两版共用的 DataStore「backtest_history」：
 * ECharts 版点「完成回测」写一份，kc 版每局结束写一份，所以这里统计的是
 * **两个页面练过的全部局**，不是只算 kc 自己的。
 * 聚合口径统一在 utils.js 的 btHistoryAggregate()（胜率按笔加权等），这里只负责画。
 */
var BTK_career = null;        // 最近一次聚合结果（**只含本版 klinecharts 的局**）
var BTK_careerAll = null;     // {echarts, klinecharts, total} 两版各有多少局（空状态提示用）
var BTK_careerSeq = 0;        // 并发守卫：切换太快时只认最后一次

function btkRenderCareer() {
  var el = $k('btkCareer');
  if (!el) return;
  if (typeof DataStore === 'undefined' || !DataStore.collection) {
    el.innerHTML = '<div class="btk-muted" style="grid-column:1/-1">历史库未就绪（DataStore 未加载）</div>';
    return;
  }
  var mySeq = ++BTK_careerSeq;
  DataStore.collection('backtest_history').getAll().then(function (list) {
    if (mySeq !== BTK_careerSeq) return;   // 已有更新的请求
    // ★ 只统计本版（klinecharts）的局：两版共用同一份 history，
    //   但玩法差异大（逐根揭示 + R 计法 vs 全量回测看收益），混在一起平均没意义
    BTK_career = (typeof btHistoryAggregate === 'function')
      ? btHistoryAggregate(list || [], 'klinecharts')
      : null;
    BTK_careerAll = (typeof btHistoryEngineCounts === 'function')
      ? btHistoryEngineCounts(list || [])
      : null;
    btkPaintCareer();
  }).catch(function (e) {
    if (mySeq !== BTK_careerSeq) return;
    el.innerHTML = '<div class="btk-muted" style="grid-column:1/-1">读取历史失败：' +
      btkEsc(e && e.message) + '</div>';
  });
}

function btkEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
  });
}

function btkPaintCareer() {
  var el = $k('btkCareer');
  if (!el) return;
  var a = BTK_career;
  if (!a || !a.sessions) {
    // 分清"真的没练过"和"练在 ECharts 版了"——两版累计战绩各算各的，
    // 不给这句提示的话，用户在旧版练了 20 局、打开本版看到空白会以为数据丢了
    var other = (BTK_careerAll && BTK_careerAll.echarts) || 0;
    el.innerHTML = '<div class="btk-muted" style="grid-column:1/-1">' +
      '本版还没有练习记录' +
      (other
        ? '——ECharts 版有 ' + other + ' 局，两版累计战绩分开统计，不会混在一起'
        : '——走完一局并结算后会自动累计') +
      '</div>';
    return;
  }
  // 收益/盈亏用 A 股配色：正=红、负=绿
  var pnlCls = a.totalPnl > 0 ? 'btk-up' : (a.totalPnl < 0 ? 'btk-down' : '');
  var avgCls = a.avgReturn > 0 ? 'btk-up' : (a.avgReturn < 0 ? 'btk-down' : '');
  var html =
    '<div class="btk-stat"><span>练习局数</span><b>' + a.sessions + ' 局</b>' +
      '<span class="btk-muted btk-small">' + a.distinctSymbols + ' 只标的</span></div>' +
    '<div class="btk-stat"><span>累计交易</span><b>' + a.trades + ' 笔</b>' +
      '<span class="btk-muted btk-small">已平仓 ' + a.closed + ' 笔</span></div>' +
    '<div class="btk-stat"><span>总胜率</span><b>' + btkFmt(a.winRate, 1) + '%</b>' +
      '<span class="btk-muted btk-small">' + a.wins + '胜 / ' + a.losses + '负</span></div>' +
    '<div class="btk-stat"><span>赚钱的局</span><b>' + btkFmt(a.winSessionRate, 0) + '%</b>' +
      '<span class="btk-muted btk-small">' + a.winSessions + '/' + a.sessions + ' 局</span></div>' +
    '<div class="btk-stat"><span>累计盈亏</span><b class="' + pnlCls + '">' + btkMoney(a.totalPnl) + '</b></div>' +
    '<div class="btk-stat"><span>平均每局</span><b class="' + avgCls + '">' +
      (a.avgReturn >= 0 ? '+' : '') + btkFmt(a.avgReturn, 2) + '%</b></div>' +
    '<div class="btk-stat"><span>最好 / 最差单局</span><b class="btk-up">+' +
      btkFmt(a.bestReturn, 2) + '%</b>' +
      '<b class="btk-down">' + btkFmt(a.worstReturn, 2) + '%</b></div>' +
    '<div class="btk-stat"><span>平均盈亏比</span><b>' +
      (a.avgPF == null ? '—' : btkFmt(a.avgPF, 2)) + '</b></div>' +
    '<div class="btk-stat"><span>最差单局回撤</span><b class="btk-down">' +
      btkFmt(a.maxDrawdown, 2) + '%</b></div>' +
    '<div class="btk-stat"><span>最大连亏</span><b>' + a.maxConsecLoss + ' 笔</b></div>';

  // R 值只有 klinecharts 版有记录，没练过 kc 局就不显示这两格（免得一直显示 0R 误导）
  if (a.rSessions > 0) {
    html +=
      '<div class="btk-stat"><span>累计 R</span><b class="' + btkCls(a.totalR) + '">' + btkR(a.totalR) + '</b>' +
        '<span class="btk-muted btk-small">' + a.rSessions + ' 局有 R 记录</span></div>' +
      '<div class="btk-stat"><span>平均 R</span><b class="' + btkCls(a.avgR) + '">' + btkR(a.avgR) + '</b></div>';
  }
  el.innerHTML = html;
}

function btkRenderTrades() {
  var el = $k('btkTrades');
  if (!el) return;
  if (!BTK.trades.length) {
    el.innerHTML = '<div class="btk-empty">还没有完成的交易</div>';
    return;
  }
  var rows = BTK.trades.map(function (t, i) {
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + t.entryDate + '</td>' +
      '<td>' + btkFmt(t.entry) + '</td>' +
      '<td>' + t.exitDate + '</td>' +
      '<td>' + btkFmt(t.exit) + '</td>' +
      '<td class="' + btkCls(t.pnlR) + '">' + btkR(t.pnlR) + '</td>' +
      '<td class="' + btkCls(t.pnlAmount) + '">' + Math.round(t.pnlAmount).toLocaleString('zh-CN') + '</td>' +
      '<td class="btk-small">' + t.reason + '</td>' +
      '</tr>';
  }).join('');
  el.innerHTML = '<table class="btk-table"><thead><tr>' +
    '<th>#</th><th>买入日</th><th>买入价</th><th>卖出日</th><th>卖出价</th>' +
    '<th>R</th><th>盈亏(元)</th><th>原因</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function btkRenderProgress() {
  var bar = $k('btkProgressBar');
  var txt = $k('btkProgressText');
  if (!BTK.bars.length) { if (txt) txt.textContent = '未开始'; return; }
  var total = BTK.endIdx - BTK.startIdx;
  var done = Math.max(0, BTK.revealIdx - BTK.startIdx);
  var pct = total > 0 ? done / total * 100 : 0;
  if (bar) bar.style.width = pct.toFixed(1) + '%';
  if (txt) {
    txt.textContent = '已揭示 ' + done + ' / ' + total + ' 根' +
      (BTK.finished ? '（本局已结束）' : '') +
      ' · 起点 ' + BTK.bars[BTK.startIdx].date;
  }
}

function btkRenderChips() {
  var el = $k('btkChips');
  if (!el) return;
  // MA 的按钮文字要跟着均线设置走，否则改完周期还写着 MA5/10/20，看着像没生效
  var maLabel = 'MA ' + btkMaCalcParams().join('/');
  var defs = [
    ['ma', maLabel], ['boll', 'BOLL'], ['vol', 'VOL'],
    ['macd', 'MACD'], ['kdj', 'KDJ'], ['ampl', '振幅']
  ];
  el.innerHTML = defs.map(function (d) {
    return '<button type="button" class="btk-chip' + (BTK.indicators[d[0]] ? ' btk-chip-on' : '') +
      '" onclick="btkToggleIndicator(\'' + d[0] + '\')">' + d[1] + '</button>';
  }).join('');
}

function btkRenderButtons() {
  var canNext = BTK.bars.length > 0 && !BTK.finished && BTK.revealIdx < BTK.endIdx;
  var canBuy = BTK.bars.length > 0 && !BTK.finished && !BTK.position && BTK.revealIdx > BTK.startIdx;
  var canClose = !!BTK.position && !BTK.finished;
  var next = $k('btkNextBtn'), buy = $k('btkBuyBtn'), close = $k('btkCloseBtn'), all = $k('btkAllBtn');
  if (next) next.disabled = !canNext;
  if (buy) buy.disabled = !canBuy;
  if (close) close.disabled = !canClose;
  if (all) all.disabled = !BTK.bars.length;

  // 自动播放按钮：播放中必须保持可点（否则暂停不了）
  var auto = $k('btkAutoBtn');
  if (auto) {
    var playing = btkAutoPlaying();
    if (playing) auto.classList.add('is-playing');
    else auto.classList.remove('is-playing');
    // ⚠️ 只在文字变了才改，而且用 textContent 而不是 innerHTML：
    //   播放中每 200ms 都会走一次 btkRenderAll → btkRenderButtons，
    //   每次重设 innerHTML 会重建文本节点；用户刚好在 mousedown 与 mouseup
    //   之间撞上一次，click 就丢了（表现是"点了暂停没反应，得再点一次"）。
    var label = playing ? '⏸ 暂停' : '▶ 自动';
    if (auto.textContent !== label) auto.textContent = label;
    auto.title = playing
      ? '暂停自动播放（当前每 ' + BTK_AUTO_MS + ' 毫秒一根）'
      : '自动播放：每 0.2 秒推进一根，再点一下暂停（点「下一根」也会暂停）';
    auto.disabled = !playing && !!btkAutoBlockReason();
  }
}

function btkRenderSettlement() {
  var el = $k('btkSettle');
  if (!el) return;
  if (!BTK.finished) { el.style.display = 'none'; el.innerHTML = ''; return; }
  var s = btkStats();
  el.style.display = 'block';
  el.innerHTML =
    '<div class="btk-settle-title">🏁 本局结算（' + BTK.finishReason + '）</div>' +
    '<div class="btk-settle-grid">' +
      '<div><span>交易笔数</span><b>' + s.count + '</b></div>' +
      '<div><span>胜率</span><b>' + btkFmt(s.winRate, 1) + '%</b></div>' +
      '<div><span>累计 R</span><b class="' + btkCls(s.totalR) + '">' + btkR(s.totalR) + '</b></div>' +
      '<div><span>平均 R</span><b class="' + btkCls(s.avgR) + '">' + btkR(s.avgR) + '</b></div>' +
      '<div><span>盈亏</span><b class="' + btkCls(s.totalMoney) + '">' + btkMoney(s.totalMoney) + '</b></div>' +
      '<div><span>最大连亏</span><b>' + s.maxLoseStreak + ' 笔</b></div>' +
    '</div>' +
    '<div class="btk-settle-hint">' + (s.count === 0
      ? '这一局你全程空仓 —— 忍住不做也是一种决策，但记得复盘：是没信号还是没敢下手？'
      : (s.totalR > 0 ? '正期望。重点看：这些 R 是靠 1~2 笔大赚撑起来的，还是稳定的？'
                      : '负期望。重点看：是止损太紧被扫，还是进场位置本身就差？')) +
    '</div>' +
    '<div class="btk-settle-actions">' +
      '<button type="button" class="btk-btn" onclick="btkRevealAll()">👀 看完整走势（事后复盘）</button>' +
      '<button type="button" class="btk-btn btk-btn-primary" onclick="btkStartPractice()">🎲 再来一局</button>' +
    '</div>';
  // 结算面板的统计要跟 btkRenderStats 一致：这里同步刷新侧栏
}

/* ============================ 搜索 ============================ */

function btkRenderSymbolList(items, hint) {
  var el = $k('btkSymList');
  if (!el) return;
  if (hint) {
    el.innerHTML = '<div class="btk-sym-hint">' + hint + '</div>';
    el.style.display = 'block';
    return;
  }
  if (!items.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.innerHTML = items.map(function (it) {
    var sym = (it.symbol || it.code || '').toLowerCase();
    var name = it.name || '';
    return '<div class="btk-sym-item" data-symbol="' + sym + '" data-name="' + name + '">' +
      '<b>' + sym + '</b><span>' + name + '</span></div>';
  }).join('');
  el.style.display = 'block';
  Array.prototype.forEach.call(el.querySelectorAll('.btk-sym-item'), function (node) {
    node.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      var input = $k('btkSymbol');
      if (input) input.value = node.getAttribute('data-symbol');
      el.style.display = 'none';
      btkStartPractice();
    });
  });
}

function btkFetchSuggestions(q) {
  var seq = ++BTK.searchSeq;
  btkFetch('/api/market/search?q=' + encodeURIComponent(q)).then(function (res) {
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return res.json();
  }).then(function (data) {
    if (seq !== BTK.searchSeq) return;
    var items = (data && data.results) || [];
    btkRenderSymbolList(items, items.length ? null : '没匹配到（可直接输 sh/sz + 6 位数字，或 6 位纯数字）');
  }).catch(function () {
    if (seq !== BTK.searchSeq) return;
    btkRenderSymbolList([], '（搜索服务暂不可用，可直接输代码）');
  });
}

/* ============================ 全局搜索（header 用） ============================ */

window.performGlobalSearch = function (q) {
  var ql = String(q || '').trim().toLowerCase();
  if (!ql) return [];
  var pool = [];
  try {
    var recent = JSON.parse(localStorage.getItem(BTK_RECENT_KEY) || '[]');
    recent.forEach(function (x) { pool.push([x.symbol, x.name]); });
  } catch (e) {}
  BTK_COMMON.forEach(function (x) { pool.push(x); });
  var seen = {};
  var out = [];
  pool.forEach(function (x) {
    if (seen[x[0]]) return;
    if (x[0].indexOf(ql) === -1 && String(x[1]).indexOf(ql) === -1) return;
    seen[x[0]] = 1;
    out.push({
      label: '🎯 ' + x[0] + ' · ' + (x[1] || ''),
      sublabel: '用它开一局回测练习',
      onClick: function () {
        var input = $k('btkSymbol');
        if (input) input.value = x[0];
        btkStartPractice();
      }
    });
  });
  return out.slice(0, 8);
};

/* ============================ 事件绑定 ============================ */

function btkBindEvents() {
  var startBtn = $k('btkStartBtn');
  if (startBtn) startBtn.addEventListener('click', btkStartPractice);

  // 随机标的：抽一只 + 直接开局
  var randSymBtn = $k('btkRandomSymBtn');
  if (randSymBtn) randSymBtn.addEventListener('click', btkRandomSymbol);

  // 均线设置：6 组（色块 + 周期）。
  // 用 change 而不是 input：输入过程中每敲一个字符就重算/重绘太浪费，
  // 而且用户敲 "1" 想输入 "120" 时中间态会被当成 MA1 去算一次指标。
  for (var mi = 0; mi < BTK_MA_COUNT; mi++) {
    var mIds = ['btkMaP' + mi, 'btkMaColor' + mi];
    for (var mj = 0; mj < mIds.length; mj++) {
      var mEl = $k(mIds[mj]);
      if (mEl) mEl.addEventListener('change', btkApplyMa);
    }
  }

  // ★ 手动操作一律先停播：手点和 200ms 定时器同时跑，节奏会乱成一团
  var nextBtn = $k('btkNextBtn');
  if (nextBtn) nextBtn.addEventListener('click', function () {
    if (btkAutoPlaying()) btkStopAuto('手动单步');
    btkNextBar();
  });
  var buyBtn = $k('btkBuyBtn');
  if (buyBtn) buyBtn.addEventListener('click', function () {
    if (btkAutoPlaying()) btkStopAuto('手动买入');
    btkBuy();
  });
  var closeBtn = $k('btkCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', function () {
    if (btkAutoPlaying()) btkStopAuto('手动平仓');
    btkClose('手动平仓', null);
  });
  var autoBtn = $k('btkAutoBtn');
  if (autoBtn) autoBtn.addEventListener('click', btkToggleAuto);
  var allBtn = $k('btkAllBtn');
  if (allBtn) allBtn.addEventListener('click', btkRevealAll);
  var finBtn = $k('btkFinishBtn');
  if (finBtn) finBtn.addEventListener('click', function () { btkFinish('手动结束'); });

  // 标的输入：防抖搜索 + 回车直接开始
  var input = $k('btkSymbol');
  if (input) {
    var timer = null;
    input.addEventListener('input', function () {
      var q = input.value.trim();
      if (timer) clearTimeout(timer);
      if (!q) { btkRenderSymbolList([]); return; }
      if (/^(sh|sz)\d{6}$/i.test(q)) { btkRenderSymbolList([]); return; }
      timer = setTimeout(function () { btkFetchSuggestions(q); }, 250);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); btkRenderSymbolList([]); btkStartPractice(); }
    });
    input.addEventListener('blur', function () { setTimeout(function () { btkRenderSymbolList([]); }, 150); });
  }

  // 揭示根数切到「全部剩余」时，随机起点无意义 → 立即禁用（不必等到点「开始」）
  var futSel = $k('btkFuture');
  if (futSel) futSel.addEventListener('change', function () {
    var isAll = futSel.value === 'all';
    var r = $k('btkRandom');
    if (r) { r.disabled = isAll; r.checked = !isAll; }
  });

  // 止损/止盈：改完失焦即保存（不必点「开始」），否则改了半天刷新又回默认值
  [['btkStopPct', 'stopPct', '7'], ['btkTargetR', 'targetR', '2']].forEach(function (d) {
    var el = $k(d[0]);
    if (!el) return;
    el.addEventListener('change', function () {
      var v = parseFloat(el.value);
      if (isNaN(v)) return;
      BTK.settings[d[1]] = v;
      btkSaveSettings();
    });
  });

  // 随机起点：勾选状态也即时存（它影响下一局的起点，刷新后不该被重置）
  var rndChk = $k('btkRandom');
  if (rndChk) rndChk.addEventListener('change', function () {
    BTK.settings.randomStart = !!rndChk.checked;
    BTK.randomStart = BTK.settings.randomStart;
    btkSaveSettings();
  });

  // 键盘：空格/→ 下一根，B 买入，C 平仓，R 重开（输入框内不触发）
  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    // 键盘操作同样先停播，避免"按着空格又跑着定时器"
    if (e.code === 'Space' || e.key === 'ArrowRight') {
      e.preventDefault();
      if (btkAutoPlaying()) btkStopAuto('手动单步');
      btkNextBar();
    }
    else if (e.key === 'b' || e.key === 'B') {
      if (btkAutoPlaying()) btkStopAuto('手动买入');
      btkBuy();
    }
    else if (e.key === 'c' || e.key === 'C') {
      if (btkAutoPlaying()) btkStopAuto('手动平仓');
      btkClose('手动平仓', null);
    }
    else if (e.key === 'r' || e.key === 'R') { btkStartPractice(); }
  });

  // 窗口尺寸变化必须 resize，否则 canvas 会被拉花
  var rzTimer = null;
  window.addEventListener('resize', function () {
    if (rzTimer) clearTimeout(rzTimer);
    rzTimer = setTimeout(function () { if (BTK.chart) BTK.chart.resize(); }, 150);
  });

  // 主题切换：包一层（header.js 的 toggleTheme 是全局函数）
  if (typeof window.toggleTheme === 'function') {
    var orig = window.toggleTheme;
    window.toggleTheme = function () {
      orig.apply(this, arguments);
      setTimeout(function () {
        if (BTK.chart) {
          try { BTK.chart.setStyles(btkStyles()); } catch (e) {}
          // 暗色下黑/深灰要提亮，否则均线在深背景上看不见
          btkApplyMaToChart();
        }
      }, 60);
    };
  }
}

/* ============================ 启动 ============================ */

function btkBoot() {
  // 先把上次的设置读回来（此前只有 save 没有 load，等于设置从不生效）
  btkLoadSettings();
  var s = BTK.settings;
  var map = { btkSymbol: 'symbol', btkYears: 'years', btkAdjust: 'adjust', btkWarmup: 'warmup', btkFuture: 'future', btkAmount: 'amount', btkStopPct: 'stopPct', btkTargetR: 'targetR' };
  Object.keys(map).forEach(function (id) {
    var el = $k(id);
    if (el && s[map[id]] !== undefined) el.value = s[map[id]];
  });
  // 复选框不能走上面的 el.value 回填（要用 checked）；老存储没有该字段 → 默认勾选
  var rndEl = $k('btkRandom');
  if (rndEl) rndEl.checked = (s.randomStart !== false);
  // 全量模式下随机起点无意义 → 首屏就禁用（否则用户会疑惑"怎么没随机"）
  if (rndEl && String(s.future) === 'all') { rndEl.disabled = true; rndEl.checked = false; }
  // 均线配置回填（必须在 btkBindEvents 之前：先让界面显示上次的值，
  // 再绑 change，避免"程序赋值触发一次 change"）
  btkMaFillUI();

  btkBindEvents();
  btkRenderChips();
  btkRenderAll();
  if (!btkEnsureLib()) return;
  btkLog('klinecharts ' + (BTK.libVersion || '') + ' 已加载（本地 vendor）', 'ok');
  // 首屏直接开一局（用上次的标的），避免用户进来只看到一块空白坐标轴
  if (s.symbol) btkStartPractice();

  // 标的记忆 + 回测历史都走 DataStore（与 ECharts 版共用同一份库）：
  // 先把 IndexedDB 初始化好，再从服务器补一次共享标的（换设备场景）。
  // 只回填空着的输入框，避免打断刚因为本机记录自动开的那一局。
  if (typeof DataStore !== 'undefined' && DataStore.init) {
    DataStore.init().then(function () {
      return (typeof btSharedPull === 'function') ? btSharedPull() : null;
    }).then(function (shared) {
      if (!shared || !shared.symbol) return;
      var input = $k('btkSymbol');
      if (input && !input.value) {
        input.value = shared.symbol;
        BTK.settings.symbol = shared.symbol;
        btkRenderChips();
      }
    }).catch(function () { })
      // 累计战绩要等 DataStore 就绪才读得到（首屏那一块先显示"统计中…"）
      .then(function () { btkRenderCareer(); });
  } else {
    btkRenderCareer();
  }

  // 练习轮次进度（随机按钮旁边的小字）：失败静默，不影响页面
  btkLoadUniverseStats();
}

document.addEventListener('DOMContentLoaded', btkBoot);
