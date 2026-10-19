// ===== 行情总览（迁移自 easy-stock 的 MarketOverviewWorkspace） =====
// 数据全部走后端 /api/market/overview/*，字段与 easy-stock 保持一致（snake_case）。
// 依赖：utils.js（formatNumber）、sync.js（authFetch 带登录 token）、header.js（顶部导航）

/* global authFetch */

var MO_state = {
  indexes: [],
  seriesId: null,
  seriesPeriod: 'day',
  industries: [],
  flows: [],
  flowDim: 'industry',
  margins: [],
  billboard: [],
  loaded: { indexes: false, industries: false, flows: false, margins: false, billboard: false }
};

var MO_REF = { indexes: null, industries: null, flows: null, margins: null, billboard: null };

// ==================== 工具 ====================
function MO_esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// 涨跌配色：A 股习惯 红涨绿跌
function MO_tone(v) {
  var n = parseFloat(v);
  if (!isFinite(n) || n === 0) return 'mo-flat';
  return n > 0 ? 'mo-up' : 'mo-down';
}

function MO_sign(v, digits) {
  var n = parseFloat(v);
  if (!isFinite(n)) return '—';
  var d = digits === undefined ? 2 : digits;
  return (n > 0 ? '+' : '') + n.toFixed(d);
}

// 金额：元 → 亿/万
function MO_amount(v) {
  var n = parseFloat(v);
  if (!isFinite(n) || n === 0) return '—';
  var abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return n.toFixed(0);
}

function MO_price(v) {
  var n = parseFloat(v);
  if (!isFinite(n) || n === 0) return '—';
  return n >= 1000 ? n.toFixed(1) : n.toFixed(2);
}

function MO_today() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

function MO_api(path) {
  // authFetch 由 sync.js 提供（自动带 Bearer token）；单测/未加载时退回原生 fetch
  var f = typeof authFetch === 'function' ? authFetch : fetch;
  return f(path, { headers: { Accept: 'application/json' } }).then(function (res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        var err = new Error(body.error || ('HTTP ' + res.status));
        err.code = body.code || null;
        err.status = res.status;
        throw err;
      });
    }
    return res.json();
  });
}

// 模块级提示：不可用（无替代源）时给说明文案，而不是红字报错
function MO_renderNotice(tbody, colspan, text, kind) {
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="mo-td-empty ' +
    (kind === 'warn' ? 'mo-td-warn' : '') + '">' + MO_esc(text) + '</td></tr>';
}

function MO_setUpdated(meta) {
  var el = document.getElementById('moUpdated');
  if (!el) return;
  var ts = meta && meta.fetched_at ? new Date(meta.fetched_at) : new Date();
  var hh = String(ts.getHours()).padStart(2, '0');
  var mm = String(ts.getMinutes()).padStart(2, '0');
  var ss = String(ts.getSeconds()).padStart(2, '0');
  el.textContent = '更新于 ' + hh + ':' + mm + ':' + ss;
}

// 降级提示：任一模块 meta.stale 为真时说清楚用了旧快照；
// meta.reason 是「非故障类说明」（例如当日龙虎榜未发布、自动回退了最近一期）
var MO_staleReasons = [];
function MO_noteMeta(name, meta) {
  if (meta && meta.stale) {
    MO_staleReasons.push(name + '：' + (meta.fallback_reason || '实时数据刷新失败'));
  } else if (meta && meta.reason) {
    MO_staleReasons.push(name + '：' + meta.reason);
  }
  var hint = document.getElementById('moStaleHint');
  if (!hint) return;
  if (MO_staleReasons.length) {
    var isWarn = MO_staleReasons.some(function (r) { return /刷新失败|快照/.test(r); });
    hint.style.display = '';
    hint.className = 'mo-hint' + (isWarn ? ' mo-hint-warn' : '');
    hint.innerHTML = (isWarn ? '⚠️ ' : 'ℹ️ ') +
      MO_staleReasons.map(function (r) { return '· ' + MO_esc(r); }).join('<br>');
  } else {
    hint.style.display = 'none';
  }
}

function MO_renderError(tbody, colspan, err) {
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="mo-td-empty mo-td-error">' +
    '数据加载失败：' + MO_esc(err && err.message ? err.message : err) + '</td></tr>';
}

// ==================== ① 核心指数 ====================
function MO_loadIndexes() {
  var grid = document.getElementById('moIndexGrid');
  var scopeEl = document.getElementById('moIndexScope');
  var scope = scopeEl && scopeEl.checked ? 'global' : 'core';
  grid.innerHTML = '<div class="mo-loading">加载中…</div>';
  MO_staleReasons = [];
  return MO_api('/api/market/overview/indexes?scope=' + scope).then(function (json) {
    MO_state.indexes = json.data || [];
    MO_REF.indexes = json.meta;
    MO_noteMeta('指数行情', json.meta);
    MO_setUpdated(json.meta);
    MO_renderIndexes();
  }).catch(function (e) {
    grid.innerHTML = '<div class="mo-error">指数行情获取失败：' + MO_esc(e.message) + '</div>';
  });
}

function MO_renderIndexes() {
  var grid = document.getElementById('moIndexGrid');
  var list = MO_state.indexes || [];
  if (!list.length) {
    grid.innerHTML = '<div class="mo-empty">暂无指数数据</div>';
    return;
  }
  // 按区域分组
  var groups = {};
  list.forEach(function (idx) {
    var k = idx.region || '其他';
    (groups[k] = groups[k] || []).push(idx);
  });
  var html = '';
  Object.keys(groups).forEach(function (region) {
    html += '<div class="mo-index-group"><div class="mo-group-title">' + MO_esc(region) + '</div><div class="mo-index-row">';
    groups[region].forEach(function (idx) {
      var tone = MO_tone(idx.change_percent);
      var active = idx.id === MO_state.seriesId ? ' mo-index-active' : '';
      html += '<button type="button" class="mo-index-card' + active + '" onclick="MO_showIndexSeries(\'' + MO_esc(idx.id) + '\')" ' +
        'title="' + MO_esc(idx.name) + ' · 点击查看 K 线">' +
        '<div class="mo-index-name">' + MO_esc(idx.name) + '</div>' +
        '<div class="mo-index-price ' + tone + '">' + MO_price(idx.price) + '</div>' +
        '<div class="mo-index-chg ' + tone + '">' + MO_sign(idx.change) + ' / ' + MO_sign(idx.change_percent) + '%</div>' +
        '</button>';
    });
    html += '</div></div>';
  });
  grid.innerHTML = html;
}

function MO_onIndexScopeChange() {
  MO_state.seriesId = null;
  MO_closeSeries();
  MO_loadIndexes();
}

function MO_showIndexSeries(id) {
  MO_state.seriesId = id;
  MO_renderIndexes();
  var box = document.getElementById('moIndexSeries');
  box.style.display = '';
  MO_loadIndexSeries();
}

function MO_closeSeries() {
  MO_state.seriesId = null;
  var box = document.getElementById('moIndexSeries');
  if (box) box.style.display = 'none';
  MO_renderIndexes();
}

function MO_loadIndexSeries() {
  var id = MO_state.seriesId;
  var body = document.getElementById('moSeriesBody');
  var title = document.getElementById('moSeriesTitle');
  var periodEl = document.getElementById('moSeriesPeriod');
  if (!id) return;
  var period = periodEl ? periodEl.value : 'day';
  MO_state.seriesPeriod = period;
  var idx = (MO_state.indexes || []).filter(function (x) { return x.id === id; })[0];
  title.textContent = (idx ? idx.name : id) + ' · ' + ({ day: '日线', week: '周线', month: '月线' }[period] || '日线');
  body.innerHTML = '<div class="mo-loading">加载中…</div>';
  MO_api('/api/market/overview/index-series?id=' + encodeURIComponent(id) + '&period=' + period + '&limit=120')
    .then(function (json) {
      var d = json.data || {};
      var lines = (d.lines || []).slice().reverse(); // 后端时间升序 → 表格显示最新在上
      if (!lines.length) {
        body.innerHTML = '<div class="mo-empty">暂无 K 线数据</div>';
        return;
      }
      var rows = lines.map(function (l) {
        return '<tr><td>' + MO_esc(l.time) + '</td>' +
          '<td>' + MO_price(l.open) + '</td>' +
          '<td>' + MO_price(l.high) + '</td>' +
          '<td>' + MO_price(l.low) + '</td>' +
          '<td class="' + MO_tone(l.change_percent) + '">' + MO_price(l.close) + '</td>' +
          '<td class="' + MO_tone(l.change_percent) + '">' + MO_sign(l.change_percent) + '%</td>' +
          '<td>' + MO_amount(l.amount) + '</td></tr>';
      }).join('');
      body.innerHTML = '<div class="mo-table-wrap"><table class="mo-table mo-series-table">' +
        '<thead><tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>涨跌幅</th><th>成交额</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    })
    .catch(function (e) {
      body.innerHTML = '<div class="mo-error">K 线获取失败：' + MO_esc(e.message) + '</div>';
    });
}

// ==================== ② 行业趋势强度 ====================
function MO_loadIndustries() {
  return MO_api('/api/market/overview/industries?limit=100').then(function (json) {
    MO_state.industries = json.data || [];
    MO_REF.industries = json.meta;
    MO_noteMeta('行业趋势', json.meta);
    MO_renderTable('moIndustryTable', MO_state.industries, MO_industryRow, 8);
  }).catch(function (e) {
    MO_renderNotice(document.querySelector('#moIndustryTable tbody'), 8,
      '行业数据暂时获取失败：' + e.message, 'warn');
  });
}

function MO_industryRow(d) {
  var leader = d.leader_name
    ? MO_esc(d.leader_name) + ' <span class="' + MO_tone(d.leader_change_percent) + '">' + MO_sign(d.leader_change_percent) + '%</span>'
    : '—';
  return '<tr>' +
    '<td class="mo-name">' + MO_esc(d.name) + '</td>' +
    '<td class="' + MO_tone(d.change_percent) + '">' + MO_sign(d.change_percent) + '%</td>' +
    '<td class="' + MO_tone(d.five_day_change_percent) + '">' + MO_sign(d.five_day_change_percent) + '%</td>' +
    '<td class="' + MO_tone(d.twenty_day_change_percent) + '">' + MO_sign(d.twenty_day_change_percent) + '%</td>' +
    '<td><span class="mo-up">' + (d.rising_count || 0) + '</span>/<span class="mo-down">' + (d.falling_count || 0) + '</span></td>' +
    '<td class="' + MO_tone(d.main_net_inflow) + '">' + MO_amount(d.main_net_inflow) + '</td>' +
    '<td>' + leader + '</td>' +
    '<td><span class="mo-score" style="--w:' + Math.max(0, Math.min(100, 50 + (d.score || 0) * 5)) + '%">' + MO_sign(d.score, 2) + '</span></td>' +
    '</tr>';
}

// ==================== ③ 资金流向 ====================
function MO_setFlowDim(dim) {
  MO_state.flowDim = dim;
  var btns = document.querySelectorAll('.mo-seg-btn');
  for (var i = 0; i < btns.length; i += 1) {
    btns[i].classList.toggle('active', btns[i].getAttribute('data-dim') === dim);
  }
  MO_renderTable('moFlowTable', MO_state.flows, MO_flowRow, 8);
}

function MO_loadFlows() {
  return MO_api('/api/market/overview/flows?dimension=' + encodeURIComponent(MO_state.flowDim) + '&sort=net&limit=60')
    .then(function (json) {
      MO_state.flows = json.data || [];
      MO_REF.flows = json.meta;
      MO_noteMeta('资金流向', json.meta);
      MO_renderTable('moFlowTable', MO_state.flows, MO_flowRow, 8);
    }).catch(function (e) {
      var tbody = document.querySelector('#moFlowTable tbody');
      if (e.status === 503 || e.code === 'FLOW_UNAVAILABLE') {
        // 无同口径替代源：明确说"暂不可用"，不显示 0 值假装有数据
        MO_renderNotice(tbody, 8, '资金流向数据暂不可用，稍后自动重试。' + (e.message || ''), 'warn');
      } else {
        MO_renderError(tbody, 8, e);
      }
    });
}

function MO_flowRow(d) {
  var isStock = MO_state.flowDim === 'stock';
  return '<tr>' +
    '<td class="mo-name">' + MO_esc(d.name) + (isStock ? ' <span class="mo-code">' + MO_esc(d.code) + '</span>' : '') + '</td>' +
    '<td>' + (isStock ? MO_price(d.price) : '—') + '</td>' +
    '<td class="' + MO_tone(d.change_percent) + '">' + MO_sign(d.change_percent) + '%</td>' +
    '<td class="' + MO_tone(d.main_net_inflow) + '">' + MO_amount(d.main_net_inflow) + '</td>' +
    '<td class="' + MO_tone(d.main_net_inflow_ratio) + '">' + MO_sign(d.main_net_inflow_ratio) + '%</td>' +
    '<td class="' + MO_tone(d.super_large_net_inflow) + '">' + MO_amount(d.super_large_net_inflow) + '</td>' +
    '<td class="' + MO_tone(d.large_net_inflow) + '">' + MO_amount(d.large_net_inflow) + '</td>' +
    '<td class="' + MO_tone(d.small_net_inflow) + '">' + MO_amount(d.small_net_inflow) + '</td>' +
    '</tr>';
}

// ==================== ④ 两融余额 ====================
function MO_loadMargins() {
  return MO_api('/api/market/overview/margin-balance?limit=60').then(function (json) {
    var points = (json.data || []).slice().reverse(); // 最新在上
    MO_state.margins = points;
    MO_REF.margins = json.meta;
    MO_noteMeta('两融余额', json.meta);
    var tbody = document.querySelector('#moMarginTable tbody');
    if (!points.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="mo-td-empty">暂无两融数据</td></tr>';
      document.getElementById('moMarginSummary').innerHTML = '';
      return;
    }
    var latest = points[0];
    document.getElementById('moMarginSummary').innerHTML =
      '<div class="mo-metric"><span>两融余额</span><b>' + MO_amount(latest.margin_balance) + '</b></div>' +
      '<div class="mo-metric"><span>融资余额</span><b>' + MO_amount(latest.financing_balance) + '</b></div>' +
      '<div class="mo-metric"><span>融券余额</span><b>' + MO_amount(latest.securities_lending_balance) + '</b></div>' +
      '<div class="mo-metric"><span>余额变化</span><b class="' + MO_tone(latest.margin_balance_change) + '">' +
      MO_amount(latest.margin_balance_change) + '</b></div>';
    tbody.innerHTML = points.map(function (p) {
      return '<tr><td>' + MO_esc(p.trade_date) + '</td>' +
        '<td>' + MO_amount(p.margin_balance) + '</td>' +
        '<td>' + MO_amount(p.financing_balance) + '</td>' +
        '<td>' + MO_amount(p.securities_lending_balance) + '</td>' +
        '<td class="' + MO_tone(p.margin_balance_change) + '">' + MO_amount(p.margin_balance_change) + '</td>' +
        '<td class="' + MO_tone(p.financing_net_buy_amount) + '">' + MO_amount(p.financing_net_buy_amount) + '</td></tr>';
    }).join('');
  }).catch(function (e) {
    MO_renderError(document.querySelector('#moMarginTable tbody'), 6, e);
  });
}

// ==================== ⑤ 龙虎榜 ====================
function MO_loadBillboard() {
  var dateEl = document.getElementById('moBillboardDate');
  var date = dateEl && dateEl.value ? dateEl.value : '';
  var url = '/api/market/overview/billboard?limit=100' + (date ? '&trade_date=' + encodeURIComponent(date) : '');
  return MO_api(url).then(function (json) {
    MO_state.billboard = json.data || [];
    MO_REF.billboard = json.meta;
    MO_noteMeta('龙虎榜', json.meta);
    // 用返回数据的实际日期回填输入框，让用户知道看的是哪一天
    // （用户指定的当天还没出榜时，后端会自动回退到最近一期并在 meta.reason 说明）
    if (MO_state.billboard.length && dateEl) {
      dateEl.value = MO_state.billboard[0].trade_date;
    }
    MO_renderTable('moBillboardTable', MO_state.billboard, MO_billboardRow, 7);
  }).catch(function (e) {
    MO_renderError(document.querySelector('#moBillboardTable tbody'), 7, e);
  });
}

function MO_billboardRow(d) {
  return '<tr>' +
    '<td class="mo-name">' + MO_esc(d.name) + ' <span class="mo-code">' + MO_esc(d.symbol) + '</span></td>' +
    '<td>' + MO_price(d.close_price) + '</td>' +
    '<td class="' + MO_tone(d.change_percent) + '">' + MO_sign(d.change_percent) + '%</td>' +
    '<td class="mo-reason" title="' + MO_esc(d.reason) + '">' + MO_esc(d.reason) + '</td>' +
    '<td class="' + MO_tone(d.net_amount) + '">' + MO_amount(d.net_amount) + '</td>' +
    '<td>' + MO_amount(d.buy_amount) + '</td>' +
    '<td>' + MO_amount(d.sell_amount) + '</td>' +
    '</tr>';
}

// ==================== 通用表格渲染 / 排序 / 筛选 ====================
function MO_renderTable(tableId, items, rowFn, colspan) {
  var tbody = document.querySelector('#' + tableId + ' tbody');
  if (!tbody) return;
  if (!items || !items.length) {
    tbody.innerHTML = '<tr><td colspan="' + colspan + '" class="mo-td-empty">暂无数据</td></tr>';
    return;
  }
  tbody.innerHTML = items.map(rowFn).join('');
}

// 点表头排序（数字升/降序切换，文本按 localeCompare）
function MO_sortBy(tableId, key) {
  var table = document.getElementById(tableId);
  if (!table) return;
  var state = table._moSort || { key: null, dir: -1 };
  state.dir = (state.key === key) ? -state.dir : -1;
  state.key = key;
  table._moSort = state;
  var items = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  items.sort(function (a, b) {
    var av = a._moData ? a._moData[key] : null;
    var bv = b._moData ? b._moData[key] : null;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * state.dir;
    return String(av || '').localeCompare(String(bv || ''), 'zh-CN') * state.dir;
  });
  items.forEach(function (tr) { tr.parentNode.appendChild(tr); });
}

// 搜索框：按第一列文本过滤
function MO_filterTable(tableId, keyword) {
  var table = document.getElementById(tableId);
  if (!table) return;
  var kw = String(keyword || '').trim().toLowerCase();
  var rows = table.querySelectorAll('tbody tr');
  for (var i = 0; i < rows.length; i += 1) {
    var first = rows[i].querySelector('td');
    var text = first ? first.textContent.toLowerCase() : '';
    rows[i].style.display = (!kw || text.indexOf(kw) >= 0) ? '' : 'none';
  }
}

// 给可排序表头绑定点击
function MO_bindSorting() {
  var ths = document.querySelectorAll('.mo-sortable');
  for (var i = 0; i < ths.length; i += 1) {
    (function (th) {
      th.addEventListener('click', function () {
        var table = th.closest('table');
        if (table) MO_sortBy(table.id, th.getAttribute('data-sort'));
      });
    })(ths[i]);
  }
}

// ==================== 初始化 / 刷新 ====================
function MO_loadAll(force) {
  MO_staleReasons = [];
  var tasks = [];
  if (force || !MO_state.loaded.indexes) { MO_state.loaded.indexes = true; tasks.push(MO_loadIndexes()); }
  if (force || !MO_state.loaded.industries) { MO_state.loaded.industries = true; tasks.push(MO_loadIndustries()); }
  if (force || !MO_state.loaded.flows) { MO_state.loaded.flows = true; tasks.push(MO_loadFlows()); }
  if (force || !MO_state.loaded.margins) { MO_state.loaded.margins = true; tasks.push(MO_loadMargins()); }
  if (force || !MO_state.loaded.billboard) { MO_state.loaded.billboard = true; tasks.push(MO_loadBillboard()); }
  return Promise.all(tasks);
}

function MO_init() {
  MO_bindSorting();
  var dateEl = document.getElementById('moBillboardDate');
  if (dateEl && !dateEl.value) dateEl.value = MO_today();
  MO_loadAll(false);

  // 导航按钮滚动到对应区块
  var nav = document.getElementById('moNav');
  if (nav) {
    var items = [
      { id: 'moSectionIndexes', label: '核心指数' },
      { id: 'moSectionIndustries', label: '行业强度' },
      { id: 'moSectionFlows', label: '资金流向' },
      { id: 'moSectionMargin', label: '两融余额' },
      { id: 'moSectionBillboard', label: '龙虎榜' }
    ];
    nav.innerHTML = items.map(function (it) {
      return '<button type="button" class="mo-nav-btn" onclick="document.getElementById(\'' + it.id + '\').scrollIntoView({behavior:\'smooth\',block:\'start\'})">' + it.label + '</button>';
    }).join('');
  }

  // 收盘前后自动刷新：交易时段（9:15-15:10）每 60 秒刷一次，其余时间不自动刷
  setInterval(function () {
    var d = new Date();
    var minutes = d.getHours() * 60 + d.getMinutes();
    var isTrading = minutes >= 555 && minutes <= 910;
    if (isTrading && !document.hidden) MO_loadAll(true);
  }, 60000);
}
