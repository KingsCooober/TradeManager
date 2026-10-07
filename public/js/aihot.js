(function () {
  'use strict';

  var state = {
    section: 'selected',
    window: '24h',
    items: [],
    nextCursor: '',
    hasMore: false,
    busy: false,
    lastSyncAt: 0,
    requestId: 0,
    timer: null
  };

  var SECTION_META = {
    selected: { title: '精选', subtitle: 'AIHOT 编辑精选的近期 AI 行业动态' },
    all: { title: '全部 AI 动态', subtitle: '查看 AIHOT 收录的 AI 行业资讯动态' },
    hot: { title: '热点榜', subtitle: '按多信源报道与讨论信号汇总的当前热点' },
    daily: { title: 'AI 日报', subtitle: 'AIHOT 最新一期 AI 行业日报' }
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(value) {
    if (!value) return '';
    try {
      var url = new URL(String(value), window.location.href);
      return url.protocol === 'https:' ? url.href : '';
    } catch (e) {
      return '';
    }
  }

  function linkHtml(value, label, className) {
    var url = safeUrl(value);
    if (!url) return '';
    return '<a' + (className ? ' class="' + escapeHtml(className) + '"' : '') +
      ' href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(label) + '</a>';
  }

  function getToken() {
    try { return localStorage.getItem('sync_token') || ''; } catch (e) { return ''; }
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('sync_user') || 'null'); } catch (e) { return null; }
  }

  function setUserAndToken(user, token) {
    localStorage.setItem('sync_user', JSON.stringify(user));
    localStorage.setItem('sync_token', token);
  }

  function clearUserAndToken() {
    try {
      localStorage.removeItem('sync_user');
      localStorage.removeItem('sync_token');
    } catch (e) {}
  }

  function updateHeaderAuth() {
    var user = getUser();
    var loggedIn = !!(getToken() && user);
    var signedIn = document.getElementById('headerSyncLoggedIn');
    var signedOut = document.getElementById('headerSyncLoggedOut');
    var name = document.getElementById('headerUsername');
    var indicator = document.getElementById('syncIndicator');
    if (signedIn) signedIn.style.display = loggedIn ? 'flex' : 'none';
    if (signedOut) signedOut.style.display = loggedIn ? 'none' : 'flex';
    if (name) name.textContent = loggedIn ? (user.username || '已登录') : '';
    if (indicator) indicator.style.display = 'none';
    return loggedIn;
  }

  function showLoginModal() {
    var modal = document.getElementById('ahLoginModal');
    if (modal) {
      modal.hidden = false;
      setTimeout(function () {
        var input = document.getElementById('ahUsername');
        if (input) input.focus();
      }, 20);
    }
  }
  window.openAihotLoginModal = showLoginModal;

  function closeLoginModal() {
    var modal = document.getElementById('ahLoginModal');
    if (modal) modal.hidden = true;
  }

  function handleLogout() {
    if (!window.confirm('退出 Trade Manager 登录？')) return;
    clearUserAndToken();
    state.requestId += 1;
    state.busy = false;
    clearInterval(state.timer);
    state.timer = null;
    updateHeaderAuth();
    showAuthGate();
    showLoginModal();
  }
  window.handleAihotLogout = handleLogout;

  function showAuthGate() {
    var gate = document.getElementById('ahAuthGate');
    var app = document.getElementById('ahApp');
    var footer = document.getElementById('ahFooter');
    if (gate) gate.hidden = false;
    if (app) app.hidden = true;
    if (footer) footer.hidden = true;
    var status = document.getElementById('ahSyncStatus');
    if (status) status.textContent = '';
  }

  function showAihotApp() {
    var gate = document.getElementById('ahAuthGate');
    var app = document.getElementById('ahApp');
    var footer = document.getElementById('ahFooter');
    if (gate) gate.hidden = true;
    if (app) app.hidden = false;
    if (footer) footer.hidden = false;
  }

  function setStatus(text, isError) {
    var el = document.getElementById('ahSyncStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-error', !!isError);
  }

  async function apiGet(path) {
    var token = getToken();
    if (!token) {
      updateHeaderAuth();
      showAuthGate();
      throw new Error('请先登录 Trade Manager。');
    }
    var response;
    try {
      response = await fetch(path, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error('网络暂时不可用，请检查连接后重试。');
    }
    var data = {};
    try { data = await response.json(); } catch (e) {}
    if (response.status === 401) {
      clearUserAndToken();
      updateHeaderAuth();
      showAuthGate();
      throw new Error('登录已过期，请重新登录。');
    }
    if (!response.ok) throw new Error(data.error || 'AIHOT 同步失败，请稍后重试。');
    return data;
  }

  function formatDate(value, withTime) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    var options = withTime
      ? { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Intl.DateTimeFormat('zh-CN', options).format(date);
  }

  function categoryLabel(value) {
    if (!value) return '';
    return String(value).replace(/-/g, ' ');
  }

  function renderItemCard(item) {
    var sourceName = item.source && item.source.name ? item.source.name :
      (item.attribution && item.attribution.name ? item.attribution.name : 'AIHOT');
    var original = item.links && item.links.original;
    var canonical = item.links && item.links.aihot;
    var titleUrl = safeUrl(original) || safeUrl(canonical);
    var title = escapeHtml(item.title || '未命名资讯');
    var titleMarkup = titleUrl
      ? '<a href="' + escapeHtml(titleUrl) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>'
      : title;
    var chips = '';
    if (item.category) chips += '<span class="ah-pill">' + escapeHtml(categoryLabel(item.category)) + '</span>';
    if (item.selected && state.section === 'all') chips += '<span class="ah-pill ah-pill-score">精选</span>';
    if (Number.isFinite(Number(item.score))) chips += '<span class="ah-pill ah-pill-score">AIHOT ' + escapeHtml(item.score) + '</span>';
    var originalTitle = item.originalTitle && item.originalTitle !== item.title
      ? '<details class="ah-original-title"><summary>查看原文标题</summary><p>' + escapeHtml(item.originalTitle) + '</p></details>' : '';
    var actions = '';
    if (original) actions += linkHtml(original, '阅读原文');
    if (canonical) actions += linkHtml(canonical, 'AIHOT 页面');
    var attribution = item.attribution || {};
    var attributionUrl = safeUrl(attribution.url);
    var attributionMarkup = attributionUrl
      ? '<a href="' + escapeHtml(attributionUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(attribution.name || 'AIHOT') + ' · 原文记录</a>'
      : escapeHtml(attribution.name || 'AIHOT');
    return '<article class="ah-card">' +
      '<div class="ah-card-top"><span class="ah-source">' + escapeHtml(sourceName) + '</span>' +
      (item.publishedAt ? '<span class="ah-meta">' + escapeHtml(formatDate(item.publishedAt, true)) + '</span>' : '') + chips + '</div>' +
      '<h3>' + titleMarkup + '</h3>' +
      (item.summary ? '<p class="ah-summary">' + escapeHtml(item.summary) + '</p>' : '') + originalTitle +
      (item.reason ? '<div class="ah-reason"><b>推荐理由：</b>' + escapeHtml(item.reason) + '</div>' : '') +
      (actions ? '<div class="ah-card-actions">' + actions + '</div>' : '') +
      '<div class="ah-card-foot"><span>' + attributionMarkup + '</span>' +
      (item.discoveredAt ? '<span>收录于 ' + escapeHtml(formatDate(item.discoveredAt, true)) + '</span>' : '') + '</div>' +
      '</article>';
  }

  function renderItems(append) {
    var container = document.getElementById('ahContent');
    if (!container) return;
    var html = state.items.map(renderItemCard).join('');
    if (!html) html = '<div class="ah-empty">这个时间范围内暂时没有内容。</div>';
    if (state.hasMore && state.nextCursor) {
      html += '<div class="ah-load-more"><button type="button" class="btn btn-ghost" id="ahLoadMore" ' +
        (state.busy ? 'disabled' : '') + '>加载更多</button></div>';
    }
    if (append) {
      var old = container.querySelector('.ah-load-more');
      if (old) old.remove();
      if (!state.items.length) container.innerHTML = html;
      else container.insertAdjacentHTML('beforeend', html);
    } else {
      container.innerHTML = html;
    }
    var more = document.getElementById('ahLoadMore');
    if (more) more.addEventListener('click', function () { loadItems(true, state.requestId); });
  }

  async function loadItems(append, requestId) {
    requestId = requestId == null ? state.requestId : requestId;
    if (append && state.busy) return;
    if (!append) {
      state.items = [];
      state.nextCursor = '';
      state.hasMore = false;
      document.getElementById('ahContent').innerHTML = '<div class="ah-loading">正在同步 AIHOT 内容…</div>';
    }
    state.busy = true;
    var refresh = document.getElementById('ahRefresh');
    if (refresh) refresh.disabled = true;
    var params = new URLSearchParams({
      mode: state.section === 'selected' ? 'selected' : 'all',
      window: state.window,
      limit: '20'
    });
    if (append && state.nextCursor) params.set('cursor', state.nextCursor);
    try {
      var data = await apiGet('/api/aihot/items?' + params.toString());
      if (requestId !== state.requestId) return;
      var next = data.items || [];
      state.items = append ? state.items.concat(next) : next;
      state.nextCursor = data.page && data.page.nextCursor ? data.page.nextCursor : '';
      state.hasMore = !!(data.page && data.page.hasMore);
      state.lastSyncAt = Date.now();
      renderItems(append);
      setStatus('同步于 ' + formatDate(state.lastSyncAt, true) + ' · ' + state.items.length + ' 条');
    } catch (error) {
      if (requestId === state.requestId && getToken()) {
        document.getElementById('ahContent').innerHTML = '<div class="ah-error">' + escapeHtml(error.message) + '</div>';
        setStatus('同步失败', true);
      }
    } finally {
      if (requestId === state.requestId) {
        state.busy = false;
        var more = document.getElementById('ahLoadMore');
        if (more) more.disabled = false;
        var refresh = document.getElementById('ahRefresh');
        if (refresh) refresh.disabled = false;
      }
    }
  }

  function renderHot(data) {
    var items = data.items || [];
    if (!items.length) return '<div class="ah-empty">当前暂无热点。</div>';
    return items.map(function (item, index) {
      var link = safeUrl(item.links && (item.links.story || item.links.aihot || item.links.original));
      var title = escapeHtml(item.title || '未命名热点');
      var titleHtml = link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>' : title;
      var sourceNames = (item.sourceNames || []).slice(0, 6).map(function (name) {
        return '<span class="ah-source-chip">' + escapeHtml(name) + '</span>';
      }).join('');
      var original = item.links && item.links.original;
      var canonical = item.links && item.links.aihot;
      var story = item.links && item.links.story;
      var topicLinks = '';
      if (original) topicLinks += linkHtml(original, '代表报道原文');
      if (story) topicLinks += linkHtml(story, '事件时间线');
      if (canonical) topicLinks += linkHtml(canonical, 'AIHOT 原文记录');
      return '<article class="ah-hot-card"><div class="ah-rank">' + escapeHtml(item.rank || index + 1) + '</div><div>' +
        '<h3 class="ah-hot-title">' + titleHtml + '</h3>' +
        '<div class="ah-hot-stats"><span>' + escapeHtml(item.sourceCount || 0) + ' 家信源</span><span>' + escapeHtml(item.signalCount || 0) + ' 条信号</span>' +
        (item.participantCount ? '<span>' + escapeHtml(item.participantCount) + ' 位参与者</span>' : '') +
        (item.latestAt ? '<span>更新 ' + escapeHtml(formatDate(item.latestAt, true)) + '</span>' : '') + '</div>' +
        (sourceNames ? '<div class="ah-source-chips">' + sourceNames + '</div>' : '') +
        (topicLinks ? '<div class="ah-card-actions">' + topicLinks + '</div>' : '') +
        '</div></article>';
    }).join('');
  }

  async function loadHot(requestId) {
    state.busy = true;
    var refreshButton = document.getElementById('ahRefresh');
    if (refreshButton) refreshButton.disabled = true;
    document.getElementById('ahContent').innerHTML = '<div class="ah-loading">正在同步热点榜…</div>';
    try {
      var data = await apiGet('/api/aihot/hot-topics');
      if (requestId !== state.requestId) return;
      document.getElementById('ahContent').innerHTML = renderHot(data);
      state.lastSyncAt = Date.now();
      setStatus('同步于 ' + formatDate(state.lastSyncAt, true) + ' · Top ' + (data.count || (data.items || []).length));
    } catch (error) {
      if (requestId === state.requestId && getToken()) {
        document.getElementById('ahContent').innerHTML = '<div class="ah-error">' + escapeHtml(error.message) + '</div>';
        setStatus('同步失败', true);
      }
    } finally {
      if (requestId === state.requestId) {
        state.busy = false;
        if (refreshButton) refreshButton.disabled = false;
      }
    }
  }

  function renderDaily(report) {
    if (!report) return '<div class="ah-empty">AIHOT 暂无日报。</div>';
    var lead = report.lead || {};
    var leadUrl = safeUrl(lead.links && (lead.links.aihot || lead.links.original)) || safeUrl(report.links && report.links.aihot);
    var leadTitle = escapeHtml(lead.title || 'AI 日报');
    var sections = (report.sections || []).map(function (section) {
      var entries = (section.items || []).map(function (item) {
        var itemLink = safeUrl(item.links && (item.links.original || item.links.aihot));
        var title = escapeHtml(item.title || '未命名资讯');
        var itemOriginal = item.links && item.links.original;
        var itemCanonical = item.links && item.links.aihot;
        var itemLinks = '';
        if (itemOriginal) itemLinks += linkHtml(itemOriginal, '原文');
        if (itemCanonical) itemLinks += linkHtml(itemCanonical, 'AIHOT 原文记录');
        return '<article class="ah-daily-item">' +
          (itemLink ? '<a class="ah-daily-item-title" href="' + escapeHtml(itemLink) + '" target="_blank" rel="noopener noreferrer">' + title + '</a>' : '<div class="ah-daily-item-title">' + title + '</div>') +
          (item.summary ? '<p>' + escapeHtml(item.summary) + '</p>' : '') +
          (itemLinks ? '<div class="ah-card-actions">' + itemLinks + '</div>' : '') +
          '<small>' + escapeHtml(item.source && item.source.name ? item.source.name : 'AIHOT') +
          (item.publishedAt ? ' · ' + escapeHtml(formatDate(item.publishedAt, true)) : '') + '</small></article>';
      }).join('');
      if (!entries) return '';
      return '<section class="ah-daily-section"><h3>' + escapeHtml(section.label || '本期要闻') + '</h3>' + entries + '</section>';
    }).join('');
    var dailyUrl = safeUrl(report.links && report.links.aihot);
    return '<article class="ah-daily-card">' +
      '<div class="ah-daily-date">' + escapeHtml(report.date || '') + ' · AIHOT 日报' +
      (report.generatedAt ? ' · 生成于 ' + escapeHtml(formatDate(report.generatedAt, true)) : '') + '</div>' +
      '<h2 class="ah-daily-lead">' + (leadUrl ? '<a href="' + escapeHtml(leadUrl) + '" target="_blank" rel="noopener noreferrer">' + leadTitle + '</a>' : leadTitle) + '</h2>' +
      (lead.leadParagraph ? '<div class="ah-daily-intro">' + escapeHtml(lead.leadParagraph) + '</div>' : '') +
      (dailyUrl ? '<div class="ah-card-actions">' + linkHtml(dailyUrl, '查看 AIHOT 原版日报') + '</div>' : '') +
      sections + '</article>';
  }

  async function loadDaily(requestId) {
    state.busy = true;
    var refreshButton = document.getElementById('ahRefresh');
    if (refreshButton) refreshButton.disabled = true;
    document.getElementById('ahContent').innerHTML = '<div class="ah-loading">正在同步 AI 日报…</div>';
    try {
      var data = await apiGet('/api/aihot/daily');
      if (requestId !== state.requestId) return;
      document.getElementById('ahContent').innerHTML = renderDaily(data.report);
      state.lastSyncAt = Date.now();
      setStatus('同步于 ' + formatDate(state.lastSyncAt, true));
    } catch (error) {
      if (requestId === state.requestId && getToken()) {
        document.getElementById('ahContent').innerHTML = '<div class="ah-error">' + escapeHtml(error.message) + '</div>';
        setStatus('同步失败', true);
      }
    } finally {
      if (requestId === state.requestId) {
        state.busy = false;
        if (refreshButton) refreshButton.disabled = false;
      }
    }
  }

  function updateSectionUi() {
    var meta = SECTION_META[state.section];
    document.getElementById('ahSectionTitle').textContent = meta.title;
    document.getElementById('ahSectionSub').textContent = meta.subtitle;
    var windowControl = document.getElementById('ahWindowControl');
    windowControl.hidden = state.section !== 'selected' && state.section !== 'all';
    document.querySelectorAll('[data-ah-section]').forEach(function (button) {
      var active = button.dataset.ahSection === state.section;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    var refresh = document.getElementById('ahRefresh');
    if (refresh) refresh.disabled = state.busy;
  }

  function loadSection() {
    if (!updateHeaderAuth()) {
      showAuthGate();
      return;
    }
    state.requestId += 1;
    state.busy = false;
    var requestId = state.requestId;
    showAihotApp();
    updateSectionUi();
    if (state.section === 'selected' || state.section === 'all') {
      loadItems(false, requestId);
    } else if (state.section === 'hot') {
      loadHot(requestId);
    } else {
      loadDaily(requestId);
    }
  }

  function openModalEvents() {
    var modal = document.getElementById('ahLoginModal');
    if (!modal) return;
    modal.querySelectorAll('[data-ah-close]').forEach(function (button) {
      button.addEventListener('click', closeLoginModal);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) closeLoginModal();
    });
    document.getElementById('ahLoginForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      var button = document.getElementById('ahLoginSubmit');
      var errorEl = document.getElementById('ahLoginError');
      var username = document.getElementById('ahUsername').value.trim();
      var password = document.getElementById('ahPassword').value;
      if (errorEl) errorEl.textContent = '';
      if (button) { button.disabled = true; button.textContent = '登录中…'; }
      try {
        var response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ username: username, password: password })
        });
        var result = {};
        try { result = await response.json(); } catch (e) {}
        if (!response.ok || !result.token) throw new Error(result.error || '登录失败，请重试。');
        setUserAndToken({ id: result.userId, username: result.username, role: result.role || 'user' }, result.token);
        document.getElementById('ahPassword').value = '';
        closeLoginModal();
        updateHeaderAuth();
        showAihotApp();
        loadSection(true);
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message || '登录失败，请检查连接。';
      } finally {
        if (button) { button.disabled = false; button.textContent = '登录'; }
      }
    });
  }

  function init() {
    if (typeof window.renderAppHeader === 'function') window.renderAppHeader('aihot');
    openModalEvents();
    updateHeaderAuth();

    document.querySelectorAll('[data-ah-section]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (state.section === button.dataset.ahSection) return;
        state.section = button.dataset.ahSection;
        state.items = [];
        state.nextCursor = '';
        state.hasMore = false;
        updateSectionUi();
        loadSection(true);
      });
    });
    document.getElementById('ahWindow').addEventListener('change', function (event) {
      state.window = event.target.value === '7d' ? '7d' : '24h';
      loadSection(true);
    });
    document.getElementById('ahRefresh').addEventListener('click', function () {
      loadSection(true);
    });

    if (updateHeaderAuth()) {
      showAihotApp();
      loadSection(true);
    } else {
      showAuthGate();
    }

    state.timer = setInterval(function () {
      if (!getToken() || state.section === 'daily') return;
      loadSection(true);
    }, 5 * 60 * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
