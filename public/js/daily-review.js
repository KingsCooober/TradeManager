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

function initDailyReview() {
  drCurrentDate = getToday();
  var dateInput = document.getElementById('drDate');
  if (dateInput) dateInput.value = drCurrentDate;
  loadLocalReviews();
  loadDRDisciplineRules();
  checkDRLoginStatus();
  setupDREventListeners();
  loadAllTrades();
}

function setupDREventListeners() {
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      closeDRModal();
    }
  });
  document.addEventListener('change', function(e) {
    if (e.target.closest('.dr-section-body')) {
      drDataDirty = true;
    }
  });
  document.addEventListener('input', function(e) {
    if (e.target.closest('.dr-section-body')) {
      drDataDirty = true;
    }
  });
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
    loadFromServerDR();
  } else {
    var loggedIn = document.getElementById('headerSyncLoggedIn');
    var loggedOut = document.getElementById('headerSyncLoggedOut');
    if (loggedIn) loggedIn.style.display = 'none';
    if (loggedOut) loggedOut.style.display = 'flex';
  }
}

function loadFromServerDR() {
  if (!drCurrentUserId) return;
  fetch('/api/daily-review/' + drCurrentUserId, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' }
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (data.reviews && data.reviews.length > 0) {
        drAllReviews = data.reviews.map(function(r) {
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
              return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '' };
            }),
            marketRegime: summary.marketRegime || { position: '', margin: '', matchedRuleId: '', matchedRuleDesc: '', scalingStrategy: '', note: '' },
            createdAt: r.created_at,
            updatedAt: r.updated_at
          };
        });
      dedupDRReviews();   // 服务器可能有同日期多条记录（历史 bug），去重保留最新
      saveLocalReviews();
      renderReviewHistory();
      loadReviewForDate(drCurrentDate);
    }
  })
  .catch(function(e) { console.error('从服务器加载复盘失败:', e); });
}

function syncToServerDR() {
  if (!drCurrentUserId || !drData.date) return;
  fetch('/api/daily-review/' + drCurrentUserId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ review: drData })
  })
  .then(function(r) { return r.json(); })
  .then(function() { showDRStatus('已同步到服务器', 'success'); })
  .catch(function(e) { console.error('同步失败:', e); });
}

function handleDRLogout() {
  localStorage.removeItem('currentUser');
  drCurrentUserId = null;
  drIsLoggedIn = false;
  var loggedIn = document.getElementById('headerSyncLoggedIn');
  var loggedOut = document.getElementById('headerSyncLoggedOut');
  if (loggedIn) loggedIn.style.display = 'none';
  if (loggedOut) loggedOut.style.display = 'flex';
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
  var dayTrades = drAllTrades.filter(function(t) {
    return t.date === date;
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
        margin: '',
        matchedRuleId: '',
        matchedRuleDesc: '',
        scalingStrategy: oldMr.scalingStrategy || '',
        note: oldMr.note || ''
      };
    }
    // 兼容旧 indices 结构（无 maState/macdState）
    if (Array.isArray(drData.indices)) {
      drData.indices.forEach(function(idx) {
        if (idx.maState === undefined) idx.maState = '';
        if (idx.macdState === undefined) idx.macdState = '';
        if (idx.trendResult === undefined) idx.trendResult = '';
        if (idx.trendHint === undefined) idx.trendHint = '';
      });
    }
  } else {
    drData = {
      date: date,
      overallReason: '',
      indices: DR_INDICES.map(function(def) {
        return { key: def.key, name: def.name, maState: '', macdState: '', trendResult: '', trendHint: '' };
      }),
      themes: [{ name: '', strength: '', stage: '' }],
      tradeReviews: [],
      marketRegime: { position: '', margin: '', matchedRuleId: '', matchedRuleDesc: '', scalingStrategy: '', note: '' },
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

// 均线状态下拉选项（只看 5-10 两条均线）
var DR_MA_OPTIONS = [
  { value: '5-10金叉',  label: '5-10 金叉' },
  { value: '5-10死叉',  label: '5-10 死叉' },
  { value: '多头排列',  label: '5-10 多头排列' },
  { value: '空头排列',  label: '5-10 空头排列' }
];

// MACD 状态下拉选项
var DR_MACD_OPTIONS = [
  { value: '水上',         label: 'MACD 水上' },
  { value: '水上金叉',     label: 'MACD 水上金叉' },
  { value: '水上死叉',     label: 'MACD 水上死叉' },
  { value: '水上但背离',   label: 'MACD 水上但顶背离' },
  { value: '水下',         label: 'MACD 水下' },
  { value: '水下金叉',     label: 'MACD 水下金叉' },
  { value: '水下死叉',     label: 'MACD 水下死叉' },
  { value: '顶背离后水下', label: 'MACD 顶背离后水下' }
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

    // 局部走势结果
    html += '<div class="dr-field dr-field-wide dr-index-trend" data-index="' + i + '">';
    html += '<label>走势判断</label>';
    html += '<div class="dr-index-trend-result' + (idx.trendResult && DR_TREND_STYLES[idx.trendResult] ? ' ' + DR_TREND_STYLES[idx.trendResult].cls : '') + '">' + esc(idx.trendResult || '—') + '</div>';
    if (idx.trendHint) {
      html += '<div class="dr-index-trend-hint">' + esc(idx.trendHint) + '</div>';
    }
    html += '</div>';

    html += '</div></div>';
  });

  container.innerHTML = html;

  // 绑定事件
  container.querySelectorAll('.dr-index-ma, .dr-index-macd').forEach(function(el) {
    el.addEventListener('change', function() {
      onDRIndexChange(parseInt(el.dataset.index));
    });
  });
}

// 单个指数 select 变化 → 重新算该指数的走势 + 整体走势 + 整体仓位
function onDRIndexChange(idx) {
  if (!Array.isArray(drData.indices) || !drData.indices[idx]) return;
  var maSelect = document.querySelector('.dr-index-ma[data-index="' + idx + '"]');
  var macdSelect = document.querySelector('.dr-index-macd[data-index="' + idx + '"]');
  if (!maSelect || !macdSelect) return;

  drData.indices[idx].maState = maSelect.value;
  drData.indices[idx].macdState = macdSelect.value;

  // 重新算这个指数的走势
  if (maSelect.value && macdSelect.value) {
    var r = analyzeTrend(maSelect.value, macdSelect.value);
    drData.indices[idx].trendResult = r.trend;
    drData.indices[idx].trendHint = r.reason;
  } else {
    drData.indices[idx].trendResult = '';
    drData.indices[idx].trendHint = '';
  }

  // 更新该指数的局部走势 UI（不重渲染整列，避免 select 闪烁）
  updateDRIndexTrendUI(idx);

  // 同步整体走势 + 整体仓位
  recalcDROverall();
  drDataDirty = true;
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
    trendBox.textContent = '—';
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
  return {
    trend: weakest.trendResult,
    hint: '综合 ' + judged.length + ' 个指数：' + parts.join(' / ') + ' → 取最弱：' + weakest.name
  };
}

// 整体走势 + 整体仓位 重新计算
function recalcDROverall() {
  // 1. 综合走势
  var overall = recalcDROverallTrend();
  updateDRTrendResultUI(overall.trend, overall.hint);

  // 2. 整体仓位 = 各指数命中规则中取最保守的（仓位区间最小的）
  autoCalcDRPosition();
}

// 单个指数的走势判定（5-10 均线 + MACD 组合 → 6 种走势之一）
function analyzeTrend(maState, macdState) {
  var trend = '';
  var reason = '';

  // 1. 5-10 金叉（刚发生）+ MACD 配合 → 反弹 / 趋势确立
  if (maState === '5-10金叉') {
    if (macdState === '水下金叉') {
      trend = '反弹观察';
      reason = '5-10 金叉 + MACD 水下金叉 → 反弹信号';
    } else if (macdState === '水上金叉') {
      trend = '多头趋势';
      reason = '5-10 金叉 + MACD 水上金叉 → 趋势确立';
    } else if (macdState === '水上' || macdState === '水上死叉' || macdState === '水上但背离') {
      trend = '震荡整理';
      reason = '5-10 金叉 + MACD 水上运行/死叉/背离 → 信号待确认';
    } else if (macdState === '水下' || macdState === '水下死叉' || macdState === '顶背离后水下') {
      trend = '震荡整理';
      reason = '5-10 金叉 + MACD 水下 → 反弹待确认';
    } else {
      trend = '震荡整理';
      reason = '5-10 金叉，等待 MACD 配合';
    }
  }
  // 2. 5-10 死叉 + MACD → 震荡 / 弱势
  else if (maState === '5-10死叉') {
    if (macdState === '水上' || macdState === '水上死叉' || macdState === '水上但背离') {
      trend = '震荡整理';
      reason = '5-10 死叉 + MACD 水上死叉/背离 → 短线震荡';
    } else if (macdState === '水下' || macdState === '水下死叉' || macdState === '顶背离后水下') {
      trend = '弱势下跌';
      reason = '5-10 死叉 + MACD 水下 → 趋势转弱';
    } else {
      trend = '震荡整理';
      reason = '5-10 死叉，等待 MACD 进一步信号';
    }
  }
  // 3. 多头排列（5 在 10 上方持续）+ MACD 水上 → 多头趋势
  else if (maState === '多头排列') {
    if (macdState === '水上金叉') {
      trend = '强势上涨';
      reason = '5-10 多头排列 + MACD 水上金叉 → 强势';
    } else if (macdState === '水上' || macdState === '水上死叉') {
      trend = '多头趋势';
      reason = '5-10 多头排列 + MACD 水上运行' + (macdState === '水上死叉' ? '（注意短线回调）' : '');
    } else if (macdState === '水上但背离') {
      trend = '趋势走弱';
      reason = '5-10 多头排列 + MACD 顶背离，警惕回调';
    } else if (macdState === '顶背离后水下' || macdState === '水下' || macdState === '水下死叉') {
      trend = '弱势下跌';
      reason = '5-10 多头排列但 MACD 水下 → 多头失败，转弱';
    } else {
      trend = '多头趋势';
      reason = '5-10 多头排列 + MACD 水下金叉 → 修复中';
    }
  }
  // 4. 空头排列（5 在 10 下方持续）+ MACD → 弱势
  else if (maState === '空头排列') {
    if (macdState === '顶背离后水下' || macdState === '水下' || macdState === '水下死叉') {
      trend = '弱势下跌';
      reason = '5-10 空头排列 + MACD 水下 → 持续下跌';
    } else if (macdState === '水上但背离') {
      trend = '趋势走弱';
      reason = '5-10 空头排列 + MACD 顶背离 → 加速下跌风险';
    } else if (macdState === '水下金叉') {
      trend = '反弹观察';
      reason = '5-10 空头排列 + MACD 水下金叉 → 反弹信号';
    } else if (macdState === '水上' || macdState === '水上金叉' || macdState === '水上死叉') {
      trend = '趋势走弱';
      reason = '5-10 空头排列 + MACD 水上 → 弱势修复中';
    } else {
      trend = '弱势下跌';
      reason = '5-10 空头排列，弱势格局';
    }
  }
  else {
    trend = '震荡整理';
    reason = '均线状态：' + maState + ' + MACD：' + macdState + ' → 中性观望';
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

// ===== 仓位策略规则表（5 条规则，基于 5-10 均线 + MACD） =====
var DR_POSITION_RULES = [
  { id: 'rule1', desc: '日线 5-10 多头排列 + MACD 水上',
    maStates: ['多头排列'], macdStates: ['水上', '水上金叉', '水上死叉'],
    position: '10-16 成', margin: '可满融', posClass: 'pos-max', rank: 5 },
  { id: 'rule2', desc: '日线 5-10 死叉 或 MACD 死叉',
    maStates: ['5-10死叉', '多头排列'], macdStates: ['水上但背离'],
    position: '5-8 成', margin: '不得融资', posClass: 'pos-mid', rank: 3 },
  { id: 'rule3', desc: '日线 5-10 空头排列 + MACD 顶背离',
    maStates: ['空头排列'], macdStates: ['水上但背离'],
    position: '3-5 成', margin: '不融资', posClass: 'pos-low', rank: 2 },
  { id: 'rule4', desc: '日线 5-10 空头排列 + MACD 水下',
    maStates: ['空头排列'], macdStates: ['水下', '水下死叉', '顶背离后水下'],
    position: '1-2 成', margin: '不融资', posClass: 'pos-min', rank: 1 },
  { id: 'rule5', desc: '日线 5-10 金叉 且 MACD 水下金叉后',
    maStates: ['5-10金叉'], macdStates: ['水下金叉'],
    position: '8-10 成', margin: '可融资', posClass: 'pos-mid', rank: 4 }
];

// 单指数：读取规则表 → 命中规则
function calcPositionByRules(maState, macdState) {
  if (!maState || !macdState) return null;
  for (var i = 0; i < DR_POSITION_RULES.length; i++) {
    var rule = DR_POSITION_RULES[i];
    if (rule.maStates.indexOf(maState) >= 0 && rule.macdStates.indexOf(macdState) >= 0) {
      return rule;
    }
  }
  return null;
}

// 整体仓位：取所有指数命中规则中 rank 最小（最保守）的
function autoCalcDRPosition() {
  if (!drData.marketRegime) drData.marketRegime = { position: '', margin: '', matchedRuleId: '', matchedRuleDesc: '', scalingStrategy: '', note: '' };

  // 收集每个指数命中的规则
  var matchedRules = [];
  var indices = Array.isArray(drData.indices) ? drData.indices : [];
  indices.forEach(function(idx) {
    if (idx.maState && idx.macdState) {
      var r = calcPositionByRules(idx.maState, idx.macdState);
      if (r) matchedRules.push({ rule: r, indexName: idx.name });
    }
  });

  // 清除所有规则行的高亮
  document.querySelectorAll('.dr-rules-table tbody tr').forEach(function(tr) {
    tr.classList.remove('matched');
  });

  if (matchedRules.length === 0) {
    drData.marketRegime.matchedRuleId = '';
    drData.marketRegime.matchedRuleDesc = '';
    drData.marketRegime.position = '';
    drData.marketRegime.margin = '';
    updateDRSuggestedPosUI('—', '', '请为每个指数选择「均线状态」和「MACD 状态」');
    hideDRMatchedRule();
    return;
  }

  // 取 rank 最小（最保守）的规则
  var weakest = matchedRules[0];
  matchedRules.forEach(function(m) {
    if (m.rule.rank < weakest.rule.rank) weakest = m;
  });

  drData.marketRegime.matchedRuleId = weakest.rule.id;
  drData.marketRegime.matchedRuleDesc = weakest.rule.desc + '（来自：' + weakest.indexName + '）';
  drData.marketRegime.position = weakest.rule.position;
  drData.marketRegime.margin = weakest.rule.margin;

  var hintParts = matchedRules.map(function(m) { return m.indexName + ':' + m.rule.position; });
  updateDRSuggestedPosUI(weakest.rule.position, weakest.rule.posClass,
    '各指数命中：' + hintParts.join(' / ') + ' → 取最保守：' + weakest.indexName);
  updateDRMatchedRuleUI(weakest.rule, weakest.indexName);
  highlightDRMatchedRuleRow(weakest.rule.id);
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
  var marginEl = document.getElementById('drMatchedRuleMargin');
  if (!block) return;
  block.style.display = 'flex';
  if (descEl) descEl.textContent = rule.desc + (indexName ? '（来自：' + indexName + '）' : '');
  if (posEl) {
    posEl.textContent = '仓位 ' + rule.position;
    posEl.className = 'dr-matched-rule-tag';
  }
  if (marginEl) {
    marginEl.textContent = rule.margin;
    marginEl.className = 'dr-matched-rule-tag';
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
  if (!drData.marketRegime) drData.marketRegime = { position: '', margin: '', matchedRuleId: '', matchedRuleDesc: '', scalingStrategy: '', note: '' };
  var mr = drData.marketRegime;

  setTextVal('drScalingStrategy', mr.scalingStrategy || '');
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
  if (!drData.marketRegime) drData.marketRegime = { position: '', margin: '', matchedRuleId: '', matchedRuleDesc: '', scalingStrategy: '', note: '' };
  drData.marketRegime.scalingStrategy = getTextVal('drScalingStrategy');
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

    html += '<div class="dr-trade-card card" data-trade-id="' + esc(t.id) + '">';
    html += '<div class="dr-trade-header">';
    html += '<span class="dr-trade-symbol">' + esc(t.symbol || '-') + '</span>';
    html += '<span class="dr-trade-dir ' + (t.dir === '多' ? 'dir-long' : 'dir-short') + '">' + esc(t.dir || '-') + '</span>';
    html += '<span class="dr-trade-entry">入场 ' + esc(t.entry || '-') + '</span>';
    html += '<span class="dr-trade-exit">出场 ' + esc(t.exit || '-') + '</span>';
    html += '<span class="dr-trade-pnl" style="color:' + pnlColor + '">' + (t.pnl !== '' ? CNY(parseFloat(t.pnl)) : '-') + '</span>';
    html += '<span class="dr-trade-r">' + fmtR(parseFloat(t.pnlR) || 0) + '</span>';
    html += '</div>';

    html += '<div class="dr-trade-fields">';
    html += '<div class="dr-field-row">';
    html += '<div class="dr-field"><label>买入逻辑</label><input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buyLogic" value="' + esc((existing && existing.buyLogic) || '') + '" placeholder="为什么买这只"></div>';
    html += '<div class="dr-field"><label>买入信号</label><input type="text" class="dr-input dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buySignal" value="' + esc((existing && existing.buySignal) || '') + '" placeholder="具体触发信号"></div>';
    html += '<div class="dr-field"><label>买点类型</label><select class="dr-select dr-trade-field" data-trade-id="' + esc(t.id) + '" data-field="buyType">';
    var buyTypes = ['', '突破买', '回踩买', '低吸', '打板', '半路', '其他'];
    var curBuyType = existing ? existing.buyType : '';
    buyTypes.forEach(function(bt) {
      html += '<option value="' + esc(bt) + '"' + (curBuyType === bt ? ' selected' : '') + '>' + (bt || '请选择') + '</option>';
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
}

function addDRTheme() {
  saveDRThemesToData();
  if (!drData.themes) drData.themes = [];
  drData.themes.push({ name: '', strength: '', stage: '' });
  renderDRThemes();
}

function removeDRTheme(idx) {
  saveDRThemesToData();
  drData.themes.splice(idx, 1);
  if (drData.themes.length === 0) drData.themes.push({ name: '', strength: '', stage: '' });
  renderDRThemes();
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
}

function renderDRDisciplineRules() {
  var container = document.getElementById('drDisciplineRules');
  if (!container) return;

  if (drDisciplineRules.length === 0) {
    container.innerHTML = '<div class="dr-empty-hint" style="font-size: 14px; padding: 20px;">点击下方按钮添加交易纪律</div>';
    return;
  }

  var html = '';
  drDisciplineRules.forEach(function(rule, i) {
    html += '<div class="dr-discipline-rule" data-index="' + i + '">';
    html += '<div class="dr-discipline-rule-content" onclick="editDRDisciplineRule(' + i + ')">';
    html += '<span class="dr-discipline-rule-num">' + (i + 1) + '</span>';
    html += '<span class="dr-discipline-rule-text">' + esc(rule) + '</span>';
    html += '</div>';
    html += '<button class="dr-discipline-rule-del" onclick="event.stopPropagation();removeDRDisciplineRule(' + i + ')" title="删除">✕</button>';
    html += '</div>';
  });

  container.innerHTML = html;
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

  if (drAllReviews.length === 0) {
    container.innerHTML = '<div class="dr-empty-hint">暂无历史复盘</div>';
    return;
  }

  var sorted = drAllReviews.slice().sort(function(a, b) { return b.date > a.date ? 1 : b.date < a.date ? -1 : 0; });
  var html = '';
  sorted.forEach(function(r) {
    var indices = r.market || [];
    var isActive = r.date === drCurrentDate;
    var shData = indices.find(function(m) { return m.key === 'sh'; }) || indices[0] || {};
    var mr = r.marketRegime || {};
    html += '<div class="dr-history-item' + (isActive ? ' active' : '') + '" onclick="jumpToReview(\'' + esc(r.date) + '\')">';
    html += '<div class="dr-history-date">' + esc(r.date) + '</div>';
    html += '<div class="dr-history-info">';
    html += '<span class="dr-history-badge">' + esc(shData.position || '-') + '</span>';
    html += '<span class="dr-history-trend">' + esc(shData.trend || '-') + '</span>';
    html += '<span class="dr-history-sentiment">' + esc(shData.sentiment || '-') + '</span>';
    if (mr.regime) {
      html += '<span class="dr-history-sentiment" style="background: rgba(67,97,238,0.1); color: var(--color-blue);">' + esc(mr.regime) + '</span>';
    }
    if (mr.position) {
      html += '<span class="dr-history-sentiment">' + esc(mr.position) + '</span>';
    }
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

function importDRData(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var imported = JSON.parse(e.target.result);
      if (Array.isArray(imported)) {
        imported.forEach(function(item) {
          var idx = drAllReviews.findIndex(function(r) { return r.date === item.date; });
          if (idx >= 0) drAllReviews[idx] = item;
          else drAllReviews.push(item);
        });
        saveLocalReviews();
        renderReviewHistory();
        loadReviewForDate(drCurrentDate);
        showDRStatus('导入成功', 'success');
      }
    } catch(e) {
      drAlert('导入失败', '文件格式错误');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
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

function closeDRModal() {}

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
