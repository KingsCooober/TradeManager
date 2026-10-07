/* ============================================================
   研报阅读整理工作台 · 前端
   ============================================================ */
(() => {
  'use strict';

  // 支持被挂到子路径下（例如主站反代到 /research/）：所有请求都带上这个前缀。
  // 直接跑在根路径时 BASE 为空串，行为与原来完全一致。
  const BASE = (() => {
    if (typeof window.__RESEARCH_BASE__ === 'string') {
      return window.__RESEARCH_BASE__.replace(/\/+$/, '');
    }
    const path = location.pathname;
    return path.endsWith('/') ? path.slice(0, -1) : path.replace(/\/[^/]*$/, '');
  })();
  // 上一级（集成时用于「返回交易台」）
  const PARENT_PATH = BASE ? (BASE.replace(/\/[^/]*$/, '') || '/') : '';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  async function api(path, { method = 'GET', body, raw, headers } = {}) {
    const opts = { method, headers: { ...(headers || {}) } };
    if (raw !== undefined) {
      opts.body = raw;
    } else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    const type = res.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
    if (!res.ok) {
      const detail = data && data.detail ? data.detail : (typeof data === 'string' ? data : `HTTP ${res.status}`);
      throw new Error(detail);
    }
    return data;
  }

  function toast(message, kind = '') {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    $('#toast-root').appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s, transform .3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 320);
    }, kind === 'err' ? 4800 : 2600);
  }

  const fmtWords = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n || 0} 字`);
  const fmtDate = (s) => (s || '').slice(0, 16);

  /* ---------------------------------------------------------- 状态 */
  const state = {
    view: 'library',
    nav: 'all',
    filters: { q: '', industry: '', org: '', rating: '', tag: '', sort: 'created_desc' },
    reports: [],
    total: 0,
    page: 1,
    pageSize: 100,
    facetNames: { industries: [], orgs: [], ratings: [], tags: [] },
    facetCounts: { industries: {}, orgs: {}, ratings: {}, tags: {} },
    currentId: null,
    current: null,
    tab: 'doc',
    qa: {},
    stats: null,
    settings: null,
    loading: false,
  };

  /* ---------------------------------------------------------- Markdown 渲染 */
  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[\s（(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // Markdown 链接优先：先转成占位符，避免 URL 部分被下面的「裸链接」规则二次包裹
    const links = [];
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
      links.push(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    });
    // 裸 URL 自动变成可点击链接（如正文里的「原文页：https://…」）
    s = s.replace(/(https?:\/\/[^\s<>"'()（）\[\]【】，。；、！？]+)/g,
      '<a href="$1" target="_blank" rel="noopener">$1</a>');
    // 还原 Markdown 链接
    s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => links[Number(i)] || '');
    return s;
  }

  function mdToHtml(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    let listType = null;
    let inCode = false;
    let codeBuf = [];

    const flushPara = () => {
      if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
    };
    const closeList = () => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };
    const openList = (type) => {
      if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type; }
    };

    while (i < lines.length) {
      const line = lines[i];

      if (inCode) {
        if (/^\s*```/.test(line)) { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); inCode = false; codeBuf = []; }
        else codeBuf.push(line);
        i += 1; continue;
      }
      if (/^\s*```/.test(line)) { flushPara(); closeList(); inCode = true; i += 1; continue; }

      const pageMark = line.match(/^\s*<!--\s*page\s*(\d+)\s*-->\s*$/i);
      if (pageMark) { flushPara(); closeList(); out.push(`<span class="page-mark">—— 第 ${pageMark[1]} 页 ——</span>`); i += 1; continue; }

      if (!line.trim()) { flushPara(); closeList(); i += 1; continue; }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); i += 1; continue; }

      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const lvl = Math.min(h[1].length, 4);
        out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
        i += 1; continue;
      }

      // 表格
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        flushPara(); closeList();
        const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { body.push(cells(lines[i])); i += 1; }
        out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
          + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        flushPara(); closeList();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
        out.push(`<blockquote>${buf.map((b) => inline(b)).join('<br>')}</blockquote>`);
        continue;
      }

      const ul = line.match(/^\s*[-*•·]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.、)]\s+(.*)$/);
      if (ul || ol) {
        flushPara();
        openList(ul ? 'ul' : 'ol');
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
        i += 1; continue;
      }

      closeList();
      para.push(line.trim());
      i += 1;
    }
    if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
    flushPara(); closeList();
    return out.join('\n');
  }

  /* ---------------------------------------------------------- 高亮落位 */
  function locateAndWrap(container, needle, decorate) {
    const target = String(needle || '').replace(/\s+/g, ' ').trim();
    if (target.length < 2) return false;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('mark.hl')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    if (!nodes.length) return false;

    let norm = '';
    const map = [];
    for (const node of nodes) {
      const value = node.nodeValue;
      for (let k = 0; k < value.length; k += 1) {
        const ch = value[k];
        if (/\s/.test(ch)) {
          if (norm.endsWith(' ')) continue;
          norm += ' '; map.push([node, k]);
        } else {
          norm += ch; map.push([node, k]);
        }
      }
    }

    let idx = norm.indexOf(target);
    let length = target.length;
    if (idx < 0 && target.length > 40) {         // 长文本容错：用前 40 字定位
      const head = target.slice(0, 40);
      idx = norm.indexOf(head);
      length = head.length;
    }
    if (idx < 0) return false;

    const start = map[idx];
    const end = map[Math.min(idx + length - 1, map.length - 1)];
    if (!start || !end) return false;

    const range = document.createRange();
    range.setStart(start[0], start[1]);
    range.setEnd(end[0], end[1] + 1);
    const mark = document.createElement('mark');
    mark.className = 'hl';
    decorate(mark);
    try {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
      return true;
    } catch (e) { return false; }
  }

  function paintHighlights(container, highlights) {
    let placed = 0;
    highlights.forEach((h) => {
      const ok = locateAndWrap(container, h.text, (mark) => {
        mark.dataset.id = h.id;
        mark.dataset.color = h.color || 'yellow';
        if (h.note) mark.classList.add('has-note');
        mark.title = h.note ? `批注：${h.note}` : '点击查看高亮';
      });
      if (ok) placed += 1;
    });
    return placed;
  }

  /* ---------------------------------------------------------- 列表 */
  function queryString() {
    const f = state.filters;
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.industry) p.set('industry', f.industry);
    if (f.org) p.set('org', f.org);
    if (f.rating) p.set('rating', f.rating);
    if (f.tag) p.set('tag', f.tag);
    p.set('sort', f.sort || 'created_desc');
    if (state.nav === 'starred') p.set('starred', '1');
    if (['unread', 'reading', 'read'].includes(state.nav)) p.set('status', state.nav);
    p.set('limit', String(state.pageSize));
    p.set('offset', String((state.page - 1) * state.pageSize));
    return p.toString();
  }

  async function loadList() {
    state.loading = true;
    try {
      const data = await api(`/api/reports?${queryString()}`);
      state.reports = data.items;
      state.total = data.total;
      if (!data.items.length && state.page > 1) { state.page = 1; return loadList(); }
    } catch (e) {
      toast(`加载列表失败：${e.message}`, 'err');
      state.reports = []; state.total = 0;
    } finally {
      state.loading = false;
    }
    renderList();
    renderFilterChips();
  }

  async function loadStats() {
    try {
      state.stats = await api('/api/stats');
      renderCounts();
      renderFacets();
      if (state.view === 'dashboard') renderDashboard();
    } catch (e) { /* 忽略 */ }
  }

  async function loadFacets() {
    try {
      const [names, all] = await Promise.all([
        api('/api/facets'),
        api('/api/reports?limit=2000'),
      ]);
      state.facetNames = names;
      const counts = { industries: {}, orgs: {}, ratings: {}, tags: {} };
      const bump = (bucket, key) => { if (key) counts[bucket][key] = (counts[bucket][key] || 0) + 1; };
      all.items.forEach((r) => {
        String(r.industry || '').split(/[、,，;；/]/).forEach((x) => bump('industries', x.trim()));
        bump('orgs', r.org);
        bump('ratings', r.rating);
        (r.tags || []).forEach((t) => bump('tags', t));
      });
      const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
      state.facetCounts = {
        industries: rank(counts.industries).slice(0, 14),
        orgs: rank(counts.orgs).slice(0, 12),
        ratings: rank(counts.ratings).slice(0, 8),
        tags: rank(counts.tags).slice(0, 24),
      };
      renderFacets();
    } catch (e) { /* 忽略 */ }
  }

  function renderCounts() {
    const s = state.stats;
    if (!s) return;
    $('#c-all').textContent = s.total;
    $('#c-star').textContent = s.starred;
    $('#c-unread').textContent = s.status.unread;
    $('#c-reading').textContent = s.status.reading;
    $('#c-read').textContent = s.status.read;
  }

  function renderFacets() {
    const on = state.filters;
    const groups = [
      ['行业', 'industry', state.facetCounts.industries],
      ['机构', 'org', state.facetCounts.orgs],
      ['评级', 'rating', state.facetCounts.ratings],
      ['标签', 'tag', state.facetCounts.tags],
    ];
    $('#facet-box').innerHTML = groups.map(([label, key, items]) => {
      if (!items || !items.length) return '';
      return `<div class="facet-group"><h4>${label}</h4><div class="facet-list">` + items.map(([name, count]) =>
        `<button class="facet ${on[key] === name ? 'is-on' : ''}" data-facet="${key}" data-value="${esc(name)}"
          title="${esc(name)}">${esc(name)}<b>${count}</b></button>`).join('') + '</div></div>';
    }).join('') || '<div class="facet-group" style="color:var(--rail-text-dim);font-size:12px">暂无筛选维度</div>';
  }

  function renderFilterChips() {
    const f = state.filters;
    const chips = [];
    if (f.q) chips.push(['q', `搜索：${f.q}`]);
    if (f.industry) chips.push(['industry', `行业：${f.industry}`]);
    if (f.org) chips.push(['org', `机构：${f.org}`]);
    if (f.rating) chips.push(['rating', `评级：${f.rating}`]);
    if (f.tag) chips.push(['tag', `标签：${f.tag}`]);
    $('#active-filters').innerHTML = chips.map(([k, label]) =>
      `<span class="chip">${esc(label)}<button data-clear="${k}" title="移除">×</button></span>`).join('');
    $('#list-count').textContent = state.loading ? '加载中…' : `${state.total} 篇`;
    renderListPager();
  }

  function renderListPager() {
    const box = $('#list-pager');
    if (!box) return;
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (pages <= 1) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <button class="btn sm" data-page="prev" ${state.page <= 1 ? 'disabled' : ''}>‹</button>
      <span class="info">${state.page}/${pages}</span>
      <button class="btn sm" data-page="next" ${state.page >= pages ? 'disabled' : ''}>›</button>`;
  }

  function bindPager() {
    const box = $('#list-pager');
    if (!box) return;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-page]');
      if (!b) return;
      const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
      state.page = b.dataset.page === 'next' ? Math.min(state.page + 1, pages) : Math.max(state.page - 1, 1);
      loadList();
      $('#list').scrollTop = 0;
    });
  }

  function renderList() {
    const box = $('#list');
    if (!state.reports.length) {
      box.innerHTML = `<div class="list-empty">没有匹配的研报<br><span style="font-size:12px">试试更换筛选条件，或点击「＋ 新建 / 上传」导入研报</span></div>`;
      return;
    }
    box.innerHTML = state.reports.map((r) => {
      const tags = (r.tags || []).slice(0, 3).map((t) => `<span class="tag-mini">${esc(t)}</span>`).join('');
      const statusLabel = { unread: '未读', reading: '在读', read: '已读' }[r.read_status] || '未读';
      return `<article class="card ${r.id === state.currentId ? 'is-active' : ''}" data-id="${r.id}">
        ${r.starred ? '<span class="card-star">★</span>' : ''}
        <h3 class="card-title">${esc(r.title || '未命名研报')}</h3>
        <p class="card-excerpt">${esc(r.summary || r.excerpt || '（暂无摘要）')}</p>
        <div class="card-meta">
          <span class="dot ${r.read_status}"></span><span>${statusLabel}</span>
          ${(!r.word_count && ['feed','auto','backfill'].includes(r.source_type)) ? '<span class="tag-mini warn-tag" title="这篇没有抓到正文，可到「研报抓取 → 补全缺失正文」重试">无正文</span>' : ''}
          ${r.org ? `<span>· ${esc(r.org)}</span>` : ''}
          ${r.rating ? `<span>· ${esc(r.rating)}</span>` : ''}
          ${r.report_date ? `<span>· ${esc(r.report_date)}</span>` : ''}
          ${r.word_count ? `<span>· ${fmtWords(r.word_count)}</span>` : ''}
        </div>
        ${tags ? `<div class="card-meta" style="margin-top:5px">${tags}</div>` : ''}
      </article>`;
    }).join('');
  }

  /* ---------------------------------------------------------- 阅读器 */
  // 东方财富研报的原文 PDF 直链：https://pdf.dfcfw.com/pdf/H3_<infocode>_1.pdf
  // infocode 形如 AP202610061830164303，可从原文页地址或 source_file 提取
  function sourcePdfUrl(r) {
    const src = String(r.source_url || '');
    const file = String(r.source_file || '');
    let code = '';
    const m = src.match(/infocode=([A-Za-z0-9]+)/) || src.match(/\/report\/info\/([A-Za-z0-9]+)\.html/);
    if (m) code = m[1];
    else if (/^AP\d{6,}$/.test(file)) code = file;
    return code ? `https://pdf.dfcfw.com/pdf/H3_${code}_1.pdf` : '';
  }

  function metaPills(r) {
    const pills = [];
    if (r.org) pills.push(`<span class="meta-pill">${esc(r.org)}</span>`);
    if (r.rating) pills.push(`<span class="meta-pill rating">${esc(r.rating)}</span>`);
    if (r.target_price) pills.push(`<span class="meta-pill">目标价 ${esc(r.target_price)}</span>`);
    if (r.stock_code) pills.push(`<span class="meta-pill">${esc(r.stock_code)}</span>`);
    if (r.industry) pills.push(`<span class="meta-pill">${esc(r.industry)}</span>`);
    if (r.authors) pills.push(`<span class="meta-pill">${esc(r.authors)}</span>`);
    if (r.report_date) pills.push(`<span class="meta-pill">${esc(r.report_date)}</span>`);
    if (r.page_count) pills.push(`<span class="meta-pill">${r.page_count} 页</span>`);
    if (r.word_count) pills.push(`<span class="meta-pill">${fmtWords(r.word_count)}</span>`);
    if (r.source_file) pills.push(`<span class="meta-pill">原件：${esc(r.source_file)}</span>`);
    if (r.source_url) pills.push(`<a class="meta-pill" href="${esc(r.source_url)}" target="_blank" rel="noopener" style="text-decoration:none">🔗 原文页</a>`);
    const pdfUrl = sourcePdfUrl(r);
    if (pdfUrl) pills.push(`<a class="meta-pill pdf" href="${esc(pdfUrl)}" target="_blank" rel="noopener" style="text-decoration:none" title="直接打开原文 PDF">📄 原文 PDF</a>`);
    (r.tags || []).forEach((t) => pills.push(`<span class="meta-pill tag">#${esc(t)}</span>`));
    if (r.ai_updated_at) pills.push(`<span class="meta-pill">AI 整理于 ${esc(fmtDate(r.ai_updated_at))}</span>`);
    return pills.join('');
  }

  function setTab(tab) {
    state.tab = tab;
    renderReader();
    if (state.currentId) writeHash(`#/report/${state.currentId}/${tab}`);
  }

  function renderReader() {    const root = $('#reader');
    const r = state.current;
    if (!r) {
      root.innerHTML = `<div class="reader-empty">
        <div class="big">📑</div>
        <div style="font-size:15px;color:var(--text-soft)">选择左侧任意一篇研报开始阅读</div>
        <div style="font-size:12.5px">选中正文文字即可高亮、写批注；<kbd>j</kbd>/<kbd>k</kbd> 切换上下篇，<kbd>/</kbd> 搜索</div>
      </div>`;
      return;
    }
    const statusOptions = [['unread', '未读'], ['reading', '在读'], ['read', '已读']]
      .map(([v, l]) => `<option value="${v}" ${r.read_status === v ? 'selected' : ''}>${l}</option>`).join('');
    const hCount = (r.highlights || []).length;
    const nCount = (r.notes || []).length;
    const tabs = [
      ['doc', '正文'],
      ['summary', '摘要 · 要点'],
      ['highlights', '高亮', hCount],
      ['notes', '笔记', nCount],
      ['qa', '问 AI'],
    ];
    root.innerHTML = `
      <header class="reader-head">
        <div class="reader-title-row">
          <h1 class="reader-title">${esc(r.title || '未命名研报')}</h1>
          <div class="reader-actions">
            <button class="icon-btn ${r.starred ? 'is-on' : ''}" data-act="star" title="星标 (s)">${r.starred ? '★' : '☆'}</button>
            <select class="icon-btn" data-act="status" title="阅读状态" style="width:64px;font-size:11.5px">${statusOptions}</select>
            <button class="icon-btn" data-act="edit" title="编辑元数据 / 正文">✎</button>
            <button class="icon-btn" data-act="ai" title="AI 生成摘要与要点">✨</button>
            <button class="icon-btn" data-act="export" title="导出 Markdown">⤓</button>
            <button class="icon-btn" data-act="delete" title="删除">🗑</button>
          </div>
        </div>
        <div class="meta-row">${metaPills(r)}</div>
        <nav class="tabs">${tabs.map(([k, label, count]) =>
          `<button class="tab ${state.tab === k ? 'is-active' : ''}" data-tab="${k}">${label}${count ? `<b>${count}</b>` : ''}</button>`).join('')}</nav>
      </header>
      <div class="reader-body"><div class="reader-inner" id="reader-inner"></div></div>`;
    renderTabBody();
    if (state.tab === 'doc' && (r.highlights || []).length) {
      paintHighlights($('#reader-inner'), r.highlights);
    }
  }

  function renderTabBody() {
    const inner = $('#reader-inner');
    const r = state.current;
    if (!inner || !r) return;

    if (state.tab === 'doc') {
      const body = (r.content || '').trim();
      inner.innerHTML = body
        ? `<div class="doc" id="doc">${mdToHtml(body)}</div>`
        : `<div class="empty-hint">这篇研报没有正文。<br>可以点击右上角 ✎ 粘贴正文，或重新上传 PDF。</div>`;
      return;
    }

    if (state.tab === 'summary') {
      const points = r.key_points || [];
      const data = r.key_data || [];
      const has = r.summary || points.length || data.length || r.risks;
      inner.innerHTML = has ? `
        <div class="panel-block">
          <h3>一句话摘要 <span class="spacer"></span>
            <button class="btn sm" data-act="ai">${r.ai_updated_at ? '重新生成' : 'AI 生成'}</button></h3>
          <div class="summary-text">${r.summary ? inline(r.summary) : '<span style="color:var(--text-dim)">尚未生成</span>'}</div>
        </div>
        ${points.length ? `<div class="panel-block"><h3>核心观点</h3><ul class="point-list">${points.map((p) => `<li>${inline(p)}</li>`).join('')}</ul></div>` : ''}
        ${data.length ? `<div class="panel-block"><h3>关键数据</h3><ul class="data-list">${data.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
        ${r.risks ? `<div class="panel-block"><h3>风险提示</h3><div class="summary-text">${inline(r.risks)}</div></div>` : ''}
      ` : `<div class="empty-hint">还没有整理内容。<br>点击下方按钮，让 AI 读一遍这份研报并生成摘要、核心观点与关键数据。</div>
           <div style="text-align:center"><button class="btn primary" data-act="ai">✨ AI 生成摘要与要点</button></div>`;
      return;
    }

    if (state.tab === 'highlights') {
      const hs = r.highlights || [];
      inner.innerHTML = `
        <div class="composer">
          <textarea id="hl-input" placeholder="手动摘录一段关键结论…（也可在正文中划词高亮）"></textarea>
          <div class="composer-foot"><span>手动摘录会进入高亮列表，可继续添加批注</span>
            <button class="btn primary sm" data-act="hl-add">添加摘录</button></div>
        </div>
        ${hs.length ? hs.map((h) => `
          <div class="hl-item" data-color="${esc(h.color || 'yellow')}" data-id="${h.id}">
            <blockquote>${esc(h.text)}</blockquote>
            ${h.note ? `<div class="hl-note">批注：${esc(h.note)}</div>` : ''}
            <div class="item-foot">
              <button class="btn sm" data-act="hl-locate" data-id="${h.id}">定位</button>
              <button class="btn sm" data-act="hl-note" data-id="${h.id}">${h.note ? '改批注' : '写批注'}</button>
              <button class="btn sm" data-act="hl-color" data-id="${h.id}">换色</button>
              <button class="btn sm danger" data-act="hl-del" data-id="${h.id}">删除</button>
              <span style="margin-left:auto;font-size:11px;color:var(--text-dim)">${esc(fmtDate(h.created_at))}</span>
            </div>
          </div>`).join('') : '<div class="empty-hint">还没有高亮。<br>切到「正文」，用鼠标选中一句话试试。</div>'}`;
      return;
    }

    if (state.tab === 'notes') {
      const ns = r.notes || [];
      inner.innerHTML = `
        <div class="composer">
          <textarea id="note-input" placeholder="写下你的判断、疑问、跟踪要点…（⌘/Ctrl + Enter 保存）"></textarea>
          <div class="composer-foot"><span>笔记保存在本地数据库</span>
            <button class="btn primary sm" data-act="note-add">添加笔记</button></div>
        </div>
        ${ns.length ? ns.map((n) => `
          <div class="note-item" data-id="${n.id}">
            <div class="note-head"><time>${esc(fmtDate(n.created_at))}</time>
              <span style="margin-left:auto"></span>
              <button class="btn sm" data-act="note-edit" data-id="${n.id}">编辑</button>
              <button class="btn sm danger" data-act="note-del" data-id="${n.id}">删除</button>
            </div>
            <div class="note-body">${esc(n.content)}</div>
          </div>`).join('') : '<div class="empty-hint">还没有笔记。</div>'}`;
      return;
    }

    if (state.tab === 'qa') {
      const log = state.qa[r.id] || [];
      inner.innerHTML = `
        <div class="composer">
          <textarea id="qa-input" placeholder="问点什么，例如：这篇研报的核心假设是什么？2026 年的盈利预测是多少？"></textarea>
          <div class="composer-foot"><span>只依据本篇正文作答，不会联网</span>
            <button class="btn primary sm" data-act="qa-ask">提问</button></div>
        </div>
        <div id="qa-log">${log.map((item) => `
          <div class="qa-item">
            <div class="qa-q">${esc(item.q)}</div>
            <div class="qa-a ${item.loading ? 'loading' : ''}">${item.loading ? '' : esc(item.a)}</div>
          </div>`).join('') || '<div class="empty-hint">AI 问答记录仅保存在当前会话。</div>'}</div>`;
    }
  }

  async function openReport(id, { silent = false } = {}) {
    try {
      const report = await api(`/api/reports/${id}`);
      state.currentId = id;
      state.current = report;
      state.tab = state.tab || 'doc';
      if (report.read_status === 'unread') {
        report.read_status = 'reading';
        api(`/api/reports/${id}`, { method: 'PATCH', body: { read_status: 'reading' } })
          .then(() => { loadStats(); loadList(); }).catch(() => {});
      }
      renderReader();
      renderList();
      $('#reader').scrollTop = 0;
      writeHash(`#/report/${id}/${state.tab}`);
      if (!silent) document.title = `${report.title || '研报'} · 研报工作台`;
    } catch (e) {
      toast(`打开失败：${e.message}`, 'err');
    }
  }

  async function refreshCurrent() {
    if (!state.currentId) return;
    const report = await api(`/api/reports/${state.currentId}`);
    state.current = report;
    renderReader();
  }

  async function patchReport(payload, { silent = false } = {}) {
    const updated = await api(`/api/reports/${state.currentId}`, { method: 'PATCH', body: payload });
    state.current = { ...state.current, ...updated };
    renderReader();
    loadList();
    if (!silent) toast('已保存', 'ok');
  }

  /* ---------------------------------------------------------- 划词工具条 */
  let pendingSelection = null;
  const selToolbar = $('#sel-toolbar');

  function selectionInDoc() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().trim();
    if (text.length < 2) return null;
    const doc = $('#doc');
    if (!doc) return null;
    const range = sel.getRangeAt(0);
    if (!doc.contains(range.commonAncestorContainer)) return null;
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  function hideSelToolbar() { selToolbar.classList.remove('is-open'); pendingSelection = null; }

  document.addEventListener('mouseup', (ev) => {
    if (selToolbar.contains(ev.target)) return;
    setTimeout(() => {
      const info = selectionInDoc();
      if (!info) { hideSelToolbar(); return; }
      pendingSelection = info.text;
      selToolbar.classList.add('is-open');
      const top = Math.max(8, info.rect.top - 42);
      const left = Math.min(window.innerWidth - 200, Math.max(8, info.rect.left + info.rect.width / 2 - 90));
      selToolbar.style.top = `${top}px`;
      selToolbar.style.left = `${left}px`;
    }, 10);
  });

  document.addEventListener('mousedown', (ev) => {
    if (!selToolbar.contains(ev.target)) hideSelToolbar();
  });
  window.addEventListener('scroll', hideSelToolbar, true);

  async function addHighlight(text, color, note = '') {
    if (!state.currentId || !text) return;
    try {
      await api(`/api/reports/${state.currentId}/highlights`, {
        method: 'POST', body: { text, color, note },
      });
      window.getSelection().removeAllRanges();
      hideSelToolbar();
      await refreshCurrent();
      toast('已高亮', 'ok');
    } catch (e) { toast(`高亮失败：${e.message}`, 'err'); }
  }

  selToolbar.addEventListener('mousedown', (ev) => ev.preventDefault());
  selToolbar.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const text = pendingSelection;
    if (btn.dataset.color) { await addHighlight(text, btn.dataset.color); return; }
    if (btn.id === 'sel-copy') { navigator.clipboard.writeText(text || '').then(() => toast('已复制', 'ok')); hideSelToolbar(); return; }
    if (btn.id === 'sel-note') {
      const note = await promptModal('添加批注', '为这段高亮写点你的想法', text);
      if (note === null) return;
      await addHighlight(text, 'yellow', note);
    }
  });

  /* ---------------------------------------------------------- 弹窗 */
  function closeModal() { const root = $('#modal-root'); root.classList.remove('is-open'); root.innerHTML = ''; }

  function openModal({ title, headerHtml, bodyHtml, footHtml = '', narrow = false, modalClass = '', onMount }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-mask" data-close></div>
      <div class="modal ${narrow ? 'narrow' : ''} ${modalClass}" role="dialog">
        <div class="modal-head">${headerHtml ? `<div class="modal-head-main">${headerHtml}</div>` : `<h2>${esc(title)}</h2>`}<button class="icon-btn" data-close>✕</button></div>
        <div class="modal-body">${bodyHtml}</div>
        ${footHtml ? `<div class="modal-foot">${footHtml}</div>` : ''}
      </div>`;
    root.classList.add('is-open');
    root.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeModal));
    if (onMount) onMount(root);
    const first = root.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
    return root;
  }

  function promptModal(title, label, initial = '') {
    return new Promise((resolve) => {
      const root = openModal({
        title, narrow: true,
        bodyHtml: `<div class="field"><label>${esc(label)}</label><textarea id="prompt-input">${esc(initial)}</textarea></div>`,
        footHtml: `<button class="btn" data-close>取消</button><button class="btn primary" id="prompt-ok">确定</button>`,
        onMount(r) {
          r.querySelector('#prompt-ok').addEventListener('click', () => {
            const v = r.querySelector('#prompt-input').value.trim();
            closeModal(); resolve(v);
          });
          r.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', () => resolve(null)));
          r.querySelector('#prompt-input').addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') r.querySelector('#prompt-ok').click();
          });
        },
      });
      root.querySelector('.modal-mask').addEventListener('click', () => resolve(null));
    });
  }

  function confirmModal(title, message) {
    return new Promise((resolve) => {
      openModal({
        title, narrow: true,
        bodyHtml: `<p style="margin:0;line-height:1.8">${esc(message)}</p>`,
        footHtml: `<button class="btn" data-close>取消</button><button class="btn danger" id="confirm-ok">确定删除</button>`,
        onMount(r) {
          r.querySelector('#confirm-ok').addEventListener('click', () => { closeModal(); resolve(true); });
          r.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', () => resolve(false)));
        },
      });
    });
  }

  /* ---------------------------------------------------------- 新建 / 编辑 */
  function reportFormHtml(r = {}) {
    return `
      <div class="field"><label>标题</label><input id="f-title" value="${esc(r.title || '')}" placeholder="留空将自动从正文首行提取"></div>
      <div class="field-row-3">
        <div class="field"><label>机构</label><input id="f-org" value="${esc(r.org || '')}" placeholder="中信证券"></div>
        <div class="field"><label>分析师</label><input id="f-authors" value="${esc(r.authors || '')}" placeholder="张三、李四"></div>
        <div class="field"><label>报告日期</label><input id="f-date" value="${esc(r.report_date || '')}" placeholder="2025-06-01"></div>
      </div>
      <div class="field-row-3">
        <div class="field"><label>行业</label><input id="f-industry" value="${esc(r.industry || '')}" placeholder="半导体、电子"></div>
        <div class="field"><label>评级</label><input id="f-rating" value="${esc(r.rating || '')}" placeholder="买入"></div>
        <div class="field"><label>目标价</label><input id="f-target" value="${esc(r.target_price || '')}" placeholder="42.0"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>股票代码</label><input id="f-code" value="${esc(r.stock_code || '')}" placeholder="688012.SH"></div>
        <div class="field"><label>标签（逗号分隔）</label><input id="f-tags" value="${esc((r.tags || []).join('、'))}" placeholder="国产替代、AI算力"></div>
      </div>
      <div class="field"><label>正文（支持 Markdown / 直接粘贴 PDF 文本）</label>
        <textarea id="f-content" style="min-height:220px">${esc(r.content || '')}</textarea>
        <div class="hint">粘贴正文后保存，系统会自动尝试识别机构、评级、目标价、股票代码与日期。</div>
      </div>`;
  }

  function readForm(root) {
    const v = (id) => (root.querySelector(id)?.value || '').trim();
    return {
      title: v('#f-title'), org: v('#f-org'), authors: v('#f-authors'),
      report_date: v('#f-date'), industry: v('#f-industry'), rating: v('#f-rating'),
      target_price: v('#f-target'), stock_code: v('#f-code'), tags: v('#f-tags'),
      content: root.querySelector('#f-content')?.value || '',
    };
  }

  function openNewModal() {
    openModal({
      title: '新建研报',
      bodyHtml: reportFormHtml(),
      footHtml: `<span style="margin-right:auto;font-size:12px;color:var(--text-dim)">需要导入 PDF？直接拖拽文件到窗口任意位置</span>
        <button class="btn" data-close>取消</button><button class="btn primary" id="save-new">保存</button>`,
      onMount(root) {
        root.querySelector('#save-new').addEventListener('click', async () => {
          const payload = readForm(root);
          if (!payload.title && !payload.content.trim()) { toast('标题和正文至少填一个', 'err'); return; }
          try {
            const created = await api('/api/reports', { method: 'POST', body: payload });
            closeModal();
            toast('已创建', 'ok');
            await Promise.all([loadList(), loadStats(), loadFacets()]);
            await openReport(created.id);
          } catch (e) { toast(`创建失败：${e.message}`, 'err'); }
        });
      },
    });
  }

  function openEditModal() {
    const r = state.current;
    if (!r) return;
    const extra = `
      <div class="field-row">
        <div class="field"><label>我的摘要（可手动修改）</label><textarea id="f-summary" style="min-height:80px">${esc(r.summary || '')}</textarea></div>
        <div class="field"><label>风险提示</label><textarea id="f-risks" style="min-height:80px">${esc(r.risks || '')}</textarea></div>
      </div>
      <div class="field"><label>阅读状态</label>
        <select id="f-status">
          ${['unread:未读', 'reading:在读', 'read:已读'].map((x) => {
            const [v, l] = x.split(':');
            return `<option value="${v}" ${r.read_status === v ? 'selected' : ''}>${l}</option>`;
          }).join('')}
        </select></div>`;
    openModal({
      title: '编辑研报',
      bodyHtml: reportFormHtml(r) + extra,
      footHtml: `<button class="btn" data-close>取消</button><button class="btn primary" id="save-edit">保存</button>`,
      onMount(root) {
        root.querySelector('#save-edit').addEventListener('click', async () => {
          const payload = readForm(root);
          payload.summary = (root.querySelector('#f-summary')?.value || '').trim();
          payload.risks = (root.querySelector('#f-risks')?.value || '').trim();
          payload.read_status = root.querySelector('#f-status')?.value || 'unread';
          try {
            await patchReport(payload, { silent: true });
            closeModal();
            toast('已保存', 'ok');
            await Promise.all([loadStats(), loadFacets()]);
          } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
        });
      },
    });
  }

  /* ---------------------------------------------------------- AI */
  async function runAI() {
    if (!state.currentId) return;
    const btn = $(`.reader-actions [data-act="ai"], #reader-inner [data-act="ai"]`);
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
    toast('AI 正在阅读这篇研报…');
    try {
      const updated = await api(`/api/reports/${state.currentId}/summarize`, { method: 'POST', body: {} });
      state.current = updated;
      setTab('summary');
      await Promise.all([loadList(), loadStats(), loadFacets()]);
      const extra = updated.ai_extra || {};
      toast(`整理完成${extra.confidence ? `（置信度：${extra.confidence}）` : ''}`, 'ok');
    } catch (e) {
      toast(`AI 生成失败：${e.message}`, 'err');
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  async function askQuestion() {
    const input = $('#qa-input');
    if (!input || !state.currentId) return;
    const question = input.value.trim();
    if (!question) return;
    const rid = state.currentId;
    state.qa[rid] = state.qa[rid] || [];
    const item = { q: question, a: '', loading: true };
    state.qa[rid].push(item);
    renderTabBody();
    try {
      const res = await api(`/api/reports/${rid}/ask`, { method: 'POST', body: { question } });
      item.a = res.answer; item.loading = false;
    } catch (e) {
      item.a = `调用失败：${e.message}`; item.loading = false;
      toast(`提问失败：${e.message}`, 'err');
    }
    if (state.tab === 'qa') renderTabBody();
    const log = $('#qa-log');
    if (log) log.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ---------------------------------------------------------- 上传 */
  async function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    for (const file of list) {
      toast(`正在导入 ${file.name}…`);
      try {
        const created = await api(`/api/reports/upload?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST', raw: file,
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
        });
        if (created.import_note) toast(created.import_note, 'err');
        else toast(`已导入《${created.title}》`, 'ok');
        await Promise.all([loadList(), loadStats(), loadFacets()]);
        await openReport(created.id);
      } catch (e) {
        toast(`导入失败（${file.name}）：${e.message}`, 'err');
      }
    }
  }

  /* ---------------------------------------------------------- 研报抓取 */
  const feedsState = {
    loaded: false,
    error: '',
    disclaimer: '',
    orgs: [],
    sources: [],
    maxImport: 20,
    items: [],
    selected: new Set(),
    meta: null,
    result: null,
    busy: false,
    lastWithContent: 0,
    auto: null,
    subs: [],
    logs: [],
    pollTimer: null,
    autoRaw: null,
    themes: [],
    bf: {},
    bfSources: null,
    bfTypes: [],
    bfDays: 30,
    bfTheme: '15th5',
    bfKeywords: '',
    bfContent: true,
    form: { source: 'eastmoney', type: 'stock', org_code: '', days: 30, keyword: '', stock_code: '', page: 1, page_size: 20, fetch_content: true },
  };

  async function loadFeedSources(force = false) {
    try {
      const data = await api(`/api/feeds/sources${force ? '?refresh=1' : ''}`);
      feedsState.sources = data.sources || [];
      feedsState.maxImport = data.max_import || 20;
      feedsState.disclaimer = data.disclaimer || '';
      feedsState.error = data.error || '';
    } catch (e) {
      feedsState.error = e.message;
      feedsState.sources = [];
    }
    feedsState.loaded = true;
  }

  function currentSource() {
    return feedsState.sources.find((s) => s.key === feedsState.form.source)
      || feedsState.sources[0]
      || { key: 'eastmoney', label: '东方财富 · 研报中心', orgs: [], types: [{ key: 'stock', label: '个股研报' }], org_filter: 'code' };
  }

  function orgOptions(selected) {
    const orgs = currentSource().orgs || [];
    const groups = {};
    orgs.forEach((o) => {
      const letter = (o.letter || '#').toUpperCase();
      (groups[letter] = groups[letter] || []).push(o);
    });
    return `<option value="">全部机构（共 ${orgs.length} 家）</option>`
      + Object.keys(groups).sort().map((letter) => `<optgroup label="${esc(letter)}">`
        + groups[letter].map((o) => `<option value="${esc(o.code)}" ${o.code === selected ? 'selected' : ''}>${esc(o.name)}</option>`).join('')
        + '</optgroup>').join('');
  }

  function bindFeedSummaryButtons() {
    const go = $('#fd-goto');
    if (go) go.addEventListener('click', () => {
      setNav('all');
      $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === 'all'));
      if (state.reports[0]) openReport(state.reports[0].id);
    });
    const again = $('#fd-again');
    if (again) again.addEventListener('click', () => {
      const el = $('#fd-result .import-summary');
      if (el) el.remove();
    });
  }

  function renderFeedResults() {
    const box = $('#fd-result');
    if (!box) return;

    let head = '';
    if (feedsState.result) {
      const res = feedsState.result;
      const done = res.created || [];
      const skipped = res.skipped || [];
      const failed = res.failed || [];
      head += `<div class="stat-card import-summary" style="margin-bottom:14px">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:4px">抓取完成</div>
        <div style="font-size:13px">成功入库 <b style="color:var(--ok)">${done.length}</b> 篇
          （其中 ${feedsState.lastWithContent} 篇含公开正文）· 跳过 ${skipped.length} 篇 · 失败 ${failed.length} 篇</div>
        ${done.length ? `<ul>${done.slice(0, 12).map((c) => `<li>${esc(c.title)} <span class="badge ${c.has_content ? 'ok' : 'warn'}">${c.has_content ? '含正文' : '仅元数据'}</span>${c.note ? ` <span style="color:var(--warn)">${esc(c.note)}</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${skipped.length ? `<div style="margin-top:8px;font-size:12.5px;color:var(--text-dim)">已跳过：${skipped.slice(0, 6).map((s) => esc(s.title)).join('、')}${skipped.length > 6 ? ' 等' : ''}</div>` : ''}
        ${failed.length ? `<div style="margin-top:6px;font-size:12.5px;color:var(--warn)">失败：${failed.map((f) => `${esc(f.title || '未命名')}（${esc(f.reason)}）`).join('；')}</div>` : ''}
        <div style="margin-top:10px"><button class="btn primary sm" id="fd-goto">去看这些研报</button></div>
      </div>`;
    }
    if (feedsState.busy) {
      box.innerHTML = head + `<div class="stat-card"><div class="spin-row"><span class="spinner"></span> 正在抓取…（每题之间间隔 0.5 秒，避免给来源站点压力）</div></div>`;
      bindFeedSummaryButtons();
      return;
    }

    const meta = feedsState.meta;
    if (!meta || !meta.items.length) {
      const hint = meta
        ? `${meta.warning ? `⚠ ${esc(meta.warning)}<br><br>` : ''}没有匹配的研报。<br><span style="font-size:12px">可以放宽时间范围，或把机构改成「全部机构」；部分类型在某些时间段可能没有公开数据。</span>`
        : (feedsState.error
          ? `读取来源失败：${esc(feedsState.error)}<br><span style="font-size:12px">可点「刷新机构列表」重试。</span>`
          : `设置好条件后点「搜索公开研报」。`);
      box.innerHTML = head + `<div class="stat-card"><div class="empty-hint">${hint}</div></div>`;
      bindFeedSummaryButtons();
      return;
    }

    const allOn = meta.items.every((i) => feedsState.selected.has(i.id));
    box.innerHTML = head + `
      <div class="fd-toolbar">
        <label><input type="checkbox" id="fd-all" ${allOn ? 'checked' : ''}> 全选本页</label>
        <span>共 <b>${meta.total}</b> 条 · 已选 <b>${feedsState.selected.size}</b> 篇（单次最多 ${feedsState.maxImport} 篇）</span>
        <span class="spacer"></span>
        <button class="btn primary sm" id="fd-import" ${feedsState.selected.size ? '' : 'disabled'}>导入所选</button>
        <div class="pager">
          <button class="btn sm" id="fd-prev" ${meta.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="info">${meta.page} / ${Math.max(meta.total_pages || 1, 1)}</span>
          <button class="btn sm" id="fd-next" ${meta.page >= (meta.total_pages || 1) ? 'disabled' : ''}>下一页</button>
        </div>
      </div>
      <div class="fd-table-wrap"><table class="fd-table">
        <thead><tr>
          <th style="width:34px"></th><th>标题</th><th class="nowrap">机构</th>
          <th class="nowrap">类型</th><th class="nowrap">行业</th><th class="nowrap">评级</th>
          <th class="nowrap">发布日期</th><th class="nowrap">页数</th><th class="nowrap">来源</th>
        </tr></thead>
        <tbody>${meta.items.map((item) => {
          const on = feedsState.selected.has(item.id);
          const target = [item.stock_name, item.stock_code].filter(Boolean).join(' ');
          const sub = [target ? `标的：${target}` : '', item.authors ? `分析师：${item.authors}` : ''].filter(Boolean).join(' · ');
          return `<tr class="${on ? 'is-on' : ''}">
            <td><input type="checkbox" data-fd-pick="${esc(item.id)}" ${on ? 'checked' : ''}></td>
            <td class="t-title">${esc(item.title)}${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}</td>
            <td class="nowrap">${esc(item.org)}</td>
            <td class="nowrap"><span class="badge">${esc(item.type_label)}</span></td>
            <td class="nowrap">${esc(item.industry || '—')}</td>
            <td class="nowrap">${item.rating ? `<span class="badge on">${esc(item.rating)}</span>` : '—'}</td>
            <td class="nowrap">${esc(item.date || '—')}</td>
            <td class="nowrap">${item.pages || '—'}</td>
            <td class="nowrap">${item.imported ? '<span class="badge ok">已入库</span> ' : ''}<a class="badge" href="${esc(item.url)}" target="_blank" rel="noopener">原文页</a></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;

    const all = $('#fd-all');
    if (all) all.addEventListener('change', () => {
      meta.items.forEach((i) => { if (all.checked) feedsState.selected.add(i.id); else feedsState.selected.delete(i.id); });
      renderFeedResults();
    });
    $$('[data-fd-pick]', box).forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) feedsState.selected.add(cb.dataset.fdPick); else feedsState.selected.delete(cb.dataset.fdPick);
      renderFeedResults();
    }));
    const prev = $('#fd-prev'); if (prev) prev.addEventListener('click', () => runFeedSearch(meta.page - 1));
    const next = $('#fd-next'); if (next) next.addEventListener('click', () => runFeedSearch(meta.page + 1));
    const imp = $('#fd-import'); if (imp) imp.addEventListener('click', importSelected);
    bindFeedSummaryButtons();
  }

  /* ---- 自动抓取面板 ---- */

  const SUB_INTERVALS = [[15, '每 15 分钟'], [30, '每 30 分钟'], [60, '每小时'], [120, '每 2 小时'],
    [360, '每 6 小时'], [720, '每 12 小时'], [1440, '每天']];

  function autoStatusLine() {
    const a = feedsState.auto;
    if (!a) return '<span style="color:var(--text-dim)">读取中…</span>';
    const bits = [];
    if (a.running) bits.push(`<span class="badge on">抓取中${a.current ? `：${esc(a.current)}` : ''}</span>`);
    else if (!a.enabled) bits.push('<span class="badge">已暂停</span>');
    else bits.push('<span class="badge ok">已启用</span>');
    if (a.enabled && a.next_run_at) bits.push(`下次运行 <b>${esc(a.next_run_at.slice(5, 16))}</b>`);
    bits.push(`今日自动入库 <b>${a.today_created}</b> / ${a.daily_limit} 篇`);
    bits.push(`累计自动入库 <b>${a.total_auto_reports}</b> 篇`);
    bits.push(`订阅 <b>${a.enabled_count}</b>/${a.subscription_count} 条启用`);
    if (a.last_error) bits.push(`<span style="color:var(--warn)">上次异常：${esc(a.last_error).slice(0, 60)}</span>`);
    return bits.join(' · ');
  }

  /* ---- 批量回填（按行业 / 主题） ---- */

  function bfProgressHtml() {
    const j = feedsState.bf || {};
    if (!j.started_at) {
      return `<div class="hint">选择时间范围与行业 / 主题关键词后点「开始批量导入」。
        扫描阶段只写元数据（快），命中后再逐篇补公开正文（慢，可随时停止，再跑会接着补）。</div>`;
    }
    const pct = Math.max(0, Math.min(100, j.progress || 0));
    const phaseLabel = { scan: '扫描中', content: '补正文', done: '已完成', cancelled: '已停止', error: '出错', idle: '待开始' }[j.phase] || j.phase;
    const bits = [
      `组合 <b>${j.combo_index || 0}/${j.combo_total || 0}</b>`,
      `已扫描 <b>${j.scanned || 0}</b> 篇`,
      `命中 <b>${j.matched || 0}</b>`,
      `入库 <b style="color:var(--ok)">${j.created || 0}</b>`,
      `跳过 <b>${j.skipped || 0}</b>`,
    ];
    if (j.content_total) bits.push(`正文 <b>${j.content_done || 0}/${j.content_total}</b>${j.content_failed ? `（失败 ${j.content_failed}）` : ''}`);
    if (j.params?.keywords?.length) bits.push(`关键词 <b>${j.params.keywords.length}</b> 个`);
    return `
      <div class="auto-status" style="margin-top:12px">
        <span class="badge ${j.running ? 'on' : (j.phase === 'done' ? 'ok' : (j.phase === 'error' ? 'warn' : ''))}">${phaseLabel}</span>
        ${j.current ? `<span style="margin-left:6px">${esc(j.current)}</span>` : ''}
        <div style="margin-top:6px">${bits.join(' · ')}</div>
      </div>
      <div class="bf-bar"><span style="width:${pct}%"></span></div>
      ${j.message ? `<div class="hint" style="margin-top:6px">${esc(j.message)}</div>` : ''}
      ${(j.log && j.log.length) ? `<div class="bf-log">${j.log.slice(-8).map((l) => `<div>${esc(l)}</div>`).join('')}</div>` : ''}`;
  }

  function renderContentFixPanel() {
    const m = feedsState.missing || { count: 0, retryable: 0, no_body: 0, by_source: [] };
    const busy = feedsState.bf && feedsState.bf.running;
    const detail = (m.by_source || []).map((x) =>
      `${esc(feedsState.sources.find((s) => s.key === x.name)?.label.split(' · ')[0] || x.name)} ${x.count}`).join(' · ');
    let body;
    if (!m.count) {
      body = '<span class="hint" style="margin:0">✅ 所有抓取进来的研报都有正文</span>';
    } else if (!m.retryable) {
      body = `<span class="hint" style="margin:0">有 <b>${m.count}</b> 篇没有正文，但都是
        <b>来源站本身没有文字版全文</b>的（已保留标题/机构/评级/日期与原文链接）</span>`;
    } else {
      body = `<span class="hint" style="margin:0">有 <b style="color:var(--warn)">${m.retryable}</b> 篇正文缺失${detail ? `（${detail}）` : ''}
        ${m.no_body ? `，另有 ${m.no_body} 篇来源站无正文` : ''}</span>`;
    }
    return `<div class="stat-card" style="margin-bottom:14px">
      <div class="auto-head">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600">正文补全</div>
        <span class="spacer"></span>
        ${m.retryable && !busy ? '<button class="btn sm primary" id="cf-run">一键补全</button>' : ''}
      </div>
      <div style="margin-top:8px">${body}</div>
      <div class="hint" style="margin-top:6px">抓取时遇到网络波动或来源限流会漏掉正文，「一键补全」会把它们重试一遍；来源站本身没有正文的不会反复重试。</div>
    </div>`;
  }

  async function loadMissing() {
    try {
      feedsState.missing = await api('/api/content/missing');
    } catch (e) { /* 忽略 */ }
  }

  function bindContentFix() {
    const btn = $('#cf-run');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 补全中';
      try {
        feedsState.bf = await api('/api/content/fill', { method: 'POST', body: {} });
        startAutoPoll(3000);
        toast(`开始补全 ${feedsState.bf.content_total || 0} 篇的正文`);
        renderFeeds();
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false; btn.textContent = '一键补全';
      }
    });
  }

  function renderBackfillPanel() {
    const themes = feedsState.themes || [];
    const sources = feedsState.sources || [];
    const allTypes = [];
    sources.forEach((s) => (s.types || []).forEach((t) => {
      if (!allTypes.some((x) => x.key === t.key)) allTypes.push(t);
    }));
    const pickedTypes = feedsState.bfTypes || [];
    return `<div class="stat-card" style="margin-bottom:14px">
      <div class="auto-head" style="margin-bottom:12px">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600">按行业 / 主题批量导入</div>
        <span class="spacer"></span>
        <span class="hint" style="margin:0">用于一次性回填历史研报；与上面的定时订阅互不影响</span>
      </div>
      <div class="field-row-3">
        <div class="field"><label>时间范围</label>
          <select id="bf-days">${[7, 15, 30, 60, 90, 180].map((v) =>
            `<option value="${v}" ${v === (feedsState.bfDays || 30) ? 'selected' : ''}>近 ${v} 天</option>`).join('')}</select></div>
        <div class="field"><label>来源</label>
          <div class="check-row">${sources.map((s) =>
            `<label class="switch sm"><input type="checkbox" data-bf-source="${esc(s.key)}" ${(feedsState.bfSources || sources.map((x) => x.key)).includes(s.key) ? 'checked' : ''}> ${esc(s.label.split(' · ')[0])}</label>`).join('') || '加载中…'}</div></div>
        <div class="field"><label>研报类型</label>
          <div class="check-row">${allTypes.map((t) =>
            `<label class="switch sm"><input type="checkbox" data-bf-type="${esc(t.key)}" ${pickedTypes.includes(t.key) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('')}</div>
          <div class="hint">不勾选＝该来源支持的全部类型</div></div>
      </div>
      <div class="field"><label>主题包（选中后自动填充关键词，可再手工修改）</label>
        <select id="bf-theme"><option value="">— 不使用主题包 —</option>${themes.map((t) =>
          `<option value="${esc(t.key)}" ${(feedsState.bfTheme || '') === t.key ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <div class="hint">${esc((themes.find((t) => t.key === feedsState.bfTheme) || {}).note || '')}</div></div>
      <div class="field"><label>行业 / 主题关键词（逗号或换行分隔，命中标题或行业名即导入）</label>
        <textarea id="bf-keywords" style="min-height:150px;line-height:1.9">${esc(feedsState.bfKeywords || '')}</textarea></div>
      <div class="auto-head">
        <label class="switch"><input type="checkbox" id="bf-content" ${feedsState.bfContent !== false ? 'checked' : ''}> 同时抓取公开正文</label>
        <span class="spacer"></span>
        <span class="hint" style="margin:0">单次最多入库 4000 篇</span>
        ${(feedsState.bf && feedsState.bf.running)
          ? '<button class="btn danger" id="bf-stop">停止</button>'
          : '<button class="btn primary" id="bf-start">开始批量导入</button>'}
      </div>
      <div id="bf-progress">${bfProgressHtml()}</div>
    </div>`;
  }

  function bindBackfill() {
    const start = $('#bf-start');
    if (start) start.addEventListener('click', startBackfill);
    const stop = $('#bf-stop');
    if (stop) stop.addEventListener('click', async () => {
      stop.disabled = true; stop.textContent = '停止中…';
      try { await api('/api/backfill/stop', { method: 'POST' }); toast('已请求停止，当前篇抓完就停'); }
      catch (e) { toast(`停止失败：${e.message}`, 'err'); }
    });
    const theme = $('#bf-theme');
    if (theme) theme.addEventListener('change', (e) => {
      feedsState.bfTheme = e.target.value;
      const t = (feedsState.themes || []).find((x) => x.key === e.target.value);
      const box = $('#bf-keywords');
      if (t && box) { box.value = t.keywords.join('、'); feedsState.bfKeywords = box.value; }
      renderFeeds();
    });
    ['#bf-days', '#bf-keywords', '#bf-content'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('change', collectBackfillForm);
      if (sel === '#bf-keywords') el.addEventListener('input', () => { feedsState.bfKeywords = el.value; });
    });
    $$('[data-bf-source]').forEach((cb) => cb.addEventListener('change', () => {
      collectBackfillForm();
      const picked = $$('[data-bf-source]').filter((x) => x.checked).map((x) => x.dataset.bfSource);
      feedsState.bfSources = picked;
      // 类型选项随来源变化，重新渲染
      feedsState.bfTypes = $$('[data-bf-type]').filter((x) => x.checked).map((x) => x.dataset.bfType);
      renderFeeds();
    }));
    $$('[data-bf-type]').forEach((cb) => cb.addEventListener('change', () => {
      feedsState.bfTypes = $$('[data-bf-type]').filter((x) => x.checked).map((x) => x.dataset.bfType);
    }));
  }

  function collectBackfillForm() {
    feedsState.bfDays = Number($('#bf-days')?.value || 30);
    feedsState.bfSources = $$('[data-bf-source]').filter((x) => x.checked).map((x) => x.dataset.bfSource);
    feedsState.bfTypes = $$('[data-bf-type]').filter((x) => x.checked).map((x) => x.dataset.bfType);
    feedsState.bfKeywords = $('#bf-keywords')?.value || feedsState.bfKeywords || '';
    feedsState.bfContent = !!$('#bf-content')?.checked;
  }

  async function startBackfill() {
    collectBackfillForm();
    const keywords = (feedsState.bfKeywords || '').trim();
    if (!keywords) { toast('请先选择主题包，或填写行业 / 主题关键词', 'err'); return; }
    if (!feedsState.bfSources.length) { toast('请至少选择一个来源', 'err'); return; }
    if (!window.confirm(`将从 ${feedsState.bfSources.length} 个来源抓取近 ${feedsState.bfDays} 天的研报，`
      + `命中关键词的才会入库${feedsState.bfContent ? '，并逐篇抓正文（较慢）' : '（仅元数据，较快）'}。\n\n开始吗？`)) return;
    try {
      feedsState.bf = await api('/api/backfill/start', {
        method: 'POST',
        body: { sources: feedsState.bfSources, types: feedsState.bfTypes, days: feedsState.bfDays,
          keywords, theme: feedsState.bfTheme, fetch_content: feedsState.bfContent },
      });
      renderFeeds();
      startAutoPoll(3000);
      toast('批量导入已启动，进度会实时刷新', 'ok');
    } catch (e) { toast(`启动失败：${e.message}`, 'err'); }
  }

  async function loadBackfillStatus() {
    try {
      const job = await api('/api/backfill/status');
      const wasRunning = feedsState.bf?.running;
      feedsState.bf = job;
      if (wasRunning && !job.running) {
        await Promise.all([loadList(), loadStats(), loadFacets(), loadMissing()]);
        toast(`批量导入结束：入库 ${job.created} 篇`, job.created ? 'ok' : '');
      }
    } catch (e) { /* 忽略 */ }
  }

  function renderAutoPanel() {
    const a = feedsState.auto || {};
    return `<div class="stat-card" style="margin-bottom:14px">
      <div class="auto-head">
        <label class="switch big"><input type="checkbox" id="af-toggle" ${a.enabled ? 'checked' : ''}>
          <span>自动获取研报</span></label>
        <span class="badge ${a.enabled ? 'ok' : ''}">${a.enabled ? '已开启' : '已关闭'}</span>
        <span class="spacer"></span>
        <label class="mini-field">每日入库上限
          <input type="number" id="af-limit" min="1" max="500" value="${a.daily_limit || 30}"></label>
        <button class="btn sm" id="af-run">立即抓取</button>
        <button class="btn sm" id="af-new">＋ 新建订阅</button>
      </div>
      <div class="auto-status" id="auto-status">${autoStatusLine()}</div>
      <div class="hint" style="margin-top:6px">
        后台每 20 秒检查一次：到点的订阅会自动拉取新研报（按来源编号去重），入库后可在左侧「全部研报」看到。
        ${a.enabled ? '' : '打开开关即立刻抓取一轮。'}
      </div>
    </div>`;
  }

  function subRowsHtml() {
    const subs = feedsState.subs || [];
    if (!subs.length) {
      return `<tr><td colspan="9"><div class="empty-hint">还没有订阅规则。<br>
        <span style="font-size:12px">点右上角「＋ 新建订阅」，例如「中信建投 · 个股研报 · 每小时」。</span></div></td></tr>`;
    }
    return subs.map((s) => {
      const src = (feedsState.sources.find((x) => x.key === s.source) || {}).label || s.source;
      const typeLabel = (() => {
        const st = feedsState.sources.find((x) => x.key === s.source);
        return ((st && st.types) || []).find((t) => t.key === s.type)?.label || s.type;
      })();
      const statusBadge = { ok: '<span class="badge ok">成功</span>', partial: '<span class="badge warn">部分成功</span>',
        error: '<span class="badge warn">失败</span>', skipped: '<span class="badge">已跳过</span>' }[s.last_status] || '<span class="badge">未运行</span>';
      return `<tr class="${s.enabled ? '' : 'is-off'}">
        <td><input type="checkbox" data-sub-toggle="${s.id}" ${s.enabled ? 'checked' : ''}></td>
        <td class="t-title">${esc(s.name)}${s.keyword ? `<div class="t-sub">关键词：${esc(s.keyword)}</div>` : ''}</td>
        <td class="nowrap">${esc(src)}</td>
        <td class="nowrap"><span class="badge">${esc(typeLabel)}</span></td>
        <td class="nowrap">${esc(s.org_name || '全部机构')}</td>
        <td class="nowrap">${esc((SUB_INTERVALS.find(([v]) => Number(v) === Number(s.interval_minutes)) || [0, `每 ${s.interval_minutes} 分钟`])[1])}
          <div class="t-sub">每次 ≤ ${s.max_per_run} 篇 · 回看 ${s.lookback_days} 天</div></td>
        <td class="nowrap">${s.last_run_at ? `${statusBadge}<div class="t-sub">${esc(s.last_run_at.slice(5, 16))}</div>` : statusBadge}</td>
        <td class="nowrap">${s.total_created}<div class="t-sub">上次 +${s.last_created}</div></td>
        <td class="nowrap">
          <button class="btn sm" data-sub-run="${s.id}">抓一次</button>
          <button class="btn sm" data-sub-edit="${s.id}">编辑</button>
          <button class="btn sm danger" data-sub-del="${s.id}">删除</button>
        </td>
      </tr>`;
    }).join('');
  }

  function logRowsHtml() {
    const logs = feedsState.logs || [];
    if (!logs.length) return `<tr><td colspan="6" style="color:var(--text-dim);text-align:center;padding:18px">还没有运行记录</td></tr>`;
    const badge = { ok: '<span class="badge ok">成功</span>', partial: '<span class="badge warn">部分</span>',
      error: '<span class="badge warn">失败</span>', skipped: '<span class="badge">跳过</span>' };
    return logs.map((l) => `<tr>
      <td class="nowrap">${esc((l.finished_at || l.started_at || '').slice(5, 16))}</td>
      <td>${esc(l.sub_name)}</td>
      <td class="nowrap">${l.trigger === 'manual' ? '手动' : '定时'}</td>
      <td class="nowrap">${badge[l.status] || esc(l.status)}</td>
      <td class="nowrap">+${l.created} / 共 ${l.found} 篇${l.skipped ? `（已存在 ${l.skipped}）` : ''}</td>
      <td style="color:var(--text-dim);font-size:12px">${esc((l.message || '').slice(0, 80))}</td>
    </tr>`).join('');
  }

  function renderSubsTable() {
    return `<div class="stat-card" style="margin-bottom:14px">
      <div class="auto-head" style="margin-bottom:10px">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600">订阅规则</div>
        <span class="spacer"></span>
        <span class="hint" style="margin:0">勾选左侧方框可单独启停某条规则</span>
      </div>
      <div class="fd-table-wrap" style="border-radius:var(--radius);border:1px solid var(--line)">
        <table class="fd-table">
          <thead><tr>
            <th style="width:34px"></th><th>名称</th><th class="nowrap">来源</th><th class="nowrap">类型</th>
            <th class="nowrap">机构</th><th class="nowrap">频率</th><th class="nowrap">最近运行</th>
            <th class="nowrap">累计入库</th><th class="nowrap">操作</th>
          </tr></thead>
          <tbody id="sub-rows">${subRowsHtml()}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderLogsCard() {
    return `<div class="stat-card" style="margin-bottom:14px">
      <div class="k" style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:10px">运行日志</div>
      <div class="fd-table-wrap" style="border-radius:var(--radius);border:1px solid var(--line)">
        <table class="fd-table">
          <thead><tr><th class="nowrap">时间</th><th>订阅</th><th class="nowrap">触发</th>
            <th class="nowrap">结果</th><th class="nowrap">入库</th><th>说明</th></tr></thead>
          <tbody id="log-rows">${logRowsHtml()}</tbody>
        </table>
      </div>
    </div>`;
  }

  function renderFeeds() {
    const f = feedsState.form;
    const src = currentSource();
    const types = src.types || [{ key: 'stock', label: '个股研报' }];
    if (!types.some((t) => t.key === f.type)) f.type = types[0]?.key || 'stock';
    const typeOptions = types.map((t) => `<option value="${esc(t.key)}" ${f.type === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
    const isSina = src.key === 'sina';

    $('#page').innerHTML = `<div class="page-inner">
      <div class="page-head"><h1>研报抓取</h1><p>订阅式自动获取公开研报，也可以手动检索指定条件</p></div>

      <div class="notice"><b>边界说明</b><span>${esc(feedsState.disclaimer || '仅抓取公开可访问的内容。')}
        自动抓取默认关闭，开启后才会联网；请求均已限流，请勿用于批量囤积或二次分发。</span></div>

      ${renderAutoPanel()}
      ${renderContentFixPanel()}
      ${renderBackfillPanel()}
      ${renderSubsTable()}
      ${renderLogsCard()}

      <details class="fold" id="fd-fold">
        <summary>手动检索（临时找特定机构 / 关键词，不入订阅）</summary>
        <div class="fold-body">
          ${feedsState.error ? `<div class="notice warn"><b>来源异常</b><span>${esc(feedsState.error)}</span></div>` : ''}
          <div class="stat-card" style="margin-bottom:14px">
            <div class="field-row-3">
              <div class="field"><label>数据来源</label>
                <select id="fd-source">${feedsState.sources.map((s) => `<option value="${esc(s.key)}" ${s.key === f.source ? 'selected' : ''}>${esc(s.label)}</option>`).join('') || '<option value="eastmoney">东方财富 · 研报中心</option>'}</select>
                <div class="hint">${esc(src.note || '')}</div></div>
              <div class="field"><label>研报类型</label><select id="fd-type">${typeOptions}</select>
                <div class="hint">${esc(src.coverage || '')}</div></div>
              <div class="field"><label>机构（券商，共 ${(src.orgs || []).length} 家）</label><select id="fd-org">${orgOptions(f.org_code)}</select>
                <div class="hint"><button class="link" id="fd-refresh-orgs" style="color:var(--accent)">刷新机构列表</button>${isSina ? ' · 机构表来自来源站点，若找不到新合并券商，可在关键词里直接填简称' : ''}</div></div>
            </div>
            <div class="field-row-3">
              <div class="field"><label>时间范围</label>
                <select id="fd-days">${[[7, '近 7 天'], [30, '近 30 天'], [90, '近 90 天'], [180, '近 180 天'], [365, '近 1 年']]
                  .map(([v, l]) => `<option value="${v}" ${Number(f.days) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
                ${isSina ? '<div class="hint">新浪按发布时间倒序返回，本工具会多翻几页再按日期过滤。</div>' : ''}</div>
              <div class="field"><label>股票代码（可选${isSina ? '，该来源不支持' : ''}）</label><input id="fd-code" value="${esc(f.stock_code)}" placeholder="600519 / 300308" ${isSina ? 'disabled' : ''}></div>
              <div class="field"><label>关键词（可选）</label><input id="fd-keyword" value="${esc(f.keyword)}" placeholder="标题、机构、分析师"></div>
            </div>
            <div class="field-row-3">
              <div class="field"><label>每页条数</label>
                <select id="fd-size">${[10, 20, 50].map((v) => `<option value="${v}" ${Number(f.page_size) === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
              <div class="field"><label>导入选项</label>
                <label class="switch"><input type="checkbox" id="fd-content" ${f.fetch_content ? 'checked' : ''}> 同时抓取公开正文</label>
                <div class="hint">关闭则只保存标题等元数据。</div></div>
              <div class="field"><label>&nbsp;</label>
                <button class="btn primary" id="fd-search" style="width:100%">搜索公开研报</button></div>
            </div>
          </div>
          <div id="fd-result"></div>
        </div>
      </details>
    </div>`;

    // 自动抓取面板
    $('#af-toggle').addEventListener('change', async (e) => {
      const on = e.target.checked;
      try {
        const res = await api('/api/autofetch/settings', { method: 'PUT', body: { enabled: on } });
        feedsState.auto = res.status;
        refreshAutoStatus();
        toast(on ? '已开启自动获取，正在抓第一轮…' : '已暂停自动获取', 'ok');
        if (on) setTimeout(pollAutoOnce, 4000);
      } catch (err) { toast(`设置失败：${err.message}`, 'err'); e.target.checked = !on; }
    });
    $('#af-limit').addEventListener('change', async (e) => {
      try {
        const res = await api('/api/autofetch/settings', { method: 'PUT', body: { daily_limit: e.target.value } });
        feedsState.auto = res.status;
        refreshAutoStatus();
        toast('已保存每日上限', 'ok');
      } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
    });
    $('#af-run').addEventListener('click', async () => {
      const btn = $('#af-run');
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 抓取中';
      try {
        const res = await api('/api/autofetch/run?force=1', { method: 'POST' });
        const created = res.created || 0;
        const detail = (res.results || []).map((r) => `${r.name}：+${r.created}`).join('，');
        toast(res.results?.length ? `本轮入库 ${created} 篇（${detail}）` : (res.message || '没有启用的订阅'), created ? 'ok' : '');
        await Promise.all([loadAuto(), loadList(), loadStats(), loadFacets()]);
      } catch (err) {
        toast(err.message.includes('已有抓取任务') ? err.message : `抓取失败：${err.message}`, err.message.includes('已有抓取任务') ? '' : 'err');
      } finally {
        btn.disabled = false; btn.textContent = '立即抓取';
        renderFeeds();
      }
    });
    $('#af-new').addEventListener('click', () => openSubModal(null));

    bindSubTable();
    bindContentFix();
    bindBackfill();
    bindFeedForm();
    renderFeedResults();
    startAutoPoll();
  }

  function bindSubTable() {
    const box = $('#sub-rows');
    if (box) {
      $$('[data-sub-toggle]', box).forEach((cb) => cb.addEventListener('change', async () => {
        try {
          await api(`/api/subscriptions/${cb.dataset.subToggle}`, { method: 'PATCH', body: { enabled: cb.checked } });
          await loadAuto();
          renderSubsOnly();
        } catch (e) { toast(`修改失败：${e.message}`, 'err'); cb.checked = !cb.checked; }
      }));
      $$('[data-sub-run]', box).forEach((b) => b.addEventListener('click', () => runSubOnce(Number(b.dataset.subRun), b)));
      $$('[data-sub-edit]', box).forEach((b) => b.addEventListener('click', () => openSubModal(Number(b.dataset.subEdit))));
      $$('[data-sub-del]', box).forEach((b) => b.addEventListener('click', async () => {
        const sub = (feedsState.subs || []).find((s) => s.id === Number(b.dataset.subDel));
        const yes = await confirmModal('删除订阅', `确定删除订阅「${sub ? sub.name : ''}」吗？已入库的研报不受影响。`);
        if (!yes) return;
        try {
          await api(`/api/subscriptions/${b.dataset.subDel}`, { method: 'DELETE' });
          await loadAuto();
          renderSubsOnly();
          toast('已删除订阅', 'ok');
        } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
      }));
    }
  }

  async function runSubOnce(sid, btn) {
    const original = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
    try {
      const res = await api(`/api/subscriptions/${sid}/run`, { method: 'POST' });
      const r = (res.results || [])[0] || {};
      toast(`「${r.name || ''}」新增 ${r.created || 0} 篇${r.message ? `（${r.message.slice(0, 40)}）` : ''}`, r.created ? 'ok' : '');
      await Promise.all([loadAuto(), loadList(), loadStats(), loadFacets()]);
    } catch (e) {
      toast(e.message.includes('已有抓取任务') ? e.message : `抓取失败：${e.message}`, e.message.includes('已有抓取任务') ? '' : 'err');
    } finally {
      btn.disabled = false; btn.innerHTML = original;
      renderSubsOnly();
    }
  }

  function refreshAutoStatus() {
    const el = $('#auto-status');
    if (el) el.innerHTML = autoStatusLine();
    const toggle = $('#af-toggle');
    if (toggle && feedsState.auto) toggle.checked = !!feedsState.auto.enabled;
    const limit = $('#af-limit');
    if (limit && feedsState.auto && document.activeElement !== limit) limit.value = feedsState.auto.daily_limit;
  }

  function renderSubsOnly() {
    const box = $('#sub-rows');
    if (box) { box.innerHTML = subRowsHtml(); bindSubTable(); }
    const logs = $('#log-rows');
    if (logs) logs.innerHTML = logRowsHtml();
    refreshAutoStatus();
  }

  async function pollAutoOnce() {
    await Promise.all([loadAuto(), loadBackfillStatus()]);
    if (state.view !== 'feeds') return;
    renderSubsOnly();
    const box = $('#bf-progress');
    if (box) box.innerHTML = bfProgressHtml();
    const running = feedsState.bf && feedsState.bf.running;
    if (running && !feedsState.bfFast) { feedsState.bfFast = true; startAutoPoll(3000); }
    if (!running && feedsState.bfFast) { feedsState.bfFast = false; startAutoPoll(8000); }
  }

  function startAutoPoll(interval = 8000) {
    stopAutoPoll();
    feedsState.pollTimer = setInterval(() => {
      if (state.view !== 'feeds') { stopAutoPoll(); return; }
      pollAutoOnce();
    }, interval);
  }

  function stopAutoPoll() {
    if (feedsState.pollTimer) { clearInterval(feedsState.pollTimer); feedsState.pollTimer = null; }
  }

  async function loadThemes() {
    if (feedsState.themes.length) return;
    try {
      const data = await api('/api/themes');
      feedsState.themes = data.themes || [];
      const preset = feedsState.themes.find((t) => t.key === feedsState.bfTheme) || feedsState.themes[0];
      if (preset && !feedsState.bfKeywords) {
        feedsState.bfTheme = preset.key;
        feedsState.bfKeywords = preset.keywords.join('、');
      }
    } catch (e) { /* 忽略 */ }
  }

  async function loadAuto() {
    try {
      const data = await api('/api/autofetch/status?logs=20');
      feedsState.auto = data.status;
      feedsState.subs = data.subscriptions || [];
      feedsState.logs = data.logs || [];
    } catch (e) { /* 忽略轮询错误 */ }
  }

  function openSubModal(sid) {
    const editing = sid ? (feedsState.subs || []).find((s) => s.id === sid) : null;
    const s = editing || { source: 'eastmoney', type: 'stock', org_code: '', keyword: '', interval_minutes: 60,
      max_per_run: 5, lookback_days: 7, fetch_content: true, enabled: true, name: '' };
    const sourceOptions = (feedsState.sources || []).map((x) => `<option value="${esc(x.key)}" ${x.key === s.source ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
    const typeOpts = (sel) => {
      const st = feedsState.sources.find((x) => x.key === sel) || {};
      return ((st.types) || []).map((t) => `<option value="${esc(t.key)}" ${t.key === s.type ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
    };
    const orgOpts = (sel, current) => {
      const st = feedsState.sources.find((x) => x.key === sel) || {};
      const orgs = st.orgs || [];
      return `<option value="">全部机构（共 ${orgs.length} 家）</option>` + orgs.map((o) =>
        `<option value="${esc(o.code)}" ${o.code === current ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    };

    openModal({
      title: editing ? '编辑订阅' : '新建订阅',
      bodyHtml: `
        <div class="field"><label>订阅名称</label><input id="sub-name" value="${esc(s.name)}" placeholder="留空自动生成，例如「中信建投 · 个股研报」"></div>
        <div class="field-row-3">
          <div class="field"><label>来源</label><select id="sub-source">${sourceOptions}</select></div>
          <div class="field"><label>研报类型</label><select id="sub-type">${typeOpts(s.source)}</select></div>
          <div class="field"><label>机构</label><select id="sub-org">${orgOpts(s.source, s.org_code)}</select></div>
        </div>
        <div class="field"><label>关键词（可选，标题 / 机构 / 分析师内匹配）</label><input id="sub-keyword" value="${esc(s.keyword)}" placeholder="例如 半导体、AI算力"></div>
        <div class="field-row-3">
          <div class="field"><label>抓取频率</label><select id="sub-interval">${SUB_INTERVALS.map(([v, l]) =>
            `<option value="${v}" ${Number(s.interval_minutes) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>每次最多入库</label><select id="sub-max">${[1, 2, 3, 5, 8, 10, 15, 20].map((v) =>
            `<option value="${v}" ${Number(s.max_per_run) === v ? 'selected' : ''}>${v} 篇</option>`).join('')}</select></div>
          <div class="field"><label>回看天数</label><select id="sub-lookback">${[1, 3, 7, 14, 30].map((v) =>
            `<option value="${v}" ${Number(s.lookback_days) === v ? 'selected' : ''}>近 ${v} 天</option>`).join('')}</select></div>
        </div>
        <div class="field-row">
          <div class="field"><label>正文</label>
            <label class="switch"><input type="checkbox" id="sub-content" ${s.fetch_content ? 'checked' : ''}> 同时抓取公开正文</label>
            <div class="hint">关闭只存元数据，速度快很多。</div></div>
          <div class="field"><label>状态</label>
            <label class="switch"><input type="checkbox" id="sub-enabled" ${s.enabled ? 'checked' : ''}> 启用这条订阅</label>
            <div class="hint">总开关关闭时全部不抓取。</div></div>
        </div>`,
      footHtml: `<button class="btn" data-close>取消</button>
        <button class="btn primary" id="sub-save">${editing ? '保存' : '创建'}</button>`,
      onMount(root) {
        const syncSelects = () => {
          const key = root.querySelector('#sub-source').value;
          const st = feedsState.sources.find((x) => x.key === key) || {};
          root.querySelector('#sub-type').innerHTML = ((st.types) || []).map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('');
          root.querySelector('#sub-org').innerHTML = orgOpts(key, '');
        };
        root.querySelector('#sub-source').addEventListener('change', syncSelects);
        root.querySelector('#sub-save').addEventListener('click', async () => {
          const pick = (id) => root.querySelector(id)?.value || '';
          const payload = {
            name: pick('#sub-name'),
            source: pick('#sub-source'),
            type: pick('#sub-type'),
            org_code: pick('#sub-org'),
            org_name: root.querySelector('#sub-org').selectedOptions[0]?.textContent?.trim() || '',
            keyword: pick('#sub-keyword'),
            interval_minutes: Number(pick('#sub-interval')),
            max_per_run: Number(pick('#sub-max')),
            lookback_days: Number(pick('#sub-lookback')),
            fetch_content: root.querySelector('#sub-content').checked,
            enabled: root.querySelector('#sub-enabled').checked,
          };
          try {
            if (editing) await api(`/api/subscriptions/${editing.id}`, { method: 'PATCH', body: payload });
            else await api('/api/subscriptions', { method: 'POST', body: payload });
            closeModal();
            await loadAuto();
            renderSubsOnly();
            toast(editing ? '订阅已保存' : '订阅已创建', 'ok');
          } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
        });
      },
    });
  }

  function bindFeedForm() {
    $('#fd-search').addEventListener('click', () => runFeedSearch(1));
    $('#fd-source').addEventListener('change', (e) => {
      collectFeedForm();
      feedsState.form.source = e.target.value;
      feedsState.form.org_code = '';
      feedsState.meta = null;
      feedsState.selected = new Set();
      feedsState.result = null;
      renderFeeds();
    });
    $('#fd-refresh-orgs').addEventListener('click', async (ev) => {
      ev.preventDefault();
      collectFeedForm();
      await loadFeedSources(true);
      renderFeeds();
      $('#fd-fold').open = true;
      toast('机构列表已刷新', 'ok');
    });
    ['#fd-keyword', '#fd-code'].forEach((sel) => {
      $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') runFeedSearch(1); });
    });
  }

  function collectFeedForm() {
    const f = feedsState.form;
    f.source = $('#fd-source')?.value || 'eastmoney';
    f.type = $('#fd-type')?.value || 'stock';
    f.org_code = $('#fd-org')?.value || '';
    f.days = Number($('#fd-days')?.value || 30);
    f.stock_code = ($('#fd-code')?.value || '').trim();
    f.keyword = ($('#fd-keyword')?.value || '').trim();
    f.page_size = Number($('#fd-size')?.value || 20);
    f.fetch_content = !!$('#fd-content')?.checked;
  }

  function feedQuery(page) {
    const f = feedsState.form;
    return new URLSearchParams({
      source: f.source, type: f.type, org_code: f.org_code, days: String(f.days),
      keyword: f.keyword, stock_code: f.stock_code,
      page: String(page || f.page), page_size: String(f.page_size),
    });
  }

  async function runFeedSearch(page = 1) {
    collectFeedForm();
    feedsState.form.page = page;
    feedsState.busy = true;
    feedsState.meta = null;
    feedsState.selected = new Set();
    renderFeedResults();
    try {
      feedsState.meta = await api(`/api/feeds/search?${feedQuery(page)}`);
      feedsState.error = '';
    } catch (e) {
      feedsState.meta = null;
      feedsState.error = e.message;
      toast(`抓取失败：${e.message}`, 'err');
    } finally {
      feedsState.busy = false;
    }
    renderFeedResults();
  }

  async function importSelected() {
    const f = feedsState.form;
    const picked = (feedsState.meta?.items || []).filter((i) => feedsState.selected.has(i.id));
    if (!picked.length) { toast('请先勾选要导入的研报', 'err'); return; }
    if (picked.length > feedsState.maxImport) {
      toast(`一次最多导入 ${feedsState.maxImport} 篇，当前选了 ${picked.length} 篇`, 'err');
      return;
    }
    feedsState.busy = true;
    renderFeedResults();
    try {
      const res = await api('/api/feeds/import', {
        method: 'POST',
        body: { source: f.source, items: picked, fetch_content: f.fetch_content },
      });
      feedsState.result = res;
      feedsState.lastWithContent = res.with_content || 0;
      feedsState.selected = new Set();
      toast(`已入库 ${res.created.length} 篇`, 'ok');
      await Promise.all([loadList(), loadStats(), loadFacets()]);
      feedsState.meta = await api(`/api/feeds/search?${feedQuery(f.page)}`);
    } catch (e) {
      toast(`导入失败：${e.message}`, 'err');
    } finally {
      feedsState.busy = false;
    }
    renderFeedResults();
  }

  /* ---------------------------------------------------------- 批量删除 */
  const BATCH_SOURCE_LABEL = {
    feed: '手动抓取', auto: '自动抓取', backfill: '批量回填', pdf: 'PDF 导入',
    file: '文件导入', text: '手动新建',
  };
  const BATCH_STATUS_LABEL = { unread: '未读', reading: '在读', read: '已读' };
  const BATCH_STATUS_CHIPS = [['', '不限'], ['read', '已读'], ['reading', '在读'], ['unread', '未读']];
  const BATCH_TIME_CHIPS = [['', '不限'], ['7', '7 天前'], ['30', '30 天前'], ['90', '90 天前'], ['180', '180 天前'], ['custom', '自定义']];

  function isoDaysAgo(days) {
    return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  }

  function openBatchDeleteModal() {
    // 弹窗内的临时状态
    const st = { status: '', days: '', field: 'report_date', date: '', scope: '', starred: false };

    const chipRow = (id, options, key) => `<div class="bd-chips" id="${id}">${options.map(([val, label]) =>
      `<button type="button" class="bd-chip${String(st[key]) === String(val) ? ' is-on' : ''}" data-val="${esc(val)}">
         <i class="bd-dot"></i>${esc(label)}</button>`).join('')}</div>`;

    openModal({
      modalClass: 'bd-modal',
      headerHtml: `<div class="bd-head">
          <div class="bd-head-ico">🗑</div>
          <div class="bd-head-text">
            <h2>批量删除研报</h2>
            <p>按阅读状态或时间清理，删除前可以逐个确认要删的内容</p>
          </div>
        </div>`,
      bodyHtml: `
        <div class="bd-cond">
          <div class="bd-row">
            <div class="bd-label">阅读状态</div>
            <div class="bd-ctl">${chipRow('bd-status-chips', BATCH_STATUS_CHIPS, 'status')}</div>
          </div>
          <div class="bd-row">
            <div class="bd-label">时间</div>
            <div class="bd-ctl">${chipRow('bd-time-chips', BATCH_TIME_CHIPS, 'days')}</div>
          </div>
          <div class="bd-row">
            <div class="bd-label">判断依据</div>
            <div class="bd-ctl">
              <select id="bd-field" class="bd-mini" title="按哪个日期判断">
                <option value="report_date">报告日期</option>
                <option value="created_at">入库时间</option>
              </select>
              <input type="date" id="bd-date" class="bd-mini" style="display:none" title="早于该日期">
              <span class="bd-hint-inline">早于所选时间</span>
            </div>
          </div>
          <div class="bd-row">
            <div class="bd-label">删除范围</div>
            <div class="bd-ctl">
              <select id="bd-scope" class="bd-mini">
                <option value="">全部研报</option>
                <option value="fetched">仅抓取入库的</option>
                <option value="manual">仅手动新建 / 导入的</option>
              </select>
              <label class="switch bd-star"><input type="checkbox" id="bd-starred"> 连同星标研报一起删除</label>
            </div>
          </div>
        </div>
        <div class="bd-preview" id="bd-preview"></div>`,
      footHtml: `<span class="bd-foot-hint"><i>⚠</i> 删除会同时移除这些研报的高亮与笔记，无法恢复</span>
        <button class="btn" data-close>取消</button>
        <button class="btn danger-solid" id="bd-run" disabled>确认删除</button>`,
      onMount(root) {
        const run = root.querySelector('#bd-run');
        const box = root.querySelector('#bd-preview');
        const dateInput = root.querySelector('#bd-date');
        let timer = null;

        const buildFilter = () => {
          const filter = { scope: st.scope };
          if (st.status) filter.read_status = st.status;
          const before = st.days === 'custom' ? st.date : (st.days ? isoDaysAgo(Number(st.days)) : '');
          if (before) { filter.date_field = st.field; filter.before = before; }
          return filter;
        };

        const activeConditions = () => !!st.status || !!(st.days === 'custom' ? st.date : st.days);

        const paint = () => {
          root.querySelectorAll('#bd-status-chips .bd-chip').forEach((b) =>
            b.classList.toggle('is-on', b.dataset.val === st.status));
          root.querySelectorAll('#bd-time-chips .bd-chip').forEach((b) =>
            b.classList.toggle('is-on', b.dataset.val === st.days));
          dateInput.style.display = st.days === 'custom' ? '' : 'none';
        };

        const renderPreview = (res, err) => {
          if (err) {
            box.className = 'bd-preview is-empty';
            box.innerHTML = `<div class="bd-empty"><span>⚠</span>统计失败：${esc(err)}</div>`;
            run.disabled = true; run.textContent = '确认删除';
            return;
          }
          if (!res || !res.count) {
            box.className = 'bd-preview is-empty';
            box.innerHTML = `<div class="bd-empty"><span>🔍</span>${
              activeConditions() ? '当前条件没有匹配到研报' : '选择上面的条件后，这里会列出将要删除的内容'}</div>`;
            run.disabled = true; run.textContent = '确认删除';
            return;
          }
          const bd = res.breakdown || {};
          const stat = (arr) => (arr || []).map((x) =>
            `<span class="bd-stat">${esc(BATCH_SOURCE_LABEL[x.name] || BATCH_STATUS_LABEL[x.name] || x.name)}<b>${x.count}</b></span>`).join('');
          const samples = (res.samples || []).map((s) =>
            `<li><span class="bd-s-title">${esc(s.title)}</span><span class="bd-s-meta">${esc(s.org || '')}${s.report_date ? ' · ' + esc(s.report_date) : ''}</span></li>`).join('');
          box.className = 'bd-preview is-danger';
          box.innerHTML = `
            <div class="bd-total">
              <b>${res.count}</b><span>篇研报将被永久删除</span>
            </div>
            <div class="bd-stats">${stat(bd.by_source)}${stat(bd.by_status)}</div>
            ${samples ? `<ul class="bd-samples">${samples}${res.count > 6
              ? `<li class="bd-more">… 另有 ${res.count - 6} 篇</li>` : ''}</ul>` : ''}`;
          run.disabled = false;
          run.textContent = `确认删除 ${res.count} 篇`;
        };

        const refresh = async () => {
          if (!activeConditions()) {
            box.className = 'bd-preview is-empty';
            box.innerHTML = `<div class="bd-empty"><span>🔍</span>选择上面的条件后，这里会列出将要删除的内容</div>`;
            run.disabled = true; run.textContent = '确认删除';
            return;
          }
          try {
            const res = await api('/api/reports/batch-delete', {
              method: 'POST', body: { filter: buildFilter(), preview: true, include_starred: st.starred },
            });
            renderPreview(res, null);
          } catch (e) { renderPreview(null, e.message); }
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 180); };

        root.querySelector('#bd-status-chips').addEventListener('click', (e) => {
          const chip = e.target.closest('.bd-chip'); if (!chip) return;
          st.status = chip.dataset.val; paint(); schedule();
        });
        root.querySelector('#bd-time-chips').addEventListener('click', (e) => {
          const chip = e.target.closest('.bd-chip'); if (!chip) return;
          st.days = chip.dataset.val; paint();
          if (st.days === 'custom' && !st.date) { dateInput.focus(); }
          schedule();
        });
        root.querySelector('#bd-field').addEventListener('change', (e) => { st.field = e.target.value; schedule(); });
        dateInput.addEventListener('change', (e) => { st.date = e.target.value; schedule(); });
        root.querySelector('#bd-scope').addEventListener('change', (e) => { st.scope = e.target.value; schedule(); });
        root.querySelector('#bd-starred').addEventListener('change', (e) => { st.starred = e.target.checked; schedule(); });

        run.addEventListener('click', async () => {
          const filter = buildFilter();
          const pre = await api('/api/reports/batch-delete', {
            method: 'POST', body: { filter, preview: true, include_starred: st.starred },
          }).catch(() => null);
          if (!pre || !pre.count) return;
          const yes = await confirmModal('确认删除',
            `将永久删除 ${pre.count} 篇研报，连同它们的高亮与笔记，无法恢复。确定继续吗？`);
          if (!yes) return;
          run.disabled = true; run.textContent = '删除中…';
          try {
            const done = await api('/api/reports/batch-delete', {
              method: 'POST', body: { filter, preview: false, include_starred: st.starred },
            });
            closeModal();
            toast(`已删除 ${done.deleted} 篇研报`, 'ok');
            state.page = 1;
            await Promise.all([loadList(), loadStats(), loadFacets()]);
            if (state.currentId) {
              const still = await api(`/api/reports/${state.currentId}`).catch(() => null);
              if (!still) { state.current = null; state.currentId = null; renderReader(); }
            }
          } catch (e) {
            toast(`删除失败：${e.message}`, 'err');
            run.disabled = false; run.textContent = '确认删除';
          }
        });

        paint();
        refresh();
      },
    });
  }

  /* ---------------------------------------------------------- 看板 */
  function bars(items, total) {
    if (!items || !items.length) return '<div class="empty-hint">暂无数据</div>';
    const max = Math.max(...items.map((i) => i.count), 1);
    return items.map((i) => `<div class="bar-row">
      <span class="name" title="${esc(i.name)}">${esc(i.name)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(i.count / max) * 100}%"></span></span>
      <span class="num">${i.count}</span>
    </div>`).join('');
  }

  function renderDashboard() {
    const s = state.stats;
    if (!s) return;
    const months = s.by_month || [];
    const maxMonth = Math.max(...months.map((m) => m.count), 1);
    $('#page').innerHTML = `<div class="page-inner">
      <div class="page-head"><h1>数据看板</h1><p>你的研报资产、覆盖领域与整理进度</p></div>

      <div class="stat-grid">
        <div class="stat-card"><div class="k">研报总数</div><div class="v">${s.total}</div><div class="s">星标 ${s.starred} 篇</div></div>
        <div class="stat-card"><div class="k">累计字数</div><div class="v">${(s.words / 10000).toFixed(1)}<span style="font-size:14px"> 万</span></div><div class="s">平均 ${s.total ? Math.round(s.words / s.total) : 0} 字/篇</div></div>
        <div class="stat-card"><div class="k">已 AI 整理</div><div class="v">${s.ai_ready}</div><div class="s">${s.total ? Math.round((s.ai_ready / s.total) * 100) : 0}% 覆盖率</div></div>
        <div class="stat-card"><div class="k">高亮 / 笔记</div><div class="v">${s.highlights} <span style="font-size:16px;color:var(--text-dim)">/</span> ${s.notes}</div><div class="s">阅读沉淀</div></div>
      </div>

      <div class="grid-2">
        <div class="stat-card"><div class="k" style="margin-bottom:10px">行业分布 Top 12</div>${bars(s.industries, s.total)}</div>
        <div class="stat-card"><div class="k" style="margin-bottom:10px">机构分布 Top 12</div>${bars(s.orgs, s.total)}</div>
      </div>

      <div class="grid-2" style="margin-top:14px">
        <div class="stat-card"><div class="k" style="margin-bottom:10px">评级分布</div>${bars(s.ratings, s.total)}</div>
        <div class="stat-card"><div class="k" style="margin-bottom:10px">阅读状态</div>
          ${bars([
            { name: '未读', count: s.status.unread },
            { name: '在读', count: s.status.reading },
            { name: '已读', count: s.status.read },
          ], s.total)}
          <div class="k" style="margin:14px 0 10px">最近 12 个月入库</div>
          <div class="heat">${months.map((m) => `<div class="col" title="${m.month}：${m.count} 篇">
            <div class="bar" style="height:${Math.max(6, (m.count / maxMonth) * 64)}px"></div>
            <span class="lb">${esc(m.month.slice(5))}</span></div>`).join('') || '<div class="empty-hint">暂无数据</div>'}</div>
        </div>
      </div>

      <div class="grid-2" style="margin-top:14px">
        <div class="stat-card"><div class="k" style="margin-bottom:12px">标签云</div>
          <div class="tag-cloud">${(s.tags || []).map((t) =>
            `<button class="facet" data-facet="tag" data-value="${esc(t.name)}">${esc(t.name)}<b> ${t.count}</b></button>`).join('') || '<div class="empty-hint">暂无标签</div>'}</div>
        </div>
        <div class="stat-card"><div class="k" style="margin-bottom:8px">最近入库</div>
          <ul class="recent-list">${(s.recent || []).map((r) =>
            `<li data-open="${r.id}"><span>${esc(r.title)}</span><time>${esc(fmtDate(r.created_at))}</time></li>`).join('') || '<div class="empty-hint">暂无数据</div>'}</ul>
        </div>
      </div>
    </div>`;
  }

  /* ---------------------------------------------------------- 设置 */
  async function renderSettings() {
    let s = state.settings;
    try { s = state.settings = await api('/api/settings'); } catch (e) { /* 忽略 */ }
    $('#page').innerHTML = `<div class="page-inner" style="max-width:760px">
      <div class="page-head"><h1>设置</h1><p>AI 能力与数据管理</p></div>

      <div class="stat-card" style="margin-bottom:16px">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:12px">AI 模型配置</div>
        <div class="field"><label>API Base URL</label>
          <input id="s-base" value="${esc(s.ai_base_url || '')}" placeholder="https://api.deepseek.com/v1">
          <div class="hint">任何兼容 OpenAI Chat Completions 的服务都可以：DeepSeek、通义千问、Kimi、智谱、OpenAI、本地 Ollama 等。</div></div>
        <div class="field"><label>API Key</label>
          <input id="s-key" type="password" placeholder="${s.ai_configured ? `已保存：${esc(s.ai_api_key_masked)}（留空则不修改）` : 'sk-...'}">
          <div class="hint">仅保存在本机 data/research.db，不会上传到任何第三方。</div></div>
        <div class="field-row">
          <div class="field"><label>模型名称</label><input id="s-model" value="${esc(s.ai_model || '')}" placeholder="deepseek-chat"></div>
          <div class="field"><label>温度（0-1，越低越稳定）</label><input id="s-temp" value="${esc(s.ai_temperature || '0.3')}"></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn primary" id="s-save">保存配置</button>
          <button class="btn" id="s-test">测试连接</button>
          ${s.ai_configured ? '<button class="btn danger" id="s-clear">清除 Key</button>' : ''}
          <span id="s-result" style="font-size:12.5px;color:var(--text-dim)"></span>
        </div>
      </div>

      <div class="stat-card" style="margin-bottom:16px">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:12px">数据管理</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn" href="${BASE}/api/export?format=md" download>导出全部为 Markdown</a>
          <a class="btn" href="${BASE}/api/export?format=json" download>导出全部为 JSON（含高亮笔记）</a>
        </div>
        <div class="hint" style="margin-top:10px">数据文件：<code>data/research.db</code>；上传的原件保存在 <code>data/files/</code>。直接备份整个 <code>data/</code> 目录即可迁移。</div>
      </div>

      <div class="stat-card">
        <div class="k" style="font-size:13px;color:var(--text);font-weight:600;margin-bottom:12px">快捷键</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font-size:13px;color:var(--text-soft)">
          <kbd>/</kbd><span>聚焦搜索框</span>
          <kbd>j</kbd><span>下一篇研报</span>
          <kbd>k</kbd><span>上一篇研报</span>
          <kbd>s</kbd><span>星标 / 取消星标当前研报</span>
          <kbd>m</kbd><span>标记为已读</span>
          <kbd>1 – 5</kbd><span>切换正文 / 摘要 / 高亮 / 笔记 / 问 AI</span>
          <kbd>Esc</kbd><span>关闭弹窗 / 取消选区</span>
          <kbd>⌘ + Enter</kbd><span>笔记框内保存</span>
        </div>
      </div>
    </div>`;

    $('#s-save').addEventListener('click', async () => {
      try {
        state.settings = await api('/api/settings', {
          method: 'PUT',
          body: {
            ai_base_url: $('#s-base').value.trim(),
            ai_model: $('#s-model').value.trim(),
            ai_temperature: $('#s-temp').value.trim(),
            ai_api_key: $('#s-key').value.trim(),
          },
        });
        toast('配置已保存', 'ok');
        renderSettings();
      } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
    });

    $('#s-test').addEventListener('click', async () => {
      const out = $('#s-result');
      out.textContent = '测试中…';
      try {
        const res = await api('/api/settings/test', {
          method: 'POST',
          body: { settings: { ai_model: $('#s-model').value.trim(), ai_base_url: $('#s-base').value.trim() } },
        });
        out.innerHTML = `<span style="color:var(--ok)">连接正常 · ${esc(res.model)} · 返回「${esc(res.reply)}」</span>`;
      } catch (e) {
        out.innerHTML = `<span style="color:var(--warn)">失败：${esc(e.message)}</span>`;
      }
    });

    const clear = $('#s-clear');
    if (clear) clear.addEventListener('click', async () => {
      await api('/api/settings', { method: 'PUT', body: { clear_api_key: true } });
      toast('已清除 Key', 'ok');
      renderSettings();
    });
  }

  /* ---------------------------------------------------------- 路由 / 事件 */
  function writeHash(hash) {
    if (location.hash === hash) return;
    try { history.replaceState(null, '', hash); } catch (e) { /* 忽略 */ }
  }

  async function applyHash() {
    const parts = (location.hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) return false;
    if (parts[0] === 'dashboard') { setNav('dashboard'); return true; }
    if (parts[0] === 'feeds') {
      // 形如 #/feeds/<type> 或 #/feeds/<source>/<type>；来源表尚未加载，先存下来晚点解析
      feedsState.autoRaw = parts.slice(1);
      setNav('feeds');
      return true;
    }
    if (parts[0] === 'settings') {
      $$('.nav-item').forEach((b) => b.classList.remove('is-active'));
      setView('settings'); return true;
    }
    if (parts[0] === 'report' && parts[1]) {
      const id = Number(parts[1]);
      if (parts[2] && ['doc', 'summary', 'highlights', 'notes', 'qa'].includes(parts[2])) state.tab = parts[2];
      if (id) {
        setView('library');
        $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === 'all'));
        await openReport(id, { silent: true });
      }
      return true;
    }
    if (['all', 'starred', 'unread', 'reading', 'read'].includes(parts[0])) { setNav(parts[0]); return true; }
    return false;
  }

  async function renderFeedsPage() {
    if (!feedsState.loaded) await loadFeedSources();
    if (state.view !== 'feeds') return;
    await Promise.all([loadAuto(), loadBackfillStatus(), loadThemes(), loadMissing()]);
    if (state.view !== 'feeds') return;
    const raw = feedsState.autoRaw || [];
    feedsState.autoRaw = null;
    const keys = (feedsState.sources || []).map((s) => s.key);
    let autoType = '';
    if (raw.length && keys.includes(raw[0])) {
      feedsState.form.source = raw[0];
      feedsState.form.org_code = '';
      autoType = raw[1] || '';
    } else if (raw[0]) {
      autoType = raw[0];
    }
    if (autoType) feedsState.form.type = autoType;
    renderFeeds();
    if (autoType) runFeedSearch(1);
  }

  function setView(view) {
    state.view = view;
    if (view !== 'feeds') stopAutoPoll();
    const app = $('#app');
    app.classList.toggle('view-page', view !== 'library');
    if (view === 'dashboard') renderDashboard();
    if (view === 'settings') renderSettings();
    if (view === 'feeds') renderFeedsPage();
  }

  function setNav(nav) {
    state.nav = nav;
    $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === nav));
    if (nav === 'dashboard') { setView('dashboard'); writeHash('#/dashboard'); return; }
    if (nav === 'feeds') { setView('feeds'); writeHash('#/feeds'); return; }
    state.page = 1;
    setView('library');
    writeHash(`#/${nav}`);
    loadList();
  }

  function bind() {
    $('#nav').addEventListener('click', (e) => {
      const item = e.target.closest('.nav-item');
      if (item) setNav(item.dataset.nav);
    });

    $('#facet-box').addEventListener('click', (e) => {
      const f = e.target.closest('.facet');
      if (!f) return;
      const key = f.dataset.facet;
      state.filters[key] = state.filters[key] === f.dataset.value ? '' : f.dataset.value;
      state.page = 1;
      renderFacets(); loadList();
      if (state.view !== 'library') setView('library');
    });

    $('#active-filters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-clear]');
      if (!b) return;
      state.filters[b.dataset.clear] = '';
      if (b.dataset.clear === 'q') $('#search').value = '';
      state.page = 1;
      renderFacets(); loadList();
    });

    $('#btn-clear-filters').addEventListener('click', () => {
      state.filters = { ...state.filters, q: '', industry: '', org: '', rating: '', tag: '' };
      $('#search').value = '';
      state.page = 1;
      renderFacets(); loadList();
    });

    let searchTimer = null;
    $('#search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      const value = e.target.value;
      searchTimer = setTimeout(() => { state.filters.q = value.trim(); state.page = 1; loadList(); }, 240);
    });

    $('#sort').addEventListener('change', (e) => { state.filters.sort = e.target.value; state.page = 1; loadList(); });
    $('#btn-new').addEventListener('click', openNewModal);
    $('#btn-upload').addEventListener('click', () => $('#file-input').click());
    $('#btn-batch-del').addEventListener('click', openBatchDeleteModal);
    $('#btn-settings').addEventListener('click', () => {
      $$('.nav-item').forEach((b) => b.classList.remove('is-active'));
      setView('settings');
      writeHash('#/settings');
    });
    $('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
    $('#btn-export-md').addEventListener('click', () => { window.location.href = BASE + '/api/export?format=md'; });
    $('#btn-export-json').addEventListener('click', () => { window.location.href = BASE + '/api/export?format=json'; });

    $('#btn-theme').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem('rh-theme', next);
    });

    $('#list').addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) openReport(Number(card.dataset.id));
    });

    $('#page').addEventListener('click', (e) => {
      const facet = e.target.closest('.facet');
      if (facet) {
        state.filters[facet.dataset.facet] = facet.dataset.value;
        setNav('all'); renderFacets(); loadList();
        $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === 'all'));
        return;
      }
      const recent = e.target.closest('[data-open]');
      if (recent) {
        setNav('all');
        $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === 'all'));
        openReport(Number(recent.dataset.open));
      }
    });

    // 阅读区交互
    $('#reader').addEventListener('click', async (e) => {
      const tab = e.target.closest('.tab');
      if (tab) { setTab(tab.dataset.tab); return; }

      const act = e.target.closest('[data-act]');
      if (!act) {
        const mark = e.target.closest('mark.hl');
        if (mark) {
          setTab('highlights');
          const item = $(`.hl-item[data-id="${mark.dataset.id}"]`);
          if (item) { item.scrollIntoView({ block: 'center' }); item.style.outline = '2px solid var(--accent)'; setTimeout(() => { item.style.outline = ''; }, 1200); }
        }
        return;
      }
      const action = act.dataset.act;

      if (action === 'star') {
        await patchReport({ starred: !state.current.starred }, { silent: true });
        loadStats();
      } else if (action === 'edit') { openEditModal(); }
      else if (action === 'ai') { runAI(); }
      else if (action === 'export') { window.location.href = `${BASE}/api/reports/${state.currentId}/export?format=md`; }
      else if (action === 'delete') {
        const ok = await confirmModal('删除研报', `确定删除《${state.current.title}》吗？相关高亮与笔记会一并删除，且不可恢复。`);
        if (!ok) return;
        try {
          await api(`/api/reports/${state.currentId}`, { method: 'DELETE' });
          state.current = null; state.currentId = null;
          renderReader(); toast('已删除', 'ok');
          await Promise.all([loadList(), loadStats(), loadFacets()]);
        } catch (err) { toast(`删除失败：${err.message}`, 'err'); }
      } else if (action === 'hl-add') {
        const text = $('#hl-input').value.trim();
        if (!text) { toast('先输入要摘录的内容', 'err'); return; }
        await addHighlight(text, 'yellow');
        setTab('highlights');
      } else if (action === 'hl-del') {
        await api(`/api/highlights/${act.dataset.id}`, { method: 'DELETE' });
        await refreshCurrent(); toast('已删除', 'ok');
      } else if (action === 'hl-note') {
        const h = (state.current.highlights || []).find((x) => String(x.id) === act.dataset.id);
        const note = await promptModal('批注', '写下你的理解或跟踪点', h ? h.note : '');
        if (note === null) return;
        await api(`/api/highlights/${act.dataset.id}`, { method: 'PATCH', body: { note } });
        await refreshCurrent();
      } else if (action === 'hl-color') {
        const colors = ['yellow', 'green', 'pink', 'blue'];
        const h = (state.current.highlights || []).find((x) => String(x.id) === act.dataset.id);
        const next = colors[(colors.indexOf(h?.color || 'yellow') + 1) % colors.length];
        await api(`/api/highlights/${act.dataset.id}`, { method: 'PATCH', body: { color: next } });
        await refreshCurrent();
      } else if (action === 'hl-locate') {
        setTab('doc');
        const mark = $(`mark.hl[data-id="${act.dataset.id}"]`);
        if (mark) {
          mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
          mark.classList.add('flash');
          setTimeout(() => mark.classList.remove('flash'), 1200);
        } else { toast('正文中未找到对应的原文片段（可能是手动摘录）', 'err'); }
      } else if (action === 'note-add') {
        const content = $('#note-input').value.trim();
        if (!content) { toast('笔记内容为空', 'err'); return; }
        await api(`/api/reports/${state.currentId}/notes`, { method: 'POST', body: { content } });
        await refreshCurrent(); toast('已添加笔记', 'ok');
      } else if (action === 'note-del') {
        await api(`/api/notes/${act.dataset.id}`, { method: 'DELETE' });
        await refreshCurrent(); toast('已删除', 'ok');
      } else if (action === 'note-edit') {
        const n = (state.current.notes || []).find((x) => String(x.id) === act.dataset.id);
        const content = await promptModal('编辑笔记', '修改笔记内容', n ? n.content : '');
        if (content === null || !content) return;
        await api(`/api/notes/${act.dataset.id}`, { method: 'PATCH', body: { content } });
        await refreshCurrent(); toast('已更新', 'ok');
      } else if (action === 'qa-ask') { askQuestion(); }
    });

    $('#reader').addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-act="status"]');
      if (sel) { await patchReport({ read_status: sel.value }, { silent: true }); loadStats(); }
    });

    $('#reader').addEventListener('keydown', (e) => {
      if (e.target.id === 'note-input' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        $(`[data-act="note-add"]`)?.click();
      }
      if (e.target.id === 'qa-input' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault(); askQuestion();
      }
    });

    // 拖拽导入
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
      dragDepth += 1; $('#drop-hint').classList.add('is-on');
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-hint').classList.remove('is-on'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault(); dragDepth = 0; $('#drop-hint').classList.remove('is-on');
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    });

    // 快捷键
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (e.key === 'Escape') { closeModal(); hideSelToolbar(); return; }
      if (typing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '/') { e.preventDefault(); $('#search').focus(); return; }
      if (!state.reports.length) return;
      const idx = state.reports.findIndex((r) => r.id === state.currentId);
      if (e.key === 'j') { const next = state.reports[Math.min(idx + 1, state.reports.length - 1)] || state.reports[0]; if (next) openReport(next.id); }
      else if (e.key === 'k') { const prev = state.reports[Math.max(idx - 1, 0)] || state.reports[0]; if (prev) openReport(prev.id); }
      else if (e.key === 's' && state.currentId) { patchReport({ starred: !state.current.starred }, { silent: true }); loadStats(); }
      else if (e.key === 'm' && state.currentId) { patchReport({ read_status: 'read' }, { silent: true }); loadStats(); }
      else if (['1', '2', '3', '4', '5'].includes(e.key) && state.currentId) {
        setTab(['doc', 'summary', 'highlights', 'notes', 'qa'][Number(e.key) - 1]);
      }
    });
  }

  /* ---------------------------------------------------------- 启动 */
  async function boot() {
    const saved = localStorage.getItem('rh-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    bind();
    bindPager();
    // 被交易台用 iframe 内嵌时不要再显示「返回交易台」——外层已有完整导航
    const framed = window.self !== window.top;
    if (PARENT_PATH && !framed) {
      const foot = document.querySelector('.rail-foot');
      if (foot) {
        const back = document.createElement('a');
        back.className = 'ghost-btn';
        back.href = PARENT_PATH;
        back.textContent = '← 返回交易台';
        back.style.textDecoration = 'none';
        foot.insertBefore(back, foot.firstChild);
      }
    }
    await Promise.all([loadList(), loadStats(), loadFacets()]);
    renderReader();
    window.addEventListener('hashchange', () => { applyHash(); });
    const handled = await applyHash();
    if (!handled && state.reports[0]) openReport(state.reports[0].id);
  }

  boot();
})();
