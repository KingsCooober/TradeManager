/**
 * 回测页 — 入口模块
 *
 * 职责：
 *   - BT_init() 页面初始化
 *   - BT_loadData() 拉取 K 线并渲染
 *   - 按钮事件绑定
 *   - 协调 chart 和 trade 两个子模块
 */
// localStorage 键（用于跨页保留用户输入）
var BT_LS_PREFIX = 'bt_state_';
function BT_lsKey(k) { return BT_LS_PREFIX + k; }

// 全局：当前正在回测的标的代码（sh600000 / sz000001 等）
var BT_currentSymbol = null;
// 全局：当前正在回测的标的名称（如「浦发银行」，由后端在 K 线接口中一起返回）
var BT_currentSymbolName = null;

// ===== 持久化：标的/周期/MA/缩放/光标位置 =====
function BT_saveState() {
  try {
    var symEl = document.getElementById('btSymbol');
    var yrsEl = document.getElementById('btYears');
    var vbEl  = document.getElementById('btVisibleBars');
    var ma1 = document.getElementById('ma1');
    var ma2 = document.getElementById('ma2');
    var ma3 = document.getElementById('ma3');
    var ma4 = document.getElementById('ma4');
    // 关键：保存 BT_visibleBars（内存变量）而不是 vbEl.value（select 显示值），
    //       这样 +/- 缩放后产生的非标称值（如 167）才能正确恢复
    var vbToSave = (typeof BT_visibleBars === 'number' && BT_visibleBars > 0)
      ? String(BT_visibleBars)
      : (vbEl && vbEl.value);
    var state = {
      symbol:       symEl && symEl.value,
      years:        yrsEl && yrsEl.value,
      visibleBars:  vbToSave,
      ma1: ma1 && ma1.value,
      ma2: ma2 && ma2.value,
      ma3: ma3 && ma3.value,
      ma4: ma4 && ma4.value,
      cursorIdx:    BT_currentIdx,
      savedAt:      Date.now()
    };
    localStorage.setItem(BT_lsKey('form'), JSON.stringify(state));

    // 同步到 DataStore（跨设备同步，fire-and-forget）
    if (typeof DataStore !== 'undefined') {
      DataStore.collection('backtest_form').save(
        Object.assign({ id: 'current' }, state)
      );
    }
  } catch (e) { /* ignore quota */ }
}

function BT_loadState() {
  try {
    var raw = localStorage.getItem(BT_lsKey('form'));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

// 入口
function BT_init() {
  // 0) 初始化 DataStore（异步，不阻塞页面渲染）
  if (typeof BT_initStore === 'function') {
    BT_initStore().then(function() {
      // DataStore ready → 从服务器拉取数据 + 迁移 localStorage 旧数据
      BT_migrateHistoryFromLocalStorage();
      BT_renderHistory();  // 从 DataStore 重新渲染历史记录
    });
  }

  // 1) 恢复表单状态（标的/周期/MA/缩放）— localStorage 即时恢复
  var saved = BT_loadState();
  if (saved) {
    if (saved.symbol)      document.getElementById('btSymbol').value = saved.symbol;
    if (saved.years)       document.getElementById('btYears').value  = saved.years;
    if (saved.visibleBars) {
      var _v = parseInt(saved.visibleBars);
      if (!isNaN(_v) && _v > 0) {
        // 关键：直接写回 BT_visibleBars 内存变量，避免 select.value 无匹配项时静默失败
        BT_visibleBars = _v;
      }
      document.getElementById('btVisibleBars').value = saved.visibleBars;  // 同步显示（即使没有匹配项也设上）
    }
    // 关键：用 typeof === 'string' 而不是 if (saved.ma1)，让空字符串也能恢复（清空的 MA）
    if (typeof saved.ma1 === 'string') document.getElementById('ma1').value = saved.ma1;
    if (typeof saved.ma2 === 'string') document.getElementById('ma2').value = saved.ma2;
    if (typeof saved.ma3 === 'string') document.getElementById('ma3').value = saved.ma3;
    if (typeof saved.ma4 === 'string') document.getElementById('ma4').value = saved.ma4;
    // 同步恢复 BT_maPeriods 内存变量（否则 K线图还会用默认 [5,10,20,60]）
    var _restoredMA = [];
    ['ma1', 'ma2', 'ma3', 'ma4'].forEach(function(id) {
      var _vv = parseInt(saved[id]);
      if (!isNaN(_vv) && _vv > 0 && _vv <= 250) _restoredMA.push(_vv);
    });
    if (_restoredMA.length > 0) BT_maPeriods = _restoredMA;
  }
  // 兜底：若 BT_visibleBars 仍是默认值 250 但 select 上有用户上次选择的值，从 select 同步一次
  if (typeof BT_visibleBars !== 'number' || BT_visibleBars === 250) {
    var _vbEl = document.getElementById('btVisibleBars');
    if (_vbEl && _vbEl.value) {
      var _vv = parseInt(_vbEl.value);
      if (!isNaN(_vv) && _vv > 0) BT_visibleBars = _vv;
    }
  }

  // 2) 同步顶部登录 UI（直接调本页内嵌版本）
  BT_updateHeaderSyncUI();

  // 3) 初始化 ECharts
  BT_initChart();

  // 3.1) 同步比例锁定按钮的 UI 状态
  BT_initZoomLockUI();

  // 4) 绑定 MA 周期输入框 change → 重画 + 持久化
  ['ma1', 'ma2', 'ma3', 'ma4'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', function() { BT_updateMAPeriods(); BT_saveState(); });
  });

  // 5) 显示开关
  var showMA = document.getElementById('showMA');
  var showMACD = document.getElementById('showMACD');
  var showVol = document.getElementById('showVol');
  var showEquity = document.getElementById('showEquity');
  if (showMA)     showMA.addEventListener('change', BT_toggleShowMA);
  if (showMACD)   showMACD.addEventListener('change', BT_toggleShowMACD);
  if (showVol)    showVol.addEventListener('change', BT_toggleShowVol);
  if (showEquity) showEquity.addEventListener('change', BT_toggleShowEquity);

  // 5.5) 指数下拉 → 重新加载指数图
  var idxEl = document.getElementById('btIndex');
  if (idxEl) idxEl.addEventListener('change', function() { BT_loadIndex(); BT_saveState(); });

  // 6) 标的/周期/显示根数 → change 即保存
  ['btSymbol', 'btYears', 'btVisibleBars'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', BT_saveState);
  });

  // 7) 标的输入框回车 → 加载
  var symbolInput = document.getElementById('btSymbol');
  if (symbolInput) {
    symbolInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') BT_loadData();
    });
    // 输入自动转小写
    symbolInput.addEventListener('input', function() {
      symbolInput.value = symbolInput.value.toLowerCase();
    });
  }

  // 8) 显示根数变化 → 重新设置 dataZoom 范围（不重画）
  var vbEl = document.getElementById('btVisibleBars');
  if (vbEl) vbEl.addEventListener('change', BT_applyVisibleBars);

  // 9) 键盘快捷键：← / → 移动光标
  document.addEventListener('keydown', function(e) {
    if (!BT_klineData) return;
    // 避免在 input 内触发
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowRight') { BT_nextBar(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { BT_prevBar(); e.preventDefault(); }
  });

  // 10) 监听登录状态变化（其他页面登录后跳回此页能立即看到）
  window.addEventListener('storage', function(e) {
    if (e.key === 'sync_user' || e.key === 'sync_token') {
      BT_updateHeaderSyncUI();
    }
  });
  window.addEventListener('user-login',  BT_updateHeaderSyncUI);
  window.addEventListener('user-logout', BT_updateHeaderSyncUI);

  // 11) 渲染初始空状态
  BT_renderTrades();
  BT_renderStats();

  // 11.1) 渲染历史回测记录（从 localStorage 读取）
  BT_renderHistory();

  // 11.2) 初始化大盘指数图表 + 加载默认指数
  if (typeof BT_initIndexChart === 'function') {
    BT_initIndexChart();
    BT_loadIndex(/*silent*/ true);
  }

  // 12) 自动加载：若上次有保存的标的 → 自动重拉
  if (saved && saved.symbol && /^(sh|sz|bj)\d{6}$/.test(saved.symbol)) {
    // 延迟一下，等 ECharts 容器 ready
    setTimeout(function() { BT_loadData(/*silent*/ true); }, 50);
  }
}

// ===== 顶部登录 UI 同步（main.js 中 updateHeaderSyncUI 的本地化版本） =====
function BT_updateHeaderSyncUI() {
  var user = null;
  try { user = (typeof syncModule !== 'undefined' && syncModule.getCurrentUser) ? syncModule.getCurrentUser() : null; } catch (e) {}
  var loggedIn  = document.getElementById('headerSyncLoggedIn');
  var loggedOut = document.getElementById('headerSyncLoggedOut');
  var userEl    = document.getElementById('headerUsername');
  var indicator = document.getElementById('syncIndicator');
  var adminMenu = document.getElementById('adminMenu');

  if (user) {
    if (user.role === 'admin') {
      // 管理员：只显示管理员菜单
      if (loggedIn)  loggedIn.style.display = 'none';
      if (loggedOut) loggedOut.style.display = 'none';
      if (adminMenu) adminMenu.style.display = 'flex';
    } else {
      if (loggedIn)  { loggedIn.style.display = 'flex'; loggedIn.style.alignItems = 'center'; loggedIn.style.gap = '8px'; }
      if (loggedOut) loggedOut.style.display = 'none';
      if (adminMenu) adminMenu.style.display = 'none';
      if (userEl) userEl.textContent = user.username;
    }
    if (indicator && typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      syncModule.setSyncIndicatorState('idle', '已登录');
    }
  } else {
    if (loggedIn)  loggedIn.style.display = 'none';
    if (loggedOut) { loggedOut.style.display = 'flex'; loggedOut.style.alignItems = 'center'; loggedOut.style.gap = '8px'; }
    if (adminMenu) adminMenu.style.display = 'none';
    if (indicator && typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      syncModule.setSyncIndicatorState('offline', '未登录');
    }
  }
}

// 加载 K 线数据
async function BT_loadData(silent) {
  var symbolEl = document.getElementById('btSymbol');
  var yearsEl  = document.getElementById('btYears');
  var symbol = (symbolEl && symbolEl.value || '').trim().toLowerCase();
  if (!/^(sh|sz|bj)\d{6}$/.test(symbol)) {
    if (!silent) BT_toast('标的格式错误，应为 sh/sz/bj + 6 位数字（如 sh600000）', 'error');
    return;
  }

  var count;
  switch (yearsEl.value) {
    case '1':   count = 250;  break;  // 1 年 ≈ 250 个交易日
    case '2':   count = 500;  break;
    case '3':   count = 750;  break;
    case '5':   count = 1200; break;
    case '7':   count = 1750; break;  // 7 年
    case '8':   count = 2000; break;  // 8 年
    case '10':  count = 2500; break;  // 10 年（后端 Baostock 一次拉到）
    default:    count = 1200;
  }

  var btn = document.getElementById('btnLoad');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 加载中…'; }

  try {
    var url = '/api/market/kline-stock/' + symbol + '?count=' + count;
    var res = await authFetch(url);
    if (!res.ok) {
      var errText = '';
      try { errText = (await res.json()).error || res.statusText; } catch (e) { errText = res.statusText; }
      throw new Error('HTTP ' + res.status + ': ' + errText);
    }
    var data = await res.json();
    // 缓存当前标的名称（来自后端 kline-stock 接口的 name 字段）
    BT_currentSymbolName = data.name || null;

    // 切换标的 → 重新加载交易记录
    if (BT_currentSymbol !== symbol) {
      BT_currentSymbol = symbol;
      await BT_loadTrades(symbol);
    }

    BT_renderKLine(data);
    BT_renderTrades();
    BT_renderStats();

    // 自动定位光标：每次加载都跳到最后一根（最新K线），保证窗口最右就是最新数据
    // 切换标的 / 刷新页面 / 改时间范围 → 都重新看最新
    var targetIdx = data.dates.length - 1;
    BT_setCursor(targetIdx, 'pinRight');  // 把光标钉在窗口最右

    // 主图加载完后，重新拉指数图（让 count 与主图一致 → 时间范围对齐）
    if (typeof BT_loadIndex === 'function') BT_loadIndex(/*silent*/ true);

    BT_saveState();  // 把最新 symbol/years/visibleBars 落盘
    if (!silent) {
      BT_toast('✅ ' + symbol + ' 加载完成：' + (data.count || data.dates.length) + ' 根 K 线' +
        (data.cached ? '（缓存）' : '（实时）'), 'success');
    }
  } catch (e) {
    console.error('[backtest] 加载失败:', e);
    if (!silent) BT_toast('加载失败：' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 加载 K 线'; }
  }
}

// 加载大盘指数 K 线（与主图解耦，时间窗口/K线根数自动同步）
//   - 与主图共用 Baostock/腾讯数据源，但调用更轻量（1 年数据足够看趋势）
//   - 切换指数时调用，初始化也调用
async function BT_loadIndex(silent) {
  var idxEl = document.getElementById('btIndex');
  var symbol = (idxEl && idxEl.value || 'sh000001').trim().toLowerCase();
  if (!/^(sh|sz)\d{6}$/.test(symbol)) {
    if (!silent) BT_toast('指数代码格式错误', 'error');
    return;
  }
  try {
    // 与主图拉相同根数（时间范围对齐 → 两图 dataZoom 同步才有意义）
    // 若主图还没加载，用主图 select 的 years 对应的 count 兜底
    var count;
    if (window.BT_klineData && window.BT_klineData.dates) {
      count = window.BT_klineData.dates.length;
    } else {
      var yearsEl = document.getElementById('btYears');
      var y = yearsEl ? yearsEl.value : '1';
      switch (y) {
        case '1':  count = 250;  break;
        case '2':  count = 500;  break;
        case '3':  count = 750;  break;
        case '5':  count = 1200; break;
        case '7':  count = 1750; break;
        case '8':  count = 2000; break;
        case '10': count = 2500; break;
        default:   count = 1200;
      }
    }
    var url = '/api/market/kline-stock/' + symbol + '?count=' + count;
    var res = await authFetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    // API 返回的 JSON 顶层带 name（指数名），传给 BT_renderIndexChart
    var indexName = data && data.name || symbol;
    BT_renderIndexChart(data, indexName);
    if (!silent) BT_toast('✅ 指数 ' + (indexName || symbol) + ' 加载完成', 'success');
  } catch (e) {
    console.error('[index] 加载失败:', e);
    if (!silent) BT_toast('指数加载失败：' + e.message, 'error');
  }
}

// 仓位选择：半仓/全仓（按当前可用资金反算手数，A 股 1 手 = 100 股）
//   - 全仓手数 = floor(可用现金 / 价格 / 100) 手
//   - 半仓手数 = floor(可用现金 × 0.5 / 价格 / 100) 手
//   - 实际买入股数 = 手数 × 100
//   - 资金不足 1 手时 toast 警告
var BT_positionMode = 'full';
var BT_LOT_SIZE = 100;            // A 股 1 手 = 100 股
function BT_setPosition(mode) {
  BT_positionMode = mode;
  var btns = document.querySelectorAll('.bt-pos-btn');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('data-pos') === mode) btns[i].classList.add('active');
    else btns[i].classList.remove('active');
  }
  if (typeof BT_saveState === 'function') BT_saveState();
}

// 按当前可用现金 × 仓位比例反算买入股数
function BT_calcBuyVolume() {
  if (!BT_klineData || !BT_currentClose) return 0;
  var price = BT_currentClose;
  if (!price || price <= 0) return 0;
  var cash = typeof BT_cash === 'number' ? BT_cash : 0;
  // 预留 0.5% 防止手续费/余数误差
  var usable = cash * 0.995;
  // 仓位比例：全仓=1，半仓=0.5
  var ratio = BT_positionMode === 'half' ? 0.5 : 1.0;
  var lotCash = price * BT_LOT_SIZE;  // 1 手需要的资金
  if (lotCash <= 0) return 0;
  // 手数 = floor(可用资金 × 比例 / 单手价)
  var lots = Math.floor(usable * ratio / lotCash);
  if (lots < 1) return 0;
  return lots * BT_LOT_SIZE;
}

function BT_calcSellVolume() {
  if (!BT_position || BT_position.volume === 0) return 0;
  // 卖出逻辑保持：半仓 = 卖一半，全仓 = 全部清仓
  return BT_positionMode === 'half'
    ? Math.round(BT_position.volume * 0.5)
    : BT_position.volume;
}

// 买入按钮
function BT_buy() {
  if (!BT_klineData) { BT_toast('请先加载 K 线', 'warn'); return; }
  if (!BT_currentDate) { BT_toast('请在 K 线上移动光标', 'warn'); return; }
  var price = parseFloat(document.getElementById('btPrice').value) || BT_currentClose;
  var volume = BT_calcBuyVolume();
  if (volume <= 0) { BT_toast('无法计算买入数量', 'warn'); return; }
  BT_doBuy(BT_currentDate, price, volume);
  BT_saveState();
}

// 卖出按钮
function BT_sell() {
  if (!BT_klineData) { BT_toast('请先加载 K 线', 'warn'); return; }
  if (!BT_currentDate) { BT_toast('请在 K 线上移动光标', 'warn'); return; }
  if (!BT_position || BT_position.volume === 0) { BT_toast('当前无持仓', 'warn'); return; }
  var price = parseFloat(document.getElementById('btPrice').value) || BT_currentClose;
  var volume = BT_calcSellVolume();
  if (volume <= 0) { BT_toast('无法计算卖出数量', 'warn'); return; }
  BT_doSell(BT_currentDate, price, volume);
  BT_saveState();
}

// 清空当前标的交易
function BT_clearTrades() {
  if (!BT_currentSymbol) { BT_toast('请先加载 K 线', 'warn'); return; }
  if (BT_trades.length === 0) { BT_toast('当前没有交易', 'warn'); return; }
  if (!confirm('确定清空 ' + BT_currentSymbol + ' 的全部 ' + BT_trades.length + ' 笔交易？此操作不可撤销！')) return;
  BT_clearAllTrades();
  BT_toast('已清空 ' + BT_currentSymbol + ' 的全部交易', 'success');
}

// 下一根K线（光标右移）—— 以"当前窗口最右一根的下一根"为目标
// 这样用户在窗口内反复点"下一根"，窗口会跟随滚动而不是被压扁
function BT_nextBar() {
  if (!BT_klineData || !BT_klineData.dates.length) { BT_toast('请先加载 K 线', 'warn'); return; }
  var max = BT_klineData.dates.length - 1;
  // 自检 + 纠正：ECharts slider moveHandle 拖到边界时会把窗口压扁（宽度 → 0）
  // 在计算 next 前先纠正，保证后续 BT_calcZoomRangeForIdx 用正确的宽度
  BT_ensureZoomRangeHealthy();
  var next;
  if (BT_userZoomRange && BT_userZoomRange.end > BT_userZoomRange.start) {
    // 用户曾拖动 slider：以窗口右边界对应的 idx + 1 为基准
    var endIdx = Math.round(BT_userZoomRange.end / 100 * max);
    next = Math.min(max, endIdx + 1);
  } else {
    next = Math.min(max, (BT_currentIdx == null ? max : BT_currentIdx + 1));
  }
  BT_setCursor(next, 'pinRight');
  BT_saveState();
}

// 上一根K线（光标左移）—— 始终以"窗口右边界 idx - 1"为基准（与 nextBar 镜像）
// 不再以窗口最左 idx - 1 为基准（那样会导致窗口一下"跳"一整个宽度）
function BT_prevBar() {
  if (!BT_klineData || !BT_klineData.dates.length) { BT_toast('请先加载 K 线', 'warn'); return; }
  var max = BT_klineData.dates.length - 1;
  BT_ensureZoomRangeHealthy();
  var prev;
  if (BT_userZoomRange && BT_userZoomRange.end > BT_userZoomRange.start) {
    // 用户曾拖动 slider：以窗口右边界对应的 idx - 1 为基准（与 nextBar 镜像）
    var endIdx = Math.round(BT_userZoomRange.end / 100 * max);
    prev = Math.max(0, endIdx - 1);
  } else {
    prev = Math.max(0, (BT_currentIdx == null ? 0 : BT_currentIdx - 1));
  }
  BT_setCursor(prev);
  BT_saveState();
}

// 自检窗口健康度：直接读 ECharts 实际 dataZoom 状态（因为 slider 拖动不触发 dataZoom 事件，
//   BT_userZoomRange 内存变量可能与 ECharts 实际不同步），如果被压扁则恢复标准宽度
// 关键：必须用 ECharts.getOption().dataZoom 作为唯一真相源，而不是 BT_userZoomRange
function BT_ensureZoomRangeHealthy() {
  if (!BT_chart || !BT_klineData) return;
  var opt = BT_chart.getOption();
  if (!opt || !opt.dataZoom || !opt.dataZoom[0]) return;
  var z = opt.dataZoom[0];
  var actualWidth = (z.end || 0) - (z.start || 0);
  var MIN_WIDTH = 1.5;
  if (actualWidth >= MIN_WIDTH) {
    // 健康：把 ECharts 实际状态同步回 BT_userZoomRange（修复潜在的不一致）
    BT_userZoomRange = { start: z.start, end: z.end };
    return;
  }
  // 被压扁了 → 强制按 BT_visibleBars 重置窗口
  var total = BT_klineData.dates.length;
  if (total <= 1) return;
  var correctVisPct = BT_visibleBars / (total - 1) * 100;
  // 让窗口左端保持在当前拖到的位置（不直接钉最右，避免覆盖用户的浏览意图）
  var newStart = Math.max(0, Math.min(z.start, 100 - correctVisPct));
  var newEnd = Math.min(100, newStart + correctVisPct);
  BT_userZoomRange = { start: newStart, end: newEnd };
  _inDataZoomApply = true;
  try {
    BT_chart.setOption({ dataZoom: [
      { start: newStart, end: newEnd },
      { start: newStart, end: newEnd }
    ]});
  } finally {
    setTimeout(function() { _inDataZoomApply = false; }, 0);
  }
}

// 完成回测：保存本次回测摘要到 localStorage
function BT_finishBacktest() {
  if (!BT_currentSymbol) { BT_toast('请先加载 K 线', 'warn'); return; }
  if (BT_trades.length === 0) {
    if (!confirm('当前没有交易记录，仍要标记为完成回测吗？')) return;
  }
  var stats = BT_computeStats(BT_currentClose);
  // 计算当前总资金 = 现金 + 持仓市值
  var positionValue = (BT_position && BT_position.volume > 0 && BT_currentClose)
    ? BT_position.volume * BT_currentClose
    : 0;
  var currentCapital = (typeof BT_cash === 'number' ? BT_cash : BT_initCapital) + positionValue;
  var summary = {
    id:             'bt_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    symbol:         BT_currentSymbol,
    name:           BT_currentSymbolName || null,   // ★ 标的名称（浦发银行等）
    finishedAt:     new Date().toISOString(),
    // 资金快照
    initCapital:    +BT_initCapital.toFixed(2),
    cash:           +(typeof BT_cash === 'number' ? BT_cash : 0).toFixed(2),
    positionValue:  +positionValue.toFixed(2),
    currentCapital: +currentCapital.toFixed(2),
    positionPct:    +stats.positionPct.toFixed(2),
    // 交易指标
    tradeCount:     BT_trades.length,
    closedCount:    stats.closedCount,
    winRate:        +stats.winRate.toFixed(2),
    profitFactor:   isFinite(stats.profitFactor) ? +stats.profitFactor.toFixed(2) : null,
    totalReturn:    +stats.totalReturn.toFixed(2),
    realized:       +stats.realized.toFixed(2),
    unrealized:     +stats.unrealized.toFixed(2),
    // 风险指标
    maxDrawdown:    +stats.maxDrawdown.toFixed(2),
    maxConsecLoss:  stats.maxConsecLoss,
    // 快照当前持仓 + 完整 trades 数组（详情查看用）
    position:       BT_position ? BT_position.volume : 0,
    cost:           BT_position ? +BT_position.cost.toFixed(2) : 0,
    trades:         BT_trades.slice()
  };
  try {
    // 保存到 localStorage（向后兼容）
    var key = BT_lsKey('history');
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    list.unshift(summary);  // 最新的在前
    localStorage.setItem(key, JSON.stringify(list));

    // 保存到 DataStore（跨设备同步）
    if (BT_historyCollection) {
      BT_historyCollection.save(summary);
    }

    BT_toast('🏁 已完成 ' + BT_currentSymbol + ' 的回测（' + summary.tradeCount + ' 笔，累计收益 ' +
      (summary.totalReturn >= 0 ? '+' : '') + summary.totalReturn + '%，已保存到历史记录）', 'success');
    // 立即刷新历史记录表
    BT_renderHistory();
  } catch (e) {
    BT_toast('保存回测记录失败：' + e.message, 'error');
  }
}

// 从历史 trades 数组重算风险指标（老数据兜底：summary 里没存 maxDrawdown/maxConsecLoss 时用）
// 入参：trades = [{action:'buy'|'sell', price, volume, pnl?}, ...]，initCapital = 初始资金
// 出参：{ maxDrawdown: %, maxConsecLoss: 次数 }
function BT_computeRiskFromTrades(trades, initCapital) {
  var maxDrawdown = 0;
  var maxConsecLoss = 0;
  if (!trades || !trades.length) return { maxDrawdown: 0, maxConsecLoss: 0 };

  // 模拟仓位 + 已实现 P&L 曲线
  var posVol = 0, posCost = 0, cumPnl = 0, peak = initCapital || 0;
  var curConsecLoss = 0;
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    if (t.action === 'buy') {
      var nv = posVol + t.volume;
      if (nv > 0) posCost = (posVol * posCost + t.volume * t.price) / nv;
      posVol = nv;
    } else {
      var sv = Math.min(t.volume, posVol);
      if (sv > 0) {
        // 优先用保存的 pnl（最准），否则按价格反算
        var pnl = (typeof t.pnl === 'number')
          ? t.pnl
          : (t.price - posCost) * sv - (t.fee || 0);
        cumPnl += pnl;
        posVol -= sv;
        if (posVol === 0) posCost = 0;
        // 最大连续亏损
        if (pnl < 0) {
          curConsecLoss++;
          if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
        } else {
          curConsecLoss = 0;
        }
        // 最大回撤（基于累计已实现 P&L 的权益曲线）
        var equity = (initCapital || 0) + cumPnl;
        if (equity > peak) peak = equity;
        if (peak > 0) {
          var dd = (peak - equity) / peak * 100;
          if (dd > maxDrawdown) maxDrawdown = dd;
        }
      }
    }
  }
  return { maxDrawdown: maxDrawdown, maxConsecLoss: maxConsecLoss };
}

// 从 localStorage 迁移历史记录到 DataStore
async function BT_migrateHistoryFromLocalStorage() {
  if (!BT_historyCollection) return;
  try {
    var raw = localStorage.getItem(BT_lsKey('history'));
    if (!raw) return;
    var list = JSON.parse(raw);
    if (!Array.isArray(list) || list.length === 0) return;
    // 检查是否已迁移（DataStore 里已有数据则跳过）
    var existing = await BT_historyCollection.getAll();
    if (existing.length > 0) return;
    // 给每条记录确保有 id
    for (var i = 0; i < list.length; i++) {
      if (!list[i].id) list[i].id = 'bt_hist_' + Date.now() + '_' + i;
    }
    await BT_historyCollection.saveBatch(list);
    console.log('[backtest] 已从 localStorage 迁移 ' + list.length + ' 条历史记录到 DataStore');
  } catch (e) {
    console.warn('[backtest] 迁移历史记录失败:', e);
  }
}

// 历史回测记录：从 DataStore 加载并渲染
async function BT_renderHistory() {
  var box = document.getElementById('btHistoryBody');
  if (!box) return;
  var list = [];
  if (BT_historyCollection) {
    list = await BT_historyCollection.getAll();
    list.sort(function(a, b) {
      return (b.finishedAt || '').localeCompare(a.finishedAt || '');
    });
  } else {
    try { list = JSON.parse(localStorage.getItem(BT_lsKey('history')) || '[]'); } catch (e) { list = []; }
  }
  if (!list.length) {
    box.innerHTML = '<tr><td colspan="12" class="bt-empty">还没有历史回测记录，完成一轮回测后会自动保存到这里。</td></tr>';
    return;
  }
  var rows = list.map(function(s, i) {
    var ret = s.totalReturn >= 0 ? '+' + s.totalReturn + '%' : s.totalReturn + '%';
    var cls = s.totalReturn >= 0 ? 'bt-buy' : 'bt-sell';
    var pnl = s.realized >= 0 ? '+' + s.realized.toFixed(2) : s.realized.toFixed(2);
    var pnlCls = s.realized >= 0 ? 'bt-buy' : 'bt-sell';
    var pf = s.profitFactor == null ? '--' : s.profitFactor.toFixed(2);
    var winRate = s.closedCount > 0 ? s.winRate + '% (' + s.closedCount + ')' : '--';
    var finished = (s.finishedAt || '').replace('T', ' ').substring(0, 16);
    var initCap = '¥' + (s.initCapital || 0).toLocaleString();
    // 标的列：优先显示名称（浦发银行），下方附代码（sh600000）。无名称时只显示代码
    var symbolHtml = s.name
      ? '<div style="font-weight:600;line-height:1.2;">' + BT_escapeHtml(s.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text-secondary,#999);line-height:1.2;">' +
          BT_escapeHtml(s.symbol) + '</div>'
      : '<b>' + BT_escapeHtml(s.symbol) + '</b>';
    // 风险指标：老数据兜底（如果 summary 里没存，从 trades 数组重算）
    var dd, ddCls, mcl, mclCls;
    if (s.maxDrawdown != null) {
      dd = s.maxDrawdown.toFixed(2) + '%';
      ddCls = (s.maxDrawdown > 10) ? 'bt-sell' : '';
    } else if (s.trades && s.trades.length) {
      var risk = BT_computeRiskFromTrades(s.trades, s.initCapital);
      dd = risk.maxDrawdown.toFixed(2) + '%';
      ddCls = (risk.maxDrawdown > 10) ? 'bt-sell' : '';
    } else {
      dd = '--';
      ddCls = '';
    }
    if (s.maxConsecLoss != null) {
      mcl = s.maxConsecLoss + ' 次';
      mclCls = (s.maxConsecLoss >= 3) ? 'bt-sell' : '';
    } else if (s.trades && s.trades.length) {
      var risk2 = risk || BT_computeRiskFromTrades(s.trades, s.initCapital);
      mcl = risk2.maxConsecLoss + ' 次';
      mclCls = (risk2.maxConsecLoss >= 3) ? 'bt-sell' : '';
    } else {
      mcl = '--';
      mclCls = '';
    }
    var sid = s.id || ('idx_' + i);
    return '<tr>' +
      '<td style="text-align: center;">' + (i + 1) + '</td>' +
      '<td>' + symbolHtml + '</td>' +
      '<td style="font-size: 12px; color: var(--text-secondary, #999); text-align: center;">' + finished + '</td>' +
      '<td style="text-align: right;">' + initCap + '</td>' +
      '<td style="text-align: right;">' + s.tradeCount + '</td>' +
      '<td style="text-align: right;">' + winRate + '</td>' +
      '<td style="text-align: right;">' + pf + '</td>' +
      '<td style="text-align: right; font-weight: 600;" class="' + cls + '">' + ret + '</td>' +
      '<td style="text-align: right; font-weight: 600;" class="' + pnlCls + '">' + pnl + '</td>' +
      '<td style="text-align: right;" class="' + ddCls + '">' + dd + '</td>' +
      '<td style="text-align: right;" class="' + mclCls + '">' + mcl + '</td>' +
      '<td style="text-align: center;">' +
        '<button class="bt-del" title="查看详情" onclick="BT_viewHistoryRecord(\'' + sid + '\')" style="color:#4361ee;cursor:pointer;border:none;background:none;font-size:14px;">👁</button>' +
        '<button class="bt-del" title="删除该记录" onclick="BT_deleteHistoryRecord(\'' + sid + '\')" style="cursor:pointer;border:none;background:none;font-size:14px;">✕</button>' +
      '</td>' +
      '</tr>';
  }).join('');
  box.innerHTML = rows;
}

// 简单的 HTML 转义（防止名称里的 < > & 破坏布局）
function BT_escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 查看历史回测详情（弹窗显示资金流水 + 交易明细）
async function BT_viewHistoryRecord(id) {
  var rec = null;
  if (BT_historyCollection) {
    rec = await BT_historyCollection.get(id);
  }
  if (!rec) {
    // 降级：从 localStorage 查
    try {
      var list = JSON.parse(localStorage.getItem(BT_lsKey('history')) || '[]');
      rec = list.find(function(s) { return s.id === id; });
    } catch (e) {}
  }
  if (!rec) { BT_toast('记录不存在', 'error'); return; }
  var lines = [];
  // 老数据兜底：详情弹窗里也用同一个重算逻辑
  var detailDd = rec.maxDrawdown;
  var detailMcl = rec.maxConsecLoss;
  if (detailDd == null || detailMcl == null) {
    if (rec.trades && rec.trades.length) {
      var risk3 = BT_computeRiskFromTrades(rec.trades, rec.initCapital);
      if (detailDd == null) detailDd = risk3.maxDrawdown;
      if (detailMcl == null) detailMcl = risk3.maxConsecLoss;
    }
  }
  lines.push('📊 回测详情: ' + rec.symbol);
  lines.push('完成时间: ' + (rec.finishedAt || '').replace('T', ' ').substring(0, 19));
  lines.push('─────────────────────');
  lines.push('初始资金: ¥' + (rec.initCapital || 0).toLocaleString());
  lines.push('当前资金: ¥' + (rec.currentCapital || 0).toLocaleString());
  lines.push('现金余额: ¥' + (rec.cash || 0).toLocaleString());
  lines.push('持仓市值: ¥' + (rec.positionValue || 0).toLocaleString());
  lines.push('当前仓位: ' + (rec.positionPct || 0).toFixed(2) + '%');
  lines.push('─────────────────────');
  lines.push('累计收益率: ' + (rec.totalReturn >= 0 ? '+' : '') + rec.totalReturn + '%');
  lines.push('已实现盈亏: ' + (rec.realized >= 0 ? '+' : '') + '¥' + rec.realized.toFixed(2));
  lines.push('浮动盈亏:   ' + (rec.unrealized >= 0 ? '+' : '') + '¥' + rec.unrealized.toFixed(2));
  lines.push('─────────────────────');
  lines.push('交易笔数: ' + rec.tradeCount + ' 笔（平仓 ' + rec.closedCount + ' 笔）');
  lines.push('胜率: ' + (rec.closedCount > 0 ? rec.winRate + '%' : '--'));
  lines.push('盈亏比: ' + (rec.profitFactor == null ? '--' : rec.profitFactor.toFixed(2)));
  lines.push('─────────────────────');
  lines.push('⚠️ 风险指标:');
  lines.push('最大回撤: ' + (detailDd != null ? detailDd.toFixed(2) + '%' : '--'));
  lines.push('最大连续亏损: ' + (detailMcl != null ? detailMcl + ' 次' : '--'));
  if (rec.trades && rec.trades.length > 0) {
    lines.push('─────────────────────');
    lines.push('交易明细:');
    rec.trades.forEach(function(t, i) {
      var action = t.action === 'buy' ? '🟥 买' : '🟩 卖';
      var sign = t.action === 'buy' ? '-' : '+';
      lines.push('  ' + (i + 1) + '. ' + action + ' ' + sign + t.volume + ' 股 @ ¥' + t.price.toFixed(2) + ' (' + t.date + ')');
      if (t.pnl != null) {
        lines.push('       本笔盈亏: ' + (t.pnl >= 0 ? '+' : '') + '¥' + t.pnl.toFixed(2));
      }
    });
  }
  alert(lines.join('\n'));
}

// 删除单条历史记录
async function BT_deleteHistoryRecord(id) {
  if (!confirm('确定删除这条回测记录吗？')) return;
  // 从 DataStore 删除
  if (BT_historyCollection) {
    await BT_historyCollection.delete(id);
  }
  // 同时从 localStorage 删除（向后兼容）
  try {
    var list = JSON.parse(localStorage.getItem(BT_lsKey('history')) || '[]');
    list = list.filter(function(s) { return s.id !== id; });
    localStorage.setItem(BT_lsKey('history'), JSON.stringify(list));
  } catch (e) {}
  BT_renderHistory();
  BT_toast('已删除', 'success');
}

// 清空所有历史记录
async function BT_clearAllHistory() {
  if (!confirm('确定清空所有历史回测记录吗？此操作不可恢复！')) return;
  // 从 DataStore 清空
  if (BT_historyCollection) {
    await BT_historyCollection.clear();
  }
  // 同时清空 localStorage
  try { localStorage.removeItem(BT_lsKey('history')); } catch (e) {}
  BT_renderHistory();
  BT_toast('已清空所有历史记录', 'success');
}
