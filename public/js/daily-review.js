// ===== 每日复盘模块 =====

var DR_INDICES = [
  { key: 'sh', name: '上证指数', defaultTrend: '上升趋势', defaultPosition: '中位震荡', defaultSentiment: '正常' },
  { key: 'zza500', name: '中证A500', defaultTrend: '上升趋势', defaultPosition: '中位震荡', defaultSentiment: '正常' },
  { key: 'cyb50', name: '创业板50', defaultTrend: '上升趋势', defaultPosition: '中位震荡', defaultSentiment: '正常' },
  { key: 'kc50', name: '科创50', defaultTrend: '上升趋势', defaultPosition: '中位震荡', defaultSentiment: '正常' }
];

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
            market: safeJSON(r.market_json),
            themes: safeJSON(r.themes_json),
            tradeReviews: safeJSON(r.trade_reviews_json),
            discipline: safeJSON(r.discipline_json),
            summary: summary,
            overallReason: summary.overallReason || '',
            sentimentCycle: summary.sentimentCycle || { phase: '', temperature: 50, indicators: {}, reason: '' },
            createdAt: r.created_at,
            updatedAt: r.updated_at
          };
        });
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
  var seen = {};
  var clean = [];
  drAllReviews.forEach(function(r) {
    if (!seen[r.date]) {
      seen[r.date] = true;
      clean.push(r);
    }
  });
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
    // 兼容旧格式：market 从对象迁移为数组
    if (drData.market && !Array.isArray(drData.market)) {
      drData.market = DR_INDICES.map(function(idx) {
        return { key: idx.key, name: idx.name, trend: idx.defaultTrend, position: idx.defaultPosition, sentiment: idx.defaultSentiment, reason: '' };
      });
    }
  } else {
    drData = {
      date: date,
      market: DR_INDICES.map(function(idx) {
        return { key: idx.key, name: idx.name, trend: idx.defaultTrend, position: idx.defaultPosition, sentiment: idx.defaultSentiment, reason: '' };
      }),
      overallReason: '',
      sentimentCycle: { phase: '', temperature: 50, indicators: { advanceDecline: '', limitUpDown: '', volumeChange: '', marginBalance: '', northbound: '' }, reason: '' },
      themes: [{ name: '', strength: '', stage: '' }],
      tradeReviews: [],
      discipline: { moodScore: 3, moodTags: [], executedStop: true, executedTakeProfit: false, chaseKilling: false, frequentTrading: false, overnightFull: false, plannedPosition: '', actualPosition: '' },
      summary: { goodPoints: '', badPoints: '', biggestLesson: '', tomorrowNotes: '', watchList: '' }
    };
  }
  populateFormFromData();
  renderReviewHistory();
}

// ===== 填充表单 =====
function populateFormFromData() {
  renderDRIndices();

  setTextVal('drMarketOverallReason', drData.overallReason || '');

  renderDRSentimentCycle();
  renderDRThemes();
  renderDRDisciplineRules();

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

// ===== 多指数渲染 =====
function renderDRIndices() {
  var container = document.getElementById('drIndicesList');
  if (!container) return;
  var indices = drData.market || [];
  if (!Array.isArray(indices)) indices = [];

  // 补齐缺失的指数
  DR_INDICES.forEach(function(def) {
    var found = indices.find(function(m) { return m.key === def.key; });
    if (!found) {
      indices.push({ key: def.key, name: def.name, trend: def.defaultTrend, position: def.defaultPosition, sentiment: def.defaultSentiment, reason: '' });
    }
  });
  drData.market = indices;

  var html = '';
  indices.forEach(function(m, i) {
    html += '<div class="dr-index-card">';
    html += '<div class="dr-index-name">' + esc(m.name) + '</div>';
    html += '<div class="dr-index-fields">';
    html += '<div class="dr-field"><label>趋势</label><select class="dr-select dr-index-field" data-index="' + i + '" data-field="trend">';
    ['上升趋势', '横盘震荡', '下降趋势'].forEach(function(v) {
      html += '<option value="' + esc(v) + '"' + (m.trend === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    html += '</select></div>';
    html += '<div class="dr-field"><label>位置</label><select class="dr-select dr-index-field" data-index="' + i + '" data-field="position">';
    ['高位风险区', '中位震荡区', '低位机会区'].forEach(function(v) {
      html += '<option value="' + esc(v) + '"' + (m.position === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    html += '</select></div>';
    html += '<div class="dr-field"><label>情绪</label><select class="dr-select dr-index-field" data-index="' + i + '" data-field="sentiment">';
    ['过热', '正常', '冰点'].forEach(function(v) {
      html += '<option value="' + esc(v) + '"' + (m.sentiment === v ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    html += '</select></div>';
    html += '<div class="dr-field dr-field-wide"><label>分析理由</label><textarea class="dr-textarea dr-index-field" data-index="' + i + '" data-field="reason" rows="2" placeholder="该指数的分析">' + esc(m.reason || '') + '</textarea></div>';
    html += '</div>';
    html += '</div>';
  });

  container.innerHTML = html;

  container.querySelectorAll('.dr-index-field').forEach(function(el) {
    el.addEventListener('change', function() {
      saveDRIndicesToData();
    });
    el.addEventListener('input', function() {
      saveDRIndicesToData();
    });
  });
}

function saveDRIndicesToData() {
  var container = document.getElementById('drIndicesList');
  if (!container) return;
  var indices = [];
  container.querySelectorAll('.dr-index-card').forEach(function(card, i) {
    var item = { key: (drData.market && drData.market[i]) ? drData.market[i].key : '', name: '' };
    card.querySelectorAll('.dr-index-field').forEach(function(el) {
      item[el.dataset.field] = el.value;
    });
    if (drData.market && drData.market[i]) {
      item.key = drData.market[i].key;
      item.name = drData.market[i].name;
    }
    indices.push(item);
  });
  drData.market = indices;
}

// ===== 情绪周期 =====
var SENTIMENT_WEIGHTS = {
  advanceDecline: { strong: 25, medium: 12, weak: 0 },
  limitUpDown: { strong: 20, medium: 10, weak: 0 },
  volumeChange: { up: 15, flat: 7, down: 0 },
  marginBalance: { up: 20, flat: 10, down: 0 },
  northbound: { inflow: 20, smallInflow: 15, flat: 10, smallOutflow: 5, outflow: 0 }
};

var SENTIMENT_PHASES = [
  { name: '极度悲观', min: 0, max: 20, color: 'var(--color-green)' },
  { name: '悲观', min: 21, max: 40, color: 'var(--color-orange, #f97316)' },
  { name: '中性', min: 41, max: 60, color: 'var(--color-yellow)' },
  { name: '乐观', min: 61, max: 80, color: 'var(--color-blue)' },
  { name: '极度乐观', min: 81, max: 100, color: 'var(--color-red)' }
];

function renderDRSentimentCycle() {
  var sc = drData.sentimentCycle || { phase: '', temperature: 50, indicators: {}, reason: '' };
  if (!drData.sentimentCycle) drData.sentimentCycle = sc;

  // 渲染周期阶段选中状态
  var phases = document.querySelectorAll('.dr-cycle-phase');
  phases.forEach(function(el) {
    el.classList.toggle('active', el.dataset.phase === sc.phase);
  });

  // 渲染温度计
  var temp = sc.temperature || 50;
  var slider = document.getElementById('drTemperature');
  if (slider) slider.value = temp;
  updateDRTemperatureUI(temp);

  // 渲染指标
  var indicators = sc.indicators || {};
  document.querySelectorAll('.dr-indicator-field').forEach(function(el) {
    el.value = indicators[el.dataset.indicator] || '';
    el.addEventListener('change', function() {
      saveDRSentimentToData();
      autoCalcSentimentSilent();
    });
  });

  setTextVal('drSentimentReason', sc.reason || '');
}

function setDRSentimentPhase(phase) {
  drData.sentimentCycle = drData.sentimentCycle || {};
  drData.sentimentCycle.phase = phase;
  document.querySelectorAll('.dr-cycle-phase').forEach(function(el) {
    el.classList.toggle('active', el.dataset.phase === phase);
  });
}

function onDRTemperatureChange(val) {
  updateDRTemperatureUI(parseInt(val));
  drData.sentimentCycle = drData.sentimentCycle || {};
  drData.sentimentCycle.temperature = parseInt(val);
}

function updateDRTemperatureUI(val) {
  var fill = document.getElementById('drTempFill');
  var pointer = document.getElementById('drTempPointer');
  var valueEl = document.getElementById('drTempValue');
  if (fill) fill.style.width = val + '%';
  if (pointer) pointer.style.left = val + '%';
  if (valueEl) valueEl.textContent = val;
}

function saveDRSentimentToData() {
  drData.sentimentCycle = drData.sentimentCycle || { phase: '', temperature: 50, indicators: {}, reason: '' };
  var indicators = {};
  document.querySelectorAll('.dr-indicator-field').forEach(function(el) {
    indicators[el.dataset.indicator] = el.value;
  });
  drData.sentimentCycle.indicators = indicators;
  drData.sentimentCycle.reason = getTextVal('drSentimentReason');
}

// ===== 自动计算情绪 =====
function calcSentimentScore(indicators) {
  var score = 0;
  var weights = SENTIMENT_WEIGHTS;

  // 涨跌比
  var ad = indicators.advanceDecline || '';
  if (ad === '强') score += weights.advanceDecline.strong;
  else if (ad === '中') score += weights.advanceDecline.medium;
  else if (ad === '弱') score += weights.advanceDecline.weak;

  // 涨停跌停
  var lu = indicators.limitUpDown || '';
  if (lu === '强') score += weights.limitUpDown.strong;
  else if (lu === '中') score += weights.limitUpDown.medium;
  else if (lu === '弱') score += weights.limitUpDown.weak;

  // 成交量
  var vc = indicators.volumeChange || '';
  if (vc === '放量') score += weights.volumeChange.up;
  else if (vc === '平量') score += weights.volumeChange.flat;
  else if (vc === '缩量') score += weights.volumeChange.down;

  // 融资余额
  var mb = indicators.marginBalance || '';
  if (mb === '增加') score += weights.marginBalance.up;
  else if (mb === '持平') score += weights.marginBalance.flat;
  else if (mb === '减少') score += weights.marginBalance.down;

  // 北向资金
  var nb = indicators.northbound || '';
  if (nb === '流入') score += weights.northbound.inflow;
  else if (nb === '小幅流入') score += weights.northbound.smallInflow;
  else if (nb === '持平') score += weights.northbound.flat;
  else if (nb === '小幅流出') score += weights.northbound.smallOutflow;
  else if (nb === '流出') score += weights.northbound.outflow;

  return score;
}

function getPhaseByScore(score) {
  for (var i = 0; i < SENTIMENT_PHASES.length; i++) {
    if (score >= SENTIMENT_PHASES[i].min && score <= SENTIMENT_PHASES[i].max) {
      return SENTIMENT_PHASES[i];
    }
  }
  return SENTIMENT_PHASES[2];
}

function autoCalcSentiment() {
  saveDRSentimentToData();
  var indicators = (drData.sentimentCycle && drData.sentimentCycle.indicators) || {};

  var hasAny = indicators.advanceDecline || indicators.limitUpDown || indicators.volumeChange || indicators.marginBalance || indicators.northbound;
  if (!hasAny) {
    drAlert('提示', '请至少填写一个情绪指标');
    return;
  }

  var score = calcSentimentScore(indicators);
  var phase = getPhaseByScore(score);

  drData.sentimentCycle.temperature = score;
  drData.sentimentCycle.phase = phase.name;

  // 更新UI
  var slider = document.getElementById('drTemperature');
  if (slider) slider.value = score;
  updateDRTemperatureUI(score);

  document.querySelectorAll('.dr-cycle-phase').forEach(function(el) {
    el.classList.toggle('active', el.dataset.phase === phase.name);
  });

  // 生成分析文字
  var parts = [];
  if (indicators.advanceDecline) parts.push('涨跌比' + indicators.advanceDecline);
  if (indicators.limitUpDown) parts.push('涨停跌停' + indicators.limitUpDown);
  if (indicators.volumeChange) parts.push('成交量' + indicators.volumeChange);
  if (indicators.marginBalance) parts.push('融资余额' + indicators.marginBalance);
  if (indicators.northbound) parts.push('北向资金' + indicators.northbound);
  var autoReason = '综合指标 (' + parts.join('、') + ') → 市场情绪处于【' + phase.name + '】阶段，温度 ' + score + '/100。';

  var reasonEl = document.getElementById('drSentimentReason');
  if (reasonEl && !reasonEl.value.trim()) {
    reasonEl.value = autoReason;
    drData.sentimentCycle.reason = autoReason;
  }

  // 显示计算结果提示
  showAutoCalcResult(score, phase);
}

function showAutoCalcResult(score, phase) {
  var toast = document.getElementById('drSaveToast');
  if (toast) {
    toast.textContent = '情绪温度 ' + score + '/100 → ' + phase.name;
    toast.style.display = 'flex';
    setTimeout(function() {
      toast.textContent = '✅ 复盘已保存';
    }, 3000);
  }
}

function autoCalcSentimentSilent() {
  var indicators = (drData.sentimentCycle && drData.sentimentCycle.indicators) || {};
  var hasAny = indicators.advanceDecline || indicators.limitUpDown || indicators.volumeChange || indicators.marginBalance || indicators.northbound;
  if (!hasAny) return;

  var score = calcSentimentScore(indicators);
  var phase = getPhaseByScore(score);

  drData.sentimentCycle.temperature = score;
  drData.sentimentCycle.phase = phase.name;

  var slider = document.getElementById('drTemperature');
  if (slider) slider.value = score;
  updateDRTemperatureUI(score);

  document.querySelectorAll('.dr-cycle-phase').forEach(function(el) {
    el.classList.toggle('active', el.dataset.phase === phase.name);
  });
}

// ===== 从表单保存到 drData =====
function saveCurrentFormToData() {
  saveDRIndicesToData();
  drData.overallReason = getTextVal('drMarketOverallReason');

  saveDRSentimentToData();

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
    var sc = r.sentimentCycle || {};
    html += '<div class="dr-history-item' + (isActive ? ' active' : '') + '" onclick="jumpToReview(\'' + esc(r.date) + '\')">';
    html += '<div class="dr-history-date">' + esc(r.date) + '</div>';
    html += '<div class="dr-history-info">';
    html += '<span class="dr-history-badge">' + esc(shData.position || '-') + '</span>';
    html += '<span class="dr-history-trend">' + esc(shData.trend || '-') + '</span>';
    html += '<span class="dr-history-sentiment">' + esc(shData.sentiment || '-') + '</span>';
    if (sc.phase) {
      html += '<span class="dr-history-sentiment" style="background: rgba(67,97,238,0.1); color: var(--color-blue);">' + esc(sc.phase) + '</span>';
    }
    if (sc.temperature !== undefined) {
      html += '<span class="dr-history-sentiment">' + esc(sc.temperature) + '°</span>';
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
