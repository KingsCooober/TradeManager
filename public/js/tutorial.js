/**
 * 量化教程 3.0 阅读页
 *
 * 进度存 DataStore('tutorial_progress')：
 *   本地 IndexedDB → 登录后防抖同步到 /api/data/tutorial_progress（user_data 表）
 *   换电脑登录打开本页，onLogin 会从服务器拉取，自动回到上次位置。
 *
 * 位置用「章节 id + 章内比例」记录，而不是绝对 scrollY：
 * 图片是懒加载的，文档高度会变，按比例恢复更稳。
 */
(function () {
  'use strict';

  var COLLECTION = 'tutorial_progress';
  var DOC_ID = 'quant-3.0';
  var SAVE_DELAY = 1200;
  var CONTENT_URL = 'tutorial/content.html';
  var TOC_URL = 'tutorial/toc.json';

  var col = null;
  var toc = [];
  var chapterMeta = [];      // 章级：{ id, title, el }
  var tocTargets = [];       // 所有目录项：{ id, el, title }
  var readSet = {};
  var maxRatio = 0;
  var lastPos = { ratio: 0, chapterId: '', chapterTitle: '', intra: 0, y: 0 };
  var saveTimer = null;
  var ticking = false;
  var loggedIn = false;
  var resumeHiddenAt = 0;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function maxScroll() {
    return Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  }

  // ── 鉴权：本页不加载 sync.js，用本地 token 给 fetch 补 Authorization ──
  function readToken() {
    try { return localStorage.getItem('sync_token') || ''; } catch (e) { return ''; }
  }

  // 本页没有 syncModule，直接解 JWT payload 拿用户名/角色并判断过期。
  // 其他页面都是 sync.js 的 syncModule 驱动 header 右侧，这里补一份等价的最小实现。
  function readTokenUser() {
    var token = readToken();
    if (!token) return null;
    try {
      var part = token.split('.')[1] || '';
      part = part.replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      var binary = atob(part);
      var bytes = [];
      for (var i = 0; i < binary.length; i++) {
        bytes.push('%' + ('0' + binary.charCodeAt(i).toString(16)).slice(-2));
      }
      var payload = JSON.parse(decodeURIComponent(bytes.join('')));
      if (payload.exp && payload.exp * 1000 <= Date.now()) {
        // 过期 token 留着只会让 API 一直 401，清掉并回到「登录同步」
        try { localStorage.removeItem('sync_token'); } catch (e) {}
        return null;
      }
      return payload;
    } catch (e) {
      return null;
    }
  }

  function renderAuthState() {
    var user = readTokenUser();
    var signedInEl = $('headerSyncLoggedIn');
    var signedOutEl = $('headerSyncLoggedOut');
    var adminMenu = $('adminMenu');
    var nameEl = $('headerUsername');
    if (!signedInEl || !signedOutEl) return;
    if (user) {
      if (nameEl) nameEl.textContent = user.username || '已登录';
      var isAdmin = user.role === 'admin';
      signedInEl.style.display = isAdmin ? 'none' : 'flex';
      signedOutEl.style.display = 'none';
      if (adminMenu) adminMenu.style.display = isAdmin ? 'flex' : 'none';
    } else {
      signedInEl.style.display = 'none';
      signedOutEl.style.display = 'flex';
      if (adminMenu) adminMenu.style.display = 'none';
    }
  }

  function installAuthFetch() {
    var token = readToken();
    if (!window.authFetch) {
      window.authFetch = function (url, options) {
        options = options || {};
        if (token) {
          options.headers = Object.assign({}, options.headers || {}, { Authorization: 'Bearer ' + token });
        }
        return fetch(url, options);
      };
    }
    return token;
  }

  // ── header 里的按钮：本页没有主站的同步 UI，给最小实现，避免 ReferenceError ──
  function installHeaderHooks() {
    window.handleLogout = function () {
      if (!window.confirm('退出登录？退出后进度仍保存在本机，重新登录会自动同步。')) return;
      try { localStorage.removeItem('sync_token'); } catch (e) {}
      if (typeof DataStore !== 'undefined') DataStore.onLogout();
      location.reload();
    };
    window.openLoginModal = function () {
      location.href = 'index.html';
    };
    window.handleFullSync = function () {
      if (typeof DataStore === 'undefined') return;
      DataStore.syncAll().then(function () {
        alert('教程进度已与服务器同步');
      }).catch(function () {
        alert('同步失败，请检查登录状态');
      });
    };
    window.handleToggleAutoSync = function () {
      alert('本页进度会自动保存，无需手动开关自动同步');
    };
    window.openAppSettings = function () {
      location.href = 'index.html';
    };
  }

  // ── 数据层 ──
  async function loadStore() {
    var token = installAuthFetch();
    loggedIn = !!token;
    if (typeof DataStore === 'undefined') return;
    await DataStore.init();
    col = DataStore.collection(COLLECTION);
    if (!token) return;
    // 登录态：先记下本地较新的副本，pull 之后再按 updatedAt 取较新者，
    // 避免离线阅读的进度被云端旧数据覆盖。
    var local = null;
    try { local = await col.get(DOC_ID); } catch (e) {}
    try { await DataStore.onLogin(); } catch (e) { console.warn('[教程] 进度同步失败', e); }
    if (local) {
      var remote = null;
      try { remote = await col.get(DOC_ID); } catch (e) {}
      var localAt = Date.parse((local && local.updatedAt) || 0) || 0;
      var remoteAt = Date.parse((remote && remote.updatedAt) || 0) || 0;
      if (localAt > remoteAt) {
        try { await col.save(local); } catch (e) {}
      }
    }
  }

  // ── 渲染 ──
  function renderToc() {
    var nav = $('tutToc');
    var html = '';
    toc.forEach(function (item) {
      html += '<a href="#' + item.id + '" data-target="' + item.id + '" class="'
        + (item.chapter ? 'is-chapter' : 'is-sub') + '">'
        + '<span class="dot"></span><span>' + escapeHtml(item.text) + '</span></a>';
    });
    nav.innerHTML = html;
    nav.addEventListener('click', function (event) {
      var link = event.target.closest('a[data-target]');
      if (!link) return;
      event.preventDefault();
      scrollToAnchor(link.getAttribute('data-target'));
      closeSidebar();
    });
  }

  function syncReadMarks() {
    var nav = $('tutToc');
    Array.prototype.forEach.call(nav.querySelectorAll('a[data-target]'), function (link) {
      link.classList.toggle('done', !!readSet[link.getAttribute('data-target')]);
    });
  }

  function decorateContent(root) {
    // 代码块右上角「复制」
    Array.prototype.forEach.call(root.querySelectorAll('pre'), function (pre) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tut-copy';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        var code = pre.querySelector('code') || pre;
        var text = code.innerText || '';
        var done = function () {
          btn.textContent = '已复制';
          setTimeout(function () { btn.textContent = '复制'; }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () { btn.textContent = '复制失败'; });
        } else {
          var ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = '复制失败'; }
          ta.remove();
        }
      });
      pre.appendChild(btn);
    });

    // 图片：缺失占位 + 点击放大
    Array.prototype.forEach.call(root.querySelectorAll('img'), function (img) {
      img.addEventListener('error', function () {
        if (img.dataset.failed) return;
        img.dataset.failed = '1';
        var ph = document.createElement('span');
        ph.className = 'tut-img-missing';
        ph.textContent = '（该插图未随文档导出）';
        if (img.parentNode) img.parentNode.replaceChild(ph, img);
      });
      img.addEventListener('click', function () { openLightbox(img.currentSrc || img.src); });
    });
  }

  function buildAnchors() {
    tocTargets = [];
    chapterMeta = [];
    toc.forEach(function (item) {
      var el = document.getElementById(item.id);
      if (!el) return;
      tocTargets.push({ id: item.id, el: el, title: item.text });
      if (item.chapter) chapterMeta.push({ id: item.id, title: item.text, el: el });
    });
  }

  // ── 位置计算 ──
  function absoluteTop(el) {
    return el.getBoundingClientRect().top + (window.scrollY || document.documentElement.scrollTop || 0);
  }

  function currentAnchor(y) {
    var found = null;
    for (var i = 0; i < tocTargets.length; i++) {
      var item = tocTargets[i];
      var top = absoluteTop(item.el);
      if (top <= y + 130) found = { id: item.id, title: item.title, top: top, el: item.el };
      else break;
    }
    return found;
  }

  function markRead(y) {
    for (var i = 0; i < chapterMeta.length; i++) {
      var chapter = chapterMeta[i];
      var next = chapterMeta[i + 1];
      var boundary = next ? absoluteTop(next.el) : Infinity;
      if (y + window.innerHeight * 0.6 >= boundary) readSet[chapter.id] = true;
    }
  }

  function renderProgress(pos) {
    var pct = Math.round(maxRatio * 100);
    $('tutPercent').textContent = pct + '%';
    $('tutReadFill').style.width = pct + '%';
    $('tutProgressFill').style.width = pct + '%';

    var readCount = Object.keys(readSet).length;
    var hint = readCount ? ('已读 ' + readCount + '/' + chapterMeta.length + ' 章') : '尚未开始阅读';
    if (!loggedIn) hint += ' · 未登录仅存本机';
    $('tutProgressHint').textContent = hint;

    $('tutNowReading').textContent = pos && pos.title ? ('正在阅读：' + pos.title) : '量化教程 3.0';

    var activeId = pos ? pos.id : '';
    Array.prototype.forEach.call($('tutToc').querySelectorAll('a[data-target]'), function (link) {
      link.classList.toggle('active', link.getAttribute('data-target') === activeId);
    });
  }

  // ── 保存 ──
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, SAVE_DELAY);
  }

  async function saveProgress() {
    if (!col) return;
    var payload = {
      id: DOC_ID,
      title: '量化教程3.0',
      ratio: Number(lastPos.ratio.toFixed(4)),
      maxRatio: Number(maxRatio.toFixed(4)),
      chapterId: lastPos.chapterId || '',
      chapterTitle: lastPos.chapterTitle || '',
      intra: Number((lastPos.intra || 0).toFixed(4)),
      scrollY: Math.round(lastPos.y || 0),
      readChapters: Object.keys(readSet),
      updatedAt: new Date().toISOString()
    };
    try { await col.save(payload); } catch (e) { console.warn('[教程] 保存进度失败', e); }
  }

  function handleScroll() {
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    var max = maxScroll();
    var ratio = max > 0 ? clamp(y / max, 0, 1) : 0;
    var pos = currentAnchor(y);
    var intra = 0;
    if (pos && pos.el && pos.el.offsetHeight > 0) {
      intra = clamp((y - (pos.top - 110)) / pos.el.offsetHeight, 0, 1);
    }
    maxRatio = Math.max(maxRatio, ratio);
    markRead(y);
    lastPos = { ratio: ratio, chapterId: pos ? pos.id : '', chapterTitle: pos ? pos.title : '', intra: intra, y: y };
    renderProgress(pos);
    syncReadMarks();
    scheduleSave();
    // 用户主动滚动后不再自动校正恢复位置
    resumeHiddenAt = Date.now();
  }

  // ── 恢复 / 重置 ──
  function scrollToAnchor(id) {
    var el = document.getElementById(id);
    if (!el) return;
    window.scrollTo({ top: Math.max(0, absoluteTop(el) - 110), behavior: 'smooth' });
  }

  function showResume(data) {
    var pct = Math.round((Number(data.maxRatio) || Number(data.ratio) || 0) * 100);
    $('tutResumeText').textContent = '已回到上次阅读位置：' + (data.chapterTitle || '教程开头') + ' · ' + pct + '%';
    $('tutResume').hidden = false;
    window.clearTimeout(showResume._timer);
    showResume._timer = window.setTimeout(hideResume, 9000);
  }

  function hideResume() {
    $('tutResume').hidden = true;
  }

  async function restore(saved) {
    if (!saved) return;
    readSet = {};
    (saved.readChapters || []).forEach(function (id) { readSet[id] = true; });
    maxRatio = Number(saved.maxRatio) || Number(saved.ratio) || 0;

    var ratio = Number(saved.ratio) || 0;
    if (ratio <= 0.004 || ratio >= 0.995) return;

    var target = saved.chapterId ? document.getElementById(saved.chapterId) : null;
    if (target) {
      var intra = clamp(Number(saved.intra) || 0, 0, 1);
      window.scrollTo(0, Math.max(0, absoluteTop(target) + intra * target.offsetHeight - 110));
    } else {
      window.scrollTo(0, ratio * maxScroll());
    }
    showResume(saved);
  }

  async function restart() {
    if (!window.confirm('从头开始阅读？当前进度会清零。')) return;
    readSet = {};
    maxRatio = 0;
    lastPos = { ratio: 0, chapterId: '', chapterTitle: '', intra: 0, y: 0 };
    window.scrollTo(0, 0);
    hideResume();
    renderProgress(null);
    syncReadMarks();
    if (col) {
      try {
        await col.save({
          id: DOC_ID,
          title: '量化教程3.0',
          ratio: 0,
          maxRatio: 0,
          chapterId: '',
          chapterTitle: '',
          intra: 0,
          scrollY: 0,
          readChapters: [],
          updatedAt: new Date().toISOString()
        });
      } catch (e) {}
    }
  }

  // ── 图片放大 ──
  function openLightbox(src) {
    var box = $('tutLightbox');
    box.querySelector('img').src = src;
    box.hidden = false;
  }
  function closeLightbox() {
    var box = $('tutLightbox');
    box.hidden = true;
    box.querySelector('img').removeAttribute('src');
  }

  // ── 侧栏（移动端） ──
  function openSidebar() { $('tutSidebar').classList.add('open'); }
  function closeSidebar() { $('tutSidebar').classList.remove('open'); }

  // ── 启动 ──
  async function boot() {
    installHeaderHooks();
    renderAppHeader('tutorial');
    renderAuthState();

    $('tutTocToggle').addEventListener('click', openSidebar);
    $('tutTocClose').addEventListener('click', closeSidebar);
    $('tutTopBtn').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('tutRestart').addEventListener('click', restart);
    $('tutResumeTop').addEventListener('click', restart);
    $('tutResumeClose').addEventListener('click', hideResume);
    $('tutLightbox').addEventListener('click', closeLightbox);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeLightbox();
        closeSidebar();
      }
    });

    var contentBox = $('tutContent');
    try {
      var responses = await Promise.all([
        fetch(TOC_URL, { cache: 'no-cache' }),
        fetch(CONTENT_URL, { cache: 'no-cache' })
      ]);
      if (!responses[0].ok || !responses[1].ok) throw new Error('HTTP ' + responses[0].status + '/' + responses[1].status);
      toc = await responses[0].json();
      var html = await responses[1].text();
      contentBox.innerHTML = html;
      contentBox.hidden = false;
      var loading = $('tutLoading');
      if (loading) loading.remove();
    } catch (error) {
      $('tutLoading').innerHTML = '<span style="color:#b42318">教程正文加载失败：' + escapeHtml(error && error.message ? error.message : '未知错误') + '，请刷新重试。</span>';
      console.error('[教程] 正文加载失败', error);
      return;
    }

    renderToc();
    decorateContent(contentBox);
    buildAnchors();

    await loadStore();

    var saved = null;
    if (col) {
      try { saved = await col.get(DOC_ID); } catch (e) {}
    }
    if (saved) await restore(saved);

    renderProgress(currentAnchor(window.scrollY || 0));
    syncReadMarks();

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        ticking = false;
        handleScroll();
      });
    }, { passive: true });

    // 页面隐藏/关闭前尽量落一次盘（IndexedDB 写入很快；服务器同步由 DataStore 防抖处理）
    window.addEventListener('pagehide', function () { void saveProgress(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') void saveProgress();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
