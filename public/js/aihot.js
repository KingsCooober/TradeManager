(function () {
  'use strict';

  var state = {
    section: 'all',
    window: '24h',
    items: [],
    nextCursor: '',
    hasMore: false,
    busy: false,
    lastSyncAt: 0,
    requestId: 0,
    timer: null
  };

  var AUTO_REFRESH_MS = 5 * 60 * 1000;

  var SECTION_META = {
    all: { title: '全部 AI 动态', subtitle: '查看 AIHOT 收录的 AI 行业资讯动态' },
    hot: { title: '热点榜', subtitle: '按多信源报道与讨论信号汇总的当前热点' }
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

  async function apiPost(path, body) {
    var token = getToken();
    if (!token) {
      updateHeaderAuth();
      showAuthGate();
      throw new Error('请先登录 Trade Manager。');
    }
    var response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
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
    if (!response.ok) throw new Error(data.error || '翻译失败，请稍后重试。');
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
    if (item.selected) chips += '<span class="ah-pill ah-pill-score">精选</span>';
    if (Number.isFinite(Number(item.score))) chips += '<span class="ah-pill ah-pill-score">AIHOT ' + escapeHtml(item.score) + '</span>';
    var originalTitle = item.originalTitle && item.originalTitle !== item.title
      ? '<details class="ah-original-title"><summary>查看原文标题</summary><p>' + escapeHtml(item.originalTitle) + '</p></details>' : '';
    var actions = '';
    if (original) actions += linkHtml(original, '阅读原文');
    if (canonical) actions += linkHtml(canonical, 'AIHOT 页面');
    if (original) actions += '<button type="button" class="ah-inline-btn" data-ah-expand="' + escapeHtml(original) + '">展开原文</button>';
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
      (original ? '<div class="ah-article" hidden></div>' : '') +
      '<div class="ah-card-foot"><span>' + attributionMarkup + '</span>' +
      (item.discoveredAt ? '<span>收录于 ' + escapeHtml(formatDate(item.discoveredAt, true)) + '</span>' : '') + '</div>' +
      '</article>';
  }

  // 正文字号：英文阅读需要比中文更大的字号，且各人偏好不同，允许调节并记住
  var READ_SIZE_MIN = 15;
  var READ_SIZE_MAX = 26;
  var READ_SIZE_DEFAULT = 18;

  function getReadSize() {
    var saved = parseInt(localStorage.getItem('ah_read_size') || '', 10);
    if (!Number.isFinite(saved)) return READ_SIZE_DEFAULT;
    return Math.min(READ_SIZE_MAX, Math.max(READ_SIZE_MIN, saved));
  }

  function applyReadSize() {
    document.documentElement.style.setProperty('--ah-read-size', getReadSize() + 'px');
  }

  function changeReadSize(delta) {
    var next = Math.min(READ_SIZE_MAX, Math.max(READ_SIZE_MIN, getReadSize() + delta));
    try { localStorage.setItem('ah_read_size', String(next)); } catch (e) {}
    applyReadSize();
  }

  function renderArticle(data, translations) {
    if (!data || !data.blocks || !data.blocks.length) {
      return '<div class="ah-article-note">未能从该页面提取到正文。</div>';
    }
    var parts = [];
    var listBuffer = [];
    function flushList() {
      if (!listBuffer.length) return;
      parts.push('<ul>' + listBuffer.map(function (text) {
        return '<li>' + escapeHtml(text) + '</li>';
      }).join('') + '</ul>');
      listBuffer = [];
    }
    function pushTrans(index) {
      var text = translations && translations[index];
      if (text) parts.push('<div class="ah-trans">' + escapeHtml(text) + '</div>');
    }
    data.blocks.forEach(function (block, index) {
      if (block.type === 'li') { listBuffer.push(block.text); return; }
      flushList();
      if (/^h[1-6]$/.test(block.type)) parts.push('<h4 class="ah-article-h">' + escapeHtml(block.text) + '</h4>');
      else if (block.type === 'quote') parts.push('<div class="ah-article-quote">' + escapeHtml(block.text) + '</div>');
      else if (block.type === 'blockquote') parts.push('<blockquote>' + escapeHtml(block.text) + '</blockquote>');
      else if (block.type === 'pre') parts.push('<pre>' + escapeHtml(block.text) + '</pre>');
      else parts.push('<p>' + escapeHtml(block.text) + '</p>');
      pushTrans(index);
    });
    flushList();
    var metaBits = [];
    if (data.siteName) metaBits.push(data.siteName);
    if (data.author) metaBits.push(data.author);
    if (data.charCount) metaBits.push(data.charCount + ' 字');
    var tools = '<div class="ah-article-tools">' +
      '<button type="button" class="ah-inline-btn" data-ah-translate>' + (translations ? '隐藏译文' : '翻译全文') + '</button>' +
      (translations ? '<span class="ah-article-engine">中文对照已显示</span>' : '<span class="ah-article-engine">可逐段显示中文对照</span>') +
      '<span class="ah-article-trans-error"></span>' +
      '<span class="ah-read-size" role="group" aria-label="正文字号">' +
        '<button type="button" data-ah-font="-1" title="缩小字号" aria-label="缩小正文字号">A−</button>' +
        '<button type="button" data-ah-font="1" title="放大字号" aria-label="放大正文字号">A+</button>' +
      '</span>' +
      '</div>';
    return '<div class="ah-article-head">' +
      (data.title ? '<div class="ah-article-title">' + escapeHtml(data.title) + '</div>' : '') +
      (metaBits.length ? '<div class="ah-article-meta">' + escapeHtml(metaBits.join(' · ')) + '</div>' : '') +
      '</div>' + tools +
      '<div class="ah-article-body">' + parts.join('') + '</div>';
  }

  // 逐段翻译：分批请求，避免单次体积过大或超时
  async function translateBlocks(blocks) {
    var texts = blocks.map(function (block) { return block.text; });
    var translations = new Array(texts.length).fill('');
    var failed = 0;
    var lastError = '';
    var anySuccess = false;
    var BATCH = 12;
    for (var i = 0; i < texts.length; i += BATCH) {
      var slice = texts.slice(i, i + BATCH);
      try {
        var data = await apiPost('/api/aihot/translate', { texts: slice });
        var list = data.translations || [];
        for (var j = 0; j < slice.length; j++) translations[i + j] = list[j] || '';
        failed += Number(data.failed) || 0;
        anySuccess = true;
      } catch (error) {
        // 单批失败不再中断整篇：记下来，继续翻后面的段落
        failed += slice.length;
        lastError = error.message || '';
      }
    }
    // 一段都没翻出来，说明是真的失败了（多半是配置问题），把原因抛给用户
    if (texts.length && !anySuccess) throw new Error(lastError || '翻译失败，请稍后重试。');
    return { translations: translations, failed: failed, lastError: lastError };
  }

  // 展开/收起中文对照；首次点击才真正发起翻译
  async function toggleTranslate(button) {
    var card = button.closest('.ah-card');
    var panel = card ? card.querySelector('.ah-article') : null;
    if (!panel || !panel._articleData) return;
    var data = panel._articleData;

    if (panel._translations) {
      panel._showTrans = !panel._showTrans;
      panel.innerHTML = renderArticle(data, panel._showTrans ? panel._translations : null);
      return;
    }

    button.disabled = true;
    button.textContent = '翻译中…';
    try {
      var result = await translateBlocks(data.blocks);
      panel._translations = result.translations;
      panel._showTrans = true;
      panel.innerHTML = renderArticle(data, result.translations);
      if (result.failed) {
        var tip = panel.querySelector('.ah-article-trans-error');
        if (tip) tip.textContent = result.failed + ' 段未能翻译，可点「翻译全文」重试。';
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = '翻译全文';
      var note = panel.querySelector('.ah-article-trans-error');
      if (note) note.textContent = error.message;
    }
  }

  // 就地展开原文正文；失败时降级提示，不影响卡片本身
  async function toggleArticle(button) {
    var card = button.closest('article');
    var panel = card ? card.querySelector('.ah-article') : null;
    if (!panel) return;
    if (!panel.hidden) {
      panel.hidden = true;
      button.textContent = '展开原文';
      return;
    }
    if (panel.dataset.loaded === '1') {
      panel.hidden = false;
      button.textContent = '收起原文';
      return;
    }
    var url = button.getAttribute('data-ah-expand') || '';
    if (!url) return;
    panel.hidden = false;
    button.disabled = true;
    button.textContent = '抓取中…';
    panel.innerHTML = '<div class="ah-article-note">正在抓取原文正文…</div>';
    try {
      var data = await apiGet('/api/aihot/article?url=' + encodeURIComponent(url));
      panel._articleData = data;
      panel.innerHTML = renderArticle(data);
      panel.dataset.loaded = '1';
      button.textContent = '收起原文';
    } catch (error) {
      panel.innerHTML = '<div class="ah-article-note is-error">' + escapeHtml(error.message) + '</div>' +
        '<div class="ah-article-note">可点击上方「阅读原文」在新窗口打开该来源。</div>';
      button.textContent = '重试';
    } finally {
      button.disabled = false;
    }
  }

  // 卡片是动态重建的，因此用事件委托绑定一次即可
  function bindArticleEvents() {
    var container = document.getElementById('ahContent');
    if (!container || container.dataset.ahArticleBound === '1') return;
    container.dataset.ahArticleBound = '1';
    container.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var fontBtn = target.closest('[data-ah-font]');
      if (fontBtn) {
        event.preventDefault();
        changeReadSize(Number(fontBtn.getAttribute('data-ah-font')) || 0);
        return;
      }
      var translateBtn = target.closest('[data-ah-translate]');
      if (translateBtn) {
        event.preventDefault();
        toggleTranslate(translateBtn);
        return;
      }
      var button = target.closest('[data-ah-expand]');
      if (!button) return;
      event.preventDefault();
      toggleArticle(button);
    });
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
    var container = document.getElementById('ahContent');
    if (!append) {
      state.items = [];
      state.nextCursor = '';
      state.hasMore = false;
      if (container) container.innerHTML = '<div class="ah-loading">正在同步 AIHOT 内容…</div>';
    }
    state.busy = true;
    var refresh = document.getElementById('ahRefresh');
    if (refresh) refresh.disabled = true;
    var params = new URLSearchParams({
      mode: 'all',
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
        if (container) container.innerHTML = '<div class="ah-error">' + escapeHtml(error.message) + '</div>';
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
      if (original) topicLinks += '<button type="button" class="ah-inline-btn" data-ah-expand="' + escapeHtml(original) + '">展开原文</button>';
      return '<article class="ah-hot-card"><div class="ah-rank">' + escapeHtml(item.rank || index + 1) + '</div><div>' +
        '<h3 class="ah-hot-title">' + titleHtml + '</h3>' +
        '<div class="ah-hot-stats"><span>' + escapeHtml(item.sourceCount || 0) + ' 家信源</span><span>' + escapeHtml(item.signalCount || 0) + ' 条信号</span>' +
        (item.participantCount ? '<span>' + escapeHtml(item.participantCount) + ' 位参与者</span>' : '') +
        (item.latestAt ? '<span>更新 ' + escapeHtml(formatDate(item.latestAt, true)) + '</span>' : '') + '</div>' +
        (sourceNames ? '<div class="ah-source-chips">' + sourceNames + '</div>' : '') +
        (topicLinks ? '<div class="ah-card-actions">' + topicLinks + '</div>' : '') +
        (original ? '<div class="ah-article" hidden></div>' : '') +
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

  function updateSectionUi() {
    var meta = SECTION_META[state.section];
    document.getElementById('ahSectionTitle').textContent = meta.title;
    document.getElementById('ahSectionSub').textContent = meta.subtitle;
    var windowControl = document.getElementById('ahWindowControl');
    windowControl.hidden = state.section !== 'all';
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
    if (state.section === 'hot') {
      loadHot(requestId);
    } else {
      loadItems(false, requestId);
    }
  }

  // 自动刷新只在“用户没有正在阅读”时进行：
  // 已滚动、已加载分页、页面在后台、或正在请求时都跳过，避免打断阅读或丢弃已翻的页
  function autoRefreshAllowed() {
    if (!getToken() || state.busy) return false;
    if (document.hidden) return false;
    if (window.scrollY > 120) return false;
    if (state.items.length > 20) return false;
    return true;
  }

  function autoRefresh() {
    if (!autoRefreshAllowed()) return;
    loadSection(true);
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
    applyReadSize();
    if (typeof window.renderAppHeader === 'function') window.renderAppHeader('aihot');
    openModalEvents();
    bindArticleEvents();
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

    state.timer = setInterval(autoRefresh, AUTO_REFRESH_MS);
    // 页面重新可见时，若数据已过期再刷新；后台标签页不做无谓请求
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && Date.now() - state.lastSyncAt > AUTO_REFRESH_MS) autoRefresh();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
