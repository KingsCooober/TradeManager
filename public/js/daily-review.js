// ===== 每日复盘模块 =====

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
var drFundData = null;      // 资金面数据缓存（来自 /api/market/fund，5 分钟有效）
var drFundLoadTime = 0;     // 上次加载资金面时间
var drFundLoadPromise = null; // 防止并发请求

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
  // 多维分析 · 技术面数据源：自动从行情 API 拉取 4 只指数实时价/均线，
  // 算出价格在 ma5/ma20 上/下方，让 4 维评分中后 2 维「数据驱动」而非手填
  loadDRMarketData();
  // 情绪面数据（与资金面并行，5 分钟缓存；资金面失败时仍能加载情绪面）
  loadDRSentimentData();
  // 历史趋势折线图（两融余额 / 成交额 / 涨跌停比例）
  loadDRHistoryCharts();
}

// 订阅全局登录/登出事件，修复"未登录状态打开页面后登录"导致复盘不同步的 bug
function setupDRLoginEvents() {
  window.addEventListener('user-login', function() {
    console.log('[DR] 收到 user-login 事件，重新检查登录状态');
    checkDRLoginStatus();
    // 登录后重新拉行情（认证通过才可调用 /api/market/indices）
    if (typeof loadDRMarketData === 'function') loadDRMarketData(true);
    // 登录后重新拉资金面、情绪面、历史数据
    if (typeof loadDRFundData === 'function') loadDRFundData(true);
    if (typeof loadDRSentimentData === 'function') loadDRSentimentData(true);
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
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeDRModal();
    }
    // Ctrl+S / Cmd+S 手动保存（与自动保存一致，但会弹 toast 提示）
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (typeof saveDRReview === 'function') saveDRReview();
    }
  });
  // 统一监听 change / input：在 .dr-section-body 内的表单字段变更后，
  // 标记 dirty 并通过 1 秒防抖触发自动保存（saveDRData 会本地 + 同步到服务器）。
  // 这样 summary / discipline 字段（drGoodPoints、drPlannedPos、复选框等）无需各自
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
            themes: safeJSON(r.themes_json),
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

function onDRDateChange() {
  autoSaveDR();
  var input = document.getElementById('drDate');
  drCurrentDate = input.value;
  loadTradesForDate(drCurrentDate);
  loadReviewForDate(drCurrentDate);
}

function navigateDRDate(delta) {
  autoSaveDR();
  var d = new Date(drCurrentDate);
  d.setDate(d.getDate() + delta);
  drCurrentDate = d.toISOString().slice(0, 10);
  document.getElementById('drDate').value = drCurrentDate;
  loadTradesForDate(drCurrentDate);
  loadReviewForDate(drCurrentDate);
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
  drAllTrades.forEach(function(t) {
    if (t.date === date || t.exitDate === date) {
      var key = String(t.id);
      if (seen[key]) return;
      seen[key] = true;
      dayTrades.push(t);
    }
  });
  renderDRTrades(dayTrades);
  updateDRSummaryCards(dayTrades);
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
      themes: [{ name: '', strength: '', stage: '' }],
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
  setTextVal('drMarketOverallReason', drData.overallReason || '');
  renderDRIndicesMAStatus();
  recalcDROverall();

  renderDRThemes();
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
  setTextVal('drPlannedPos', d.plannedPosition);
  setTextVal('drActualPos', d.actualPosition);

  var s = drData.summary || {};
  setTextVal('drGoodPoints', s.goodPoints);
  setTextVal('drBadPoints', s.badPoints);
  setTextVal('drBiggestLesson', s.biggestLesson);
  setTextVal('drTomorrowNotes', s.tomorrowNotes);
  setTextVal('drWatchList', s.watchList);

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

    // K线图区域（默认隐藏，点击 📊 K线 按钮展开 / 受总开关联动控制）
    // 单个指数的均线状态/MACD状态/价格 vs 5日线/走势判断等指标已在此处隐藏，
    // 用户展开 K线图后从 K线本身的形态 + 走势判断，K线图已包含 MA/成交额/MACD 等参考。
    html += '<div class="dr-field dr-field-wide dr-kline-wrap" data-index="' + i + '">';
    html += '<div class="dr-kline-toolbar">';
    html += '<button type="button" class="btn btn-xs btn-ghost dr-kline-toggle" data-index="' + i + '" data-key="' + esc(idx.key) + '" onclick="toggleDRKline(this)">📊 K线</button>';
    html += '<span class="dr-kline-hint" id="drKlineHint' + i + '">点击展开日K线图（120 根）</span>';
    html += '</div>';
    html += '<div class="dr-kline-container" id="drKline' + i + '" style="display:none"></div>';
    html += '</div>';

    html += '</div></div>';
  });

  container.innerHTML = html;

  // 渲染后同步总开关的视觉状态（如果某些 K线已被展开但总开关仍是「收起」，
  // 总开关 label 显示「部分展开」/「全部展开」取决于展开数量）
  syncKlineToggleAllBtn();
}

// ===== 大盘研判 section 折叠/展开 =====
function toggleDRMarketSection() {
  var body = document.getElementById('drMarketSectionBody');
  var icon = document.getElementById('drMarketSectionIcon');
  var header = document.querySelector('#drMarketSection .dr-section-header--clickable');
  if (!body) return;
  var isCollapsed = body.style.display === 'none';
  if (isCollapsed) {
    body.style.display = '';
    if (icon) icon.textContent = '▼';
    if (header) header.setAttribute('aria-expanded', 'true');
  } else {
    body.style.display = 'none';
    if (icon) icon.textContent = '▶';
    if (header) header.setAttribute('aria-expanded', 'false');
  }
}

// ===== K线总开关：同步展开/收起全部 4 个指数的 K线图 =====
function toggleAllDRKline() {
  var containers = document.querySelectorAll('.dr-kline-container');
  if (!containers.length) return;
  // 任意一个仍是收起状态 → 全部展开；否则全部收起
  var anyHidden = Array.prototype.some.call(containers, function(c) {
    return c.style.display === 'none' || c.style.display === '';
  });
  var newDisplay = anyHidden ? 'block' : 'none';
  var buttons = document.querySelectorAll('.dr-kline-toggle');
  Array.prototype.forEach.call(containers, function(c) {
    var wasHidden = c.style.display === 'none' || c.style.display === '';
    c.style.display = newDisplay;
    if (newDisplay === 'block' && wasHidden) {
      // 容器之前是隐藏的 → 懒加载 K线（保留已绘制的实例，不重新创建）
      var wrap = c.closest('.dr-kline-wrap');
      if (wrap) {
        var idxAttr = wrap.getAttribute('data-index');
        var btn = document.querySelector('.dr-kline-toggle[data-index="' + idxAttr + '"]');
        if (btn) renderDRKlineChart(parseInt(idxAttr), btn.getAttribute('data-key'));
      }
    } else if (newDisplay === 'none') {
      // 收起时，保留实例（避免下次再请求）但更新按钮文本
      var idxAttr2 = c.id.replace('drKline', '');
      if (drKlineCharts && drKlineCharts[idxAttr2]) {
        // 不 dispose，只隐藏 DOM
      }
    }
  });
  // 收起状态：按钮恢复"📊 K线"；展开状态：显示"📊 收起"
  Array.prototype.forEach.call(buttons, function(b) {
    b.textContent = newDisplay === 'block' ? '🔼 收起' : '📊 K线';
    if (newDisplay === 'block') b.classList.add('active');
    else b.classList.remove('active');
  });
  syncKlineToggleAllBtn();
}

// 同步总开关按钮的文本和样式（根据当前各 K线的展开状态）
function syncKlineToggleAllBtn() {
  var btn = document.getElementById('drKlineToggleAll');
  if (!btn) return;
  var containers = document.querySelectorAll('.dr-kline-container');
  if (!containers.length) {
    btn.textContent = '📊 展开 K线';
    return;
  }
  var expanded = 0;
  Array.prototype.forEach.call(containers, function(c) {
    if (c.style.display === 'block') expanded++;
  });
  if (expanded === 0) {
    btn.textContent = '📊 展开 K线';
    btn.classList.remove('dr-kline-toggle-all--partial');
  } else if (expanded === containers.length) {
    btn.textContent = '📊 收起 K线';
    btn.classList.remove('dr-kline-toggle-all--partial');
  } else {
    btn.textContent = '📊 展开 K线（' + expanded + '/' + containers.length + '）';
    btn.classList.add('dr-kline-toggle-all--partial');
  }
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
    return { trend: '', hint: '等待行情数据（后端自动识别均线/MACD 状态）...', totalScore: 0, scoreBreakdown: '', hasScore: false, hasFund: false, totalAll: 0, fundScore: 0, fundBreakdown: '' };
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

  // 资金面 0-20 分（数据驱动，无需用户填写）
  var fundScore = 0;
  var fundBreakdown = '';
  var hasFund = false;
  if (drFundData && drFundData.score) {
    fundScore = drFundData.score.total;
    fundBreakdown = drFundData.score.breakdown;
    hasFund = true;
    hint += ' ｜ 资金面分：' + fundScore + '/20';
  }

  // 情绪面 0-20 分（数据驱动，无需用户填写）
  var sentimentScore = 0;
  var sentimentBreakdown = '';
  var hasSentiment = false;
  if (drSentimentData && drSentimentData.score) {
    sentimentScore = drSentimentData.score.total;
    sentimentBreakdown = drSentimentData.score.breakdown;
    hasSentiment = true;
    hint += ' ｜ 情绪面分：' + sentimentScore + '/20';
  }

  // 综合分 = 技术面 0-40 + 资金面 0-20 + 情绪面 0-20 = 0-80
  var totalAll = (hasScore ? totalScore : 0) + (hasFund ? fundScore : 0) + (hasSentiment ? sentimentScore : 0);
  var hasAny = hasScore || hasFund || hasSentiment;
  if (hasAny) {
    var totalTrend = scoreToCompositeTrend(totalAll);
    hint += ' ｜ 综合分：' + totalAll + '/80 → ' + totalTrend;
  }

  return {
    trend: weakest.trendResult,
    hint: hint,
    totalScore: totalScore,
    scoreBreakdown: scoreBreakdown,
    fundScore: fundScore,
    fundBreakdown: fundBreakdown,
    sentimentScore: sentimentScore,
    sentimentBreakdown: sentimentBreakdown,
    totalAll: totalAll,
    hasScore: hasScore,
    hasFund: hasFund,
    hasSentiment: hasSentiment
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
      // 行情加载完成后再拉资金面（资金面接口需要 4 只指数成交额合计）
      if (typeof loadDRFundData === 'function') loadDRFundData();
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
}

// ==================== 资金面 0-20 分 ====================
// 数据源：/api/market/fund（北向资金 + 融资融券 + 沪深两市总成交额）
//   沪深两市总成交额由后端从 sh000001(沪市) + sz399001(深市) 的 amount 字段求和
// 评分维度：
//   北向资金  0-8 分：净流入 >50亿 = 8 / 0-50亿 = 6 / 0~-50亿 = 4 / <-50亿 = 2
//   融资余额  0-6 分：环比 >+1% = 6 / 0-1% = 4 / -1%-0% = 3 / <-1% = 1
//   市场成交  0-6 分：>1.5万亿 = 6 / 1.0-1.5 = 5 / 0.8-1.0 = 4 / 0.6-0.8 = 2 / <0.6 = 0
// 总分 0-20，与技术面 0-40 + 情绪面 0-20 = 综合分 0-80

var DR_FUND_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// 拉取资金面数据（后端内部自动获取沪深两市总成交额，前端无需再传 4 只指数 amount）
function loadDRFundData(force) {
  if (!force && drFundData && (Date.now() - drFundLoadTime) < DR_FUND_CACHE_TTL) {
    applyFundToUI();
    return Promise.resolve(drFundData);
  }
  if (drFundLoadPromise) return drFundLoadPromise;

  // 不再需要 4 只指数成交额合计 —— 后端内部直接从 sh000001 + sz399001 拉取
  drFundLoadPromise = authFetch('/api/market/fund', { method: 'GET' })
    .then(function(r) {
      if (!r.ok) throw new Error('资金面接口返回 ' + r.status);
      return r.json();
    })
    .then(function(data) {
      drFundData = data;
      drFundLoadTime = Date.now();
      console.log('[DR] 资金面已加载', '总成交', data.amount && data.amount.totalYi + '亿',
        '北向净流入', data.north && (data.north.netInflow / 1e8).toFixed(2) + '亿',
        '融资变化', data.margin && data.margin.changePct.toFixed(2) + '%',
        '资金面分', data.score && data.score.total + '/20');
      applyFundToUI();
      // 资金面加载完后，重新计算综合走势（综合分从 0-60 → 0-80）
      if (typeof recalcDROverall === 'function') recalcDROverall();
      // 链式加载情绪面（与资金面无依赖关系，但分批加载可降低并发压力）
      if (typeof loadDRSentimentData === 'function') loadDRSentimentData();
      return data;
    })
    .catch(function(e) {
      console.warn('[DR] 资金面加载失败，保持空值:', e.message);
      return null;
    })
    .then(function(d) {
      drFundLoadPromise = null;
      return d;
    });
  return drFundLoadPromise;
}

// ==================== 情绪面 0-20 分 ====================
// 数据源：/api/market/sentiment（沪深两市涨跌停统计 + 上涨家数占比）
// 评分维度：
//   涨跌停差   0-8 分：(涨停 - 跌停) >= 80 = 8 / 30-80 = 6 / 0-30 = 4 / -30-0 = 2 / <-30 = 0
//   上涨占比   0-8 分：>=80% = 8 / 60-80% = 6 / 40-60% = 4 / 20-40% = 2 / <20% = 0
//   涨停绝对数 0-4 分：>=80 = 4 / 40-80 = 3 / 20-40 = 2 / <20 = 1
// 总分 0-20，与技术面 0-40 + 资金面 0-20 = 综合分 0-80

var drSentimentData = null;      // 情绪面数据缓存（来自 /api/market/sentiment，5 分钟有效）
var drSentimentLoadTime = 0;
var drSentimentLoadPromise = null;
var DR_SENTIMENT_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// 拉取情绪面数据
function loadDRSentimentData(force) {
  if (!force && drSentimentData && (Date.now() - drSentimentLoadTime) < DR_SENTIMENT_CACHE_TTL) {
    applySentimentToUI();
    return Promise.resolve(drSentimentData);
  }
  if (drSentimentLoadPromise) return drSentimentLoadPromise;

  drSentimentLoadPromise = authFetch('/api/market/sentiment', { method: 'GET' })
    .then(function(r) {
      if (!r.ok) throw new Error('情绪面接口返回 ' + r.status);
      return r.json();
    })
    .then(function(data) {
      drSentimentData = data;
      drSentimentLoadTime = Date.now();
      var m = data.merged || {};
      console.log('[DR] 情绪面已加载', '上涨', m.up, '下跌', m.down, '涨停', m.zt, '跌停', m.dt,
        '情绪面分', data.score && data.score.total + '/20');
      applySentimentToUI();
      // 情绪面加载完后，重新计算综合走势（综合分 0-80）
      if (typeof recalcDROverall === 'function') recalcDROverall();
      return data;
    })
    .catch(function(e) {
      console.warn('[DR] 情绪面加载失败，保持空值:', e.message);
      return null;
    })
    .then(function(d) {
      drSentimentLoadPromise = null;
      return d;
    });
  return drSentimentLoadPromise;
}

// 渲染情绪面卡片
function applySentimentToUI() {
  var card = document.getElementById('drSentimentCard');
  if (!card) return;

  if (!drSentimentData) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  var score = drSentimentData.score || {};
  var merged = drSentimentData.merged || {};

  // 评分徽章
  var scoreEl = document.getElementById('drSentimentScore');
  if (scoreEl) {
    scoreEl.textContent = (score.total || 0) + '/20';
    scoreEl.className = 'dr-fund-score ' + getSentimentScoreBadgeClass(score.total || 0);
  }
  var breakdownEl = document.getElementById('drSentimentBreakdown');
  if (breakdownEl) breakdownEl.textContent = score.breakdown || '';

  // 涨跌停差
  var lddEl = document.getElementById('drSentimentLDD');
  if (lddEl) {
    var lddDiff = (merged.zt || 0) - (merged.dt || 0);
    var sign = lddDiff > 0 ? '+' : '';
    lddEl.textContent = sign + lddDiff;
    lddEl.className = 'dr-fund-num ' + (lddDiff > 0 ? 'fund-up' : (lddDiff < 0 ? 'fund-down' : 'fund-flat'));
  }
  var lddHintEl = document.getElementById('drSentimentLDDHint');
  if (lddHintEl) {
    lddHintEl.textContent = '涨停 ' + (merged.zt || 0) + ' / 跌停 ' + (merged.dt || 0);
  }

  // 上涨家数占比
  var upPctEl = document.getElementById('drSentimentUpPct');
  if (upPctEl) {
    var upPct = score.upPct || 0;
    upPctEl.textContent = upPct.toFixed(1) + '%';
    upPctEl.className = 'dr-fund-num ' + (upPct >= 50 ? 'fund-up' : (upPct >= 20 ? 'fund-flat' : 'fund-down'));
  }
  var upPctHintEl = document.getElementById('drSentimentUpPctHint');
  if (upPctHintEl) {
    upPctHintEl.textContent = '上涨 ' + (merged.up || 0) + ' / 下跌 ' + (merged.down || 0) + ' / 平盘 ' + (merged.flat || 0);
  }

  // 涨停数
  var ztEl = document.getElementById('drSentimentZT');
  if (ztEl) {
    ztEl.textContent = (merged.zt || 0) + ' 只';
  }
  var ztHintEl = document.getElementById('drSentimentZTHint');
  if (ztHintEl) {
    var sh = (drSentimentData.sh && drSentimentData.sh.zt) || 0;
    var sz = (drSentimentData.sz && drSentimentData.sz.zt) || 0;
    ztHintEl.textContent = '沪市 ' + sh + ' + 深市 ' + sz;
  }
}

// 情绪面 0-20 分 CSS class（与综合走势档位对齐）
function getSentimentScoreBadgeClass(total) {
  if (total >= 17) return 'fund-score-max';     // 强势（>= 17/20）
  if (total >= 13) return 'fund-score-bullish'; // 多头（13-16）
  if (total >= 9)  return 'fund-score-rebound'; // 反弹（9-12）
  if (total >= 5)  return 'fund-score-neutral'; // 震荡（5-8）
  if (total >= 2)  return 'fund-score-warning'; // 走弱（2-4）
  return 'fund-score-weak';                     // 弱势（0-1）
}

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
var drDisplayDays = 60;            // 图表显示天数（默认 60）
var drHistoryECharts = { margin: null, amount: null, ldd: null };  // ECharts 实例缓存
var DR_HISTORY_CACHE_TTL = 5 * 60 * 1000; // 5 分钟
var DR_HISTORY_API_DAYS = 730;     // 后端最大可查询天数（≈ 2 年）

// 拉取并渲染历史趋势图（始终拉全量，渲染时按 drDisplayDays 切片）
function loadDRHistoryCharts(force) {
  if (!force && drHistoryData) {
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
      if (hintEl) {
        hintEl.textContent = '图表显示近 ' + displayDays + ' 天（共 ' + (data.count || 0) + ' 天历史数据，百分位基于近 2 年）';
      }
      renderDRHistoryCharts();
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
  if (drHistoryECharts.margin) { drHistoryECharts.margin.dispose(); drHistoryECharts.margin = null; }
  if (drHistoryECharts.amount) { drHistoryECharts.amount.dispose(); drHistoryECharts.amount = null; }
  if (drHistoryECharts.ldd)    { drHistoryECharts.ldd.dispose();    drHistoryECharts.ldd    = null; }
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
    drawDRMarginChart(echarts, displayData, fullData);
    drawDRAmountChart(echarts, displayData, fullData);
    drawDRLDDChart(echarts, displayData);
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

// 1) 两融余额（亿元）—— 含历史百分位
// displayData: 用于绘制折线（最近 N 天）
// fullData:    用于计算百分位（近 2 年全量）
function drawDRMarginChart(echarts, displayData, fullData) {
  var el = document.getElementById('drHistoryMarginChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  // 显示数据：折线
  var dates = displayData.map(function(d) { return d.date.slice(5); });
  var marginArr = displayData.map(function(d) { return Math.round((d.rzrqye || 0) / 1e8); });
  // 全量数据：百分位
  var fullMarginArr = (fullData || displayData).map(function(d) { return Math.round((d.rzrqye || 0) / 1e8); });
  var currentVal = fullMarginArr.length ? fullMarginArr[fullMarginArr.length - 1] : 0;  // 最新一日
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
        data: [{ name: '当前位置', value: currentVal, xAxis: dates.length - 1, yAxis: currentVal }]
      }
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
  // 两市总成交额（亿元）
  var amountArr = displayData.map(function(d) { return Math.round(d.amount_total_yi || 0); });
  // 全量数据：百分位
  var fullAmountArr = (fullData || displayData).map(function(d) { return Math.round(d.amount_total_yi || 0); });
  var currentVal = fullAmountArr.length ? fullAmountArr[fullAmountArr.length - 1] : 0;
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
          data: [{ name: '当前位置', value: currentVal, xAxis: dates.length - 1, yAxis: currentVal }]
        }
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

// 3) 涨跌停比例（涨/跌/差）—— 柱状图（涨跌停差）+ 折线图（涨/跌比）
// 注：涨跌停历史从今天开始累积，之前的日期为 0（公开 API 无历史涨跌停数据），所以不需要全量数据
function drawDRLDDChart(echarts, data) {
  var el = document.getElementById('drHistoryLDDChart');
  if (!el) return;
  var ts = getEChartsTextStyle();
  var dates = data.map(function(d) { return d.date.slice(5); });
  var ratioArr = data.map(function(d) {
    var zt = d.zt_count || 0;
    var dt = d.dt_count || 0;
    if (dt === 0) return zt > 0 ? 10 : 0;  // 没跌停就显示 10
    return Math.round((zt / dt) * 100) / 100;
  });
  var diffArr = data.map(function(d) { return d.zt_dt_diff || 0; });
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
        return date + '<br/>' +
          '📈 涨停: ' + (d.zt_count||0) + ' / 跌停: ' + (d.dt_count||0) +
          '<br/>📊 涨跌停差: ' + (d.zt_dt_diff||0) +
          '<br/>📐 比例: ' + ratioArr[idx];
      }
    },
    legend: {
      data: ['涨跌停差', '涨/跌比'],
      textStyle: { color: ts.textColor, fontSize: 10 },
      top: 0, right: 0
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
        name: '差值',
        position: 'left',
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { lineStyle: { color: ts.gridLine, type: 'dashed' } }
      },
      {
        type: 'value',
        name: '比值',
        position: 'right',
        axisLine:  { lineStyle: { color: ts.gridLine } },
        axisLabel: { color: ts.textColor, fontSize: 10 },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: '涨跌停差',
        type: 'bar',
        yAxisIndex: 0,
        data: diffArr,
        itemStyle: {
          color: function(p) { return p.value >= 0 ? '#30d158' : '#ff453a'; }
        },
        barMaxWidth: 14
      },
      {
        name: '涨/跌比',
        type: 'line',
        yAxisIndex: 1,
        data: ratioArr,
        smooth: true,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { color: '#bf5af2', width: 2 },
        itemStyle: { color: '#bf5af2' }
      }
    ]
  });
  if (drHistoryECharts.ldd) drHistoryECharts.ldd.dispose();
  drHistoryECharts.ldd = chart;
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
  if (drHistoryECharts.margin) drHistoryECharts.margin.resize();
  if (drHistoryECharts.amount) drHistoryECharts.amount.resize();
  if (drHistoryECharts.ldd)    drHistoryECharts.ldd.resize();
});

// 把资金面数据渲染到独立卡片
function applyFundToUI() {
  var card = document.getElementById('drFundCard');
  if (!card) return;

  if (!drFundData) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  var score = drFundData.score || {};
  var north = drFundData.north || {};
  var margin = drFundData.margin || {};
  var amount = drFundData.amount || {};

  // 评分徽章
  var scoreEl = document.getElementById('drFundScore');
  if (scoreEl) {
    scoreEl.textContent = score.total + '/20';
    scoreEl.className = 'dr-fund-score ' + getFundScoreBadgeClass(score.total);
  }
  var breakdownEl = document.getElementById('drFundBreakdown');
  if (breakdownEl) breakdownEl.textContent = score.breakdown || '';

  // 北向资金
  var northEl = document.getElementById('drFundNorth');
  if (northEl) {
    var netYi = (north.netInflow || 0) / 1e8;
    var sign = netYi > 0 ? '+' : '';
    northEl.textContent = sign + netYi.toFixed(2) + ' 亿';
    northEl.className = 'dr-fund-num ' + (netYi > 0 ? 'fund-up' : (netYi < 0 ? 'fund-down' : 'fund-flat'));
  }
  var northHintEl = document.getElementById('drFundNorthHint');
  if (northHintEl) northHintEl.textContent = '沪股通 ' + (north.hk2sh / 1e8).toFixed(2) + ' + 深股通 ' + (north.hk2sz / 1e8).toFixed(2) + ' 亿';

  // 融资余额
  var marginEl = document.getElementById('drFundMargin');
  if (marginEl) {
    var pct = margin.changePct || 0;
    var sign2 = pct > 0 ? '+' : '';
    marginEl.textContent = sign2 + pct.toFixed(2) + '%';
    marginEl.className = 'dr-fund-num ' + (pct > 0 ? 'fund-up' : (pct < 0 ? 'fund-down' : 'fund-flat'));
  }
  var marginHintEl = document.getElementById('drFundMarginHint');
  if (marginHintEl) marginHintEl.textContent = '余额 ' + (margin.rzye / 1e12).toFixed(2) + ' 万亿（昨日 ' + (margin.prev && margin.prev.rzye / 1e12 || 0).toFixed(2) + '）';

  // 成交额（沪深两市 = sh000001 + sz399001 的 amount 字段求和）
  var amountEl = document.getElementById('drFundAmount');
  if (amountEl) {
    amountEl.textContent = (amount.totalYi || 0).toFixed(0) + ' 亿';
  }
  var amountHintEl = document.getElementById('drFundAmountHint');
  if (amountHintEl) {
    // 沪市 + 深市成交额明细（单位：亿元）
    var shYi = (amount.shYi || 0).toFixed(0);
    var szYi = (amount.szYi || 0).toFixed(0);
    amountHintEl.textContent = '沪市 ' + shYi + ' 亿 + 深市 ' + szYi + ' 亿（数据源: sh000001+sz399001）';
  }
}

// 资金面 0-20 分 CSS class（与综合走势档位对齐）
function getFundScoreBadgeClass(total) {
  if (total >= 17) return 'fund-score-max';     // 强势（>= 17/20）
  if (total >= 13) return 'fund-score-bullish'; // 多头（13-16）
  if (total >= 9)  return 'fund-score-rebound'; // 反弹（9-12）
  if (total >= 5)  return 'fund-score-neutral'; // 震荡（5-8）
  if (total >= 2)  return 'fund-score-warning'; // 走弱（2-4）
  return 'fund-score-weak';                     // 弱势（0-1）
}

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

  // 技术面 + 资金面 + 情绪面 + 综合分徽章
  if (scoreEl) {
    // 从 closure 找到综合分（recalcDROverallTrend 的返回值）
    var lastOverall = window._lastDROverall || {};
    var hasScore     = !!lastOverall.hasScore;
    var hasFund      = !!lastOverall.hasFund;
    var hasSentiment = !!lastOverall.hasSentiment;
    var techScore     = lastOverall.totalScore;
    var fundScore     = lastOverall.fundScore;
    var sentimentScore = lastOverall.sentimentScore;
    var totalAll      = lastOverall.totalAll;
    if (hasScore || hasFund || hasSentiment) {
      scoreEl.style.display = '';
      var valSpan = scoreEl.querySelector('.dr-trend-result-score-value');
      var detailSpan = scoreEl.querySelector('.dr-trend-result-score-detail');
      if (valSpan) {
        // 优先显示综合分
        var allThree = hasScore && hasFund && hasSentiment;
        if (allThree) {
          valSpan.textContent = '综合分 ' + totalAll + '/80';
          valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(totalAll);
        } else if (hasScore && hasFund) {
          valSpan.textContent = '技术+资金 ' + totalAll + '/60';
          valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(totalAll);
        } else if (hasScore && hasSentiment) {
          valSpan.textContent = '技术+情绪 ' + totalAll + '/60';
          valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(totalAll);
        } else if (hasFund && hasSentiment) {
          valSpan.textContent = '资金+情绪 ' + totalAll + '/40';
          valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(totalAll);
        } else if (hasScore) {
          valSpan.textContent = '技术分 ' + techScore + '/40';
          valSpan.className = 'dr-trend-result-score-value ' + getScoreBadgeClass(techScore);
        } else if (hasFund) {
          valSpan.textContent = '资金分 ' + fundScore + '/20';
          valSpan.className = 'dr-trend-result-score-value ' + getFundScoreBadgeClass(fundScore);
        } else {
          valSpan.textContent = '情绪分 ' + sentimentScore + '/20';
          valSpan.className = 'dr-trend-result-score-value ' + getSentimentScoreBadgeClass(sentimentScore);
        }
      }
      if (detailSpan) {
        var parts = [];
        if (hasScore)     parts.push('技术 ' + techScore + '/40');
        if (hasFund)      parts.push('资金 ' + fundScore + '/20');
        if (hasSentiment) parts.push('情绪 ' + sentimentScore + '/20');
        if (hasScore || hasFund || hasSentiment) {
          parts.push('综合 ' + totalAll + '/' + (allThree ? '80' : (hasScore ? '40' : (hasFund ? '20' : '20'))));
        }
        detailSpan.textContent = parts.join(' · ');
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

  setTextVal('drRegimeNote', mr.note || '');

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
  drData.marketRegime.note = getTextVal('drRegimeNote');
}

function saveDRIndicesToData() {
  // indices 字段已在 onDRIndexChange 中实时更新，无需重复保存
}

// ===== 从表单保存到 drData =====
function saveCurrentFormToData() {
  saveDRIndicesToData();
  drData.overallReason = getTextVal('drMarketOverallReason');

  saveDRMarketRegimeToData();

  drData.discipline = {
    moodScore: getDRMoodScore(),
    moodTags: getDRMoodTags(),
    executedStop: getCheckVal('drExecutedStop'),
    executedTakeProfit: getCheckVal('drExecutedTP'),
    chaseKilling: getCheckVal('drChaseKilling'),
    frequentTrading: getCheckVal('drFrequentTrading'),
    overnightFull: getCheckVal('drOvernightFull'),
    plannedPosition: getTextVal('drPlannedPos'),
    actualPosition: getTextVal('drActualPos')
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

// ===== 概览卡片 =====
function updateDRSummaryCards(dayTrades) {
  var total = dayTrades.length;
  var closed = dayTrades.filter(function(t) { return t.status !== 'open' && t.pnl !== '' && !isNaN(parseFloat(t.pnl)); });
  var wins = closed.filter(function(t) { return parseFloat(t.pnl) > 0; });
  var totalPnl = closed.reduce(function(s, t) { return s + parseFloat(t.pnl || 0); }, 0);
  var totalR = closed.reduce(function(s, t) { return s + parseFloat(t.pnlR || 0); }, 0);
  var wr = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(0) : '-';
  var followed = closed.filter(function(t) { return t.followedPlan === '是'; });
  var followRate = closed.length > 0 ? (followed.length / closed.length * 100).toFixed(0) : '-';

  setText('drCardTotal', total);
  setText('drCardPnl', CNY(totalPnl));
  setText('drCardWinRate', wr + '%');
  setText('drCardFollowRate', followRate + '%');
  setText('drCardTotalR', fmtR(totalR));

  var pnlEl = document.getElementById('drCardPnl');
  if (pnlEl) {
    pnlEl.style.color = totalPnl >= 0 ? 'var(--color-red)' : 'var(--color-green)';
  }
}

// ===== 交易复盘列表 =====
function renderDRTrades(dayTrades) {
  var container = document.getElementById('drTradesList');
  if (!container) return;

  if (dayTrades.length === 0) {
    container.innerHTML = '<div class="dr-empty-hint">当日无交易记录</div>';
    return;
  }

  var html = '';
  dayTrades.forEach(function(t) {
    var existing = (drData.tradeReviews || []).find(function(r) { return r.tradeId === t.id; });
    var pnlColor = t.pnl !== '' && !isNaN(parseFloat(t.pnl)) ? (parseFloat(t.pnl) >= 0 ? 'var(--color-red)' : 'var(--color-green)') : 'var(--text-secondary)';

    // 区分「当日开仓」与「当日出场（跨日持仓平仓）」两种来源
    var isOpenedToday = t.date === drCurrentDate;
    var isExitedToday = !isOpenedToday && t.exitDate === drCurrentDate;
    var sourceTag = isExitedToday
      ? '<span class="dr-trade-source dr-source-exit" title="此笔在 ' + esc(t.date) + ' 开仓，今日平仓">📤 当日出场 · 开仓 ' + esc(t.date) + '</span>'
      : '<span class="dr-trade-source dr-source-open" title="今日开仓">📥 当日开仓</span>';

    html += '<div class="dr-trade-card card" data-trade-id="' + esc(t.id) + '">';
    html += '<div class="dr-trade-header">';
    html += sourceTag;
    html += '<span class="dr-trade-symbol">' + esc(t.symbol || '-') + '</span>';
    html += '<span class="dr-trade-dir ' + (t.dir === '多' ? 'dir-long' : 'dir-short') + '">' + esc(t.dir || '-') + '</span>';
    html += '<span class="dr-trade-entry">入场 ' + esc(t.entry || '-') + '</span>';
    html += '<span class="dr-trade-exit">出场 ' + esc(t.exit || '-') + '</span>';
    html += '<span class="dr-trade-pnl" style="color:' + pnlColor + '">' + (t.pnl !== '' ? CNY(parseFloat(t.pnl)) : '-') + '</span>';
    html += '<span class="dr-trade-r">' + fmtR(parseFloat(t.pnlR) || 0) + '</span>';
    html += '<a href="index.html#trade-' + esc(t.id) + '" class="dr-trade-edit-link" title="跳转到交易管理页编辑此笔交易" aria-label="编辑此笔交易">✏️ 编辑</a>';
    html += '</div>';

    html += '<div class="dr-trade-fields">';
    html += '<div class="dr-field-row">';
    html += '<div class="dr-field"><label>买入逻辑</label><input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buyLogic" value="' + esc((existing && existing.buyLogic) || '') + '" placeholder="为什么买这只"></div>';
    html += '<div class="dr-field"><label>买入信号</label><input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buySignal" value="' + esc((existing && existing.buySignal) || '') + '" placeholder="具体触发信号"></div>';
    html += '<div class="dr-field"><label>买点类型</label><select class="dr-select dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buyType">';
    // 买点类型与开仓计算器同步（来自 utils.js BUY_TYPES）；优先预填 trade.buyType
    var curBuyType = (existing && existing.buyType) || t.buyType || '';
    html += '<option value=""' + (curBuyType === '' ? ' selected' : '') + '>请选择</option>';
    (window.BUY_TYPES || []).forEach(function(bt) {
      html += '<option value="' + esc(bt) + '"' + (curBuyType === bt ? ' selected' : '') + '>' + esc(bt) + '</option>';
    });
    html += '</select></div>';
    html += '<div class="dr-field"><label>符合系统</label><select class="dr-select dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="followedPlan">';
    html += '<option value="是"' + (t.followedPlan === '是' ? ' selected' : '') + '>是 ✓</option>';
    html += '<option value="否"' + (t.followedPlan !== '是' ? ' selected' : '') + '>否 ✗</option>';
    html += '</select></div>';
    html += '</div>';
    html += '<div class="dr-field-row">';
    html += '<div class="dr-field"><label>当时心态</label><input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="mood" value="' + esc((existing && existing.mood) || '') + '" placeholder="交易时的心态"></div>';
    html += '<div class="dr-field dr-field-wide"><label>教训与总结</label><textarea class="dr-textarea dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="lesson" rows="2" placeholder="本次交易的教训">' + esc((existing && existing.lesson) || '') + '</textarea></div>';
    html += '</div>';
    html += '<div class="dr-field-row"><div class="dr-field dr-field-wide"><label>改进措施</label><textarea class="dr-textarea dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="improvement" rows="2" placeholder="下次如何改进">' + esc((existing && existing.improvement) || '') + '</textarea></div></div>';
    html += '</div>';
    html += '</div>';
  });

  container.innerHTML = html;

  // 绑定事件
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

// ===== 主线板块 =====
function renderDRThemes() {
  var container = document.getElementById('drThemesList');
  if (!container) return;
  var themes = drData.themes || [{ name: '', strength: '', stage: '' }];

  var html = '';
  themes.forEach(function(t, i) {
    html += '<div class="dr-theme-row">';
    html += '<input type="text" class="dr-input dr-theme-field" data-index="' + i + '" data-field="name" value="' + esc(t.name) + '" placeholder="主线名称 (如: AI算力)">';
    html += '<select class="dr-select dr-theme-field" data-index="' + i + '" data-field="strength">';
    ['', '强', '中', '弱'].forEach(function(s) {
      html += '<option value="' + esc(s) + '"' + (t.strength === s ? ' selected' : '') + '>' + (s || '强度') + '</option>';
    });
    html += '</select>';
    html += '<select class="dr-select dr-theme-field" data-index="' + i + '" data-field="stage">';
    ['', '刚开始', '进行中', '尾声'].forEach(function(s) {
      html += '<option value="' + esc(s) + '"' + (t.stage === s ? ' selected' : '') + '>' + (s || '阶段') + '</option>';
    });
    html += '</select>';
    if (i > 0 || themes.length > 1) {
      html += '<button class="dr-btn-icon dr-btn-remove" onclick="removeDRTheme(' + i + ')" title="删除">✕</button>';
    }
    html += '</div>';
  });

  container.innerHTML = html;

  container.querySelectorAll('.dr-theme-field').forEach(function(el) {
    el.addEventListener('change', function() {
      saveDRThemesToData();
      renderDRThemes();
    });
  });

  // 把所有原生 select 升级为 custom-select（视觉与"买点类型"统一）
  if (typeof upgradeSelectToCustom === 'function') {
    container.querySelectorAll('select.dr-select').forEach(upgradeSelectToCustom);
  }
}

function saveDRThemesToData() {
  var container = document.getElementById('drThemesList');
  if (!container) return;
  var themes = [];
  container.querySelectorAll('.dr-theme-row').forEach(function(row) {
    var t = { name: '', strength: '', stage: '' };
    row.querySelectorAll('.dr-theme-field').forEach(function(el) {
      t[el.dataset.field] = el.value;
    });
    themes.push(t);
  });
  drData.themes = themes;
  // 主线板块修改后立即触发自动保存
  drDataDirty = true;
  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
    showDRAutoSaveHint();
  }, 1000);
}

function addDRTheme() {
  saveDRThemesToData();
  if (!drData.themes) drData.themes = [];
  drData.themes.push({ name: '', strength: '', stage: '' });
  renderDRThemes();
  // 新增主题行后立即保存（不依赖字段 change 事件）
  drDataDirty = true;
  saveDRData();
  drDataDirty = false;
  showDRAutoSaveHint();
}

function removeDRTheme(idx) {
  saveDRThemesToData();
  drData.themes.splice(idx, 1);
  if (drData.themes.length === 0) drData.themes.push({ name: '', strength: '', stage: '' });
  renderDRThemes();
  // 删除主题行后立即保存
  drDataDirty = true;
  saveDRData();
  drDataDirty = false;
  showDRAutoSaveHint();
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

// ===== 复盘历史列表 =====
function renderReviewHistory() {
  var container = document.getElementById('drHistoryList');
  if (!container) return;

  // 合并当前正在编辑的复盘（drData）进列表
  // 这样未保存的修改也能在历史卡片中实时看到
  // 用 JSON 深拷贝避免 drData 与历史记录共享引用
  var merged = drAllReviews.map(function(r) { return JSON.parse(JSON.stringify(r)); });
  if (drData && drData.date) {
    var drSnapshot = JSON.parse(JSON.stringify(drData));
    var idx = merged.findIndex(function(r) { return r.date === drSnapshot.date; });
    if (idx >= 0) {
      merged[idx] = drSnapshot;  // 用最新的 drData 覆盖（包含未保存修改）
    } else {
      merged.push(drSnapshot);
    }
  }

  if (merged.length === 0) {
    container.innerHTML = '<div class="dr-empty-hint">暂无历史复盘</div>';
    return;
  }

  var sorted = merged.slice().sort(function(a, b) { return b.date > a.date ? 1 : b.date < a.date ? -1 : 0; });
  var html = '';
  sorted.forEach(function(r) {
    var isActive = r.date === drCurrentDate;
    // 大盘走势：取 indices 中第一个有 trendResult 的指数结果
    var indices = Array.isArray(r.indices) ? r.indices : [];
    var trendText = '-';
    var trendCls = '';
    for (var i = 0; i < indices.length; i++) {
      if (indices[i].trendResult) {
        trendText = indices[i].trendResult;
        trendCls = DR_TREND_STYLES[indices[i].trendResult] ? DR_TREND_STYLES[indices[i].trendResult].cls : '';
        break;
      }
    }
    // 兼容旧数据：旧 r.market 结构里第一个指数的 trend
    if (trendText === '-' && Array.isArray(r.market) && r.market[0] && r.market[0].trend) {
      trendText = r.market[0].trend;
    }
    // 建议仓位：取 marketRegime.position
    var mr = r.marketRegime || {};
    var position = mr.position || '-';

    html += '<div class="dr-history-item' + (isActive ? ' active' : '') + '" onclick="jumpToReview(\'' + esc(r.date) + '\')">';
    html += '<div class="dr-history-date">' + esc(r.date) + '</div>';
    html += '<div class="dr-history-info">';
    if (trendCls) {
      html += '<span class="dr-history-trend ' + trendCls + '">' + esc(trendText) + '</span>';
    } else {
      html += '<span class="dr-history-trend">' + esc(trendText) + '</span>';
    }
    html += '<span class="dr-history-badge">' + esc(position) + '</span>';
    html += '</div>';
    html += '</div>';
  });
  container.innerHTML = html;
}

function jumpToReview(date) {
  autoSaveDR();
  drCurrentDate = date;
  document.getElementById('drDate').value = date;
  loadTradesForDate(date);
  loadReviewForDate(date);
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
    'drConfirmModal': closeDRConfirmModal
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

// 切换 K线图展开/收起
function toggleDRKline(btn) {
  var idx = parseInt(btn.dataset.index);
  var key = btn.dataset.key;
  var container = document.getElementById('drKline' + idx);
  if (!container) return;
  if (container.style.display === 'none') {
    container.style.display = 'block';
    btn.textContent = '🔼 收起';
    btn.classList.add('active');
    document.getElementById('drKlineHint' + idx).textContent = '加载中...';
    renderDRKlineChart(idx, key);
  } else {
    container.style.display = 'none';
    btn.textContent = '📊 K线';
    btn.classList.remove('active');
    document.getElementById('drKlineHint' + idx).textContent = '点击展开日K线图（120 根）';
    if (drKlineCharts[idx]) {
      if (drKlineCharts[idx]._resizeHandler) {
        window.removeEventListener('resize', drKlineCharts[idx]._resizeHandler);
      }
      drKlineCharts[idx].dispose();
      drKlineCharts[idx] = null;
    }
  }
}

// 渲染 K线图（异步：先加载 ECharts + 拉数据，再绘图）
function renderDRKlineChart(idx, key) {
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
    var hint = document.getElementById('drKlineHint' + idx);
    if (hint) hint.textContent = '❌ 加载失败: ' + e.message;
    var btn = document.querySelector('.dr-kline-toggle[data-index="' + idx + '"]');
    if (btn) { btn.textContent = '📊 重试'; btn.classList.remove('active'); }
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

  // 成功提示
  var hint = document.getElementById('drKlineHint' + idx);
  if (hint) {
    var lastDate = data.dates[data.dates.length - 1];
    hint.textContent = '✅ ' + data.name + ' · ' + data.dates.length + ' 根 · 至 ' + lastDate;
  }
}

window.addEventListener('load', function() {
  initDailyReview();
});
