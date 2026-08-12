// ===== 每日复盘模块 =====
// 注意：以下全局变量按功能分组，新增变量请加到对应分组末尾
// 数据分组：drData / drAllReviews / drAllTrades / drDisciplineRules
// 状态分组：drCurrentDate / drCurrentUserId / drIsLoggedIn / drDataDirty / drAutoSaveTimer
// 缓存分组：drMarketData / drHistoryData 及对应的 LoadTime / LoadPromise（资金面/情绪面已下线）

var DR_INDICES = [
  { key: 'sh',     name: '上证指数' },
  { key: 'zza500', name: '中证A500' },
  { key: 'cyb50',  name: '创业板50' },
  { key: 'kc50',   name: '科创50' }
];

// 走势强度排序（用于"最保守原则"取最弱走势）
// 数值越小越弱 → 整体走势取最小值
var DR_TREND_RANK = {
  '强势上涨': 6,
  '多头趋势': 5,
  '反弹观察': 4,
  '震荡整理': 3,
  '趋势走弱': 2,
  '弱势下跌': 1
};

// ===== 交易复盘分析下拉选项 =====
// 开仓质量评价
var DR_ENTRY_TIMING_OPTS = ['左侧抄底', '回踩企稳', '右侧突破', '追高接力'];
var DR_POSITION_SIZE_OPTS = ['过重', '适中', '过轻'];
var DR_RATING_OPTS = ['优秀', '良好', '一般', '较差'];
// 开仓心态
var DR_OPEN_EMOTION_OPTS = ['冷静', '果断', '犹豫', '冲动', 'FOMO', '恐惧'];
// 风控检查
var DR_STOP_LOSS_OPTS = ['已设止损', '未设止损', '移动止损'];
var DR_RISK_REWARD_OPTS = ['≥3:1', '2:1-3:1', '1:1-2:1', '<1:1'];
// 平仓原因
var DR_EXIT_REASON_OPTS = ['止盈', '止损', '时间止损', '情绪平仓', '计划平仓'];
var DR_EXIT_TRIGGER_OPTS = ['到价自动', '手动执行', '破位止损', '恐慌抛售'];
var DR_EXIT_TIMING_OPTS = ['过早', '适时', '过晚'];
// 平仓后表现
var DR_POST_EXIT_TREND_OPTS = ['继续上涨', '横盘震荡', '掉头下跌'];
// 持仓走势判断
var DR_HOLDING_TREND_OPTS = ['顺势上涨', '横盘震荡', '回调企稳', '破位下跌'];
var DR_RISK_STATUS_OPTS = ['安全', '关注', '警戒', '危险'];
var DR_HOLDING_DECISION_OPTS = ['继续持有', '减仓', '加仓', '清仓'];

var drData = {};           // 当前编辑的复盘数据
var drAllReviews = [];     // 所有复盘记录
var drCurrentDate = '';    // 当前复盘日期
var drCurrentUserId = null;
var drIsLoggedIn = false;
var drAllTrades = [];      // 从数据库加载的所有交易记录
var drDisciplineRules = []; // 全局交易纪律
var drDataDirty = false;   // 标记是否有未保存的修改
var drAutoSaveTimer = null; // 延迟自动保存定时器
var drMarketData = null;    // 行情数据缓存（来自 /api/market/indices，5 分钟有效）
var drMarketLoadTime = 0;   // 上次加载行情时间
var drMarketLoadPromise = null; // 防止并发请求

function initDailyReview() {
  drCurrentDate = getToday();
  var dateInput = document.getElementById('drDate');
  if (dateInput) dateInput.value = drCurrentDate;
  loadLocalReviews();
  loadDRDisciplineRules();
  renderDRDisciplineRules();  // 渲染本地交易纪律
  checkDRLoginStatus();
  setupDREventListeners();
  loadAllTrades();
  // 订阅全局登录/登出事件
  setupDRLoginEvents();
  // 注册全局搜索（每日复盘页：搜索历史复盘）
  setupDRGlobalSearch();
  // 风险提示系统：恢复当日已读状态
  loadDRRiskDismissed();
  // 多维分析 · 行情 + 历史趋势图（资金面/情绪面已下线，数据在历史趋势图中查看）
  loadDRMarketData();
  loadDRHistoryCharts();
}

// 订阅全局登录/登出事件，修复"未登录状态打开页面后登录"导致复盘不同步的 bug
function setupDRLoginEvents() {
  window.addEventListener('user-login', function() {
    console.log('[DR] 收到 user-login 事件，重新检查登录状态');
    checkDRLoginStatus();
    // 登录后重新拉行情（认证通过才可调用 /api/market/indices）
    if (typeof loadDRMarketData === 'function') loadDRMarketData(true);
    // 登录后重新拉历史数据（资金面/情绪面已下线）
    if (typeof loadDRHistoryCharts === 'function') loadDRHistoryCharts(true);
  });
  window.addEventListener('user-logout', function() {
    console.log('[DR] 收到 user-logout 事件，重置登录状态');
    drIsLoggedIn = false;
    drCurrentUserId = null;
    var loggedIn = document.getElementById('headerSyncLoggedIn');
    var loggedOut = document.getElementById('headerSyncLoggedOut');
    if (loggedIn) loggedIn.style.display = 'none';
    if (loggedOut) loggedOut.style.display = 'flex';
  });
}
function setupDRGlobalSearch() {
  window.performGlobalSearch = function(q) {
    if (!Array.isArray(drAllReviews)) return [];
    var ql = q.toLowerCase();
    var results = [];
    for (var i = 0; i < drAllReviews.length; i++) {
      var r = drAllReviews[i];
      // 拼接可搜索字段：日期 / 总结 / 纪律备注 / 心态
      var summary = r.summary || {};
      var discipline = r.discipline || {};
      var fields = [r.date, summary.text, summary.improvement, discipline.note, discipline.moodNote, r.overallReason]
        .filter(function(v) { return v !== null && v !== undefined; }).join(' ');
      if (fields.toLowerCase().indexOf(ql) !== -1) {
        var preview = summary.text ? summary.text.slice(0, 60) : (discipline.note ? discipline.note.slice(0, 60) : '（无总结内容）');
        results.push({
          label: '📅 ' + (r.date || '') + ' · 每日复盘',
          sublabel: preview,
          onClick: (function(recDate) {
            return function() {
              if (typeof loadReviewForDate === 'function') {
                loadReviewForDate(recDate);
                if (typeof drCurrentDate !== 'undefined') drCurrentDate = recDate;
                var di = document.getElementById('drDate');
                if (di) di.value = recDate;
              }
            };
          })(r.date)
        });
      }
    }
    return results;
  };
}

function setupDREventListeners() {
  // 合并所有键盘快捷键到一个监听器（避免多个 keydown 叠加）
  document.addEventListener('keydown', function(e) {
    // Escape：关闭弹窗
    if (e.key === 'Escape') {
      closeDRModal();
      return;
    }
    // Ctrl+S / Cmd+S：手动保存
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (typeof saveDRReview === 'function') saveDRReview();
      return;
    }
    // ←/→ 切换日期（在 input/textarea/select 中不触发）
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowLeft') { navigateDRDate(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { navigateDRDate(1); e.preventDefault(); }
  });
  // 统一监听 change / input：在 .dr-section-body 内的表单字段变更后，
  // 标记 dirty 并通过 1 秒防抖触发自动保存（saveDRData 会本地 + 同步到服务器）。
  // 这样 summary / discipline 字段（drGoodPoints、复选框等）无需各自
  // 单独写保存逻辑也能在编辑后自动同步到后端。
  function markDirtyAndScheduleSave(e) {
    if (!e.target || !e.target.closest || !e.target.closest('.dr-section-body')) return;
    // 跳过已经单独处理的字段（交易复盘字段有 saveTradeFieldToData）
    if (e.target.classList && e.target.classList.contains('dr-trade-field')) return;
    drDataDirty = true;
    if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
    drAutoSaveTimer = setTimeout(function() {
      saveDRData();
      drDataDirty = false;
      drAutoSaveTimer = null;
      showDRAutoSaveHint();
    }, 1000);
    // 每日总结 textarea 输入时，实时更新进度条
    if (e.target && e.target.id && /^dr(GoodPoints|BadPoints|BiggestLesson|TomorrowNotes|WatchList)$/.test(e.target.id)) {
      if (typeof updateDRProgressBar === 'function') updateDRProgressBar();
    }
  }
  document.addEventListener('change', markDirtyAndScheduleSave);
  document.addEventListener('input', markDirtyAndScheduleSave);
}

// ===== 登录状态 =====
function checkDRLoginStatus() {
  if (typeof syncModule !== 'undefined' && syncModule.isLoggedIn()) {
    var user = syncModule.getCurrentUser();
    drCurrentUserId = user.id;
    drIsLoggedIn = true;
    var loggedIn = document.getElementById('headerSyncLoggedIn');
    var loggedOut = document.getElementById('headerSyncLoggedOut');
    if (loggedIn) loggedIn.style.display = 'flex';
    if (loggedOut) loggedOut.style.display = 'none';
    var usernameEl = document.getElementById('headerUsername');
    if (usernameEl) usernameEl.textContent = user.username;
    if (syncModule.setSyncIndicatorState) {
      if (syncModule.getLastSyncTime && syncModule.getLastSyncTime()) {
        syncModule.setSyncIndicatorState('success', syncModule.buildSyncTooltip());
      } else {
        syncModule.setSyncIndicatorState('idle', '已登录，尚未同步');
      }
    }
    loadFromServerDR();
    loadDisciplineRulesFromServer();
  } else {
    var loggedIn = document.getElementById('headerSyncLoggedIn');
    var loggedOut = document.getElementById('headerSyncLoggedOut');
    if (loggedIn) loggedIn.style.display = 'none';
    if (loggedOut) loggedOut.style.display = 'flex';
    if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      syncModule.setSyncIndicatorState('offline', '未登录，无法同步');
    }
  }
}

function loadFromServerDR() {
  if (!drCurrentUserId) return;
  if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
    syncModule.setSyncIndicatorState('syncing', '正在加载复盘数据...');
  }
  // P0-1: 必须用 authFetch，否则提交 80ee3c3 加入的 authMiddleware 会返回 401
  authFetch('/api/daily-review/' + drCurrentUserId, {
    method: 'GET'
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      try {
        var t = localStorage.getItem('last_sync_time');
        if (t) {
          localStorage.setItem('last_sync_time', String(Date.now()));
        }
        syncModule.setSyncIndicatorState('success', '已加载复盘数据 ' + new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'}));
      } catch(e) {}
    }
    if (data.reviews && data.reviews.length > 0) {
        var serverReviews = data.reviews.map(function(r) {
          var summary = safeJSON(r.summary_json) || {};
          return {
            id: r.id,
            date: r.review_date,
            tradeReviews: safeJSON(r.trade_reviews_json),
            discipline: safeJSON(r.discipline_json),
            summary: summary,
            overallReason: summary.overallReason || '',
            indices: summary.indices || DR_INDICES.map(function(def) {
              return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '', ma5Analysis: { currentPrice: null, ma5: null, position: '' } };
            }),
            marketRegime: summary.marketRegime || { position: '', matchedRuleId: '', matchedRuleDesc: '', note: '' },
            createdAt: r.created_at,
            updatedAt: r.updated_at
          };
        });
      // 关键修复：合并而非覆盖
      // 服务器数据 + 本地存在但服务器没有的复盘（按 date 判断）
      // 这样换电脑登录时，本地未同步的复盘会被增量上传到服务器
      var byDate = {};
      serverReviews.forEach(function(r) { if (r.date) byDate[r.date] = r; });
      var localOnly = [];
      drAllReviews.forEach(function(r) {
        if (!r.date) return;
        if (byDate[r.date]) return;  // 服务器有，跳过
        localOnly.push(r);
      });
      drAllReviews = serverReviews.concat(localOnly);
      dedupDRReviews();   // 服务器可能有同日期多条记录（历史 bug），去重保留最新
      saveLocalReviews();
      renderReviewHistory();
      loadReviewForDate(drCurrentDate);
      // 把本地独有的复盘增量上传到服务器
      if (localOnly.length > 0) {
        console.log('[DR] 检测到本地有 ' + localOnly.length + ' 条未同步的复盘，正在增量上传...');
        localOnly.forEach(function(r) {
          var backup = drData;
          drData = JSON.parse(JSON.stringify(r));
          syncToServerDR();
          drData = backup;
        });
        if (typeof syncModule !== 'undefined' && syncModule.showSyncStatus) {
          syncModule.showSyncStatus('已增量上传 ' + localOnly.length + ' 条复盘', 'success');
        }
      }
    }
  })
  .catch(function(e) {
    console.error('从服务器加载复盘失败:', e);
    if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      syncModule.setSyncIndicatorState('error', '复盘数据加载失败');
    }
  });
}

function syncToServerDR() {
  if (!drCurrentUserId || !drData.date) return;
  if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
    syncModule.setSyncIndicatorState('syncing', '正在保存复盘...');
  }
  // P0-1: 必须用 authFetch，否则提交 80ee3c3 加入的 authMiddleware 会返回 401
  authFetch('/api/daily-review/' + drCurrentUserId, {
    method: 'POST',
    body: JSON.stringify({ review: drData })
  })
  .then(function(r) { return r.json(); })
  .then(function() {
    showDRStatus('已同步到服务器', 'success');
    if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      try { localStorage.setItem('last_sync_time', String(Date.now())); } catch(e) {}
      var hh = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
      syncModule.setSyncIndicatorState('success', '复盘已同步 ' + hh);
    }
  })
  .catch(function(e) {
    console.error('同步失败:', e);
    if (typeof syncModule !== 'undefined' && syncModule.setSyncIndicatorState) {
      syncModule.setSyncIndicatorState('error', '复盘同步失败');
    }
  });
}

function handleDRLogout() {
  // P1-1: 退出登录前增加二次确认（复用页面已有的 drConfirm 自定义弹窗）
  drConfirm('退出登录', '确定要退出登录吗？', '退出', function() {
    localStorage.removeItem('currentUser');
    drCurrentUserId = null;
    drIsLoggedIn = false;
    var loggedIn = document.getElementById('headerSyncLoggedIn');
    var loggedOut = document.getElementById('headerSyncLoggedOut');
    if (loggedIn) loggedIn.style.display = 'none';
    if (loggedOut) loggedOut.style.display = 'flex';
  });
}

function openDRLoginModal() {
  drConfirm('登录同步', '需要登录才能同步数据。是否返回主页面进行登录？', '去登录', function() {
    window.location.href = 'index.html';
  });
}

function showDRStatus(msg, type) {
  var el = document.getElementById('syncStatus');
  if (el) {
    el.textContent = msg;
    el.className = 'sync-status-inline ' + type;
    setTimeout(function() { el.textContent = ''; el.className = 'sync-status-inline'; }, 3000);
  }
}

// ===== 本地存储 =====
function loadLocalReviews() {
  try {
    var stored = localStorage.getItem('daily_reviews');
    if (stored) drAllReviews = JSON.parse(stored);
  } catch(e) { drAllReviews = []; }
  dedupDRReviews();
}

function dedupDRReviews() {
  // 按 date 分组，同日期保留 updatedAt 最新的（updatedAt 为空则保留 createdAt 最新的，再为空保留最后一条）
  var byDate = {};
  drAllReviews.forEach(function(r) {
    if (!r.date) return;
    var key = r.date;
    var cur = byDate[key];
    if (!cur) {
      byDate[key] = r;
    } else {
      var t1 = r.updatedAt || r.createdAt || '';
      var t2 = cur.updatedAt || cur.createdAt || '';
      if (t1 > t2) byDate[key] = r;
    }
  });
  var clean = Object.keys(byDate).map(function(k) { return byDate[k]; });
  if (clean.length !== drAllReviews.length) {
    drAllReviews = clean;
    saveLocalReviews();
  }
}

function saveLocalReviews() {
  try { localStorage.setItem('daily_reviews', JSON.stringify(drAllReviews)); } catch(e) {}
}

function saveDRData() {
  var idx = drAllReviews.findIndex(function(r) { return r.date === drData.date; });
  if (idx >= 0) {
    drAllReviews[idx] = JSON.parse(JSON.stringify(drData));
  } else {
    drAllReviews.push(JSON.parse(JSON.stringify(drData)));
  }
  saveLocalReviews();
  if (drIsLoggedIn) syncToServerDR();
}

// ===== 日期切换 =====
function autoSaveDR() {
  if (!drDataDirty) return;
  saveCurrentFormToData();
  saveDRData();
  drDataDirty = false;
  showDRAutoSaveHint();
}

// 显示「已自动保存 HH:MM」提示（持续 4 秒后淡出）
function showDRAutoSaveHint() {
  var el = document.getElementById('drAutoSaveHint');
  if (!el) return;
  var now = new Date();
  var hh = String(now.getHours()).padStart(2, '0');
  var mm = String(now.getMinutes()).padStart(2, '0');
  el.textContent = '✓ 已自动保存 ' + hh + ':' + mm;
  el.classList.add('show');
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(function() {
    el.classList.remove('show');
  }, 4000);
}

// 日期切换防抖（避免快速点击 ◀▶ 触发多次 API 请求）
var drDateChangeTimer = null;
var DR_DATE_DEBOUNCE_MS = 300;

function onDRDateChange() {
  autoSaveDR();
  var input = document.getElementById('drDate');
  drCurrentDate = input.value;
  // 立即加载本地数据（trades/review），API 请求防抖
  loadTradesForDate(drCurrentDate);
  loadReviewForDate(drCurrentDate);
  // API 请求防抖（资金面/情绪面已下线，只需重绘历史图表）
  if (drDateChangeTimer) clearTimeout(drDateChangeTimer);
  drDateChangeTimer = setTimeout(function() {
    if (typeof renderDRHistoryCharts === 'function' && drHistoryData) renderDRHistoryCharts();
    drDateChangeTimer = null;
  }, DR_DATE_DEBOUNCE_MS);
}

function navigateDRDate(delta) {
  autoSaveDR();
  var d = new Date(drCurrentDate);
  d.setDate(d.getDate() + delta);
  drCurrentDate = d.toISOString().slice(0, 10);
  document.getElementById('drDate').value = drCurrentDate;
  loadTradesForDate(drCurrentDate);
  loadReviewForDate(drCurrentDate);
  // API 请求防抖（资金面/情绪面已下线，只需重绘历史图表）
  if (drDateChangeTimer) clearTimeout(drDateChangeTimer);
  drDateChangeTimer = setTimeout(function() {
    if (typeof renderDRHistoryCharts === 'function' && drHistoryData) renderDRHistoryCharts();
    drDateChangeTimer = null;
  }, DR_DATE_DEBOUNCE_MS);
}

// ===== 加载交易记录 =====
function loadAllTrades() {
  if (typeof initDatabase === 'function') {
    initDatabase().then(function() {
      return getAllTradesFromDB();
    }).then(function(data) {
      drAllTrades = data || [];
      loadTradesForDate(drCurrentDate);
      loadReviewForDate(drCurrentDate);
    }).catch(function(e) {
      console.error('从数据库加载交易记录失败:', e);
      drAllTrades = [];
      loadTradesForDate(drCurrentDate);
      loadReviewForDate(drCurrentDate);
    });
  } else {
    drAllTrades = [];
    loadTradesForDate(drCurrentDate);
    loadReviewForDate(drCurrentDate);
  }
}

function loadTradesForDate(date) {
  // 当日交易复盘范围：
  //   1. 当日开仓（t.date === date）
  //   2. 当日出场（t.exitDate === date）—— 即使开仓日是更早，也纳入今日复盘
  // 用 id 去重，避免同笔交易（开仓=出场=今日）出现两次
  var seen = {};
  var dayTrades = [];
  // 当前持仓：开仓日早于今日且仍未平仓（status === 'open'）
  var holdings = [];
  drAllTrades.forEach(function(t) {
    if (t.date === date || t.exitDate === date) {
      var key = String(t.id);
      if (seen[key]) return;
      seen[key] = true;
      dayTrades.push(t);
    }
    if (t.status === 'open' && t.date && t.date < date) {
      holdings.push(t);
    }
  });
  // 持仓按开仓日期升序（最早的在前）
  holdings.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
  renderDRTrades(dayTrades, holdings);
}

// ===== 加载复盘数据 =====
function loadReviewForDate(date) {
  var existing = drAllReviews.find(function(r) { return r.date === date; });
  if (existing) {
    drData = JSON.parse(JSON.stringify(existing));
    // 兼容旧格式：删除已废弃字段
    if (drData.market) delete drData.market;
    if (drData.keyLevels) delete drData.keyLevels;
    if (drData.riskAlert) delete drData.riskAlert;
    if (drData.maSystem) delete drData.maSystem;
    // 兼容旧 marketRegime 结构
    if (drData.marketRegime && drData.marketRegime.trend !== undefined) {
      var oldMr = drData.marketRegime;
      drData.marketRegime = {
        position: oldMr.position || '',
        matchedRuleId: '',
        matchedRuleDesc: '',
        note: oldMr.note || ''
      };
    }
    // 兼容旧 indices 结构（无 maState/macdState/ma5Analysis）
    if (Array.isArray(drData.indices)) {
      drData.indices.forEach(function(idx) {
        if (idx.maState === undefined) idx.maState = '';
        if (idx.macdState === undefined) idx.macdState = '';
        if (idx.trendResult === undefined) idx.trendResult = '';
        if (idx.trendHint === undefined) idx.trendHint = '';
        if (!idx.ma5Analysis) idx.ma5Analysis = { currentPrice: null, ma5: null, position: '' };
      });
    }
  } else {
    drData = {
      date: date,
      overallReason: '',
      indices: DR_INDICES.map(function(def) {
        return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '', ma5Analysis: { currentPrice: null, ma5: null, position: '' } };
      }),
      tradeReviews: [],
      marketRegime: { position: '', matchedRuleId: '', matchedRuleDesc: '', note: '' },
      discipline: { moodScore: 3, moodTags: [], executedStop: true, executedTakeProfit: false, chaseKilling: false, frequentTrading: false, overnightFull: false, plannedPosition: '', actualPosition: '' },
      summary: { goodPoints: '', badPoints: '', biggestLesson: '', tomorrowNotes: '', watchList: '' }
    };
  }
  populateFormFromData();
  renderReviewHistory();
  // 关键：drData.indices 刚刚初始化完成，如果行情数据已加载（drMarketData），
  // 立即套用 maState/macdState/ma5/ma20 到 drData.indices。
  // 修复"loadDRMarketData 完成时 drData.indices 尚未初始化"导致的空值问题
  if (typeof applyMarketDataToIndices === 'function' && drMarketData) {
    applyMarketDataToIndices();
  }
}

// ===== 填充表单 =====
function populateFormFromData() {
  renderDRIndicesMAStatus();
  recalcDROverall();

  renderDRDisciplineRules();
  renderDRMarketRegime();

  var d = drData.discipline || {};
  setDRMoodScore(d.moodScore || 3);
  renderDRMoodTags(d.moodTags || []);
  setCheckVal('drExecutedStop', d.executedStop);
  setCheckVal('drExecutedTP', d.executedTakeProfit);
  setCheckVal('drChaseKilling', d.chaseKilling);
  setCheckVal('drFrequentTrading', d.frequentTrading);
  setCheckVal('drOvernightFull', d.overnightFull);

  var s = drData.summary || {};
  setTextVal('drGoodPoints', s.goodPoints);
  setTextVal('drBadPoints', s.badPoints);
  setTextVal('drBiggestLesson', s.biggestLesson);
  setTextVal('drTomorrowNotes', s.tomorrowNotes);
  setTextVal('drWatchList', s.watchList);

  // 更新复盘进度条
  if (typeof updateDRProgressBar === 'function') updateDRProgressBar();

  renderDRTradeReviews();
}

// ===== 大盘走势分析：每个指数独立判断均线+MACD =====

// 走势判断类型 → CSS class 映射
var DR_TREND_STYLES = {
  '强势上涨': { cls: 'trend-strong',   color: 'var(--color-green)' },
  '多头趋势': { cls: 'trend-bullish',  color: 'var(--color-red)' },
  '震荡整理': { cls: 'trend-neutral',  color: 'var(--color-blue)' },
  '趋势走弱': { cls: 'trend-warning',  color: '#b8860b' },
  '弱势下跌': { cls: 'trend-weak',     color: 'var(--color-red)' },
  '反弹观察': { cls: 'trend-rebound',  color: 'var(--color-blue)' }
};

// 6 档走势（与 SCORE_MA_MAP / SCORE_MACD_MAP 评分一一对应，DR_TREND_RANK 用于排序）
// 已废弃：DR_MA_OPTIONS / DR_MACD_OPTIONS / DR_TREND_OPTIONS 不再使用
//   - 均线状态和 MACD 状态由后端 /api/market/indices 自动识别并填充
//   - 走势由 scoreTechnical 自动计算 → scoreToTrend → 6 档之一
//   - 此处保留仅供代码维护参考，不再生成 <option>

// 渲染多指数卡片
// 简化：所有 4 维评分（均线/MACD/价格 vs 5日线/价格 vs 20日线）均由后端数据自动计算，
// 此处只显示「自动识别的指标状态」「走势结果」「技术分徽章」+ K线图（不提供任何手动输入）。
function renderDRIndicesMAStatus() {
  var container = document.getElementById('drIndicesList');
  if (!container) return;

  // 补齐缺失的指数
  if (!Array.isArray(drData.indices)) {
    drData.indices = DR_INDICES.map(function(def) {
      return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '', ma5Analysis: { currentPrice: null, ma5: null, position: '' } };
    });
  } else {
    DR_INDICES.forEach(function(def) {
      var found = drData.indices.find(function(m) { return m.key === def.key; });
      if (!found) {
        drData.indices.push({ key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '' });
      } else {
        // 同步 DR_INDICES 中的最新名称（修复重命名后旧复盘仍显示旧名的问题）
        found.name = def.name;
      }
    });
  }

  var html = '';
  drData.indices.forEach(function(idx, i) {
    html += '<div class="dr-index-card" data-index="' + i + '">';
    html += '<div class="dr-index-name">' + esc(idx.name) + '</div>';
    html += '<div class="dr-index-fields">';

    // K线图区域（默认全部展开，无收起功能）
    // 单个指数的均线状态/MACD状态/价格 vs 5日线/走势判断等指标已在此处隐藏，
    // 用户从 K线本身的形态 + 走势判断，K线图已包含 MA/成交额/MACD 等参考。
    html += '<div class="dr-field dr-field-wide dr-kline-wrap" data-index="' + i + '">';
    html += '<div class="dr-kline-container" id="drKline' + i + '"></div>';
    html += '</div>';

    html += '</div></div>';
  });

  container.innerHTML = html;

  // 渲染后自动加载全部 4 个指数的 K线图
  drData.indices.forEach(function(idx, i) {
    renderDRKlineChart(i, idx.key);
  });
}

// 单个指数 select 变化 → 重新算该指数的走势 + 整体走势 + 整体仓位
// （已废弃：UI 中已无 select，所有 4 维评分均由后端数据自动计算，保留空函数以防外部误调）
function onDRIndexChange(idx) {
  // no-op: 4 维评分改为后端自动计算，无 select 需监听
  void idx;
}

// 手动选择走势（6 档可选，3 select 联动时会自动设置值）
// （已废弃：UI 中已无手动 select，保留空函数以防外部误调）
function onDRManualTrendChange(idx) {
  // no-op: 走势已由后端 4 维评分自动计算
  void idx;
}

// 更新单个指数的走势显示 + 技术面评分徽章
function updateDRIndexTrendUI(idx) {
  var trendBox = document.querySelector('.dr-index-trend[data-index="' + idx + '"] .dr-index-trend-result');
  var hintBox = document.querySelector('.dr-index-trend[data-index="' + idx + '"] .dr-index-trend-hint');
  var scoreBadge = document.querySelector('.dr-index-score-badge[data-index="' + idx + '"]');
  if (!trendBox) return;
  var item = drData.indices[idx];
  trendBox.className = 'dr-index-trend-result';
  if (item.trendResult && DR_TREND_STYLES[item.trendResult]) {
    trendBox.textContent = item.trendResult;
    trendBox.classList.add(DR_TREND_STYLES[item.trendResult].cls);
  } else {
    trendBox.textContent = '请选择走势';
  }
  if (hintBox) {
    hintBox.textContent = item.trendHint || '';
  }
  // 同步技术面评分徽章
  if (scoreBadge) {
    var ma5Pos  = (item.ma5Analysis  && item.ma5Analysis.position)  || '';
    var ma20Pos = (item.ma20Analysis && item.ma20Analysis.position) || '';
    var s = scoreTechnical(item.maState, item.macdState, ma5Pos, ma20Pos);
    scoreBadge.className = 'dr-index-score-badge ' + (s.filled ? getScoreBadgeClass(s.total) : 'score-empty');
    var textEl  = scoreBadge.querySelector('.dr-index-score-text');
    var detailEl = scoreBadge.querySelector('.dr-index-score-detail');
    if (textEl) {
      textEl.textContent = s.filled
        ? '技术分 ' + s.total + '/40 · ' + s.trendFromScore
        : '技术分 —/40（待填）';
    }
    if (detailEl) {
      if (s.filled) {
        var ma5Auto  = (item.ma5Analysis  && item.ma5Analysis.source  === 'auto') ? '📊' : '';
        var ma20Auto = (item.ma20Analysis && item.ma20Analysis.source === 'auto') ? '📊' : '';
        detailEl.textContent = '均线 ' + s.ma + ' + MACD ' + s.macd + ' + 5日线 ' + s.ma5 + ma5Auto + ' + 20日线 ' + s.ma20 + ma20Auto;
        detailEl.style.display = '';
      } else {
        detailEl.style.display = 'none';
      }
    }
  }
}

// 综合走势（最保守原则：取所有指数中走势最弱的）
// 每个指数的 trendResult 现在由 scoreTechnical 实时计算（不再依赖 idx.trendResult 字段写入）
function recalcDROverallTrend() {
  if (!Array.isArray(drData.indices)) return { trend: '', hint: '', totalScore: 0, scoreBreakdown: '' };

  // 1. 为每个指数实时计算 trendResult（基于 maState/macdState/ma5/ma20 自动评分）
  drData.indices.forEach(function(i) {
    var ma5Pos  = (i.ma5Analysis  && i.ma5Analysis.position)  || '';
    var ma20Pos = (i.ma20Analysis && i.ma20Analysis.position) || '';
    var s = scoreTechnical(i.maState, i.macdState, ma5Pos, ma20Pos);
    if (s.filled) {
      i.trendResult = s.trendFromScore;
      i.trendHint   = '均线 ' + i.maState + ' + MACD ' + i.macdState + ' → ' + s.total + ' 分';
    } else {
      i.trendResult = '';
      i.trendHint   = '';
    }
  });

  var judged = drData.indices.filter(function(i) { return i.trendResult; });
  if (judged.length === 0) {
    return { trend: '', hint: '等待行情数据（后端自动识别均线/MACD 状态）...', totalScore: 0, scoreBreakdown: '', hasScore: false, totalAll: 0 };
  }

  var weakest = judged[0];
  judged.forEach(function(i) {
    if (DR_TREND_RANK[i.trendResult] < DR_TREND_RANK[weakest.trendResult]) {
      weakest = i;
    }
  });

  var parts = judged.map(function(i) { return i.name + ':' + i.trendResult; });
  var hint = '综合 ' + judged.length + ' 个指数：' + parts.join(' / ') + ' → 取最弱：' + weakest.name;

  // 5 日线共识：统计已填 5 日线位置的指数中，上/下比例
  var ma5Filled = drData.indices.filter(function(i) { return i.ma5Analysis && i.ma5Analysis.position === 'above' || i.ma5Analysis && i.ma5Analysis.position === 'below'; });
  if (ma5Filled.length > 0) {
    var upCnt = ma5Filled.filter(function(i) { return i.ma5Analysis.position === 'above'; }).length;
    var dnCnt = ma5Filled.filter(function(i) { return i.ma5Analysis.position === 'below'; }).length;
    var consensus = upCnt > dnCnt ? '多数在上' : (dnCnt > upCnt ? '多数在下' : '上下参半');
    hint += ' ｜ 5日线共识：' + ma5Filled.length + ' 个指数已填，' + consensus + '（上 ' + upCnt + ' / 下 ' + dnCnt + '）';
  }

  // 技术面评分汇总：所有指数的技术分平均（最保守原则取最弱，但显示平均让用户横向对比）
  var scored = drData.indices
    .map(function(i) {
      var ma5Pos  = (i.ma5Analysis  && i.ma5Analysis.position)  || '';
      var ma20Pos = (i.ma20Analysis && i.ma20Analysis.position) || '';
      return scoreTechnical(i.maState, i.macdState, ma5Pos, ma20Pos);
    })
    .filter(function(s) { return s.filled; });
  var totalScore = 0;
  var scoreBreakdown = '';
  var hasScore = scored.length > 0;
  if (hasScore) {
    var sum = scored.reduce(function(acc, s) { return acc + s.total; }, 0);
    totalScore = Math.round(sum / scored.length);
    var avgMa   = Math.round(scored.reduce(function(a, s) { return a + s.ma;   }, 0) / scored.length);
    var avgMacd = Math.round(scored.reduce(function(a, s) { return a + s.macd; }, 0) / scored.length);
    var avgMa5  = Math.round(scored.reduce(function(a, s) { return a + s.ma5;  }, 0) / scored.length);
    var avgMa20 = Math.round(scored.reduce(function(a, s) { return a + s.ma20; }, 0) / scored.length);
    // 4 个指数里只要有一个 ma5/ma20 是 auto，就给后缀加 📊 提示数据驱动
    var anyMa5Auto  = drData.indices.some(function(i) { return i.ma5Analysis  && i.ma5Analysis.source  === 'auto'; });
    var anyMa20Auto = drData.indices.some(function(i) { return i.ma20Analysis && i.ma20Analysis.source === 'auto'; });
    var s5  = anyMa5Auto  ? '📊' : '';
    var s20 = anyMa20Auto ? '📊' : '';
    scoreBreakdown = '均线 ' + avgMa + ' + MACD ' + avgMacd + ' + 5日线 ' + avgMa5 + s5 + ' + 20日线 ' + avgMa20 + s20;
    hint += ' ｜ 技术面均分：' + totalScore + '/40 → ' + scoreToTrend(totalScore);
  }

  // 综合分 = 技术面 0-40（资金面/情绪面已下线，数据保留在历史趋势图中查看）
  var totalAll = hasScore ? totalScore : 0;
  if (hasScore) {
    hint += ' ｜ 综合分：' + totalAll + '/40 → ' + scoreToCompositeTrend(totalAll);
  }

  return {
    trend: weakest.trendResult,
    hint: hint,
    totalScore: totalScore,
    scoreBreakdown: scoreBreakdown,
    totalAll: totalAll,
    hasScore: hasScore
  };
}

// 整体走势 + 整体仓位 重新计算
function recalcDROverall() {
  // 1. 综合走势（含技术面均分 + 资金面分 + 综合分）
  var overall = recalcDROverallTrend();
  window._lastDROverall = overall;  // 给 updateDRTrendResultUI 读
  updateDRTrendResultUI(overall.trend, overall.hint, overall.totalScore, overall.scoreBreakdown);

  // 2. 整体仓位 = 各指数命中规则中取最保守的（仓位区间最小的）
  autoCalcDRPosition();

  // 3. 同步刷新历史复盘列表（让当前编辑的复盘卡片实时反映走势+仓位变化）
  renderReviewHistory();
}

// ==================== 技术面 0-40 分自动评分 ====================
// 设计原则：4 个维度加权求和，每个维度按强弱分配不同分值
//   - 均线状态        0-12 分（趋势方向）
//   - MACD 状态       0-12 分（动能强弱）
//   - 价格 vs 5日线   0-8 分（短期超强势）
//   - 价格 vs 20日线  0-8 分（中期趋势）
// 总分 0-40 → 6 档走势映射（与原 6 档一致）
//   32-40 → 强势上涨
//   24-31 → 多头趋势
//   18-23 → 反弹观察
//   12-17 → 震荡整理
//    6-11 → 趋势走弱
//    0-5  → 弱势下跌
var SCORE_MA_MAP = {
  '多头排列': 12,
  '5-10金叉': 10,
  '5-10粘合': 5,
  '5-10死叉': 3,
  '空头排列': 0
};
var SCORE_MACD_MAP = {
  '水上金叉': 12,
  '水上多头': 10,
  '水下底背离':  9,   // 弱势酝酿反转，参考价值高
  '水下金叉':   8,   // 弱势转强
  '水下多头':   6,
  '水上死叉':   4,   // 强势转弱
  '水上空头':   3,
  '水上顶背离': 3,   // 顶部信号，强转弱
  '水下死叉':   2,
  '水下空头':   0
};
// 价格 vs 均线位置：上方 8 / 下方 0；未填按中性 4（不打分也不扣分）
var SCORE_POS_MAP = { 'above': 8, 'below': 0 };
var SCORE_POS_NEUTRAL = 4;

// 单个指数技术面评分
// 入参: maState / macdState / ma5Pos('above'|'below'|''|undefined) / ma20Pos(同上)
// 返回: { ma, macd, ma5, ma20, total, trendFromScore, filled }
function scoreTechnical(maState, macdState, ma5Pos, ma20Pos) {
  var ma   = SCORE_MA_MAP[maState]   != null ? SCORE_MA_MAP[maState]   : 0;
  var macd = SCORE_MACD_MAP[macdState] != null ? SCORE_MACD_MAP[macdState] : 0;
  var ma5  = (ma5Pos  && SCORE_POS_MAP[ma5Pos]  != null) ? SCORE_POS_MAP[ma5Pos]  : SCORE_POS_NEUTRAL;
  var ma20 = (ma20Pos && SCORE_POS_MAP[ma20Pos] != null) ? SCORE_POS_MAP[ma20Pos] : SCORE_POS_NEUTRAL;
  var total = ma + macd + ma5 + ma20;
  return {
    ma: ma,
    macd: macd,
    ma5: ma5,
    ma20: ma20,
    total: total,
    trendFromScore: scoreToTrend(total),
    filled: !!(maState && macdState)
  };
}

// 分数 → 6 档走势（与原 DR_TREND_RANK 一一对应）
function scoreToTrend(total) {
  if (total >= 32) return '强势上涨';
  if (total >= 24) return '多头趋势';
  if (total >= 18) return '反弹观察';
  if (total >= 12) return '震荡整理';
  if (total >=  6) return '趋势走弱';
  return '弱势下跌';
}

// 综合分（技术面 0-40 + 资金面 0-20 + 情绪面 0-20 = 0-80） → 6 档走势
// 阈值与原 scoreToTrend 等比例缩放（80 / 40 = 2 倍）
function scoreToCompositeTrend(total) {
  if (total >= 64) return '强势上涨';
  if (total >= 48) return '多头趋势';
  if (total >= 36) return '反弹观察';
  if (total >= 24) return '震荡整理';
  if (total >= 12) return '趋势走弱';
  return '弱势下跌';
}

// 评分等级 CSS class
function getScoreBadgeClass(total) {
  if (total >= 32) return 'score-max';
  if (total >= 24) return 'score-bullish';
  if (total >= 18) return 'score-rebound';
  if (total >= 12) return 'score-neutral';
  if (total >=  6) return 'score-warning';
  return 'score-weak';
}

// ==================== 行情数据自动填充 ma5/ma20 ====================
// 数据源：/api/market/indices（代理腾讯股票 API）
// 用途：让 4 维技术面评分中后 2 维「数据驱动」而非手填
//   - ma5：用户没填时用实时价 vs ma5 推算；用户已填则保留其选择
//   - ma20：始终从实时数据填充（无 UI，避免冲突）
// 缓存策略：5 分钟（与后端一致）；过期重新拉取
// 失败容错：网络/接口失败时保持空，评分按中性 4 分计算

var DR_MARKET_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// 拉取全部 4 只指数的行情（带缓存和并发合并）
function loadDRMarketData(force) {
  // 缓存命中：5 分钟内不重复请求
  if (!force && drMarketData && (Date.now() - drMarketLoadTime) < DR_MARKET_CACHE_TTL) {
    applyMarketDataToIndices();
    return Promise.resolve(drMarketData);
  }
  // 防止并发：复用进行中的请求
  if (drMarketLoadPromise) return drMarketLoadPromise;

  drMarketLoadPromise = authFetch('/api/market/indices', { method: 'GET' })
    .then(function(r) {
      if (!r.ok) throw new Error('行情接口返回 ' + r.status);
      return r.json();
    })
    .then(function(data) {
      drMarketData = data;
      drMarketLoadTime = Date.now();
      console.log('[DR] 行情数据已加载', Object.keys(data.data || {}).map(function(k) {
        var it = data.data[k];
        return k + '(' + (it.quote && it.quote.price) + ')';
      }).join(' '));
      applyMarketDataToIndices();
      // 资金面已改为并行加载（initDailyReview 中同时调用），不再链式触发
      return data;
    })
    .catch(function(e) {
      console.warn('[DR] 行情数据加载失败，保持空值（评分按中性 4 分计算）:', e.message);
      return null;
    })
    .then(function(d) {
      drMarketLoadPromise = null;
      return d;
    });
  return drMarketLoadPromise;
}

// 计算单只指数的价格 vs 均线位置（'above' / 'below' / ''）
function deriveMaPosition(price, ma) {
  if (price == null || ma == null || isNaN(price) || isNaN(ma)) return '';
  if (price > ma) return 'above';
  if (price < ma) return 'below';
  return '';  // 完全相等按未知处理
}

// 把行情数据套用到当前 drData.indices
//  - maState / macdState：后端基于 K 线自动识别，前端直接使用（每次行情刷新都更新）
//  - ma5Analysis.position：仅当用户没填时才自动填
//  - ma20Analysis：始终自动填（无 UI）
//  - 自动填的字段标记 source='auto'，UI 用「📊」图标区分
function applyMarketDataToIndices() {
  if (!drMarketData || !drMarketData.data) return;
  if (!Array.isArray(drData.indices)) return;

  var changed = false;
  drData.indices.forEach(function(idx) {
    var m = drMarketData.data[idx.key];
    if (!m || !m.quote) return;
    var price = m.quote.price;
    var ma5  = m.ma5;
    var ma20 = m.ma20;

    // 1) maState / macdState：后端自动识别，每次刷新同步到前端
    if (idx.maState !== (m.maState || '')) {
      idx.maState = m.maState || '';
      changed = true;
    }
    if (idx.macdState !== (m.macdState || '')) {
      idx.macdState = m.macdState || '';
      changed = true;
    }

    // 2) ma5：仅当用户没填时才自动填
    if (!idx.ma5Analysis) idx.ma5Analysis = { currentPrice: null, ma5: null, position: '' };
    if (!idx.ma5Analysis.position) {
      var pos5 = deriveMaPosition(price, ma5);
      if (pos5) {
        idx.ma5Analysis.position = pos5;
        idx.ma5Analysis.currentPrice = price;
        idx.ma5Analysis.ma5 = ma5;
        idx.ma5Analysis.source = 'auto';
        changed = true;
      }
    } else {
      // 用户已填，刷新 currentPrice/ma5 但不覆盖 position
      idx.ma5Analysis.currentPrice = price;
      idx.ma5Analysis.ma5 = ma5;
    }

    // 3) ma20：始终自动填（无 UI）
    if (!idx.ma20Analysis) idx.ma20Analysis = { currentPrice: null, ma20: null, position: '' };
    var pos20 = deriveMaPosition(price, ma20);
    if (pos20) {
      idx.ma20Analysis.position = pos20;
      idx.ma20Analysis.currentPrice = price;
      idx.ma20Analysis.ma20 = ma20;
      idx.ma20Analysis.source = 'auto';
      changed = true;
    }
  });

  // 触发 UI 重渲染：每个指数卡片上的「📊 自动」徽章需要重画
  if (changed) {
    if (typeof renderDRIndicesMAStatus === 'function') renderDRIndicesMAStatus();
    if (typeof recalcDROverall === 'function') recalcDROverall();
  }

  // 风险提示系统：行情刷新后检查 MACD 水上死叉
  if (typeof checkDRRiskAlerts === 'function') checkDRRiskAlerts();
}

// ==================== 资金面 0-20 分（已下线，数据保留在历史趋势图中）====================
// 原数据源 /api/market/fund 已停止调用，相关 UI 卡片已从 HTML 移除。
// 北向资金 / 融资余额 / 总成交额 等数据仍通过 /api/market/history 在历史趋势图中展示。

// ==================== 情绪面 0-20 分（已下线，数据保留在历史趋势图中）====================
// 原数据源 /api/market/sentiment 已停止调用，相关 UI 卡片已从 HTML 移除。
// 涨跌停 / 涨跌家数 等数据仍通过 /api/market/history 在历史趋势图中展示。

// ==================== 历史趋势折线图 ====================
// 数据源：/api/market/history?days=730（后端从 market_history 表读取近 2 年全量数据）
// 渲染策略：
//   - 图表折线：仅显示最近 N 天（默认 60，可选 7/30/60/90）
//   - 历史百分位：基于近 2 年全量数据计算（确保分位数稳定、不受显示范围影响）
// 三张折线图：
//   1) 两融余额（亿元）       = 每日 rzrqye
//   2) 两市总成交额（亿元）   = 每日 amount_total_yi
//   3) 涨跌停比例（涨/跌/差）  = zt_count/dt_count/zt_dt_diff
// 注：涨跌停历史从今天开始累积，之前的日期为 0（公开 API 无历史涨跌停数据）

var drHistoryData = null;          // 全量历史数据缓存（近 2 年）
var drHistoryLoadTime = 0;         // 上次加载时间（用于自动过期）
var drDisplayDays = 60;            // 图表显示天数（默认 60）
var drHistoryECharts = { margin: null, amount: null, ldd: null, upDown: null };  // ECharts 实例缓存
var DR_HISTORY_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
var DR_HISTORY_API_DAYS = 730;     // 后端最大可查询天数（≈ 2 年）

// 拉取并渲染历史趋势图（始终拉全量，渲染时按 drDisplayDays 切片）
function loadDRHistoryCharts(force) {
  var cacheExpired = (Date.now() - drHistoryLoadTime) > DR_HISTORY_CACHE_TTL;
  if (!force && drHistoryData && !cacheExpired) {
    renderDRHistoryCharts();
    return Promise.resolve(drHistoryData);
  }
  var daysEl = document.getElementById('drHistoryRange');
  var displayDays = daysEl ? parseInt(daysEl.value) || 60 : 60;
  drDisplayDays = displayDays;
  var hintEl = document.getElementById('drHistoryHint');
  if (hintEl) hintEl.textContent = '正在加载…';

  return authFetch('/api/market/history?days=' + DR_HISTORY_API_DAYS, { method: 'GET' })
    .then(function(r) {
      if (!r.ok) throw new Error('历史接口返回 ' + r.status);
      return r.json();
    })
    .then(function(data) {
      drHistoryData = data;
      drHistoryLoadTime = Date.now();
      if (hintEl) {
        hintEl.textContent = '图表显示近 ' + displayDays + ' 天（共 ' + (data.count || 0) + ' 天历史数据，百分位基于近 2 年）';
      }
      renderDRHistoryCharts();
      // 风险提示系统：历史数据加载后检查成交额/两融余额百分位
      if (typeof checkDRRiskAlerts === 'function') checkDRRiskAlerts();
      return data;
    })
    .catch(function(e) {
      console.warn('[DR] 历史数据加载失败:', e.message);
      if (hintEl) hintEl.textContent = '加载失败：' + e.message;
      return null;
    });
}

// 用户切换时间范围时触发
function reloadDRHistoryCharts() {
  drHistoryData = null;  // 清缓存
  // 销毁旧图避免叠加
  if (drHistoryECharts.margin)  { drHistoryECharts.margin.dispose();  drHistoryECharts.margin  = null; }
  if (drHistoryECharts.amount)  { drHistoryECharts.amount.dispose();  drHistoryECharts.amount  = null; }
  if (drHistoryECharts.ldd)     { drHistoryECharts.ldd.dispose();     drHistoryECharts.ldd     = null; }
  if (drHistoryECharts.upDown)  { drHistoryECharts.upDown.dispose();  drHistoryECharts.upDown  = null; }
  loadDRHistoryCharts(true);
}

// 等 ECharts CDN 加载完后再画图
function renderDRHistoryCharts() {
  if (!drHistoryData || !drHistoryData.data || drHistoryData.data.length === 0) {
    var hintEl2 = document.getElementById('drHistoryHint');
    if (hintEl2) hintEl2.textContent = '暂无历史数据';
    return;
  }
  if (typeof loadEcharts !== 'function') {
    console.warn('[DR] ECharts 未加载');
    return;
  }
  loadEcharts().then(function(echarts) {
    var fullData = drHistoryData.data;
    // 取最近 drDisplayDays 天作为显示数据
    var displayData = fullData.slice(-drDisplayDays);

    // ★ 按图分别过滤"关键字段为 0"的当天
    // 某些天可能只有部分数据发布（例如东财两融通常 20:00 后才发，但成交额 19:00 就有）
    // 这种"半数据"的天在对应图上不显示（避免折线断在 0）
    // 全量 fullData 仍保留给百分位计算用（0 值在分位里权重小，可忽略）
    var marginData = displayData.filter(function(d) {
      return (d.rzye || 0) > 0 || (d.rzrqye || 0) > 0;
    });
    var amountData = displayData.filter(function(d) {
      return (d.amount_total_yi || 0) > 0;
    });
    var lddData = displayData.filter(function(d) {
      return (d.zt_count || 0) > 0 || (d.dt_count || 0) > 0;
    });
    var upDownData = displayData.filter(function(d) {
      return (d.up_count || 0) > 0 || (d.down_count || 0) > 0;
    });

    drawDRMarginChart(echarts, marginData, fullData);
    drawDRAmountChart(echarts, amountData, fullData);
    drawDRLDDChart(echarts, lddData);
    drawDRUpDownChart(echarts, upDownData);
  }).catch(function(e) {
    console.warn('[DR] ECharts 加载失败:', e.message);
  });
}

// 通用：获取 ECharts 主题色
function getEChartsTextStyle() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    textColor: isDark ? '#98989d' : '#6e6e73',
    gridLine:  isDark ? '#3a3a3c'  : '#f0f0f0',
    bgColor:   isDark ? '#1c1c1e'  : '#ffffff'
  };
}

// 计算当前值在历史数组中的百分位（rank-based：含当前值）
// P=70 表示当前值 ≥ 70% 的历史值
// 空数组或无当前值返回 null
function calcPercentile(arr, currentVal) {
  if (!arr || arr.length === 0 || currentVal == null || isNaN(currentVal)) return null;
  var valid = arr.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
  if (valid.length === 0) return null;
  var below = 0;
  for (var i = 0; i < valid.length; i++) { if (valid[i] < currentVal) below++; }
  // 含当前值自身的 rank 百分位：below / N * 100
  return Math.round((below / valid.length) * 100);
}

// 计算数组在指定百分位处的值（线性插值，便于历史分位参考线）
// p 范围 0-100；返回 null 表示数据不足
function calcPercentileValue(arr, p) {
  if (!arr || arr.length === 0) return null;
  var valid = arr.filter(function(v) { return typeof v === 'number' && !isNaN(v); });
  if (valid.length === 0) return null;
  valid.sort(function(a, b) { return a - b; });
  var rank = (p / 100) * (valid.length - 1);
  var lo = Math.floor(rank);
  var hi = Math.ceil(rank);
  if (lo === hi) return valid[lo];
  return valid[lo] + (valid[hi] - valid[lo]) * (rank - lo);
}

// 百分位配色：低位绿、中位黄、高位红
function percentileColor(p) {
  if (p == null) return '#8e8e93';
  if (p >= 70) return '#ff453a';
  if (p >= 30) return '#ff9f0a';
  return '#30d158';
}

// 百分位文字徽章（HTML）
function percentileBadge(label, p) {
  if (p == null) return '';
  var color = percentileColor(p);
  return '<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:10px;' +
         'background:' + color + '22;color:' + color + ';font-size:11px;font-weight:600;' +
         'border:1px solid ' + color + '55;">' + label + ' · P' + p + '</span>';
}

// ★ 历史图表：查找当前复盘日期在 displayData 中的索引
function findDRDateIndex(displayData) {
  if (!drCurrentDate || !displayData) return -1;
  for (var i = displayData.length - 1; i >= 0; i--) {
    if (displayData[i].date === drCurrentDate) return i;
  }
  return -1;
}

// 生成 markLine 配置：在当前日期位置画垂直高亮线
function getDRCurrentDateMarkLine(idx) {
  if (idx < 0) return null;
  return {
    symbol: 'none',
    label: { show: false },
    lineStyle: { color: '#4361ee', type: 'dashed', width: 1.5, opacity: 0.6 },
    data: [{ xAxis: idx }]
  };
}

// 1) 两融余额（亿元）—— 含历史百分位
// displayData: 用于绘制折线（最近 N 天）
// fullData:    用于计算百分位（近 2 年全量）
function drawDRMarginChart(echarts, displayData, fullData) {
  var el = document.getElementById('drHistoryMarginChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  // 显示数据：折线
  var dates = displayData.map(function(d) { return d.date.slice(5); });
  // ★ 当前日期在图表中的索引（用于高亮标记线）
  var currentDateIdx = findDRDateIndex(displayData);
  var marginArr = displayData.map(function(d) { return Math.round((d.rzrqye || 0) / 1e8); });
  // 全量数据：百分位
  var fullMarginArr = (fullData || displayData).map(function(d) { return Math.round((d.rzrqye || 0) / 1e8); });
  // ★ currentVal/prevVal 改为从 displayData（已过滤）取最后两项
  //   防止"今天两融还没出"时把 0 当成今日值，导致 P0 + 标题显示 0
  var currentVal = marginArr.length ? marginArr[marginArr.length - 1] : 0;
  // 昨日数据：取倒数第二项（如果存在）
  var prevVal = marginArr.length >= 2 ? marginArr[marginArr.length - 2] : null;
  var prevDate = dates.length >= 2 ? dates[dates.length - 2] : '';
  var percentP = calcPercentile(fullMarginArr, currentVal);
  // Y 轴范围基于显示数据
  var maxVal = marginArr.length ? Math.max.apply(null, marginArr) : 0;
  var minVal = marginArr.length ? Math.min.apply(null, marginArr) : 0;
  var range = maxVal - minVal || maxVal * 0.01;
  var pColor = percentileColor(percentP);
  // P90 历史分位参考值（基于全量数据，Y 轴要能看到这条线）
  var p90Val = calcPercentileValue(fullMarginArr, 90);
  if (p90Val != null && p90Val > maxVal) maxVal = p90Val;
  if (p90Val != null && p90Val < minVal) minVal = p90Val;
  // P95 / P98 历史分位参考值
  var p95Val = calcPercentileValue(fullMarginArr, 95);
  if (p95Val != null && p95Val > maxVal) maxVal = p95Val;
  if (p95Val != null && p95Val < minVal) minVal = p95Val;
  var p98Val = calcPercentileValue(fullMarginArr, 98);
  if (p98Val != null && p98Val > maxVal) maxVal = p98Val;
  if (p98Val != null && p98Val < minVal) minVal = p98Val;
  var chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      formatter: function(p) {
        var v = p[0];
        return v.axisValue + '<br/>' + v.marker + ' ' + v.seriesName + ': ' + v.value + ' 亿';
      }
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 6) - 1) }
    },
    yAxis: {
      type: 'value',
      min: Math.floor(minVal - range * 0.1),
      max: Math.ceil(maxVal + range * 0.1),
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, formatter: function(v) { return v >= 10000 ? (v/10000).toFixed(2) + ' 万亿' : v + ' 亿'; } },
      splitLine: { lineStyle: { color: ts.gridLine, type: 'dashed' } }
    },
    series: [{
      name: '两融余额',
      type: 'line',
      data: marginArr,
      smooth: true,
      symbol: 'circle',
      symbolSize: 4,
      lineStyle: { color: '#0a84ff', width: 2 },
      itemStyle: { color: '#0a84ff' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(10,132,255,0.3)' },
            { offset: 1, color: 'rgba(10,132,255,0.02)' }
          ]
        }
      },
      // 历史百分位：标记线（当前位置 = 不显示文字，文字由 markPoint 的 pin 承担）
      // + P90 / P95 / P98 历史分位水平参考线（颜色从橙到深红，标注分位值）
      markLine: {
        silent: true,
        symbol: ['none', 'none'],
        data: [
          { xAxis: dates.length - 1, yAxis: currentVal, lineStyle: { color: pColor, width: 1.5, type: 'dashed', opacity: 0.8 }, label: { show: false } },
          // 昨日位置垂直参考线
          ...(prevVal != null ? [{ xAxis: dates.length - 2, lineStyle: { color: '#94a3b8', width: 1, type: 'dotted', opacity: 0.6 }, label: { show: true, position: 'start', formatter: '昨日 ' + prevDate, color: '#94a3b8', fontSize: 9, fontWeight: 600, backgroundColor: 'rgba(148,163,184,0.15)', padding: [2, 4], borderRadius: 3 } }] : []),
          { yAxis: p90Val, lineStyle: { color: '#ff9f0a', width: 1, type: 'dashed', opacity: 0.55 },
            label: { show: true, position: 'insideEndTop', formatter: 'P90 · ' + Math.round(p90Val) + ' 亿',
              color: '#ffffff', backgroundColor: 'rgba(255,159,10,0.85)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } },
          { yAxis: p95Val, lineStyle: { color: '#ff6b35', width: 1, type: 'dashed', opacity: 0.6 },
            label: { show: true, position: 'insideEndTop', formatter: 'P95 · ' + Math.round(p95Val) + ' 亿',
              color: '#ffffff', backgroundColor: 'rgba(255,107,53,0.9)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } },
          { yAxis: p98Val, lineStyle: { color: '#ff453a', width: 1.2, type: 'dashed', opacity: 0.7 },
            label: { show: true, position: 'insideEndTop', formatter: 'P98 · ' + Math.round(p98Val) + ' 亿',
              color: '#ffffff', backgroundColor: 'rgba(255,69,58,0.9)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } }
        ]
      },
      markPoint: {
        symbol: 'pin',
        symbolSize: 36,
        itemStyle: { color: pColor },
        label: {
          color: '#ffffff',
          fontSize: 10,
          fontWeight: 700,
          formatter: percentP != null ? 'P' + percentP : ''
        },
        data: [
          { name: '当前位置', value: currentVal, xAxis: dates.length - 1, yAxis: currentVal },
          // 昨日位置（如果有）
          ...(prevVal != null ? [{ name: '昨日', value: prevVal, xAxis: dates.length - 2, yAxis: prevVal,
            symbol: 'circle', symbolSize: 10, itemStyle: { color: '#94a3b8' },
            label: { show: true, position: 'top', formatter: '昨 ' + prevVal + ' 亿', color: '#94a3b8', fontSize: 9, fontWeight: 600 } }] : [])
        ]
      },
      markLine: getDRCurrentDateMarkLine(currentDateIdx)
    }]
  });
  if (drHistoryECharts.margin) drHistoryECharts.margin.dispose();
  drHistoryECharts.margin = chart;
}

// 2) 两市总成交额（亿元）+ 5 日均线 —— 含历史百分位
// displayData: 用于绘制折线（最近 N 天）
// fullData:    用于计算百分位（近 2 年全量）
function drawDRAmountChart(echarts, displayData, fullData) {
  var el = document.getElementById('drHistoryAmountChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  // 显示数据：折线
  var dates = displayData.map(function(d) { return d.date.slice(5); });
  // ★ 当前日期在图表中的索引（用于高亮标记线）
  var currentDateIdx = findDRDateIndex(displayData);
  // 两市总成交额（亿元）
  var amountArr = displayData.map(function(d) { return Math.round(d.amount_total_yi || 0); });
  // 全量数据：百分位
  var fullAmountArr = (fullData || displayData).map(function(d) { return Math.round(d.amount_total_yi || 0); });
  // ★ currentVal/prevVal 改为从 displayData（已过滤）取最后两项
  //   防止"今天成交额还没出"时把 0 当成今日值
  var currentVal = amountArr.length ? amountArr[amountArr.length - 1] : 0;
  // 昨日数据
  var prevVal = amountArr.length >= 2 ? amountArr[amountArr.length - 2] : null;
  var prevDate = dates.length >= 2 ? dates[dates.length - 2] : '';
  var percentP = calcPercentile(fullAmountArr, currentVal);
  var ma5 = calcSimpleMA(amountArr, 5);
  // Y 轴范围基于显示数据
  var maxVal = amountArr.length ? Math.max.apply(null, amountArr) : 0;
  var minVal = amountArr.length ? Math.min.apply(null, amountArr) : 0;
  var range = maxVal - minVal || maxVal * 0.01;
  var pColor = percentileColor(percentP);
  // P90 历史分位参考值（基于全量数据，Y 轴要能看到这条线）
  var p90Val = calcPercentileValue(fullAmountArr, 90);
  if (p90Val != null && p90Val > maxVal) maxVal = p90Val;
  if (p90Val != null && p90Val < minVal) minVal = p90Val;
  // P95 / P98 历史分位参考值
  var p95Val = calcPercentileValue(fullAmountArr, 95);
  if (p95Val != null && p95Val > maxVal) maxVal = p95Val;
  if (p95Val != null && p95Val < minVal) minVal = p95Val;
  var p98Val = calcPercentileValue(fullAmountArr, 98);
  if (p98Val != null && p98Val > maxVal) maxVal = p98Val;
  if (p98Val != null && p98Val < minVal) minVal = p98Val;
  var chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 20, top: 30, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: {
      data: ['两市总成交额', '5日均线'],
      textStyle: { color: ts.textColor, fontSize: 10 },
      top: 0, right: 0
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 6) - 1) }
    },
    yAxis: {
      type: 'value',
      min: Math.floor(minVal - range * 0.1),
      max: Math.ceil(maxVal + range * 0.1),
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, formatter: function(v) { return v >= 10000 ? (v/10000).toFixed(2) + ' 万亿' : v + ' 亿'; } },
      splitLine: { lineStyle: { color: ts.gridLine, type: 'dashed' } }
    },
    series: [
      {
        name: '两市总成交额',
        type: 'line',
        data: amountArr,
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { color: '#ff9f0a', width: 2 },
        itemStyle: { color: '#ff9f0a' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(255,159,10,0.3)' },
              { offset: 1, color: 'rgba(255,159,10,0.02)' }
            ]
          }
        },
        // 历史百分位：标记线（当前位置 + P90 / P95 / P98 历史分位水平参考线）
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: [
            { xAxis: dates.length - 1, yAxis: currentVal, lineStyle: { color: pColor, width: 1.5, type: 'dashed', opacity: 0.8 }, label: { show: false } },
            ...(prevVal != null ? [{ xAxis: dates.length - 2, lineStyle: { color: '#94a3b8', width: 1, type: 'dotted', opacity: 0.6 }, label: { show: true, position: 'start', formatter: '昨日 ' + prevDate, color: '#94a3b8', fontSize: 9, fontWeight: 600, backgroundColor: 'rgba(148,163,184,0.15)', padding: [2, 4], borderRadius: 3 } }] : []),
            { yAxis: p90Val, lineStyle: { color: '#ff9f0a', width: 1, type: 'dashed', opacity: 0.55 },
              label: { show: true, position: 'insideEndTop', formatter: 'P90 · ' + Math.round(p90Val) + ' 亿',
                color: '#ffffff', backgroundColor: 'rgba(255,159,10,0.85)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } },
            { yAxis: p95Val, lineStyle: { color: '#ff6b35', width: 1, type: 'dashed', opacity: 0.6 },
              label: { show: true, position: 'insideEndTop', formatter: 'P95 · ' + Math.round(p95Val) + ' 亿',
                color: '#ffffff', backgroundColor: 'rgba(255,107,53,0.9)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } },
            { yAxis: p98Val, lineStyle: { color: '#ff453a', width: 1.2, type: 'dashed', opacity: 0.7 },
              label: { show: true, position: 'insideEndTop', formatter: 'P98 · ' + Math.round(p98Val) + ' 亿',
                color: '#ffffff', backgroundColor: 'rgba(255,69,58,0.9)', padding: [2, 6], borderRadius: 4, fontSize: 10, fontWeight: 600 } }
          ]
        },
        markPoint: {
          symbol: 'pin',
          symbolSize: 36,
          itemStyle: { color: pColor },
          label: {
            color: '#ffffff',
            fontSize: 10,
            fontWeight: 700,
            formatter: percentP != null ? 'P' + percentP : ''
          },
          data: [
            { name: '当前位置', value: currentVal, xAxis: dates.length - 1, yAxis: currentVal },
            ...(prevVal != null ? [{ name: '昨日', value: prevVal, xAxis: dates.length - 2, yAxis: prevVal, symbol: 'circle', symbolSize: 10, itemStyle: { color: '#94a3b8' }, label: { show: true, position: 'top', formatter: '昨 ' + prevVal + ' 亿', color: '#94a3b8', fontSize: 9, fontWeight: 600 } }] : [])
          ]
        },
        markLine: getDRCurrentDateMarkLine(currentDateIdx)
      },
      {
        name: '5日均线',
        type: 'line',
        data: ma5,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#0a84ff', width: 1.5, type: 'dashed' },
        itemStyle: { color: '#0a84ff' }
      }
    ]
  });
  if (drHistoryECharts.amount) drHistoryECharts.amount.dispose();
  drHistoryECharts.amount = chart;
}

// 3) 涨跌停比例图 —— 堆叠柱（红=涨停/绿=跌停） + 折线（涨跌比例）
// 注：涨跌停历史从今天开始累积，之前的日期为 0（公开 API 无历史涨跌停数据），所以不需要全量数据
function drawDRLDDChart(echarts, data) {
  var el = document.getElementById('drHistoryLDDChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  var dates = data.map(function(d) { return d.date.slice(5); });
  // ★ 当前日期在图表中的索引（用于高亮标记线）
  var currentDateIdx = findDRDateIndex(data);
  // 跌停数（堆在下半，绿色）/ 涨停数（堆在上半，红色）
  var dtArr = data.map(function(d) { return d.dt_count || 0; });
  var ztArr = data.map(function(d) { return d.zt_count || 0; });
  // 涨跌比例：zt/dt，跌停=0 时用 10 表示 +∞ 强势（与之前行为一致）
  var ratioArr = data.map(function(d) {
    var zt = d.zt_count || 0;
    var dt = d.dt_count || 0;
    if (dt === 0) return zt > 0 ? 10 : 0;
    return Math.round((zt / dt) * 100) / 100;
  });
  // 昨值参考（用于标记点）
  var prevRatio = data.length >= 2 ? ratioArr[ratioArr.length - 2] : null;
  var prevZt = data.length >= 2 ? (data[data.length - 2].zt_count || 0) : null;
  var prevDate = dates.length >= 2 ? dates[dates.length - 2] : '';

  // 柱图 Y 轴上限：max(zt+dt) + 15% padding；最少 20 避免空数据时看不到柱
  var maxStack = 0;
  for (var _i = 0; _i < data.length; _i++) {
    var _sum = (data[_i].zt_count || 0) + (data[_i].dt_count || 0);
    if (_sum > maxStack) maxStack = _sum;
  }
  var yMax = Math.max(20, Math.ceil(maxStack * 1.15));
  var chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 50, top: 30, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      formatter: function(params) {
        var date = params[0].axisValue;
        var idx = params[0].dataIndex;
        var d = data[idx];
        var prevD = idx > 0 ? data[idx - 1] : null;
        // ★ 必须先声明 zt / dt，否则下方引用会 ReferenceError 致 tooltip 静默失败
        var zt = (d && d.zt_count) || 0;
        var dt = (d && d.dt_count) || 0;
        var diffTxt = '';
        if (prevD) {
          var ztDiff = zt - ((prevD.zt_count || 0));
          var dtDiff = dt - ((prevD.dt_count || 0));
          diffTxt = '<br/>🔄 较昨日: 涨停 ' + (ztDiff > 0 ? '+' : '') + ztDiff + ', 跌停 ' + (dtDiff > 0 ? '+' : '') + dtDiff;
        }
        return date + '<br/>' +
          '📈 涨停: <b style="color:#ff3b30">' + zt + '</b> 家<br/>' +
          '📉 跌停: <b style="color:#34c759">' + dt + '</b> 家' +
          '<br/>📊 涨跌停差: ' + (zt - dt) +
          '<br/>📐 涨跌比例: ' + ratioArr[idx] +
          diffTxt;
      }
    },
    legend: {
      data: ['涨停数', '跌停数', '涨跌比例'],
      textStyle: { color: ts.textColor, fontSize: 10 },
      top: 0, right: 0,
      itemWidth: 10, itemHeight: 8
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 6) - 1) }
    },
    yAxis: [
      {
        type: 'value',
        name: '家数',
        position: 'left',
        min: 0,
        max: yMax,
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { lineStyle: { color: ts.gridLine, type: 'dashed' } }
      },
      {
        type: 'value',
        name: '比值',
        position: 'right',
        min: 0,
        max: Math.max(10, (function() {
          // 折线最大值 * 1.2 避免顶到边
          var mx = 0;
          for (var _k = 0; _k < ratioArr.length; _k++) if (ratioArr[_k] > mx) mx = ratioArr[_k];
          return Math.ceil(mx * 1.2);
        })()),
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { show: false }
      }
    ],
    series: [
      // 跌停数（绿色，堆在下半，y 值=跌停数）
      {
        name: '跌停数',
        type: 'bar',
        stack: 'ztDtStack',
        yAxisIndex: 0,
        data: dtArr,
        itemStyle: { color: '#34c759' },
        barMaxWidth: 16,
        emphasis: { focus: 'series' }
      },
      // 涨停数（红色，堆在上半，y 值=涨停数；与跌停同 stack 累加）
      {
        name: '涨停数',
        type: 'bar',
        stack: 'ztDtStack',
        yAxisIndex: 0,
        data: ztArr,
        itemStyle: { color: '#ff3b30' },
        barMaxWidth: 16,
        emphasis: { focus: 'series' },
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: prevZt != null ? [{ xAxis: dates.length - 2, lineStyle: { color: '#94a3b8', width: 1, type: 'dotted', opacity: 0.6 }, label: { show: true, position: 'start', formatter: '昨日 ' + prevDate, color: '#94a3b8', fontSize: 9, fontWeight: 600, backgroundColor: 'rgba(148,163,184,0.15)', padding: [2, 4], borderRadius: 3 } }] : []
        }
      },
      // 涨跌比例（折线，浮在柱子上方）
      {
        name: '涨跌比例',
        type: 'line',
        yAxisIndex: 1,
        data: ratioArr,
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { color: '#bf5af2', width: 2 },
        itemStyle: { color: '#bf5af2' },
        z: 10,
        markPoint: prevRatio != null ? {
          symbol: 'circle', symbolSize: 8,
          itemStyle: { color: '#94a3b8' },
          label: { show: true, position: 'top', formatter: '昨比 ' + prevRatio, color: '#94a3b8', fontSize: 9, fontWeight: 600 },
          data: [{ name: '昨日比例', value: prevRatio, xAxis: dates.length - 2, yAxis: prevRatio }]
        } : { data: [] },
        markLine: getDRCurrentDateMarkLine(currentDateIdx)
      }
    ]
  });
  if (drHistoryECharts.ldd) drHistoryECharts.ldd.dispose();
  drHistoryECharts.ldd = chart;
}

// 4) 涨跌比例图 —— 堆叠柱（红=上涨/绿=下跌家数） + 折线（涨跌比例）
//   与"涨跌停比例图"结构完全一致，只是把 zt_count→up_count、dt_count→down_count
//   注意：涨跌家数 = up_count / down_count，比值通常远大于 1（如 6.4 倍 = 4660/725），
//   右 Y 轴 max 自动取 ratioArr.max * 1.2
function drawDRUpDownChart(echarts, data) {
  var el = document.getElementById('drHistoryUpDownChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  var dates = data.map(function(d) { return d.date.slice(5); });
  // ★ 当前日期在图表中的索引（用于高亮标记线）
  var currentDateIdx = findDRDateIndex(data);
  // 下跌家数（堆在下半，绿色）/ 上涨家数（堆在上半，红色）
  var downArr = data.map(function(d) { return d.down_count || 0; });
  var upArr = data.map(function(d) { return d.up_count || 0; });
  // 涨跌比例：up/down，下跌=0 时用 10 表示 +∞ 强势（与涨跌停图保持一致）
  var ratioArr = data.map(function(d) {
    var up = d.up_count || 0;
    var down = d.down_count || 0;
    if (down === 0) return up > 0 ? 10 : 0;
    return Math.round((up / down) * 100) / 100;
  });
  // 昨值参考（用于标记点）
  var prevRatio = data.length >= 2 ? ratioArr[ratioArr.length - 2] : null;
  var prevUp = data.length >= 2 ? (data[data.length - 2].up_count || 0) : null;
  var prevDate = dates.length >= 2 ? dates[dates.length - 2] : '';

  // 柱图 Y 轴上限：max(up+down) + 15% padding；最少 100（涨跌家数通常几千）
  var maxStack = 0;
  for (var _i = 0; _i < data.length; _i++) {
    var _sum = (data[_i].up_count || 0) + (data[_i].down_count || 0);
    if (_sum > maxStack) maxStack = _sum;
  }
  var yMax = Math.max(100, Math.ceil(maxStack * 1.15));
  var chart = echarts.init(el);
  chart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 50, right: 50, top: 30, bottom: 30 },
    tooltip: {
      trigger: 'axis',
      formatter: function(params) {
        var date = params[0].axisValue;
        var idx = params[0].dataIndex;
        var d = data[idx];
        var prevD = idx > 0 ? data[idx - 1] : null;
        // ★ 必须先声明 up / down，否则下方引用会 ReferenceError 致 tooltip 静默失败
        var up = (d && d.up_count) || 0;
        var down = (d && d.down_count) || 0;
        var flat = (d && d.flat_count) || 0;
        var sample = (d && d.sample_size) || 0;
        var upPct = sample > 0 ? (up / sample * 100).toFixed(1) + '%' : '--';
        var diffTxt = '';
        if (prevD) {
          var upDiff = up - ((prevD.up_count || 0));
          var downDiff = down - ((prevD.down_count || 0));
          diffTxt = '<br/>🔄 较昨日: 上涨 ' + (upDiff > 0 ? '+' : '') + upDiff + ', 下跌 ' + (downDiff > 0 ? '+' : '') + downDiff;
        }
        return date + '<br/>' +
          '📈 上涨: <b style="color:#ff3b30">' + up + '</b> 家 (' + upPct + ')<br/>' +
          '📉 下跌: <b style="color:#34c759">' + down + '</b> 家' +
          (flat > 0 ? '<br/>⚪ 平盘: ' + flat + ' 家' : '') +
          '<br/>📊 涨跌差: ' + (up - down) +
          '<br/>📐 涨跌比例: ' + ratioArr[idx] +
          diffTxt;
      }
    },
    legend: {
      data: ['上涨家数', '下跌家数', '涨跌比例'],
      textStyle: { color: ts.textColor, fontSize: 10 },
      top: 0, right: 0,
      itemWidth: 10, itemHeight: 8
    },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine:  { lineStyle: { color: ts.gridLine } },
      axisLabel: { color: ts.textColor, fontSize: 10, interval: Math.max(0, Math.floor(dates.length / 6) - 1) }
    },
    yAxis: [
      {
        type: 'value',
        name: '家数',
        position: 'left',
        min: 0,
        max: yMax,
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { lineStyle: { color: ts.gridLine, type: 'dashed' } }
      },
      {
        type: 'value',
        name: '比值',
        position: 'right',
        min: 0,
        max: Math.max(10, (function() {
          // 折线最大值 * 1.2 避免顶到边
          var mx = 0;
          for (var _k = 0; _k < ratioArr.length; _k++) if (ratioArr[_k] > mx) mx = ratioArr[_k];
          return Math.ceil(mx * 1.2);
        })()),
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { show: false }
      }
    ],
    series: [
      // 下跌家数（绿色，堆在下半）
      {
        name: '下跌家数',
        type: 'bar',
        stack: 'upDownStack',
        yAxisIndex: 0,
        data: downArr,
        itemStyle: { color: '#34c759' },
        barMaxWidth: 16,
        emphasis: { focus: 'series' }
      },
      // 上涨家数（红色，堆在上半）
      {
        name: '上涨家数',
        type: 'bar',
        stack: 'upDownStack',
        yAxisIndex: 0,
        data: upArr,
        itemStyle: { color: '#ff3b30' },
        barMaxWidth: 16,
        emphasis: { focus: 'series' },
        markLine: {
          silent: true,
          symbol: ['none', 'none'],
          data: prevUp != null ? [{ xAxis: dates.length - 2, lineStyle: { color: '#94a3b8', width: 1, type: 'dotted', opacity: 0.6 }, label: { show: true, position: 'start', formatter: '昨日 ' + prevDate, color: '#94a3b8', fontSize: 9, fontWeight: 600, backgroundColor: 'rgba(148,163,184,0.15)', padding: [2, 4], borderRadius: 3 } }] : []
        }
      },
      // 涨跌比例（折线，浮在柱子上方）
      {
        name: '涨跌比例',
        type: 'line',
        yAxisIndex: 1,
        data: ratioArr,
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { color: '#bf5af2', width: 2 },
        itemStyle: { color: '#bf5af2' },
        z: 10,
        markPoint: prevRatio != null ? {
          symbol: 'circle', symbolSize: 8,
          itemStyle: { color: '#94a3b8' },
          label: { show: true, position: 'top', formatter: '昨比 ' + prevRatio, color: '#94a3b8', fontSize: 9, fontWeight: 600 },
          data: [{ name: '昨日比例', value: prevRatio, xAxis: dates.length - 2, yAxis: prevRatio }]
        } : { data: [] },
        markLine: getDRCurrentDateMarkLine(currentDateIdx)
      }
    ]
  });
  if (drHistoryECharts.upDown) drHistoryECharts.upDown.dispose();
  drHistoryECharts.upDown = chart;
}

// 简单移动平均（用于辅助线）
function calcSimpleMA(arr, n) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    var s = 0;
    for (var j = i - n + 1; j <= i; j++) s += arr[j];
    out.push(Math.round(s / n));
  }
  return out;
}

// 主题切换时，让 3 张图重新计算颜色
window.addEventListener('theme-changed', function() {
  if (drHistoryData) renderDRHistoryCharts();
});
// 窗口尺寸变化时也重新计算
window.addEventListener('resize', function() {
  if (drHistoryECharts.margin)  drHistoryECharts.margin.resize();
  if (drHistoryECharts.amount)  drHistoryECharts.amount.resize();
  if (drHistoryECharts.ldd)     drHistoryECharts.ldd.resize();
  if (drHistoryECharts.upDown)  drHistoryECharts.upDown.resize();
});

// 单个指数的走势判定（5-10 均线 + MACD + 价格 vs 5日线位置 → 6 种走势之一）
// ma5Position: 'above'（价格在 5 日线上方） / 'below'（下方） / ''（未填）
// 加权规则：
//   - ma5Position='above' → 走势升 1 档（最多「强势上涨」）
//   - ma5Position='below' → 走势降 1 档（最多「弱势下跌」）
function analyzeTrend(maState, macdState, ma5Position) {
  var trend = '';
  var reason = '';

  // 1. 5-10 金叉（刚发生）+ MACD 配合
  if (maState === '5-10金叉') {
    if (macdState === '水上金叉' || macdState === '水上多头') {
      trend = '多头趋势';
      reason = '5-10 金叉 + MACD 水上强势 → 趋势确立';
    } else if (macdState === '水下金叉' || macdState === '水下多头' || macdState === '水下底背离') {
      trend = '反弹观察';
      reason = '5-10 金叉 + MACD 水下转强 → 反弹信号';
    } else if (macdState === '水上死叉' || macdState === '水上空头' || macdState === '水上顶背离') {
      trend = '震荡整理';
      reason = '5-10 金叉 + MACD 水上偏弱 → 信号待确认';
    } else {
      trend = '震荡整理';
      reason = '5-10 金叉 + MACD ' + macdState + ' → 方向待选择';
    }
  }
  // 2. 5-10 死叉 + MACD
  else if (maState === '5-10死叉') {
    if (macdState === '水上金叉' || macdState === '水上多头') {
      trend = '震荡整理';
      reason = '5-10 死叉 + MACD 水上强势 → 短线震荡';
    } else if (macdState === '水下金叉' || macdState === '水下多头') {
      trend = '弱势下跌';
      reason = '5-10 死叉 + MACD 水下转强 → 弱势修复中';
    } else if (macdState === '水上死叉' || macdState === '水上空头' || macdState === '水上顶背离') {
      trend = '趋势走弱';
      reason = '5-10 高位死叉 + MACD 水上转弱（顶背离/水上死叉）→ 典型顶部信号';
    } else if (macdState === '水下底背离') {
      trend = '反弹观察';
      reason = '5-10 死叉 + MACD 水下底背离 → 弱势中酝酿反弹';
    } else {
      trend = '弱势下跌';
      reason = '5-10 死叉 + MACD 水下 → 趋势转弱';
    }
  }
  // 3. 5-10 粘合 + MACD
  else if (maState === '5-10粘合') {
    if (macdState === '水上金叉' || macdState === '水上多头') {
      trend = '震荡整理';
      reason = '5-10 粘合 + MACD 水上强势 → 方向待选择';
    } else if (macdState === '水上顶背离') {
      trend = '趋势走弱';
      reason = '5-10 粘合 + MACD 顶背离 → 警惕回调';
    } else if (macdState === '水下金叉' || macdState === '水下多头' || macdState === '水下底背离') {
      trend = '反弹观察';
      reason = '5-10 粘合 + MACD 水下转强 → 底部可能';
    } else if (macdState === '水上死叉' || macdState === '水上空头') {
      trend = '震荡整理';
      reason = '5-10 粘合 + MACD 水上偏弱 → 方向待选择';
    } else {
      trend = '弱势下跌';
      reason = '5-10 粘合 + MACD 水下 → 弱势震荡';
    }
  }
  // 4. 多头排列（5 在 10 上方持续）+ MACD
  else if (maState === '多头排列') {
    if (macdState === '水上金叉' || macdState === '水上多头') {
      trend = '强势上涨';
      reason = '5-10 多头排列 + MACD 水上强势 → 强势';
    } else if (macdState === '水上死叉' || macdState === '水上空头') {
      trend = '多头趋势';
      reason = '5-10 多头排列 + MACD 水上偏弱（注意短线回调）';
    } else if (macdState === '水上顶背离') {
      trend = '趋势走弱';
      reason = '5-10 多头排列 + MACD 顶背离，警惕回调';
    } else if (macdState === '水下金叉' || macdState === '水下多头') {
      trend = '多头趋势';
      reason = '5-10 多头排列 + MACD 水下转强 → 修复中';
    } else if (macdState === '水下底背离') {
      trend = '反弹观察';
      reason = '5-10 多头排列 + MACD 水下底背离 → 调整尾声';
    } else {
      trend = '弱势下跌';
      reason = '5-10 多头排列 + MACD 水下偏弱 → 多头失败';
    }
  }
  // 5. 空头排列（5 在 10 下方持续）+ MACD
  else if (maState === '空头排列') {
    if (macdState === '水上金叉' || macdState === '水上多头') {
      trend = '趋势走弱';
      reason = '5-10 空头排列 + MACD 水上强势 → 弱势修复中';
    } else if (macdState === '水上死叉' || macdState === '水上空头' || macdState === '水上顶背离') {
      trend = '趋势走弱';
      reason = '5-10 空头排列 + MACD 水上偏弱 → 加速下跌风险';
    } else if (macdState === '水下金叉' || macdState === '水下多头' || macdState === '水下底背离') {
      trend = '反弹观察';
      reason = '5-10 空头排列 + MACD 水下转强 → 反弹信号';
    } else {
      trend = '弱势下跌';
      reason = '5-10 空头排列 + MACD 水下偏弱 → 持续下跌';
    }
  }
  else {
    trend = '震荡整理';
    reason = '均线状态：' + maState + ' + MACD：' + macdState + ' → 中性观望';
  }

  // === 3 指标加权：根据价格在 5 日线上方/下方，对走势升/降 1 档 ===
  if (ma5Position === 'above' || ma5Position === 'below') {
    var ranked = ['弱势下跌', '反弹观察', '趋势走弱', '震荡整理', '多头趋势', '强势上涨'];
    var idx = ranked.indexOf(trend);
    if (idx >= 0) {
      var newIdx = ma5Position === 'above' ? Math.min(idx + 1, ranked.length - 1) : Math.max(idx - 1, 0);
      if (newIdx !== idx) {
        var dir = ma5Position === 'above' ? '上' : '下';
        reason += ' ｜ 5日线' + dir + '方加权：' + trend + ' → ' + ranked[newIdx];
        trend = ranked[newIdx];
      } else {
        reason += ' ｜ 5日线' + (ma5Position === 'above' ? '上' : '下') + '方已到档位极限（' + trend + '）';
      }
    }
  }

  return { trend: trend, reason: reason };
}

// 综合走势 UI 更新（含技术面均分 + 资金面分 + 综合分显示）
function updateDRTrendResultUI(trend, hint, totalScore, scoreBreakdown) {
  // 这个函数被调用时 hint 里已经包含所有评分信息。
  // 但 totalScore/scoreBreakdown 是技术面的，我们需要在更上层把资金面和综合分拼出来。
  // 为了不破坏现有调用方签名，hint 已包含所有上下文，UI 直接用 hint 即可。
  // 这里只负责把技术面分徽章放到 span 里。
  var valEl = document.getElementById('drTrendResultValue');
  var hintEl = document.getElementById('drTrendResultHint');
  var scoreEl = document.getElementById('drTrendResultScore');
  if (!valEl) return;
  valEl.className = 'dr-trend-result-value';

  if (trend && DR_TREND_STYLES[trend]) {
    valEl.textContent = trend;
    valEl.classList.add(DR_TREND_STYLES[trend].cls);
    if (hintEl) hintEl.textContent = hint || '';
  } else {
    valEl.textContent = '—';
    if (hintEl) hintEl.textContent = hint || '请为每个指数选择「均线状态」和「MACD 状态」';
  }

  // 技术面综合分徽章（资金面/情绪面已下线，仅显示技术分 0-40）
  if (scoreEl) {
    // 从 closure 找到综合分（recalcDROverallTrend 的返回值）
    var lastOverall = window._lastDROverall || {};
    var hasScore     = !!lastOverall.hasScore;
    var techScore    = lastOverall.totalScore;
    var totalAll     = lastOverall.totalAll;
    if (hasScore) {
      scoreEl.style.display = '';
      var valSpan = scoreEl.querySelector('.dr-trend-result-score-value');
      var detailSpan = scoreEl.querySelector('.dr-trend-result-score-detail');
      if (valSpan) {
        valSpan.textContent = '技术分 ' + techScore + '/40';
        valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(techScore);
      }
      if (detailSpan) {
        detailSpan.textContent = '技术 ' + techScore + '/40 · 综合 ' + totalAll + '/40';
      }
    } else {
      scoreEl.style.display = 'none';
    }
  }
}

// ===== 整体走势 → 仓位映射（6 档走势对应 6 档仓位）=====
// 仓位与整体走势一一对应，砍掉了原 5 条独立规则表（与 analyzeTrend 重复）
var TREND_TO_POSITION = {
  '强势上涨': { range: '10-16 成', cls: 'pos-max' },
  '多头趋势': { range: '8-10 成',  cls: 'pos-mid' },
  '反弹观察': { range: '5-8 成',  cls: 'pos-mid' },
  '震荡整理': { range: '3-5 成',  cls: 'pos-low' },
  '趋势走弱': { range: '1-2 成',  cls: 'pos-min' },
  '弱势下跌': { range: '1-2 成',  cls: 'pos-min' }
};

// 整体仓位 = 复用整体走势（取最弱指数）→ 直接映射仓位
function autoCalcDRPosition() {
  if (!drData.marketRegime) drData.marketRegime = { position: '', matchedRuleId: '', matchedRuleDesc: '', note: '' };

  var overall = recalcDROverallTrend();
  var trend = overall.trend;

  // 没有有效走势
  if (!trend || !TREND_TO_POSITION[trend]) {
    drData.marketRegime.matchedRuleId = '';
    drData.marketRegime.matchedRuleDesc = '';
    drData.marketRegime.position = '';
    updateDRSuggestedPosUI('—', '', '请为每个指数选择「均线状态」和「MACD 状态」');
    hideDRMatchedRule();
    return;
  }

  var pos = TREND_TO_POSITION[trend];
  drData.marketRegime.matchedRuleId = 'trend_' + trend;
  drData.marketRegime.matchedRuleDesc = '整体走势：' + trend + ' → 建议仓位 ' + pos.range;
  drData.marketRegime.position = pos.range;
  updateDRSuggestedPosUI(pos.range, pos.cls, '基于整体走势「' + trend + '」自动匹配');
  hideDRMatchedRule();
}

function updateDRSuggestedPosUI(position, posClass, hint) {
  var valEl = document.getElementById('drSuggestedPosValue');
  var hintEl = document.getElementById('drSuggestedPosHint');
  if (!valEl) return;
  valEl.className = 'dr-suggested-pos-value';
  valEl.textContent = position;
  if (posClass) valEl.classList.add(posClass);
  if (hintEl) hintEl.textContent = hint;
}

function updateDRMatchedRuleUI(rule, indexName) {
  var block = document.getElementById('drMatchedRule');
  var descEl = document.getElementById('drMatchedRuleDesc');
  var posEl = document.getElementById('drMatchedRulePos');
  if (!block) return;
  block.style.display = 'flex';
  if (descEl) descEl.textContent = rule.desc + (indexName ? '（来自：' + indexName + '）' : '');
  if (posEl) {
    posEl.textContent = '仓位 ' + rule.position;
    posEl.className = 'dr-matched-rule-tag';
  }
}

function hideDRMatchedRule() {
  var block = document.getElementById('drMatchedRule');
  if (block) block.style.display = 'none';
}

function highlightDRMatchedRuleRow(ruleId) {
  if (!ruleId) return;
  var row = document.querySelector('.dr-rules-table tbody tr[data-rule-id="' + ruleId + '"]');
  if (row) row.classList.add('matched');
}

// ===== 填充表单：仓位策略区 =====
function renderDRMarketRegime() {
  if (!drData.marketRegime) drData.marketRegime = { position: '', matchedRuleId: '', matchedRuleDesc: '', note: '' };
  var mr = drData.marketRegime;

  // 历史数据中可能保留旧规则的 matchedRuleId（593c9eb 之前）。新规则统一为
  // 'trend_<走势名>' 格式，源自 TREND_TO_POSITION。如果旧规则 id 找不到，
  // 静默回退到 autoCalcDRPosition（按当前整体走势重新匹配）。
  if (mr.matchedRuleId) {
    var trendFromRule = null;
    if (typeof mr.matchedRuleId === 'string' && mr.matchedRuleId.indexOf('trend_') === 0) {
      trendFromRule = mr.matchedRuleId.substring('trend_'.length);
    }
    if (trendFromRule && TREND_TO_POSITION[trendFromRule]) {
      var pos = TREND_TO_POSITION[trendFromRule];
      updateDRSuggestedPosUI(mr.position || pos.range, pos.cls, '匹配规则：整体走势「' + trendFromRule + '」 → 仓位 ' + pos.range);
      hideDRMatchedRule();
      return;
    }
    // 旧规则 id：已删除的 DR_POSITION_RULES 找不到，直接重算
    mr.matchedRuleId = '';
    mr.matchedRuleDesc = '';
  }
  // 否则尝试根据 indices 重新匹配
  if (Array.isArray(drData.indices) && drData.indices.some(function(i) { return i.maState && i.macdState; })) {
    autoCalcDRPosition();
  } else {
    updateDRSuggestedPosUI('—', '', '请为每个指数选择「均线状态」和「MACD 状态」自动计算仓位');
    hideDRMatchedRule();
  }
}

function saveDRMarketRegimeToData() {
  if (!drData.marketRegime) drData.marketRegime = { position: '', matchedRuleId: '', matchedRuleDesc: '', note: '' };
}

function saveDRIndicesToData() {
  // indices 字段已在 onDRIndexChange 中实时更新，无需重复保存
}

// ===== 从表单保存到 drData =====
function saveCurrentFormToData() {
  saveDRIndicesToData();
  saveDRMarketRegimeToData();

  drData.discipline = {
    moodScore: getDRMoodScore(),
    moodTags: getDRMoodTags(),
    executedStop: getCheckVal('drExecutedStop'),
    executedTakeProfit: getCheckVal('drExecutedTP'),
    chaseKilling: getCheckVal('drChaseKilling'),
    frequentTrading: getCheckVal('drFrequentTrading'),
    overnightFull: getCheckVal('drOvernightFull')
  };

  drData.summary = {
    goodPoints: getTextVal('drGoodPoints'),
    badPoints: getTextVal('drBadPoints'),
    biggestLesson: getTextVal('drBiggestLesson'),
    tomorrowNotes: getTextVal('drTomorrowNotes'),
    watchList: getTextVal('drWatchList')
  };

  saveDRThemesToData();
}

// ===== 交易复盘列表 =====
function renderDRTrades(dayTrades, holdings) {
  var container = document.getElementById('drTradesList');
  if (!container) return;

  var hasDayTrades = dayTrades.length > 0;
  var hasHoldings = holdings && holdings.length > 0;

  if (!hasDayTrades && !hasHoldings) {
    container.innerHTML = '';
    var emptyGuide = document.getElementById('drTradesEmpty');
    if (emptyGuide) emptyGuide.style.display = '';
    return;
  }
  var emptyGuide = document.getElementById('drTradesEmpty');
  if (emptyGuide) emptyGuide.style.display = 'none';

  // 当日交易再拆分为「当日开仓」与「当日出场」两组
  var opens = [];
  var exits = [];
  dayTrades.forEach(function(t) {
    if (t.date === drCurrentDate) {
      opens.push(t);
    } else if (t.exitDate === drCurrentDate) {
      exits.push(t);
    }
  });

  var html = '';
  if (opens.length > 0) {
    html += '<div class="dr-trade-group">';
    html += '<div class="dr-trade-group-title">📥 当日开仓 <span class="dr-trade-group-count">' + opens.length + '</span></div>';
    opens.forEach(function(t) { html += renderDRDayTradeCard(t, 'open'); });
    html += '</div>';
  }

  if (exits.length > 0) {
    html += '<div class="dr-trade-group">';
    html += '<div class="dr-trade-group-title">📤 当日出场 <span class="dr-trade-group-count">' + exits.length + '</span></div>';
    exits.forEach(function(t) { html += renderDRDayTradeCard(t, 'exit'); });
    html += '</div>';
  }

  if (hasHoldings) {
    html += '<div class="dr-trade-group">';
    html += '<div class="dr-trade-group-title">💼 当前持仓 <span class="dr-trade-group-count">' + holdings.length + '</span></div>';
    holdings.forEach(function(t) { html += renderDRHoldingCard(t); });
    html += '</div>';
  }

  container.innerHTML = html;

  // 绑定事件（开仓/平仓/持仓卡片的可编辑字段统一处理）
  container.querySelectorAll('.dr-trade-field').forEach(function(el) {
    el.addEventListener('change', function() {
      saveTradeFieldToData(el.dataset.tradeId, el.dataset.field, el.value);
    });
    el.addEventListener('input', function() {
      saveTradeFieldToData(el.dataset.tradeId, el.dataset.field, el.value);
    });
  });

  // 把所有原生 select 升级为 custom-select（视觉与"买点类型"统一）
  if (typeof upgradeSelectToCustom === 'function') {
    container.querySelectorAll('select.dr-select').forEach(upgradeSelectToCustom);
  }
}

// 渲染当日交易卡片（开仓/出场差异化字段）
function renderDRDayTradeCard(t, source) {
  var existing = (drData.tradeReviews || []).find(function(r) { return r.tradeId === t.id; });
  var pnlColor = t.pnl !== '' && !isNaN(parseFloat(t.pnl)) ? (parseFloat(t.pnl) >= 0 ? 'var(--color-red)' : 'var(--color-green)') : 'var(--text-secondary)';

  var sourceTag = source === 'exit'
    ? '<span class="dr-trade-source dr-source-exit" title="此笔在 ' + esc(t.date) + ' 开仓，今日平仓">📤 当日出场 · 开仓 ' + esc(t.date) + '</span>'
    : '<span class="dr-trade-source dr-source-open" title="今日开仓">📥 当日开仓</span>';

  var html = '<div class="dr-trade-card card" data-trade-id="' + esc(t.id) + '">';
  html += '<div class="dr-trade-header">';
  html += sourceTag;
  html += '<span class="dr-trade-symbol">' + esc(t.symbol || '-') + '</span>';
  html += '<span class="dr-trade-dir ' + (t.dir === '多' ? 'dir-long' : 'dir-short') + '">' + esc(t.dir || '-') + '</span>';
  html += '<span class="dr-trade-entry">入场 ' + esc(t.entry || '-') + '</span>';
  if (source === 'exit') {
    html += '<span class="dr-trade-exit">出场 ' + esc(t.exit || '-') + '</span>';
    html += '<span class="dr-trade-pnl" style="color:' + pnlColor + '">' + (t.pnl !== '' ? CNY(parseFloat(t.pnl)) : '-') + '</span>';
    html += '<span class="dr-trade-r">' + fmtR(parseFloat(t.pnlR) || 0) + '</span>';
  }
  html += '<a href="index.html#trade-' + esc(t.id) + '" class="dr-trade-edit-link" title="跳转到交易管理页编辑此笔交易" aria-label="编辑此笔交易">✏️ 编辑</a>';
  html += '</div>';

  html += '<div class="dr-trade-fields">';
  if (source === 'open') {
    html += renderDROpenFields(t, existing);
  } else {
    html += renderDRExitFields(t, existing);
  }
  html += '</div>';
  html += '</div>';
  return html;
}

// 生成 select HTML（含请选择占位 + 选项列表）
function drSelectHTML(tradeId, field, options, currentVal) {
  var html = '<select class="dr-select dr-trade-field" data-trade-id="' + esc(tradeId) + '" data-field="' + esc(field) + '">';
  html += '<option value=""' + (currentVal === '' ? ' selected' : '') + '>请选择</option>';
  (options || []).forEach(function(opt) {
    html += '<option value="' + esc(opt) + '"' + (currentVal === opt ? ' selected' : '') + '>' + esc(opt) + '</option>';
  });
  html += '</select>';
  return html;
}

// 生成 input HTML
function drInputHTML(tradeId, field, value, placeholder) {
  return '<input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(tradeId) + '" data-field="' + esc(field) + '" value="' + esc(value || '') + '" placeholder="' + esc(placeholder || '') + '">';
}

// 生成 textarea HTML
function drTextareaHTML(tradeId, field, value, placeholder, rows) {
  return '<textarea class="dr-textarea dr-trade-field" data-trade-id="' + esc(tradeId) + '" data-field="' + esc(field) + '" rows="' + (rows || 2) + '" placeholder="' + esc(placeholder || '') + '">' + esc(value || '') + '</textarea>';
}

// 生成分组标题
function drSectionTitleHTML(title) {
  return '<div class="dr-analysis-section-title">' + esc(title) + '</div>';
}

// 开仓标的复盘字段（4 个维度）
function renderDROpenFields(t, existing) {
  var html = '';
  // 1. 开仓决策分析
  html += drSectionTitleHTML('开仓决策分析');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>买入逻辑</label>' + drInputHTML(t.id, 'buyLogic', existing && existing.buyLogic, '为什么买这只') + '</div>';
  html += '<div class="dr-field"><label>买入信号</label>' + drInputHTML(t.id, 'buySignal', existing && existing.buySignal, '具体触发信号') + '</div>';
  html += '<div class="dr-field"><label>买点类型</label>' + drSelectHTML(t.id, 'buyType', window.BUY_TYPES || [], (existing && existing.buyType) || t.buyType || '') + '</div>';
  html += '<div class="dr-field"><label>符合系统</label>' + drSelectHTML(t.id, 'followedPlan', ['是', '否'], t.followedPlan || '') + '</div>';
  html += '</div>';
  // 2. 开仓质量评价
  html += drSectionTitleHTML('开仓质量评价');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>开仓时机</label>' + drSelectHTML(t.id, 'entryTiming', DR_ENTRY_TIMING_OPTS, existing && existing.entryTiming) + '</div>';
  html += '<div class="dr-field"><label>仓位大小</label>' + drSelectHTML(t.id, 'positionSizeRating', DR_POSITION_SIZE_OPTS, existing && existing.positionSizeRating) + '</div>';
  html += '<div class="dr-field"><label>入场评分</label>' + drSelectHTML(t.id, 'entryRating', DR_RATING_OPTS, existing && existing.entryRating) + '</div>';
  html += '</div>';
  // 3. 开仓心态
  html += drSectionTitleHTML('开仓心态');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>开仓情绪</label>' + drSelectHTML(t.id, 'openEmotion', DR_OPEN_EMOTION_OPTS, existing && existing.openEmotion) + '</div>';
  html += '<div class="dr-field dr-field-wide"><label>情绪影响</label>' + drInputHTML(t.id, 'emotionImpact', existing && existing.emotionImpact, '情绪对开仓决策的影响') + '</div>';
  html += '</div>';
  // 4. 风控检查
  html += drSectionTitleHTML('风控检查');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>止损设置</label>' + drSelectHTML(t.id, 'stopLossSetup', DR_STOP_LOSS_OPTS, existing && existing.stopLossSetup) + '</div>';
  html += '<div class="dr-field"><label>风险收益比</label>' + drSelectHTML(t.id, 'riskRewardRatio', DR_RISK_REWARD_OPTS, existing && existing.riskRewardRatio) + '</div>';
  html += '</div>';
  // 改进措施（保留原字段）
  html += '<div class="dr-field-row"><div class="dr-field dr-field-wide"><label>改进措施</label>' + drTextareaHTML(t.id, 'improvement', existing && existing.improvement, '下次如何改进') + '</div></div>';
  return html;
}

// 平仓标的复盘字段（4 个维度）
function renderDRExitFields(t, existing) {
  var html = '';
  // 1. 平仓原因
  html += drSectionTitleHTML('平仓原因');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>平仓类型</label>' + drSelectHTML(t.id, 'exitReason', DR_EXIT_REASON_OPTS, existing && existing.exitReason) + '</div>';
  html += '<div class="dr-field"><label>平仓触发</label>' + drSelectHTML(t.id, 'exitTrigger', DR_EXIT_TRIGGER_OPTS, existing && existing.exitTrigger) + '</div>';
  html += '</div>';
  // 2. 平仓时机
  html += drSectionTitleHTML('平仓时机');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>平仓时机</label>' + drSelectHTML(t.id, 'exitTiming', DR_EXIT_TIMING_OPTS, existing && existing.exitTiming) + '</div>';
  html += '<div class="dr-field"><label>执行评分</label>' + drSelectHTML(t.id, 'exitRating', DR_RATING_OPTS, existing && existing.exitRating) + '</div>';
  html += '</div>';
  // 3. 平仓后表现
  html += drSectionTitleHTML('平仓后表现');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>平仓后走势</label>' + drSelectHTML(t.id, 'postExitTrend', DR_POST_EXIT_TREND_OPTS, existing && existing.postExitTrend) + '</div>';
  html += '<div class="dr-field dr-field-wide"><label>最大不利</label>' + drInputHTML(t.id, 'maxAdverse', existing && existing.maxAdverse, '如果不平仓，最大浮亏会到多少') + '</div>';
  html += '</div>';
  // 4. 交易总结
  html += drSectionTitleHTML('交易总结');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>做对什么</label>' + drTextareaHTML(t.id, 'didRight', existing && existing.didRight, '本次交易做对的地方') + '</div>';
  html += '<div class="dr-field"><label>做错什么</label>' + drTextareaHTML(t.id, 'didWrong', existing && existing.didWrong, '本次交易做错的地方') + '</div>';
  html += '</div>';
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>改进措施</label>' + drTextareaHTML(t.id, 'improvement', existing && existing.improvement, '下次如何改进') + '</div>';
  html += '<div class="dr-field"><label>最大教训</label>' + drTextareaHTML(t.id, 'biggestLesson', existing && existing.biggestLesson, '本次交易最大的一个教训') + '</div>';
  html += '</div>';
  return html;
}

// 渲染当前持仓卡片（带每日状态分析字段）
function renderDRHoldingCard(t) {
  var existing = (drData.tradeReviews || []).find(function(r) { return r.tradeId === t.id; });
  // 计算持仓天数（开仓日到当前复盘日）
  var holdingDays = 0;
  if (t.date) {
    var openD = new Date(t.date + 'T00:00:00');
    var curD = new Date(drCurrentDate + 'T00:00:00');
    if (!isNaN(openD.getTime()) && !isNaN(curD.getTime())) {
      holdingDays = Math.round((curD - openD) / 86400000);
    }
  }
  var holdingDaysText = holdingDays > 0 ? ('持仓 ' + holdingDays + ' 天') : '持仓中';

  var html = '<div class="dr-trade-card dr-holding-card card" data-trade-id="' + esc(t.id) + '">';
  html += '<div class="dr-trade-header">';
  html += '<span class="dr-trade-source dr-source-holding" title="开仓于 ' + esc(t.date) + '，至今未平仓">💼 当前持仓 · 开仓 ' + esc(t.date) + '</span>';
  html += '<span class="dr-trade-symbol">' + esc(t.symbol || '-') + '</span>';
  html += '<span class="dr-trade-dir ' + (t.dir === '多' ? 'dir-long' : 'dir-short') + '">' + esc(t.dir || '-') + '</span>';
  html += '<span class="dr-trade-entry">入场 ' + esc(t.entry || '-') + '</span>';
  if (t.stop) html += '<span class="dr-trade-exit">止损 ' + esc(t.stop) + '</span>';
  if (t.posSize) html += '<span class="dr-trade-possize">仓位 ' + esc(t.posSize) + '</span>';
  html += '<span class="dr-holding-days">' + esc(holdingDaysText) + '</span>';
  html += '<a href="index.html#trade-' + esc(t.id) + '" class="dr-trade-edit-link" title="跳转到交易管理页编辑此笔交易" aria-label="编辑此笔交易">✏️ 编辑</a>';
  html += '</div>';
  if (t.note) {
    html += '<div class="dr-holding-note">' + esc(t.note) + '</div>';
  }

  // 每日状态分析字段
  html += '<div class="dr-trade-fields">';
  // 1. 走势判断 + 风险状态 + 持仓决策
  html += drSectionTitleHTML('每日状态分析');
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>走势判断</label>' + drSelectHTML(t.id, 'holdingTrend', DR_HOLDING_TREND_OPTS, existing && existing.holdingTrend) + '</div>';
  html += '<div class="dr-field"><label>风险状态</label>' + drSelectHTML(t.id, 'riskStatus', DR_RISK_STATUS_OPTS, existing && existing.riskStatus) + '</div>';
  html += '<div class="dr-field"><label>持仓决策</label>' + drSelectHTML(t.id, 'holdingDecision', DR_HOLDING_DECISION_OPTS, existing && existing.holdingDecision) + '</div>';
  html += '</div>';
  // 2. 文本备注
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field dr-field-wide"><label>今日观察</label>' + drTextareaHTML(t.id, 'todayObservation', existing && existing.todayObservation, '今日量价行为、异动、异常成交量的观察记录') + '</div>';
  html += '</div>';
  html += '<div class="dr-field-row">';
  html += '<div class="dr-field"><label>明日计划</label>' + drTextareaHTML(t.id, 'tomorrowPlan', existing && existing.tomorrowPlan, '明日需要满足什么条件才继续持有/减仓/加仓') + '</div>';
  html += '<div class="dr-field"><label>风险提示</label>' + drTextareaHTML(t.id, 'riskNote', existing && existing.riskNote, '当前持仓的风险点或注意事项') + '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  return html;
}

function saveTradeFieldToData(tradeId, field, value) {
  if (!drData.tradeReviews) drData.tradeReviews = [];
  var existing = drData.tradeReviews.find(function(r) { return r.tradeId === tradeId; });
  if (existing) {
    existing[field] = value;
  } else {
    var rec = { tradeId: tradeId };
    rec[field] = value;
    drData.tradeReviews.push(rec);
  }
  // 标记脏数据 + 延迟 1 秒自动保存（与其他字段一致）
  drDataDirty = true;
  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
    showDRAutoSaveHint();
  }, 1000);
}

// ===== 交易纪律（全局） =====
var drDisciplineEditIdx = -1;
var drDisciplineDelIdx = -1;

function loadDRDisciplineRules() {
  try {
    var stored = localStorage.getItem('daily_discipline_rules');
    if (stored) drDisciplineRules = JSON.parse(stored);
  } catch(e) { drDisciplineRules = []; }
}

function saveDRDisciplineRules() {
  try { localStorage.setItem('daily_discipline_rules', JSON.stringify(drDisciplineRules)); } catch(e) {}
  // 同步到服务器（如果已登录）
  if (drIsLoggedIn && drCurrentUserId) {
    syncDisciplineRulesToServer();
  }
}

// 同步交易纪律到服务器
function syncDisciplineRulesToServer() {
  if (!drCurrentUserId) return;
  // P0-1: 必须用 authFetch，否则提交 80ee3c3 加入的 authMiddleware 会返回 401
  // 这是「同一账号跨设备看不到交易纪律」的根本原因
  authFetch('/api/discipline-rules/' + drCurrentUserId, {
    method: 'POST',
    body: JSON.stringify({ rules: drDisciplineRules })
  })
  .then(function(r) { return r.json(); })
  .then(function() {
    if (typeof syncModule !== 'undefined' && syncModule.showSyncStatus) {
      syncModule.showSyncStatus('交易纪律已同步', 'success');
    }
  })
  .catch(function(e) {
    console.error('同步交易纪律失败:', e);
  });
}

// 从服务器加载交易纪律
// 修复：admin 等用户的纪律可能只存于 localStorage（d746d41 之前添加的），从未上传到 server。
// 现在登录时执行"以本地为基准的强同步"：本地独有 + 服务端数据 → 合并上传 → UI。
function loadDisciplineRulesFromServer() {
  if (!drCurrentUserId) return;

  // 快照本地纪律（用于合并前的状态）
  var localRules = drDisciplineRules.slice();

  // P0-1: 必须用 authFetch，否则提交 80ee3c3 加入的 authMiddleware 会返回 401
  authFetch('/api/discipline-rules/' + drCurrentUserId, {
    method: 'GET'
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data || !Array.isArray(data.rules)) return;

    var serverRules = data.rules;
    var serverSet = new Set(serverRules);

    // 1) 计算本地独有的纪律（不在 server 中）
    var localOnly = localRules.filter(function(r) { return serverSet.has(r) === false; });

    // 2) 合并策略：
    //    - 如果本地有独有 → 并集上传
    //    - 如果本地为空但 server 有 → 覆盖本地
    //    - 都没有 → 保持
    if (localOnly.length > 0) {
      // 关键：避免重复。如果 server 里已有同名项（来自其他浏览器），不去重是 ok 的（保持顺序）
      var merged = serverRules.concat(localOnly);
      drDisciplineRules = merged;
      // 立即同步上传（async）
      forceSyncDisciplineRulesToServer(merged);
    } else if (localRules.length === 0 && serverRules.length > 0) {
      // 本地空，server 有 → 拉取覆盖本地
      drDisciplineRules = serverRules;
    } else {
      // 都没有或两边都有但完全一致 → 保持
      drDisciplineRules = serverRules.length > 0 ? serverRules : localRules;
    }

    saveDRDisciplineRules();
    renderDRDisciplineRules();

    if (typeof console !== 'undefined') {
      console.log('[discipline] 同步完成 | server:', serverRules.length, '| local:', localRules.length, '| merged:', drDisciplineRules.length);
    }
  })
  .catch(function(e) {
    console.error('[discipline] 加载交易纪律失败:', e);
  });
}

// 强制同步（不依赖 drIsLoggedIn，确保登录后能上传）
function forceSyncDisciplineRulesToServer(rules) {
  if (!drCurrentUserId) return;
  var payload = Array.isArray(rules) ? rules : drDisciplineRules;
  // P0-1: 必须用 authFetch，否则提交 80ee3c3 加入的 authMiddleware 会返回 401
  authFetch('/api/discipline-rules/' + drCurrentUserId, {
    method: 'POST',
    body: JSON.stringify({ rules: payload })
  })
  .then(function(r) { return r.json(); })
  .then(function(resp) {
    if (typeof console !== 'undefined') {
      console.log('[discipline] 已强制同步到 server:', payload.length, '条', resp);
    }
    if (typeof syncModule !== 'undefined' && syncModule.showSyncStatus) {
      syncModule.showSyncStatus('交易纪律已同步', 'success');
    }
  })
  .catch(function(e) {
    console.error('[discipline] 强制同步失败:', e);
  });
}

var drDisciplineDragFromIdx = -1; // 拖动源索引

function renderDRDisciplineRules() {
  var container = document.getElementById('drDisciplineRules');
  if (!container) return;

  if (drDisciplineRules.length === 0) {
    container.innerHTML = '<div class="dr-empty-hint" style="font-size: 14px; padding: 20px;">点击下方按钮添加交易纪律</div>';
    return;
  }

  var html = '';
  drDisciplineRules.forEach(function(rule, i) {
    html += '<div class="dr-discipline-rule" data-index="' + i + '" draggable="true"'
         + ' ondragstart="onDRDisciplineDragStart(event,' + i + ')"'
         + ' ondragover="onDRDisciplineDragOver(event,' + i + ')"'
         + ' ondragend="onDRDisciplineDragEnd(event)"'
         + ' ondragleave="onDRDisciplineDragLeave(event,' + i + ')"'
         + ' ondrop="onDRDisciplineDrop(event,' + i + ')">';
    html += '<span class="dr-discipline-rule-drag" title="拖动调整顺序">⋮⋮</span>';
    html += '<div class="dr-discipline-rule-content" onclick="editDRDisciplineRule(' + i + ')">';
    html += '<span class="dr-discipline-rule-num">' + (i + 1) + '</span>';
    html += '<span class="dr-discipline-rule-text">' + esc(rule) + '</span>';
    html += '</div>';
    html += '<button class="dr-discipline-rule-del" onclick="event.stopPropagation();removeDRDisciplineRule(' + i + ')" title="删除">✕</button>';
    html += '</div>';
  });

  container.innerHTML = html;
}

// 拖动开始
function onDRDisciplineDragStart(e, idx) {
  drDisciplineDragFromIdx = idx;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(idx));
  // 给被拖动元素加样式
  var el = e.currentTarget;
  setTimeout(function() { if (el) el.classList.add('dr-dragging'); }, 0);
}

// 拖动经过：阻止默认行为（必须）+ 视觉提示
function onDRDisciplineDragOver(e, idx) {
  if (drDisciplineDragFromIdx < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  // 清除其他高亮
  document.querySelectorAll('.dr-discipline-rule.dr-drop-before, .dr-discipline-rule.dr-drop-after')
    .forEach(function(n) { n.classList.remove('dr-drop-before', 'dr-drop-after'); });
  // 根据鼠标在元素的上/下半部分决定插入位置
  var el = e.currentTarget;
  var rect = el.getBoundingClientRect();
  var isAbove = (e.clientY - rect.top) < rect.height / 2;
  el.classList.add(isAbove ? 'dr-drop-before' : 'dr-drop-after');
}

// 拖动离开
function onDRDisciplineDragLeave(e, idx) {
  // dragleave 可能在子元素上触发，仅在真正离开元素时清除
  var el = e.currentTarget;
  if (el && !el.contains(e.relatedTarget)) {
    el.classList.remove('dr-drop-before', 'dr-drop-after');
  }
}

// 拖动结束
function onDRDisciplineDragEnd(e) {
  drDisciplineDragFromIdx = -1;
  document.querySelectorAll('.dr-discipline-rule').forEach(function(n) {
    n.classList.remove('dr-dragging', 'dr-drop-before', 'dr-drop-after');
  });
}

// 放置：重新计算顺序
function onDRDisciplineDrop(e, toIdx) {
  e.preventDefault();
  var fromIdx = drDisciplineDragFromIdx;
  if (fromIdx < 0 || fromIdx === toIdx) return;
  var el = e.currentTarget;
  var rect = el.getBoundingClientRect();
  var isAbove = (e.clientY - rect.top) < rect.height / 2;
  // 计算实际目标 index
  var target = isAbove ? toIdx : toIdx + 1;
  if (fromIdx < target) target--;
  if (fromIdx === target) return;
  // 数组重排
  var item = drDisciplineRules.splice(fromIdx, 1)[0];
  drDisciplineRules.splice(target, 0, item);
  // 重新渲染 + 同步
  renderDRDisciplineRules();
  saveDRDisciplineRules();
  syncDisciplineRulesToServer();
}

function addDRDisciplineRule() {
  drDisciplineEditIdx = -1;
  document.getElementById('drDisciplineModalTitle').textContent = '添加交易纪律';
  document.getElementById('drDisciplineInput').value = '';
  document.getElementById('drDisciplineModal').classList.add('show');
  setTimeout(function() { document.getElementById('drDisciplineInput').focus(); }, 100);
}

function editDRDisciplineRule(idx) {
  drDisciplineEditIdx = idx;
  document.getElementById('drDisciplineModalTitle').textContent = '编辑交易纪律';
  document.getElementById('drDisciplineInput').value = drDisciplineRules[idx];
  document.getElementById('drDisciplineModal').classList.add('show');
  setTimeout(function() { document.getElementById('drDisciplineInput').focus(); }, 100);
}

function confirmDRDiscipline() {
  var val = document.getElementById('drDisciplineInput').value.trim();
  if (!val) return;
  if (drDisciplineEditIdx >= 0) {
    drDisciplineRules[drDisciplineEditIdx] = val;
  } else {
    drDisciplineRules.push(val);
  }
  saveDRDisciplineRules();
  renderDRDisciplineRules();
  closeDRDisciplineModal();
}

function closeDRDisciplineModal() {
  document.getElementById('drDisciplineModal').classList.remove('show');
}

function removeDRDisciplineRule(idx) {
  drDisciplineDelIdx = idx;
  document.getElementById('drDisciplineDelModal').classList.add('show');
}

function confirmDRDisciplineDel() {
  if (drDisciplineDelIdx >= 0) {
    drDisciplineRules.splice(drDisciplineDelIdx, 1);
    saveDRDisciplineRules();
    renderDRDisciplineRules();
  }
  closeDRDisciplineDelModal();
}

function closeDRDisciplineDelModal() {
  document.getElementById('drDisciplineDelModal').classList.remove('show');
  drDisciplineDelIdx = -1;
}

// ===== 心态评分 =====
function setDRMoodScore(score) {
  drData.discipline = drData.discipline || {};
  drData.discipline.moodScore = score;
  var stars = document.querySelectorAll('.dr-mood-star');
  stars.forEach(function(s, i) {
    s.classList.toggle('active', i < score);
  });
  // 心态评分变更后触发自动保存（与其他字段一致）
  drDataDirty = true;
  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
    showDRAutoSaveHint();
  }, 1000);
}

function getDRMoodScore() {
  return (drData.discipline && drData.discipline.moodScore) || 3;
}

// ===== 情绪标签 =====
function renderDRMoodTags(selected) {
  var tags = ['冷静', '焦虑', '贪婪', '恐惧', '自信', '犹豫', '冲动', '兴奋'];
  var container = document.getElementById('drMoodTags');
  if (!container) return;
  var html = '';
  tags.forEach(function(tag) {
    var isActive = selected.indexOf(tag) >= 0;
    html += '<button class="dr-mood-tag' + (isActive ? ' active' : '') + '" onclick="toggleDRMoodTag(this, \'' + tag + '\')">' + tag + '</button>';
  });
  container.innerHTML = html;
}

function toggleDRMoodTag(el, tag) {
  el.classList.toggle('active');
  // 把当前激活的标签同步到 drData.discipline.moodTags 并触发自动保存
  drData.discipline = drData.discipline || {};
  drData.discipline.moodTags = getDRMoodTags();
  drDataDirty = true;
  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
    showDRAutoSaveHint();
  }, 1000);
}

function getDRMoodTags() {
  var tags = [];
  document.querySelectorAll('.dr-mood-tag.active').forEach(function(el) {
    tags.push(el.textContent);
  });
  return tags;
}

// ===== 交易复盘渲染 =====
function renderDRTradeReviews() {
  // trade reviews are rendered inline with trades list
}

// ===== 历史复盘列表（已移除，通过顶部日期切换访问历史复盘） =====
// 保留 renderReviewHistory 空函数避免调用错误
function renderReviewHistory() { /* no-op: 历史复盘列表已移除 */ }

function jumpToReview(date) {
  autoSaveDR();
  drCurrentDate = date;
  document.getElementById('drDate').value = date;
  loadTradesForDate(date);
  loadReviewForDate(date);
  // 切日期后立即重绘历史图表以更新当前日期高亮线
  if (typeof renderDRHistoryCharts === 'function' && drHistoryData) renderDRHistoryCharts();
}

// ===== 保存 =====
function saveDRReview() {
  saveCurrentFormToData();
  drData.id = drData.id || ('dr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9));
  drData.createdAt = drData.createdAt || new Date().toISOString();
  drData.updatedAt = new Date().toISOString();
  drData.date = drCurrentDate;
  saveDRData();
  drDataDirty = false;
  renderReviewHistory();
  showDRStatus('复盘已保存', 'success');
  showDRSaveToast();
}

function showDRSaveToast() {
  var toast = document.getElementById('drSaveToast');
  if (toast) {
    toast.style.display = 'flex';
    setTimeout(function() { toast.style.display = 'none'; }, 2000);
  }
}

// ===== 导入导出 =====
function exportDRData() {
  var blob = new Blob([JSON.stringify(drAllReviews, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'daily-reviews-' + getToday() + '.json';
  a.click();
  URL.revokeObjectURL(url);
}

// 导入文件大小上限：5 MB（足够容纳数千条复盘记录）
var DR_IMPORT_MAX_SIZE = 5 * 1024 * 1024;

function importDRData(event) {
  var file = event.target.files[0];
  if (!file) return;

  // 校验文件类型：仅允许 .json 或 application/json
  var isJsonName = /\.json$/i.test(file.name);
  var isJsonType = file.type === 'application/json' || file.type === '';
  if (!isJsonName && !isJsonType) {
    drAlert('导入失败', '仅支持 JSON 格式的文件');
    event.target.value = '';
    return;
  }

  // 校验文件大小
  if (file.size > DR_IMPORT_MAX_SIZE) {
    drAlert('导入失败', '文件过大（超过 5MB），请检查是否选错文件');
    event.target.value = '';
    return;
  }

  if (file.size === 0) {
    drAlert('导入失败', '文件为空');
    event.target.value = '';
    return;
  }

  var reader = new FileReader();
  reader.onerror = function() {
    drAlert('导入失败', '读取文件时发生错误');
    event.target.value = '';
  };
  reader.onload = function(e) {
    var imported;
    try {
      imported = JSON.parse(e.target.result);
    } catch(err) {
      drAlert('导入失败', '文件内容不是合法的 JSON：' + err.message);
      event.target.value = '';
      return;
    }

    // 必须是数组
    if (!Array.isArray(imported)) {
      drAlert('导入失败', '文件内容应为复盘记录数组');
      event.target.value = '';
      return;
    }

    // 逐条校验：必须有 date 字段且为字符串
    var validItems = [];
    var skipped = 0;
    imported.forEach(function(item) {
      if (item && typeof item.date === 'string' && item.date.length > 0) {
        validItems.push(item);
      } else {
        skipped++;
      }
    });

    if (validItems.length === 0) {
      drAlert('导入失败', '文件中没有有效的复盘记录（每条记录必须包含 date 字段）');
      event.target.value = '';
      return;
    }

    validItems.forEach(function(item) {
      var idx = drAllReviews.findIndex(function(r) { return r.date === item.date; });
      if (idx >= 0) drAllReviews[idx] = item;
      else drAllReviews.push(item);
    });
    dedupDRReviews();
    saveLocalReviews();
    renderReviewHistory();
    loadReviewForDate(drCurrentDate);

    var msg = '成功导入 ' + validItems.length + ' 条复盘记录';
    if (skipped > 0) msg += '（跳过无效记录 ' + skipped + ' 条）';
    showDRStatus(msg, 'success');
    event.target.value = '';
  };
  reader.readAsText(file);
}

// ===== 删除复盘 =====
function deleteDRReview() {
  drConfirm('删除复盘', '确定要删除当前日期的复盘记录吗？', '删除', function() {
    drAllReviews = drAllReviews.filter(function(r) { return r.date !== drCurrentDate; });
    saveLocalReviews();
    loadReviewForDate(drCurrentDate);
    showDRStatus('已删除', 'success');
  });
}

// ===== 工具函数 =====
function setText(id, val) {
  var el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setTextVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val || '';
}

function getTextVal(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}

// ===== 复盘进度提示 =====
// 检查 5 个关键字段是否已填写
var DR_PROGRESS_FIELDS = [
  { id: 'drGoodPoints', label: '做得好' },
  { id: 'drBadPoints', label: '需改进' },
  { id: 'drBiggestLesson', label: '教训' },
  { id: 'drTomorrowNotes', label: '明日注意' },
  { id: 'drWatchList', label: '关注标的' }
];

function updateDRProgressBar() {
  var filled = 0;
  DR_PROGRESS_FIELDS.forEach(function(f) {
    var el = document.getElementById(f.id);
    if (el && el.value && el.value.trim().length > 0) filled++;
  });
  var pct = Math.round(filled / DR_PROGRESS_FIELDS.length * 100);
  var fillEl = document.getElementById('drProgressFill');
  var textEl = document.getElementById('drProgressText');
  if (fillEl) fillEl.style.width = pct + '%';
  if (textEl) textEl.textContent = '已完成 ' + filled + '/' + DR_PROGRESS_FIELDS.length + ' 项';
}

// ===== Skeleton loading 占位 =====
function showDRSkeleton(cardId) {
  var card = document.getElementById(cardId);
  if (!card) return;
  card.style.display = '';
  var nums = card.querySelectorAll('.dr-fund-num');
  var hints = card.querySelectorAll('.dr-fund-item-hint');
  nums.forEach(function(el) {
    el.textContent = '加载中';
    el.className = 'dr-fund-num dr-skeleton';
  });
  hints.forEach(function(el) {
    el.textContent = '加载中...';
    el.className = 'dr-fund-item-hint dr-skeleton';
  });
}

function setSelectVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val || '';
}

function getSelectVal(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}

function setCheckVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.checked = !!val;
}

function getCheckVal(id) {
  var el = document.getElementById(id);
  return el ? el.checked : false;
}

function safeJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch(e) { return null; }
}

// 关闭当前打开的弹窗（ESC 触发或外部调用）
// 会自动归还焦点到打开弹窗前的元素
function closeDRModal() {
  var openModal = document.querySelector('.modal-overlay.show');
  if (!openModal) return;

  // 调用该弹窗对应的关闭函数（如果存在）
  var closeFns = {
    'drDisciplineModal': closeDRDisciplineModal,
    'drDisciplineDelModal': closeDRDisciplineDelModal,
    'drAlertModal': closeDRAlertModal,
    'drConfirmModal': closeDRConfirmModal,
    'drRiskBacktestModal': closeDRRiskBacktest
  };
  var fn = closeFns[openModal.id];
  if (fn) {
    fn();
  } else {
    openModal.classList.remove('show');
  }

  // 归还焦点
  if (drLastFocused && typeof drLastFocused.focus === 'function') {
    drLastFocused.focus();
    drLastFocused = null;
  }
}

// 焦点陷阱：在弹窗打开时记录触发元素、关闭时归还焦点
var drLastFocused = null;
var drFocusTrapHandler = null;

function setupDRFocusTrap(modalEl) {
  // 记录当前焦点元素，以便关闭弹窗后归还
  drLastFocused = document.activeElement;

  // 将焦点移入弹窗（优先关闭按钮，其次弹窗本身）
  setTimeout(function() {
    var focusable = modalEl.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    else modalEl.focus();
  }, 50);

  // 移除旧处理器
  if (drFocusTrapHandler) {
    document.removeEventListener('keydown', drFocusTrapHandler);
  }

  // Tab 键循环：在弹窗内焦点之间循环
  drFocusTrapHandler = function(e) {
    if (e.key !== 'Tab' || !modalEl.classList.contains('show')) return;
    var focusables = modalEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      // Shift+Tab：从第一个跳到最后一个
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab：从最后一个跳到第一个
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', drFocusTrapHandler);
}

// 监听所有弹窗的 show 类变化，自动启用/关闭焦点陷阱
(function() {
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(m) {
      if (m.attributeName !== 'class') return;
      var target = m.target;
      if (target.classList.contains('show')) {
        setupDRFocusTrap(target);
      }
    });
  });
  // 等 DOM 加载完成后再观察
  window.addEventListener('DOMContentLoaded', function() {
    ['drDisciplineModal', 'drDisciplineDelModal', 'drAlertModal', 'drConfirmModal'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true });
    });
  });
})();

// ===== 通用弹窗 =====
var drConfirmCallback = null;

function drAlert(title, msg) {
  document.getElementById('drAlertModalTitle').textContent = title || '提示';
  document.getElementById('drAlertModalMsg').textContent = msg || '';
  document.getElementById('drAlertModal').classList.add('show');
}

function closeDRAlertModal() {
  document.getElementById('drAlertModal').classList.remove('show');
}

function drConfirm(title, msg, okText, callback) {
  document.getElementById('drConfirmModalTitle').textContent = title || '确认';
  document.getElementById('drConfirmModalMsg').textContent = msg || '';
  document.getElementById('drConfirmModalOkBtn').textContent = okText || '确定';
  drConfirmCallback = callback;
  document.getElementById('drConfirmModal').classList.add('show');
}

function closeDRConfirmModal() {
  document.getElementById('drConfirmModal').classList.remove('show');
  drConfirmCallback = null;
}

// ==================== K线图（ECharts 懒加载） ====================
// 设计要点：
// 1. ECharts 体积大（~1MB），用动态加载避免首屏白等
// 2. 每个指数独立 ECharts 实例（关闭时 dispose）
// 3. 4 sub-plot 风格：K线+MA5/10/20、成交量、MACD（DIF/DEA/MACD 柱）
// 4. A 股配色：涨=红 (#ef476f)，跌=绿 (#2d9f7f)，与项目风格一致
var ECHARTS_CDN = 'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js';
var echartsLoadPromise = null;

// 懒加载 ECharts（多次调用只会加载一次；失败重置 promise 允许重试）
function loadEcharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsLoadPromise) return echartsLoadPromise;
  echartsLoadPromise = new Promise(function(resolve, reject) {
    var script = document.createElement('script');
    script.src = ECHARTS_CDN;
    script.onload = function() { resolve(window.echarts); };
    script.onerror = function() { echartsLoadPromise = null; reject(new Error('ECharts 加载失败（请检查网络）')); };
    document.head.appendChild(script);
  });
  return echartsLoadPromise;
}

// 存储已初始化的 ECharts 实例（key: index 序号 → echarts instance）
var drKlineCharts = {};

// 渲染 K线图（异步：先加载 ECharts + 拉数据，再绘图）
function renderDRKlineChart(idx, key) {
  var container = document.getElementById('drKline' + idx);
  if (container) container.setAttribute('data-loading', '1');
  Promise.all([
    loadEcharts(),
    authFetch('/api/market/kline/' + key + '?count=120').then(function(r) {
      if (!r.ok) throw new Error('K线接口返回 ' + r.status);
      return r.json();
    })
  ]).then(function(results) {
    drawDRKlineChart(results[0], idx, key, results[1]);
  }).catch(function(e) {
    console.error('[DR] K线加载失败:', e.message);
    if (container) container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-secondary);font-size:13px;">❌ 加载失败: ' + esc(e.message) + '</div>';
  });
}

// 实际绘制 K线图
function drawDRKlineChart(echarts, idx, key, data) {
  var container = document.getElementById('drKline' + idx);
  if (!container) return;
  if (drKlineCharts[idx]) {
    drKlineCharts[idx].dispose();
  }
  var chart = echarts.init(container);
  drKlineCharts[idx] = chart;

  // A 股配色：涨=红，跌=绿
  var UP_COLOR   = '#ef476f';
  var DOWN_COLOR = '#2d9f7f';
  var MA5_COLOR  = '#ffa726';
  var MA10_COLOR = '#29b6f6';
  var MA20_COLOR = '#ab47bc';

  // 成交量柱颜色（根据当日涨跌）
  var volumeColors = data.ohlc.map(function(o) {
    return o[1] >= o[0] ? UP_COLOR : DOWN_COLOR;  // close >= open → 红
  });

  chart.setOption({
    backgroundColor: 'transparent',
    animation: false,
    legend: {
      data: ['MA5', 'MA10', 'MA20', 'DIF', 'DEA'],
      top: 0,
      textStyle: { fontSize: 11, color: '#5c5c70' }
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(26, 26, 46, 0.95)',
      borderColor: '#4361ee',
      textStyle: { color: '#fff', fontSize: 12 }
    },
    axisPointer: {
      link: [{ xAxisIndex: 'all' }],
      label: { backgroundColor: '#4361ee' }
    },
    grid: [
      { left: 56, right: 16, top: 32,  height: '50%' },  // K线+MA
      { left: 56, right: 16, top: '64%', height: '14%' },  // 成交量
      { left: 56, right: 16, top: '82%', height: '14%' }   // MACD
    ],
    xAxis: [
      { type: 'category', data: data.dates, gridIndex: 0, boundaryGap: false,
        axisLine: { lineStyle: { color: '#5c5c70' } },
        axisLabel: { fontSize: 10, color: '#9090a8' },
        splitLine: { show: false } },
      { type: 'category', data: data.dates, gridIndex: 1, boundaryGap: false,
        axisLine: { lineStyle: { color: '#5c5c70' } },
        axisLabel: { show: false }, splitLine: { show: false } },
      { type: 'category', data: data.dates, gridIndex: 2, boundaryGap: false,
        axisLine: { lineStyle: { color: '#5c5c70' } },
        axisLabel: { fontSize: 10, color: '#9090a8' }, splitLine: { show: false } }
    ],
    yAxis: [
      { gridIndex: 0, scale: true,
        splitLine: { lineStyle: { color: 'rgba(92, 92, 112, 0.1)' } },
        axisLabel: { fontSize: 10, color: '#9090a8' } },
      // 成交额（万元 → 亿元显示）。后端 volumes 字段已用「金额/10000」计算为万元。
      // 此处改用成交额比成交量更有参考意义（金额含价格信息，反映真实资金参与度）
      { gridIndex: 1, min: 0, splitNumber: 2,
        splitLine: { show: false },
        axisLabel: { fontSize: 10, color: '#9090a8', formatter: function(v) { return (v / 10000).toFixed(1) + '亿'; } } },
      { gridIndex: 2, scale: true, splitNumber: 2,
        splitLine: { show: false },
        axisLabel: { fontSize: 10, color: '#9090a8' } }
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], start: 60, end: 100 }
    ],
    series: [
      {
        name: 'K线', type: 'candlestick', data: data.ohlc,
        itemStyle: {
          color: UP_COLOR, color0: DOWN_COLOR,
          borderColor: UP_COLOR, borderColor0: DOWN_COLOR
        }
      },
      { name: 'MA5',  type: 'line', data: data.ma5,  smooth: true, lineStyle: { width: 1, color: MA5_COLOR  }, symbol: 'none' },
      { name: 'MA10', type: 'line', data: data.ma10, smooth: true, lineStyle: { width: 1, color: MA10_COLOR }, symbol: 'none' },
      { name: 'MA20', type: 'line', data: data.ma20, smooth: true, lineStyle: { width: 1, color: MA20_COLOR }, symbol: 'none' },
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: data.volumes,
        itemStyle: { color: function(params) { return volumeColors[params.dataIndex]; } }
      },
      { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: data.macd.dif,  smooth: true, lineStyle: { width: 1, color: '#ffa726' }, symbol: 'none' },
      { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: data.macd.dea,  smooth: true, lineStyle: { width: 1, color: '#29b6f6' }, symbol: 'none' },
      {
        name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2, data: data.macd.macd,
        itemStyle: {
          color: function(params) { return params.data >= 0 ? UP_COLOR : DOWN_COLOR; }
        }
      }
    ]
  });

  // 自适应窗口大小
  var resizeHandler = function() { chart.resize(); };
  window.addEventListener('resize', resizeHandler);
  chart._resizeHandler = resizeHandler;
}

// ==================== 实时风险提示系统 ====================
// 设计：
//   1) 技术面：监控四大指数 MACD 水上死叉（DIFF 下穿 DEA 且两者均 > 0）
//      — 复用后端 /api/market/indices 已计算的 macdState 字段（detectMacdState）
//      — MACD 参数标准 12/26/9，由后端 calcMACD() 统一计算
//   2) 情绪面：监控市场总成交额 / 两融余额是否达到近 500 天 95 百分位
//      — 复用 drHistoryData（近 2 年）+ calcPercentile()
//      — 异常交易日（0 值 / 缺失）自动过滤
//   3) 缓存：跟随现有 drMarketData / drHistoryData 的 5 分钟 TTL，不额外请求
//   4) 已读：按「日期 + 类型」存 localStorage，当日不再弹（次日自动重置）

var DR_RISK_ALERT = {
  PERCENTILE_WINDOW: 500,       // 百分位计算窗口（天）
  PERCENTILE_THRESHOLD: 95,     // 百分位阈值
  ALERT_SEVERITY: {             // 严重程度（影响是否可标记已读）
    macd: 'urgent',             // MACD 水上死叉 = 紧急（可关但当日不再重复弹）
    margin: 'warning',          // 两融余额高位 = 警告
    turnover: 'warning'         // 成交额高位 = 警告
  }
};
var drRiskAlertDismissed = {};  // 当日已读的 alert key → true
var drRiskAlertCache = {        // 检测结果缓存（避免每次渲染都重算）
  macd: null,
  sentiment: null,
  macdAt: 0,
  sentimentAt: 0
};

// 从 localStorage 恢复当日已读状态（key 含日期，次日自动失效）
function loadDRRiskDismissed() {
  try {
    var raw = localStorage.getItem('dr_risk_dismissed');
    if (!raw) return;
    var obj = JSON.parse(raw);
    // 只保留今天的已读记录
    var today = getToday();
    drRiskAlertDismissed = {};
    if (obj.date === today && obj.keys) {
      obj.keys.forEach(function(k) { drRiskAlertDismissed[k] = true; });
    }
  } catch (e) { drRiskAlertDismissed = {}; }
}

// 保存已读状态到 localStorage
function saveDRRiskDismissed() {
  try {
    localStorage.setItem('dr_risk_dismissed', JSON.stringify({
      date: getToday(),
      keys: Object.keys(drRiskAlertDismissed)
    }));
  } catch (e) { /* ignore quota */ }
}

// 生成当日 alert key（含日期，保证次日重置）
function drRiskAlertKey(type, sub) {
  return getToday() + '_' + type + (sub ? '_' + sub : '');
}

// ===== 1) MACD 水上死叉检测 =====
// 数据源：drData.indices[].macdState（由后端 detectMacdState 计算）
// 触发条件：macdState === '水上死叉'
// 返回：[{ key, indexName, indexKey, macdState, timePoint }] 或空数组
function detectMacdDeadCrossAlerts() {
  if (!Array.isArray(drData.indices)) return [];
  var alerts = [];
  var timePoint = drCurrentDate || getToday();
  drData.indices.forEach(function(idx) {
    if (idx.macdState === '水上死叉') {
      alerts.push({
        key: drRiskAlertKey('macd', idx.key),
        type: 'macd',
        severity: DR_RISK_ALERT.ALERT_SEVERITY.macd,
        indexName: idx.name,
        indexKey: idx.key,
        macdState: idx.macdState,
        timePoint: timePoint
      });
    }
  });
  return alerts;
}

// ===== 2) 市场情绪百分位检测 =====
// 数据源：drHistoryData.data（近 2 年，含 rzrqye / amount_total_yi）
// 触发条件：当前值 ≥ 近 500 天 95 百分位
// 异常过滤：0 值 / null / 负值（缺失数据）
// 返回：[{ key, metric, label, currentVal, percentile, threshold, unit }] 或空数组
function detectSentimentPercentileAlerts() {
  if (!drHistoryData || !drHistoryData.data || drHistoryData.data.length === 0) return [];

  var fullData = drHistoryData.data;
  var sampleDays = DR_RISK_ALERT.PERCENTILE_WINDOW;
  // 取近 N 天作为百分位计算样本
  var sample = fullData.slice(-sampleDays);

  var alerts = [];

  // --- 两融余额（rzrqye，单位：元 → 亿元）---
  var marginArrYi = filterAbnormalValues(sample.map(function(d) { return d.rzrqye; }))
    .map(function(v) { return v / 1e8; });
  if (marginArrYi.length >= 30) {
    // 当前值：取最后一条有效记录
    var curMargin = null;
    for (var i = fullData.length - 1; i >= 0; i--) {
      if (fullData[i].rzrqye > 0) { curMargin = fullData[i].rzrqye; break; }
    }
    if (curMargin != null) {
      var marginYi = curMargin / 1e8;
      var marginP = calcPercentile(marginArrYi, marginYi);
      if (marginP != null && marginP >= DR_RISK_ALERT.PERCENTILE_THRESHOLD) {
        alerts.push({
          key: drRiskAlertKey('margin'),
          type: 'margin',
          severity: DR_RISK_ALERT.ALERT_SEVERITY.margin,
          metric: 'margin',
          label: '两融余额',
          currentVal: marginYi,
          percentile: marginP,
          threshold: DR_RISK_ALERT.PERCENTILE_THRESHOLD,
          unit: '亿元',
          sampleSize: marginArrYi.length
        });
      }
    }
  }

  // --- 两市总成交额（amount_total_yi，单位：亿元）---
  var amountArr = filterAbnormalValues(sample.map(function(d) { return d.amount_total_yi; }));
  if (amountArr.length >= 30) {
    var curAmount = null;
    for (var j = fullData.length - 1; j >= 0; j--) {
      if (fullData[j].amount_total_yi > 0) { curAmount = fullData[j].amount_total_yi; break; }
    }
    if (curAmount != null) {
      var amountP = calcPercentile(amountArr, curAmount);
      if (amountP != null && amountP >= DR_RISK_ALERT.PERCENTILE_THRESHOLD) {
        alerts.push({
          key: drRiskAlertKey('turnover'),
          type: 'turnover',
          severity: DR_RISK_ALERT.ALERT_SEVERITY.turnover,
          metric: 'turnover',
          label: '两市总成交额',
          currentVal: curAmount,
          percentile: amountP,
          threshold: DR_RISK_ALERT.PERCENTILE_THRESHOLD,
          unit: '亿元',
          sampleSize: amountArr.length
        });
      }
    }
  }

  return alerts;
}

// ===== 异常数据过滤（供回测复用）=====
// 过滤规则：0 / null / 负值 / 超出均值 ±5σ 的极端异常
// 返回过滤后的数组
function filterAbnormalValues(arr) {
  if (!arr || arr.length === 0) return [];
  var valid = arr.filter(function(v) { return typeof v === 'number' && v > 0 && !isNaN(v); });
  if (valid.length === 0) return [];
  // 均值 ± 5σ 过滤极端数据错误（保留合法高位值）
  var sum = 0;
  for (var i = 0; i < valid.length; i++) sum += valid[i];
  var mean = sum / valid.length;
  var sqSum = 0;
  for (var k = 0; k < valid.length; k++) sqSum += (valid[k] - mean) * (valid[k] - mean);
  var std = Math.sqrt(sqSum / valid.length);
  if (std === 0) return valid;
  var lo = mean - 5 * std;
  var hi = mean + 5 * std;
  return valid.filter(function(v) { return v >= lo && v <= hi; });
}

// ===== 主检查函数：汇总所有风险并渲染 =====
function checkDRRiskAlerts() {
  // 检测
  var macdAlerts = detectMacdDeadCrossAlerts();
  var sentimentAlerts = detectSentimentPercentileAlerts();

  // 缓存
  drRiskAlertCache.macd = macdAlerts;
  drRiskAlertCache.sentiment = sentimentAlerts;
  drRiskAlertCache.macdAt = Date.now();
  drRiskAlertCache.sentimentAt = Date.now();

  // 合并 + 过滤已读
  var allAlerts = macdAlerts.concat(sentimentAlerts);
  var activeAlerts = allAlerts.filter(function(a) {
    return !drRiskAlertDismissed[a.key];
  });

  renderDRRiskAlerts(activeAlerts);
}

// ===== 渲染风险提示（综合走势判断下方的高亮警示）=====
function renderDRRiskAlerts(alerts) {
  var wrap = document.getElementById('drTrendRiskHighlight');
  var body = document.getElementById('drTrendRiskBody');
  if (!wrap || !body) return;

  if (!alerts || alerts.length === 0) {
    wrap.style.display = 'none';
    body.innerHTML = '';
    return;
  }

  // 构建高亮提示内容（精简版，避免占用过多空间）
  var html = '';
  alerts.forEach(function(a) {
    var tag = '';
    var text = '';
    if (a.type === 'macd') {
      tag = '技术面';
      text = '<b>' + esc(a.indexName) + '</b> 出现 MACD 水上死叉（DIFF 下穿 DEA，两者均位于零轴上方）';
    } else if (a.type === 'margin') {
      tag = '情绪面';
      text = '<b>两融余额 ' + a.currentVal.toFixed(0) + ' ' + a.unit + '</b> 达近 ' + a.sampleSize
           + ' 天 <b>P' + a.percentile + '</b>（≥ P' + a.threshold + ' 高位）';
    } else if (a.type === 'turnover') {
      tag = '情绪面';
      text = '<b>两市总成交额 ' + a.currentVal.toFixed(0) + ' ' + a.unit + '</b> 达近 ' + a.sampleSize
           + ' 天 <b>P' + a.percentile + '</b>（≥ P' + a.threshold + ' 高位）';
    }
    html += '<div class="dr-trend-risk-item">'
          + '<span class="dr-trend-risk-item-icon" aria-hidden="true">⚠</span>'
          + '<span class="dr-trend-risk-item-tag">' + tag + '</span>'
          + '<span class="dr-trend-risk-item-text">' + text + '</span>'
          + '</div>';
  });
  body.innerHTML = html;
  wrap.style.display = '';
}

// ===== 标记为已读（隐藏高亮警示）=====
function dismissDRRiskAlerts() {
  var wrap = document.getElementById('drTrendRiskHighlight');
  if (!wrap) return;
  wrap.style.display = 'none';

  // 将当前所有活跃 alert key 标记为已读
  var allAlerts = (drRiskAlertCache.macd || []).concat(drRiskAlertCache.sentiment || []);
  allAlerts.forEach(function(a) {
    drRiskAlertDismissed[a.key] = true;
  });
  saveDRRiskDismissed();
}

// ===== 历史回测弹窗 =====
function openDRRiskBacktest() {
  var modal = document.getElementById('drRiskBacktestModal');
  if (modal) modal.classList.add('show');
  // 预填结果区域
  var resultEl = document.getElementById('drRiskBtResult');
  if (resultEl && !resultEl.innerHTML) {
    resultEl.innerHTML = '<div class="dr-risk-bt-empty">选择回测范围后点击「开始回测」</div>';
  }
}

function closeDRRiskBacktest() {
  var modal = document.getElementById('drRiskBacktestModal');
  if (modal) modal.classList.remove('show');
}

// 执行历史回测：扫描历史数据，统计百分位信号触发次数
function runDRRiskBacktest() {
  var resultEl = document.getElementById('drRiskBtResult');
  var rangeEl = document.getElementById('drRiskBtRange');
  if (!resultEl) return;
  var days = rangeEl ? parseInt(rangeEl.value) : 365;

  if (!drHistoryData || !drHistoryData.data || drHistoryData.data.length === 0) {
    resultEl.innerHTML = '<div class="dr-risk-bt-empty">历史数据未加载，请稍后重试</div>';
    return;
  }

  var fullData = drHistoryData.data;
  var sampleDays = DR_RISK_ALERT.PERCENTILE_WINDOW;
  var threshold = DR_RISK_ALERT.PERCENTILE_THRESHOLD;

  // 回测范围：取最近 days 天
  var btData = fullData.slice(-days);

  // 逐日计算百分位信号（使用当日之前 sampleDays 天作为样本）
  var marginSignals = [];
  var turnoverSignals = [];
  var marginTotal = 0;
  var turnoverTotal = 0;

  for (var i = 0; i < btData.length; i++) {
    var cur = btData[i];

    // 两融余额信号
    if (cur.rzrqye > 0) {
      marginTotal++;
      // 取 btData[0..i] 中最近 sampleDays 天的有效数据作为样本
      var startIdx = Math.max(0, i - sampleDays);
      var sampleMargin = [];
      for (var j = startIdx; j <= i; j++) {
        if (btData[j].rzrqye > 0) sampleMargin.push(btData[j].rzrqye / 1e8);
      }
      if (sampleMargin.length >= 30) {
        var curMarginYi = cur.rzrqye / 1e8;
        var mp = calcPercentile(sampleMargin, curMarginYi);
        if (mp != null && mp >= threshold) {
          marginSignals.push({ date: cur.date, value: curMarginYi, p: mp });
        }
      }
    }

    // 成交额信号
    if (cur.amount_total_yi > 0) {
      turnoverTotal++;
      var startIdx2 = Math.max(0, i - sampleDays);
      var sampleAmount = [];
      for (var k = startIdx2; k <= i; k++) {
        if (btData[k].amount_total_yi > 0) sampleAmount.push(btData[k].amount_total_yi);
      }
      if (sampleAmount.length >= 30) {
        var ap = calcPercentile(sampleAmount, cur.amount_total_yi);
        if (ap != null && ap >= threshold) {
          turnoverSignals.push({ date: cur.date, value: cur.amount_total_yi, p: ap });
        }
      }
    }
  }

  // 渲染回测结果
  var html = '';

  // 汇总卡片
  html += '<div class="dr-risk-bt-summary">';
  html += '<div class="dr-risk-bt-stat"><div class="dr-risk-bt-stat-label">回测天数</div><div class="dr-risk-bt-stat-value">' + btData.length + '</div></div>';
  html += '<div class="dr-risk-bt-stat"><div class="dr-risk-bt-stat-label">两融高位信号</div><div class="dr-risk-bt-stat-value">' + marginSignals.length + '/' + marginTotal + '</div></div>';
  html += '<div class="dr-risk-bt-stat"><div class="dr-risk-bt-stat-label">成交额高位信号</div><div class="dr-risk-bt-stat-value">' + turnoverSignals.length + '/' + turnoverTotal + '</div></div>';
  html += '<div class="dr-risk-bt-stat"><div class="dr-risk-bt-stat-label">信号阈值</div><div class="dr-risk-bt-stat-value">P' + threshold + '</div></div>';
  html += '</div>';

  // 明细表（合并两融 + 成交额信号，按日期倒序）
  var allSignals = [];
  marginSignals.forEach(function(s) { allSignals.push({ date: s.date, type: '两融余额', value: s.value.toFixed(0) + ' 亿', p: s.p }); });
  turnoverSignals.forEach(function(s) { allSignals.push({ date: s.date, type: '总成交额', value: s.value.toFixed(0) + ' 亿', p: s.p }); });
  allSignals.sort(function(a, b) { return a.date < b.date ? 1 : -1; });

  if (allSignals.length === 0) {
    html += '<div class="dr-risk-bt-empty">回测范围内无高位信号触发</div>';
  } else {
    html += '<table class="dr-risk-bt-table"><thead><tr>'
          + '<th>日期</th><th>指标</th><th>数值</th><th>百分位</th>'
          + '</tr></thead><tbody>';
    // 最多显示 200 条避免 DOM 过大
    var maxRows = Math.min(allSignals.length, 200);
    for (var r = 0; r < maxRows; r++) {
      var s = allSignals[r];
      var pClass = s.p >= 98 ? 'bt-tag-high' : 'bt-tag-mid';
      html += '<tr><td>' + s.date + '</td><td>' + s.type + '</td><td>' + s.value + '</td>'
            + '<td class="' + pClass + '">P' + s.p + '</td></tr>';
    }
    html += '</tbody></table>';
    if (allSignals.length > 200) {
      html += '<div class="dr-risk-bt-empty">（仅显示前 200 条，共 ' + allSignals.length + ' 条信号）</div>';
    }
  }

  resultEl.innerHTML = html;

  // 更新 hint
  var hintEl = document.getElementById('drRiskBtHint');
  if (hintEl) {
    hintEl.textContent = '回测完成：扫描 ' + btData.length + ' 天，发现 '
      + (marginSignals.length + turnoverSignals.length) + ' 个高位信号（异常数据已过滤）';
  }
}

window.addEventListener('load', function() {
  initDailyReview();
});
