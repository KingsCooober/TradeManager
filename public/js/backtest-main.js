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
  // 1) 恢复表单状态（标的/周期/MA/缩放）
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
  if (showMA)   showMA.addEventListener('change', BT_toggleShowMA);
  if (showMACD) showMACD.addEventListener('change', BT_toggleShowMACD);
  if (showVol)  showVol.addEventListener('change', BT_toggleShowVol);

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
    case '1':   count = 250; break;
    case '2':   count = 500; break;
    case '3':   count = 750; break;
    case '5':   count = 1200; break;
    case 'all': count = 1500; break;
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

    // 切换标的 → 重新加载交易记录
    if (BT_currentSymbol !== symbol) {
      BT_currentSymbol = symbol;
      BT_loadTrades(symbol);
    }

    BT_renderKLine(data);
    BT_renderTrades();
    BT_renderStats();

    // 自动定位光标：每次加载都跳到最后一根（最新K线），保证窗口最右就是最新数据
    // 切换标的 / 刷新页面 / 改时间范围 → 都重新看最新
    var targetIdx = data.dates.length - 1;
    BT_setCursor(targetIdx, 'pinRight');  // 把光标钉在窗口最右

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

// 仓位选择：半仓/全仓（用相对持仓概念，不需要金额）
//   - 首次建仓：半仓 = BT_BASE_VOLUME（基础单位），全仓 = BT_BASE_VOLUME * 2
//   - 加仓（已有持仓）：半仓 = 当前持仓 × 0.5，全仓 = 当前持仓 × 1
//   - 卖出：半仓 = 卖一半，全仓 = 全部
var BT_positionMode = 'full';
var BT_BASE_VOLUME = 100;       // 基础单位（1 单位 = 100 股）
function BT_setPosition(mode) {
  BT_positionMode = mode;
  var btns = document.querySelectorAll('.bt-pos-btn');
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].getAttribute('data-pos') === mode) btns[i].classList.add('active');
    else btns[i].classList.remove('active');
  }
  if (typeof BT_saveState === 'function') BT_saveState();
}

function BT_calcBuyVolume() {
  if (BT_position && BT_position.volume > 0) {
    return BT_positionMode === 'half'
      ? Math.round(BT_position.volume * 0.5)
      : Math.round(BT_position.volume * 1);
  }
  return BT_positionMode === 'half' ? BT_BASE_VOLUME : BT_BASE_VOLUME * 2;
}

function BT_calcSellVolume() {
  if (!BT_position || BT_position.volume === 0) return 0;
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
  var summary = {
    symbol:      BT_currentSymbol,
    finishedAt:  new Date().toISOString(),
    tradeCount:  BT_trades.length,
    closedCount: stats.closedCount,
    winRate:     +stats.winRate.toFixed(2),
    profitFactor: isFinite(stats.profitFactor) ? +stats.profitFactor.toFixed(2) : null,
    totalReturn: +stats.totalReturn.toFixed(2),
    realized:    +stats.realized.toFixed(2),
    trades:      BT_trades.slice()  // 快照
  };
  try {
    var key = BT_lsKey('history');
    var list = JSON.parse(localStorage.getItem(key) || '[]');
    list.unshift(summary);  // 最新的在前
    localStorage.setItem(key, JSON.stringify(list));
    BT_toast('🏁 已完成 ' + BT_currentSymbol + ' 的回测（' + summary.tradeCount + ' 笔，总收益 ' +
      (summary.totalReturn >= 0 ? '+' : '') + summary.totalReturn + '%）', 'success');
  } catch (e) {
    BT_toast('保存回测记录失败：' + e.message, 'error');
  }
}

// 历史回测记录：分页渲染
function BT_renderHistory() {
  var box = document.getElementById('btHistoryBody');
  if (!box) return;
  var list = [];
  try {
    list = JSON.parse(localStorage.getItem(BT_lsKey('history')) || '[]');
  } catch (e) { list = []; }
  if (!list.length) {
    box.innerHTML = '<div class="bt-empty">还没有历史回测记录，完成一轮回测后会自动保存到这里。</div>';
    return;
  }
  var html = list.map(function(s, i) {
    var ret = s.totalReturn >= 0 ? '+' + s.totalReturn + '%' : s.totalReturn + '%';
    var cls = s.totalReturn >= 0 ? 'bt-buy' : 'bt-sell';
    var pnl = s.realized >= 0 ? '+' + s.realized.toFixed(2) : s.realized.toFixed(2);
    var pnlCls = s.realized >= 0 ? 'bt-buy' : 'bt-sell';
    var pf = s.profitFactor == null ? '--' : s.profitFactor.toFixed(2);
    var finished = (s.finishedAt || '').replace('T', ' ').substring(0, 16);
    return '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td>' + s.symbol + '</td>' +
      '<td>' + finished + '</td>' +
      '<td style="text-align:right;">' + s.tradeCount + '</td>' +
      '<td style="text-align:right;">' + s.winRate + '%</td>' +
      '<td style="text-align:right;">' + pf + '</td>' +
      '<td style="text-align:right;" class="' + pnlCls + '">' + pnl + '</td>' +
      '<td style="text-align:right;" class="' + cls + '">' + ret + '</td>' +
      '</tr>';
  }).join('');
  box.innerHTML = html;
}
