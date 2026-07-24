// ===== 每日复盘模块 =====

var DR_INDICES = [
  { key: 'sh',     name: 'A股平均股价' },
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
}

// 订阅全局登录/登出事件，修复"未登录状态打开页面后登录"导致复盘不同步的 bug
function setupDRLoginEvents() {
  window.addEventListener('user-login', function() {
    console.log('[DR] 收到 user-login 事件，重新检查登录状态');
    checkDRLoginStatus();
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

// 走势手动选择选项（6 档，按强到弱），用于覆盖自动计算结果
var DR_TREND_OPTIONS = [
  { value: '强势上涨', label: '强势上涨' },
  { value: '多头趋势', label: '多头趋势' },
  { value: '反弹观察', label: '反弹观察' },
  { value: '震荡整理', label: '震荡整理' },
  { value: '趋势走弱', label: '趋势走弱' },
  { value: '弱势下跌', label: '弱势下跌' }
];

// 均线状态下拉选项（只看 5-10 两条均线）
var DR_MA_OPTIONS = [
  { value: '5-10金叉',  label: '5-10 金叉' },
  { value: '5-10死叉',  label: '5-10 死叉' },
  { value: '5-10粘合',  label: '5-10 粘合' },
  { value: '多头排列',  label: '5-10 多头排列' },
  { value: '空头排列',  label: '5-10 空头排列' }
];

// MACD 状态下拉选项（完整 10 态）
var DR_MACD_OPTIONS = [
  { value: '水上金叉',   label: 'MACD 水上金叉' },
  { value: '水上死叉',   label: 'MACD 水上死叉' },
  { value: '水上多头',   label: 'MACD 水上多头' },
  { value: '水上空头',   label: 'MACD 水上空头' },
  { value: '水上顶背离', label: 'MACD 水上顶背离' },
  { value: '水下金叉',   label: 'MACD 水下金叉' },
  { value: '水下死叉',   label: 'MACD 水下死叉' },
  { value: '水下多头',   label: 'MACD 水下多头' },
  { value: '水下空头',   label: 'MACD 水下空头' },
  { value: '水下底背离', label: 'MACD 水下底背离' }
];

// 渲染多指数卡片
function renderDRIndicesMAStatus() {
  var container = document.getElementById('drIndicesList');
  if (!container) return;

  // 补齐缺失的指数
  if (!Array.isArray(drData.indices)) {
    drData.indices = DR_INDICES.map(function(def) {
      return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '' };
    });
  } else {
    DR_INDICES.forEach(function(def) {
      var found = drData.indices.find(function(m) { return m.key === def.key; });
      if (!found) {
        drData.indices.push({ key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '' });
      }
    });
  }

  var html = '';
  drData.indices.forEach(function(idx, i) {
    html += '<div class="dr-index-card" data-index="' + i + '">';
    html += '<div class="dr-index-name">' + esc(idx.name) + '</div>';
    html += '<div class="dr-index-fields">';

    // 均线 select
    html += '<div class="dr-field"><label>均线状态</label>';
    html += '<select class="dr-select dr-index-ma" data-index="' + i + '">';
    html += '<option value="">请选择</option>';
    DR_MA_OPTIONS.forEach(function(opt) {
      html += '<option value="' + esc(opt.value) + '"' + (idx.maState === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
    });
    html += '</select></div>';

    // MACD select
    html += '<div class="dr-field"><label>MACD 状态</label>';
    html += '<select class="dr-select dr-index-macd" data-index="' + i + '">';
    html += '<option value="">请选择</option>';
    DR_MACD_OPTIONS.forEach(function(opt) {
      html += '<option value="' + esc(opt.value) + '"' + (idx.macdState === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
    });
    html += '</select></div>';

    // 5 日均线位置（在 MACD 旁边：3 选项）— 放在走势判断之前，保持 3 select 同一行
    var ma5Pos = (idx.ma5Analysis && idx.ma5Analysis.position) || '';
    html += '<div class="dr-field"><label>价格 vs 5日线</label>';
    html += '<select class="dr-select dr-index-ma5pos" data-index="' + i + '">';
    html += '<option value="">请选择</option>';
    html += '<option value="above"' + (ma5Pos === 'above' ? ' selected' : '') + '>在 5 日线上方</option>';
    html += '<option value="below"' + (ma5Pos === 'below' ? ' selected' : '') + '>在 5 日线下方</option>';
    html += '</select></div>';

    // 局部走势结果（dr-field-wide 独占一行，强制换行）— 改成手动选择下拉框
    html += '<div class="dr-field dr-field-wide dr-index-trend" data-index="' + i + '">';
    html += '<label>走势判断</label>';
    // 手动选择走势（6 档可选）；3 select 联动时会自动设置值
    var manualTrend = idx.manualTrend || '';
    html += '<div class="dr-index-trend-row">';
    html += '<select class="dr-select dr-index-manual-trend" data-index="' + i + '" title="手动选择走势">';
    DR_TREND_OPTIONS.forEach(function(opt) {
      html += '<option value="' + esc(opt.value) + '"' + (manualTrend === opt.value ? ' selected' : '') + '>' + esc(opt.label) + '</option>';
    });
    html += '</select>';
    // 高亮醒目字体显示当前走势（保留配色）
    html += '<div class="dr-index-trend-result' + (idx.trendResult && DR_TREND_STYLES[idx.trendResult] ? ' ' + DR_TREND_STYLES[idx.trendResult].cls : '') + '">' + esc(idx.trendResult || '请选择走势') + '</div>';
    html += '</div>';
    html += '</div>';

    html += '</div></div>';
  });

  container.innerHTML = html;

  // 绑定事件
  container.querySelectorAll('.dr-index-ma, .dr-index-macd, .dr-index-ma5pos').forEach(function(el) {
    el.addEventListener('change', function() {
      onDRIndexChange(parseInt(el.dataset.index));
    });
  });
  // 手动走势 select 独立绑定
  container.querySelectorAll('.dr-index-manual-trend').forEach(function(el) {
    el.addEventListener('change', function() {
      onDRManualTrendChange(parseInt(el.dataset.index));
    });
  });

  // 把所有原生 select 升级为 custom-select（视觉与"买点类型"统一）
  if (typeof upgradeSelectToCustom === 'function') {
    container.querySelectorAll('select.dr-select').forEach(upgradeSelectToCustom);
  }
}

// 单个指数 select 变化 → 重新算该指数的走势 + 整体走势 + 整体仓位
function onDRIndexChange(idx) {
  if (!Array.isArray(drData.indices) || !drData.indices[idx]) return;
  var maSelect = document.querySelector('.dr-index-ma[data-index="' + idx + '"]');
  var macdSelect = document.querySelector('.dr-index-macd[data-index="' + idx + '"]');
  var ma5Select = document.querySelector('.dr-index-ma5pos[data-index="' + idx + '"]');
  if (!maSelect || !macdSelect) return;

  drData.indices[idx].maState = maSelect.value;
  drData.indices[idx].macdState = macdSelect.value;
  var ma5Pos = ma5Select ? ma5Select.value : '';
  // 写入 ma5Analysis.position（保持现有数据结构兼容）
  if (!drData.indices[idx].ma5Analysis) drData.indices[idx].ma5Analysis = { currentPrice: null, ma5: null, position: '' };
  drData.indices[idx].ma5Analysis.position = ma5Pos;

  // 根据 3 select 重新计算走势 → 联动到手动 select（用户可再手动改）
  if (maSelect.value && macdSelect.value) {
    var r = analyzeTrend(maSelect.value, macdSelect.value, ma5Pos);
    drData.indices[idx].trendResult = r.trend;
    drData.indices[idx].trendHint = r.reason;
    drData.indices[idx].manualTrend = r.trend;  // 同步给手动 select
  } else {
    drData.indices[idx].trendResult = '';
    drData.indices[idx].trendHint = '';
    drData.indices[idx].manualTrend = '';
  }

  // 同步手动 select 的值（联动显示）；手动触发 change 让 custom-select 视觉同步
  var manualSel = document.querySelector('.dr-index-manual-trend[data-index="' + idx + '"]');
  if (manualSel) {
    manualSel.value = drData.indices[idx].manualTrend;
    manualSel.dispatchEvent(new Event('change'));
  }

  // 更新该指数的局部走势 UI（不重渲染整列，避免 select 闪烁）
  updateDRIndexTrendUI(idx);

  // 同步整体走势 + 整体仓位
  recalcDROverall();
  drDataDirty = true;

  // 延迟 1 秒自动保存（防抖：选多个指数时不会频繁保存）
  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveCurrentFormToData();
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
  }, 1000);
}

// 手动选择走势（6 档可选，3 select 联动时会自动设置值）
function onDRManualTrendChange(idx) {
  if (!Array.isArray(drData.indices) || !drData.indices[idx]) return;
  var sel = document.querySelector('.dr-index-manual-trend[data-index="' + idx + '"]');
  if (!sel) return;
  drData.indices[idx].trendResult = sel.value;
  updateDRIndexTrendUI(idx);
  recalcDROverall();
  drDataDirty = true;

  if (drAutoSaveTimer) clearTimeout(drAutoSaveTimer);
  drAutoSaveTimer = setTimeout(function() {
    saveCurrentFormToData();
    saveDRData();
    drDataDirty = false;
    drAutoSaveTimer = null;
  }, 1000);
}

// 更新单个指数的走势显示
function updateDRIndexTrendUI(idx) {
  var trendBox = document.querySelector('.dr-index-trend[data-index="' + idx + '"] .dr-index-trend-result');
  var hintBox = document.querySelector('.dr-index-trend[data-index="' + idx + '"] .dr-index-trend-hint');
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
}

// 综合走势（最保守原则：取所有指数中走势最弱的）
function recalcDROverallTrend() {
  if (!Array.isArray(drData.indices)) return { trend: '', hint: '' };
  var judged = drData.indices.filter(function(i) { return i.trendResult; });
  if (judged.length === 0) return { trend: '', hint: '请为每个指数选择「均线状态」和「MACD 状态」' };

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

  return {
    trend: weakest.trendResult,
    hint: hint
  };
}

// 整体走势 + 整体仓位 重新计算
function recalcDROverall() {
  // 1. 综合走势
  var overall = recalcDROverallTrend();
  updateDRTrendResultUI(overall.trend, overall.hint);

  // 2. 整体仓位 = 各指数命中规则中取最保守的（仓位区间最小的）
  autoCalcDRPosition();

  // 3. 同步刷新历史复盘列表（让当前编辑的复盘卡片实时反映走势+仓位变化）
  renderReviewHistory();
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

// 综合走势 UI 更新
function updateDRTrendResultUI(trend, hint) {
  var valEl = document.getElementById('drTrendResultValue');
  var hintEl = document.getElementById('drTrendResultHint');
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

  // 如果已记录命中规则 → 重新展示
  if (mr.matchedRuleId) {
    var rule = DR_POSITION_RULES.find(function(r) { return r.id === mr.matchedRuleId; });
    if (rule) {
      updateDRSuggestedPosUI(mr.position || rule.position, rule.posClass, '匹配规则：' + rule.desc);
      updateDRMatchedRuleUI(rule, '');
      highlightDRMatchedRuleRow(rule.id);
      return;
    }
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

window.addEventListener('load', function() {
  initDailyReview();
});
