/**
 * 量化策略卡片页
 * 数据来自 quant-strategies-data.js（QS_FAMILIES / QS_STRATEGIES，生成自《量化教程3.0》）。
 * 卡片网格 + 族筛选 + 搜索 + 排序；点击卡片弹出详情（原理/规则/回测/风险/插图/完整聚宽代码）。
 */
(function () {
  'use strict';

  var FAMS = QS_FAMILIES;
  var STRATS = QS_STRATEGIES;

  // ── header 钩子：本页不加载 sync.js（同 tutorial 页处理）──
  function readToken() {
    try { return localStorage.getItem('sync_token') || ''; } catch (e) { return ''; }
  }
  window.handleLogout = function () {
    if (!window.confirm('退出登录？')) return;
    try { localStorage.removeItem('sync_token'); } catch (e) {}
    location.href = 'index.html';
  };
  window.openLoginModal = function () { location.href = 'index.html'; };
  window.openAppSettings = function () { location.href = 'index.html'; };

  (function renderAuth() {
    var user = null;
    var token = readToken();
    if (token) {
      try {
        var part = token.split('.')[1] || '';
        part = part.replace(/-/g, '+').replace(/_/g, '/');
        while (part.length % 4) part += '=';
        user = JSON.parse(decodeURIComponent(atob(part).split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join('')));
        if (user.exp && user.exp * 1000 <= Date.now()) user = null;
      } catch (e) { user = null; }
    }
    var inEl = document.getElementById('headerSyncLoggedIn');
    var outEl = document.getElementById('headerSyncLoggedOut');
    var adminEl = document.getElementById('adminMenu');
    var nameEl = document.getElementById('headerUsername');
    if (!inEl || !outEl) return;
    if (user) {
      if (nameEl) nameEl.textContent = user.username || '已登录';
      var isAdmin = user.role === 'admin';
      inEl.style.display = isAdmin ? 'none' : 'flex';
      outEl.style.display = 'none';
      if (adminEl) adminEl.style.display = isAdmin ? 'flex' : 'none';
    } else {
      inEl.style.display = 'none';
      outEl.style.display = 'flex';
      if (adminEl) adminEl.style.display = 'none';
    }
  })();

  // ── 工具 ──
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 从回测文本里抽展示用的数字（粗提取，仅用于卡片角标）
  var CAGR_CACHE = {};
  function cagrOf(s) {
    if (CAGR_CACHE[s.idx] !== undefined) return CAGR_CACHE[s.idx];
    var m = String(s.bt || '').match(/年化[≈约]?\s*(\d+(?:\.\d+)?)\s*%/);
    var v = m ? parseFloat(m[1]) : null;
    CAGR_CACHE[s.idx] = v;
    return v;
  }
  function drawdownOf(s) {
    var txt = String(s.bt || '') + ' ' + String(s.risk || '');
    var m = txt.match(/回撤[≈]?\s*-?(\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  }

  // ── 状态 ──
  var state = { fam: 'ALL', q: '', sort: 'order' };

  // ── 顶部统计 ──
  function renderHero() {
    var counts = {};
    STRATS.forEach(function (s) { counts[s.fam] = (counts[s.fam] || 0) + 1; });
    var withCagr = STRATS.filter(function (s) { return cagrOf(s) !== null; }).length;
    document.getElementById('qsHeroStats').innerHTML =
      statHtml(STRATS.length, '个策略') +
      Object.keys(FAMS).map(function (k) {
        return '<div class="qs-stat" style="--fam-color:' + FAMS[k].color + '"><b style="color:' + FAMS[k].color + '">' + counts[k] + '</b><span>' + esc(FAMS[k].name) + '</span></div>';
      }).join('') +
      statHtml(withCagr, '有年化数字');
    function statHtml(v, label) {
      return '<div class="qs-stat"><b>' + v + '</b><span>' + label + '</span></div>';
    }
  }

  // ── 族筛选 chips ──
  function renderChips() {
    var counts = {};
    STRATS.forEach(function (s) { counts[s.fam] = (counts[s.fam] || 0) + 1; });
    var html = chip('ALL', '全部', STRATS.length, '#5b8def');
    Object.keys(FAMS).forEach(function (k) {
      html += chip(k, FAMS[k].name, counts[k], FAMS[k].color);
    });
    function chip(fam, name, n, color) {
      var active = state.fam === fam;
      return '<button type="button" class="qs-chip' + (active ? ' active' : '') +
        '" data-fam="' + fam + '" style="' + (active ? 'background:' + color : '') + '">' +
        esc(name) + '<small>' + n + '</small></button>';
    }
    document.getElementById('qsFamChips').innerHTML = html;
  }

  // ── 卡片网格 ──
  function visibleStrategies() {
    var list = STRATS.slice();
    if (state.fam !== 'ALL') list = list.filter(function (s) { return s.fam === state.fam; });
    if (state.q) {
      var q = state.q.toLowerCase();
      list = list.filter(function (s) {
        return (s.title + ' ' + s.principle + ' ' + s.rules + ' ' + s.type + ' ' + s.bt).toLowerCase().indexOf(q) >= 0;
      });
    }
    if (state.sort === 'cagr') {
      list.sort(function (a, b) { return (cagrOf(b) || -1) - (cagrOf(a) || -1); });
    } else if (state.sort === 'dd') {
      list.sort(function (a, b) { return (drawdownOf(a) || 999) - (drawdownOf(b) || 999); });
    }
    return list;
  }

  function renderGrid() {
    var list = visibleStrategies();
    var grid = document.getElementById('qsGrid');
    var empty = document.getElementById('qsEmpty');
    if (!list.length) { grid.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    grid.innerHTML = list.map(cardHtml).join('');
  }

  function cardHtml(s) {
    var fam = FAMS[s.fam] || {};
    var cagr = cagrOf(s);
    var btShort = String(s.bt || '');
    if (btShort.length > 110) btShort = btShort.slice(0, 110) + '…';
    return '<article class="qs-card" data-idx="' + s.idx + '" style="--fam-color:' + fam.color + '" tabindex="0" role="button" aria-label="查看 ' + esc(s.title) + ' 详情">' +
      '<div class="qs-card-top"><span class="qs-card-no">#' + s.no + '</span><span class="qs-card-title">' + esc(s.title) + '</span></div>' +
      '<div class="qs-card-tags">' +
        '<span class="qs-tag">' + esc(fam.name || '') + '</span>' +
        '<span class="qs-tag plain">' + esc(s.type || '') + '</span>' +
        (s.hold && s.hold !== '—' ? '<span class="qs-tag plain">' + esc(s.hold) + '</span>' : '') +
        (cagr !== null ? '<span class="qs-tag plain">年化≈' + cagr + '%</span>' : '') +
      '</div>' +
      '<div class="qs-card-bt">' + esc(btShort) + '</div>' +
      '<div class="qs-card-foot">' +
        '<span class="qs-card-link">查看详情 →</span>' +
        (s.images && s.images.length ? '<span class="qs-card-no">🖼 ' + s.images.length + ' 图</span>' : '') +
      '</div>' +
    '</article>';
  }

  // ── 详情浮层 ──
  var modal = document.getElementById('qsModal');
  var modalBody = document.getElementById('qsModalBody');
  var current = null;

  function rulesList(rules) {
    return String(rules || '').split('；').filter(function (x) { return x.trim(); }).map(function (x) {
      return '<li>' + esc(x.trim().replace(/^①/, '')) + '</li>';
    }).join('') || '<li>' + esc(rules || '') + '</li>';
  }

  function codeBlocksHtml(s) {
    if (!s.code) return '';
    var blocks = String(s.code).split(/\n*# ─── 代码块 \d+ ───\n*/).filter(function (x) { return x.trim(); });
    return blocks.map(function (code, i) {
      var lines = code.split('\n').length;
      return '<div class="qsm-code-box' + (lines > 120 ? ' collapsed' : '') + '" data-code="' + i + '">' +
        '<div class="qsm-code-bar">' +
          '<span>Python · 聚宽平台 · ' + lines + ' 行' + (blocks.length > 1 ? '（块 ' + (i + 1) + '/' + blocks.length + '）' : '') + '</span>' +
          '<span>' +
            (lines > 120 ? '<button type="button" class="qsm-code-toggle" data-act="toggle">展开全部</button>' : '') +
            '<button type="button" class="qsm-code-copy" data-act="copy">📋 复制</button>' +
          '</span>' +
        '</div>' +
        '<pre><code>' + esc(code.trim()) + '</code></pre>' +
      '</div>';
    }).join('');
  }

  function modalHtml(s) {
    var fam = FAMS[s.fam] || {};
    var html =
      '<div class="qsm-head" style="--fam-color:' + fam.color + '">' +
        '<div class="qsm-head-row"><span class="qsm-no">第 6 章 · #' + s.no + '</span><span class="qsm-fam">' + esc(fam.name || '') + '</span></div>' +
        '<h3 class="qsm-title">' + esc(s.title) + '</h3>' +
        '<div class="qsm-tags" style="margin-top:8px">' +
          '<span class="qsm-tag">' + esc(s.type || '') + '</span>' +
          (s.hold && s.hold !== '—' ? '<span class="qsm-tag">' + esc(s.hold) + '</span>' : '') +
          '<span class="qsm-tag">族：' + esc(fam.desc || '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="qsm-sec"><h4><span class="qsm-ico">💡</span>策略原理</h4><p class="qsm-p">' + esc(s.principle || '') + '</p></div>' +
      '<div class="qsm-sec"><h4><span class="qsm-ico">📐</span>规则细节</h4><ul class="qsm-ul">' + rulesList(s.rules) + '</ul></div>' +
      '<div class="qsm-sec"><h4><span class="qsm-ico">📊</span>回测效果</h4><div class="qsm-bt">' + esc(s.bt || '（原书未给出数字）') + '</div></div>' +
      (s.risk ? '<div class="qsm-sec"><h4><span class="qsm-ico">⚠️</span>风险与提示</h4><div class="qsm-risk">' + esc(s.risk) + '</div></div>' : '');
    if (s.images && s.images.length) {
      html += '<div class="qsm-sec"><h4><span class="qsm-ico">🖼</span>原文插图</h4><div class="qsm-imgs">' +
        s.images.map(function (src) {
          var name = String(src).split('/').pop();
          return '<figure class="qsm-img" style="margin:0"><img loading="lazy" src="' + esc(src) + '" alt="' + esc(name) + '"><figcaption class="qsm-img-cap">' + esc(name) + '</figcaption></figure>';
        }).join('') + '</div></div>';
    }
    if (s.code) {
      html += '<div class="qsm-sec"><h4><span class="qsm-ico">🐍</span>完整代码</h4>' + codeBlocksHtml(s) +
        '<p class="qsm-code-hint">代码原样摘自教程，运行于聚宽（JoinQuant）平台环境。</p></div>';
    }
    return html;
  }

  function openModal(idx) {
    var s = null;
    for (var i = 0; i < STRATS.length; i++) if (STRATS[i].idx === idx) { s = STRATS[i]; break; }
    if (!s) return;
    current = s;
    modalBody.innerHTML = modalHtml(s);
    modalBody.scrollTop = 0;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    current = null;
  }

  // ── 灯箱 ──
  var lightbox = document.getElementById('qsLightbox');
  var lightboxImg = lightbox.querySelector('img');
  lightbox.addEventListener('click', function () { lightbox.hidden = true; });

  // ── 事件绑定 ──
  document.getElementById('qsFamChips').addEventListener('click', function (e) {
    var chip = e.target.closest('.qs-chip');
    if (!chip) return;
    state.fam = chip.getAttribute('data-fam');
    renderChips();
    renderGrid();
  });

  var searchTimer = null;
  document.getElementById('qsSearch').addEventListener('input', function (e) {
    var v = e.target.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { state.q = v; renderGrid(); }, 150);
  });

  document.getElementById('qsSort').addEventListener('change', function (e) {
    state.sort = e.target.value;
    renderGrid();
  });

  document.getElementById('qsGrid').addEventListener('click', function (e) {
    var card = e.target.closest('.qs-card');
    if (card) openModal(parseInt(card.getAttribute('data-idx'), 10));
  });
  document.getElementById('qsGrid').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest('.qs-card');
    if (card) { e.preventDefault(); openModal(parseInt(card.getAttribute('data-idx'), 10)); }
  });

  modal.addEventListener('click', function (e) {
    if (e.target.closest('[data-qs-close]')) { closeModal(); return; }
    var img = e.target.closest('.qsm-img img');
    if (img) { lightboxImg.src = img.src; lightboxImg.alt = img.alt; lightbox.hidden = false; return; }
    var toggle = e.target.closest('[data-act="toggle"]');
    if (toggle) {
      var box = toggle.closest('.qsm-code-box');
      var collapsed = box.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '展开全部' : '收起代码';
      return;
    }
    var copy = e.target.closest('[data-act="copy"]');
    if (copy) {
      var codeEl = copy.closest('.qsm-code-box').querySelector('pre code');
      var text = codeEl.textContent;
      var done = function () { copy.textContent = '✅ 已复制'; setTimeout(function () { copy.textContent = '📋 复制'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    }
  });

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) {}
    document.body.removeChild(ta);
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!lightbox.hidden) lightbox.hidden = true;
      else if (!modal.hidden) closeModal();
    }
  });

  // ── 启动 ──
  var total = document.getElementById('qsTotalCount');
  if (total) total.textContent = String(STRATS.length);
  renderHero();
  renderChips();
  renderGrid();
})();
