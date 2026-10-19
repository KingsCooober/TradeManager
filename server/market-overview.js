/**
 * 行情总览数据源（迁移自 easy-stock 的 Go 实现 eastmoney/market_overview.go）
 *
 * 数据全部来自东方财富公开接口：
 *   - 指数快照：  push2.eastmoney.com/api/qt/ulist.np/get
 *   - 指数K线：   push2.eastmoney.com/api/qt/stock/kline/get
 *   - 行业强度：  push2.eastmoney.com/api/qt/clist/get  (fs=m:90+t:2+f:!50)
 *   - 资金流：    push2.eastmoney.com/api/qt/clist/get  (行业/题材/个股 三档)
 *   - 两融余额：  datacenter-web.eastmoney.com/api/data/v1/get (RPTA_WEB_RZRQ_LSSH)
 *   - 龙虎榜：    datacenter-web.eastmoney.com/api/data/v1/get (RPT_DAILYBILLBOARD_DETAILSNEW)
 *
 * 约定：
 *   - 所有对外结构用 snake_case，与 easy-stock 前端保持一致，便于日后对照。
 *   - 每个返回都带 meta:{source, fetched_at, stale, fallback_reason}，前端据 stale 显示降级提示。
 *   - 抓取失败且有旧快照时返回旧数据并标 stale，不向前端抛错（除非从未成功过）。
 */

const https = require('https');

// ==================== 指数目录 ====================
// core=true 的进「核心指数」，其余进「全球指数」
const MARKET_INDEX_CATALOG = [
  { id: 'sse', secid: '1.000001', name: '上证指数', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'szse', secid: '0.399001', name: '深证成指', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'chinext', secid: '0.399006', name: '创业板指', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'csi300', secid: '1.000300', name: '沪深300', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'sse50', secid: '1.000016', name: '上证50', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'csi1000', secid: '1.000852', name: '中证1000', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'star50', secid: '1.000688', name: '科创50', region: '中国', market: 'CN', currency: 'CNY', core: true },
  { id: 'hsi', secid: '100.HSI', name: '恒生指数', region: '中国香港', market: 'HK', currency: 'HKD', core: true },
  { id: 'nikkei', secid: '100.N225', name: '日经225', region: '亚太', market: 'JP', currency: 'JPY' },
  { id: 'kospi', secid: '100.KS11', name: '韩国综合', region: '亚太', market: 'KR', currency: 'KRW' },
  { id: 'taiwan', secid: '100.TWII', name: '台湾加权', region: '亚太', market: 'TW', currency: 'TWD' },
  { id: 'dow', secid: '100.DJIA', name: '道琼斯', region: '美洲', market: 'US', currency: 'USD', core: true },
  { id: 'sp500', secid: '100.SPX', name: '标普500', region: '美洲', market: 'US', currency: 'USD', core: true },
  { id: 'nasdaq', secid: '100.NDX', name: '纳斯达克', region: '美洲', market: 'US', currency: 'USD', core: true },
  { id: 'ftse', secid: '100.FTSE', name: '英国富时100', region: '欧洲', market: 'UK', currency: 'GBP' },
  { id: 'dax', secid: '100.GDAXI', name: '德国DAX', region: '欧洲', market: 'DE', currency: 'EUR' },
  { id: 'cac', secid: '100.FCHI', name: '法国CAC40', region: '欧洲', market: 'FR', currency: 'EUR' }
];

const BASE_QUOTE = 'https://push2.eastmoney.com';
const BASE_DATA = 'https://datacenter-web.eastmoney.com';

// push2 系接口按顺序轮换的主机：某个域名被限流（socket hang up）时换下一个。
// 实测 2026-10 本机 IP 频繁被 push2 断链，而 datacenter 不受影响，
// 所以轮换失败后行情部分还能靠腾讯快照兜底（见 fetchMarketIndexes）。
const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://7.push2.eastmoney.com'
];

// ==================== 通用抓取 ====================
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function httpsGetJSON(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      // ★ 必须强制 IPv4（family: 4）：
      //   2026-10 实测，本机解析 push2.eastmoney.com 会得到 IPv6 地址，
      //   走 IPv6 连接时东财直接断链，Node 报 `socket hang up`；
      //   同一 URL 指定 family:4 立即 200。curl/PowerShell 默认优先 IPv4 所以看不出问题。
      family: 4,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://data.eastmoney.com/',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: timeoutMs || 15000
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode + ' ' + url.slice(0, 80)));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

/**
 * push2 系接口带主机轮换地抓取：按 QUOTE_HOSTS 顺序尝试，
 * 任一主机成功即返回；全部失败时抛出最后一个错误（保留原始信息便于排查）。
 */
async function httpsGetJSONRotating(pathAndQuery, timeoutMs) {
  let lastErr = null;
  for (const host of QUOTE_HOSTS) {
    try {
      return await httpsGetJSON(host + pathAndQuery, timeoutMs);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('push2 全部主机不可用');
}

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}

function num(v, fallback) {  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

// 东财用 "-" 表示停牌/无数据
function numOrZero(v) {
  if (v === '-' || v === null || v === undefined || v === '') return 0;
  return num(v, 0);
}

function nowMeta(source) {
  return { source: source, fetched_at: new Date().toISOString(), stale: false, fallback_reason: '' };
}

// ==================== 快照缓存（TTL + 失败降级） ====================
const SNAPSHOT_TTL_MS = 60 * 1000;
const snapshots = new Map(); // key -> { value, meta, expiresAt }

async function loadWithCache(key, ttlMs, loader) {
  const cached = snapshots.get(key);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    return { value: cached.value, meta: cached.meta };
  }
  try {
    const loaded = await loader();
    const entry = {
      value: loaded.value,
      meta: Object.assign({}, loaded.meta, { stale: false, fallback_reason: '' }),
      expiresAt: now + ttlMs
    };
    snapshots.set(key, entry);
    return { value: entry.value, meta: entry.meta };
  } catch (e) {
    if (cached) {
      const meta = Object.assign({}, cached.meta, {
        stale: true,
        fallback_reason: '实时数据刷新失败，已返回最近一次成功快照：' + e.message
      });
      return { value: cached.value, meta: meta };
    }
    throw e;
  }
}

// ==================== 指数快照 ====================
function indexSnapshotFromRow(def, row) {
  const price = numOrZero(row.f2);
  const change = numOrZero(row.f4);
  const pct = numOrZero(row.f3);
  const ts = num(row.f124, 0); // 秒级时间戳
  return {
    id: def.id,
    secid: def.secid,
    code: String(row.f12 || def.secid.split('.')[1]),
    name: String(row.f14 || def.name),
    region: def.region,
    market: def.market,
    currency: def.currency,
    price: price,
    change: change,
    change_percent: pct,
    trade_time: ts > 0 ? new Date(ts * 1000).toISOString() : null,
    status: price > 0 ? 'ok' : 'unavailable',
    meta: nowMeta('eastmoney:index')
  };
}

async function fetchMarketIndexes(scope) {
  const wantCore = scope === 'core';
  const defs = MARKET_INDEX_CATALOG.filter((d) => !wantCore || d.core);
  const secids = defs.map((d) => d.secid).join(',');
  try {
    const payload = await httpsGetJSONRotating('/api/qt/ulist.np/get?' + qs({
      fltt: 2,
      invt: 2,
      secids: secids,
      fields: 'f12,f13,f14,f2,f3,f4,f124'
    }));
    if (!payload || payload.rc !== 0) {
      throw new Error('eastmoney index rc=' + (payload && payload.rc));
    }
    const diff = (payload.data && payload.data.diff) || [];
    // diff 顺序与请求顺序一致，按序对齐（secid 前缀 f13 表示市场）
    const out = defs.map((def, i) => indexSnapshotFromRow(def, diff[i] || {}));
    return { value: out, meta: nowMeta('eastmoney:index') };
  } catch (e) {
    // 兜底：push2 被限流时用腾讯行情现价 + 日K 算涨跌，覆盖沪深 + 恒生 + 美股三大；
    // 日经/韩综/台指/富时/DAX/CAC 腾讯无对应代码，标记 unavailable（前端显示 —，不谎报数据）。
    const out = await fetchIndexesViaTencent(defs);
    if (!out.some((x) => x.status === 'ok')) throw e;
    const meta = nowMeta('tencent:index-fallback');
    meta.reason = '东财指数接口不可用（' + e.message + '），已用腾讯行情兜底沪深/恒生/美股指数';
    return { value: out, meta: meta };
  }
}

async function fetchIndexesViaTencent(defs) {
  // 一次性批量取实时快照（比逐只拉 K 线快得多，且直接带 changePct，不用自己推算涨跌）
  const symbolMap = {}; // symbol -> def
  defs.forEach((def) => {
    const sym = secidToTencentSymbol(def.secid);
    if (sym) symbolMap[sym] = def;
  });
  const symbols = Object.keys(symbolMap);
  let quotes = {};
  if (symbols.length) {
    try {
      const { fetchQuotes } = require('./market-quote');
      quotes = await fetchQuotes(symbols);
    } catch (e) {
      quotes = {};
    }
  }
  return defs.map((def) => {
    const sym = secidToTencentSymbol(def.secid);
    const q = sym ? quotes[sym] : null;
    if (!q || !(q.price > 0)) return indexSnapshotFromRow(def, {});
    return {
      id: def.id,
      secid: def.secid,
      code: sym.slice(2),
      name: def.name,
      region: def.region,
      market: def.market,
      currency: def.currency,
      price: q.price,
      change: q.change || 0,
      change_percent: q.changePct || 0,
      trade_time: null,
      status: 'ok',
      meta: nowMeta('tencent:index-fallback')
    };
  });
}

// ==================== 指数 K 线 ====================
// ★ 为什么用腾讯而不是东财：
//   2026-10 实测，东财 K 线接口（push2his.eastmoney.com/api/qt/stock/kline/get）
//   从本机任何域名、任何参数组合都返回 `socket hang up`（IPv4/IPv6、带不带 ut、
//   个股/指数全试过），而同域名的 trends2 分时接口正常 → 是该路径被单独限制。
//   项目里 market-quote.js 已有稳定的腾讯 K 线（多域名轮换 + WAF 识别），直接复用。
const { fetchKLine } = require('./market-quote');

const PERIOD_TO_TXKLINE = { day: 'day', week: 'week', month: 'month' };

// 东财 secid → 腾讯代码前缀：1.=sh（沪市），0.=sz（深市），100.=海外
// 海外用腾讯的国际指数代码（实测可用）：hkHSI / usDJI / us.IXIC / usINX，
// 其余市场（日经、韩综、台指、富时、DAX、CAC）腾讯无对应代码，返回 null 由调用方降级。
const TENCNET_OVERSEAS = {
  '100.HSI': 'hkHSI',
  '100.DJIA': 'usDJI',
  '100.NDX': 'usIXIC',
  '100.SPX': 'usINX'
};

function secidToTencentSymbol(secid) {
  const key = String(secid || '');
  if (TENCNET_OVERSEAS[key]) return TENCNET_OVERSEAS[key];
  const parts = key.split('.');
  if (parts.length !== 2) return null;
  if (parts[0] === '1') return 'sh' + parts[1];
  if (parts[0] === '0') return 'sz' + parts[1];
  return null;
}

async function fetchMarketIndexSeries(id, period, limit) {
  const def = MARKET_INDEX_CATALOG.find((d) => d.id === String(id || '').toLowerCase());
  if (!def) throw new Error('未知指数 id: ' + id);
  const symbol = secidToTencentSymbol(def.secid);
  if (!symbol) throw new Error('该指数暂不支持K线（仅支持沪深指数）：' + def.name);
  const txPeriod = PERIOD_TO_TXKLINE[period] || 'day';
  // 腾讯：period 必须传下去，否则周线/月线都会退回日线
  const raw = await fetchKLine(symbol, limit, txPeriod);
  const lines = raw.map((k) => ({
    time: k.date,
    open: k.open,
    close: k.close,
    high: k.high,
    low: k.low,
    volume: k.volume,
    amount: k.amount,
    amplitude: 0,
    change_percent: 0,
    change: 0,
    turnover_rate: 0
  }));
  // 涨跌幅由相邻收盘价推算（腾讯 K 线不带）
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1].close;
    if (prev > 0) {
      lines[i].change = +(lines[i].close - prev).toFixed(3);
      lines[i].change_percent = +(((lines[i].close - prev) / prev) * 100).toFixed(2);
    }
    lines[i].amplitude = lines[i - 1].close > 0
      ? +(((lines[i].high - lines[i].low) / lines[i - 1].close) * 100).toFixed(2)
      : 0;
  }
  const last = lines[lines.length - 1] || {};
  const snapshot = {
    id: def.id,
    secid: def.secid,
    code: symbol.slice(2),
    name: def.name,
    region: def.region,
    market: def.market,
    currency: def.currency,
    price: last.close || 0,
    change: last.change || 0,
    change_percent: last.change_percent || 0,
    trade_time: null,
    status: lines.length ? 'ok' : 'unavailable',
    meta: nowMeta('tencent:index-kline')
  };
  const meta = nowMeta('tencent:index-kline');
  return { value: { index: snapshot, lines: lines, meta: meta }, meta: meta };
}

// ==================== 行业趋势强度 ====================
async function fetchIndustryMomentum(limit) {
  try {
    return await fetchIndustryMomentumEastmoney(limit);
  } catch (e) {
    // push2 被风控时的降级：新浪行业板块（今日） + 腾讯成分股 K 线（5日/20日）
    const items = await fetchIndustryMomentumSina(limit);
    if (!items.length) throw e;
    const meta = nowMeta('sina:industry');
    meta.stale = true;
    meta.fallback_reason = '东财板块接口不可用（' + e.message + '），已用新浪板块 + 腾讯成分股兜底；主力净流入口径不可得';
    return { value: items, meta: meta };
  }
}

async function fetchIndustryMomentumEastmoney(limit) {
  const payload = await httpsGetJSONRotating('/api/qt/clist/get?' + qs({
    pn: 1,
    pz: limit,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: 'f3',
    fs: 'm:90+t:2+f:!50', // 东财二级行业板块（不含概念）
    fields: 'f12,f14,f3,f8,f62,f104,f105,f136,f128,f109,f160,f24'
  }));
  if (!payload || payload.rc !== 0 || !payload.data) {
    throw new Error('eastmoney industry rc=' + (payload && payload.rc));
  }
  const diff = payload.data.diff || [];
  const items = diff.map((row) => {
    const changePct = numOrZero(row.f3);
    const fiveDay = numOrZero(row.f109);
    const twentyDay = numOrZero(row.f160);
    const turnover = numOrZero(row.f8);
    const rising = numOrZero(row.f104);
    const falling = numOrZero(row.f105);
    const mainNet = numOrZero(row.f62);
    // 强度分：多周期涨跌 + 涨跌家数差 + 主力净流入（归一化后加权，仅用于同屏排序）
    const breadth = (rising + falling) > 0 ? (rising - falling) / (rising + falling) : 0;
    const score = changePct * 0.5 + fiveDay * 0.35 + twentyDay * 0.15 + breadth * 1.2 + (mainNet / 1e8) * 0.1;
    return {
      code: String(row.f12 || ''),
      name: String(row.f14 || ''),
      change_percent: changePct,
      five_day_change_percent: fiveDay,
      twenty_day_change_percent: twentyDay,
      turnover_rate: turnover,
      rising_count: rising,
      falling_count: falling,
      main_net_inflow: mainNet,
      leader_symbol: String(row.f140 || ''),
      leader_name: String(row.f128 || ''),
      leader_change_percent: numOrZero(row.f136),
      score: Math.round(score * 100) / 100,
      meta: nowMeta('eastmoney:industry')
    };
  });
  return { value: items, meta: nowMeta('eastmoney:industry') };
}

// ---------- 新浪行业板块（东财 push2 被风控时的降级源） ----------
// 接口：https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php  (GBK 编码，JSONP 外壳)
// 字段（逗号分隔）：0 代码 1 名称 2 成分数 3 均价 4 涨跌额 5 涨跌幅% 6 总量 7 总金额
//                   8 领涨股代码 9 领涨股涨幅% 10 领涨股现价 11 领涨股涨额 12 领涨股名称
const SINA_HY_URL = 'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php';
const SINA_NODE_URL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeDataSimple';

function httpsGetTextGBK(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      family: 4,
      headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' },
      timeout: timeoutMs || 15000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // 新浪返回 GBK，Node 不内置 iconv，用 TextDecoder('gbk')（Node 18+ 由 ICU 提供）
        try {
          resolve(new TextDecoder('gbk').decode(Buffer.concat(chunks)));
        } catch (e) {
          resolve(Buffer.concat(chunks).toString('utf8'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function fetchSinaSectors() {
  const text = await httpsGetTextGBK(SINA_HY_URL);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('新浪板块返回格式异常');
  const obj = JSON.parse(text.slice(start, end + 1));
  return Object.keys(obj).map((key) => {
    const f = String(obj[key]).split(',');
    return {
      node: f[0],
      name: f[1],
      member_count: numOrZero(f[2]),
      change_percent: numOrZero(f[5]),
      amount: numOrZero(f[7]),
      leader_symbol: f[8] || '',
      leader_change_percent: numOrZero(f[9]),
      leader_name: f[12] || ''
    };
  }).filter((s) => s.node && s.name);
}

// 拉某板块成分股前 N 只的日 K，算板块等权 5 日 / 20 日涨跌幅
async function sinaSectorMultiPeriod(sector, sample) {
  const url = SINA_NODE_URL + '?' + qs({
    page: 1, num: sample, sort: 'amount', asc: 0, node: sector.node
  });
  const text = await httpsGetTextGBK(url);
  const list = JSON.parse(text);
  if (!Array.isArray(list) || !list.length) return { five: 0, twenty: 0, rising: 0, falling: 0 };
  const { fetchKLine } = require('./market-quote');
  const bars = await Promise.all(list.map((s) => fetchKLine(s.symbol, 22).catch(() => [])));
  let sum5 = 0, n5 = 0, sum20 = 0, n20 = 0, rising = 0, falling = 0;
  bars.forEach((k) => {
    if (!k || k.length < 2) return;
    const last = k[k.length - 1].close;
    if (last > numOrZero(k[k.length - 1].open)) rising += 1;
    else if (last < numOrZero(k[k.length - 1].open)) falling += 1;
    if (k.length >= 6 && k[k.length - 6].close > 0) {
      sum5 += (last - k[k.length - 6].close) / k[k.length - 6].close * 100;
      n5 += 1;
    }
    const head = k[0];
    if (k.length >= 21 && head.close > 0) {
      sum20 += (last - head.close) / head.close * 100;
      n20 += 1;
    }
  });
  return {
    five: n5 ? +(sum5 / n5).toFixed(2) : 0,
    twenty: n20 ? +(sum20 / n20).toFixed(2) : 0,
    rising: rising,
    falling: falling
  };
}

async function fetchIndustryMomentumSina(limit) {
  const sectors = await fetchSinaSectors();
  // 成分股多的板块更有代表性；取成交额靠前的 limit 个，避免全量拉 49 个板块的 K 线
  const picked = sectors.slice().sort((a, b) => b.amount - a.amount).slice(0, limit);
  const SAMPLE = 6;          // 每板块最多取 6 只成分股算多周期
  const CONCURRENCY = 6;     // 同时算几个板块
  const results = [];
  for (let i = 0; i < picked.length; i += CONCURRENCY) {
    const batch = picked.slice(i, i + CONCURRENCY);
    const details = await Promise.all(batch.map((s) => sinaSectorMultiPeriod(s, SAMPLE).catch(() => ({ five: 0, twenty: 0, rising: 0, falling: 0 }))));
    batch.forEach((s, j) => {
      const d = details[j];
      const breadth = (d.rising + d.falling) > 0 ? (d.rising - d.falling) / (d.rising + d.falling) : 0;
      // 口径与东财版一致，只是主力净流入缺失（按 0 参与）
      const score = s.change_percent * 0.5 + d.five * 0.35 + d.twenty * 0.15 + breadth * 1.2;
      results.push({
        code: s.node,
        name: s.name,
        change_percent: +s.change_percent.toFixed(2),
        five_day_change_percent: d.five,
        twenty_day_change_percent: d.twenty,
        turnover_rate: 0,
        rising_count: d.rising,
        falling_count: d.falling,
        main_net_inflow: 0,
        leader_symbol: s.leader_symbol,
        leader_name: s.leader_name,
        leader_change_percent: s.leader_change_percent,
        score: Math.round(score * 100) / 100,
        meta: nowMeta('sina:industry')
      });
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ==================== 资金流 ====================
const FLOW_DIMENSIONS = {
  // 行业（东财二级行业板块）
  industry: { fs: 'm:90+t:2+f:!50', sort: { net: 'f62', change: 'f3', ratio: 'f184' } },
  // 题材概念
  theme: { fs: 'm:90+t:3+f:!50', sort: { net: 'f62', change: 'f3', ratio: 'f184' } },
  // 个股（沪深A股 + 北交所）
  stock: { fs: 'm:0+t:6+f:!2,m:0+t:13+f:!2,m:0+t:80+f:!2,m:1+t:2+f:!2,m:1+t:23+f:!2', sort: { net: 'f62', change: 'f3', ratio: 'f184' } }
};

async function fetchFundFlows(dimension, sortKey, limit) {
  const conf = FLOW_DIMENSIONS[dimension];
  if (!conf) throw new Error('资金流维度不支持: ' + dimension);
  try {
    return await fetchFundFlowsEastmoney(dimension, sortKey, limit, conf);
  } catch (e) {
    // ★ 主力/超大单/大单净额是东财独有的逐笔单量分类，没有可靠的免费第三方同口径源。
    //   这里不编造数据：抛出明确的「暂不可用」，前端展示为失败而非 0 值。
    const err = new Error('资金流向数据暂不可用（东财接口被风控：' + e.message + '）。' +
      '该模块依赖东财独有的主力单量分类，暂无同口径替代源，稍后自动重试。');
    err.code = 'FLOW_UNAVAILABLE';
    throw err;
  }
}

async function fetchFundFlowsEastmoney(dimension, sortKey, limit, conf) {
  const fid = conf.sort[sortKey] || 'f62';
  const payload = await httpsGetJSONRotating('/api/qt/clist/get?' + qs({
    pn: 1,
    pz: limit,
    po: 1,
    np: 1,
    fltt: 2,
    invt: 2,
    fid: fid,
    fs: conf.fs,
    fields: 'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87'
  }));
  if (!payload || payload.rc !== 0 || !payload.data) {
    throw new Error('eastmoney flow rc=' + (payload && payload.rc));
  }
  const diff = payload.data.diff || [];
  const items = diff.map((row) => {
    const main = numOrZero(row.f62);          // 主力净流入（元）
    const superLarge = numOrZero(row.f66);    // 超大单净额
    const large = numOrZero(row.f72);         // 大单净额
    const medium = numOrZero(row.f78);        // 中单净额
    const small = numOrZero(row.f84);         // 小单净额
    return {
      dimension: dimension,
      code: String(row.f12 || ''),
      symbol: String(row.f12 || ''),
      name: String(row.f14 || ''),
      price: numOrZero(row.f2),
      change_percent: numOrZero(row.f3),
      inflow: 0,
      outflow: 0,
      net_inflow: main,
      net_inflow_ratio: numOrZero(row.f184),
      main_inflow: main > 0 ? main : 0,
      main_outflow: main < 0 ? main : 0,
      main_net_inflow: main,
      main_net_inflow_ratio: numOrZero(row.f184),
      retail_inflow: small > 0 ? small : 0,
      retail_outflow: small < 0 ? small : 0,
      retail_net_inflow: small,
      retail_net_inflow_ratio: numOrZero(row.f87),
      super_large_net_inflow: superLarge,
      super_large_net_inflow_ratio: numOrZero(row.f69),
      large_net_inflow: large,
      large_net_inflow_ratio: numOrZero(row.f75),
      medium_net_inflow: medium,
      medium_net_inflow_ratio: numOrZero(row.f81),
      small_net_inflow: small,
      small_net_inflow_ratio: numOrZero(row.f87),
      leader_symbol: '',
      leader_name: '',
      leader_price: 0,
      leader_change_percent: 0,
      leader_net_inflow_ratio: 0,
      meta: nowMeta('eastmoney:flow')
    };
  });
  return { value: items, meta: nowMeta('eastmoney:flow') };
}

// ==================== 融资融券余额 ====================
async function fetchMarginBalance(limit) {
  const url = BASE_DATA + '/api/data/v1/get?' + qs({
    reportName: 'RPTA_WEB_RZRQ_LSSH',
    columns: 'DIM_DATE,SCDM,XOB_MARKET_0001,RZYE,RQYE,RZRQYE,RZMRE,RZCHE,RZJME,RQMCL,RQCHL',
    source: 'WEB',
    client: 'WEB',
    sortColumns: 'DIM_DATE,SCDM',
    sortTypes: '-1,1',
    pageNumber: 1,
    pageSize: 500
  });
  const payload = await httpsGetJSON(url);
  // 该接口成功时可能没有 code 字段（只有 version/result），失败才给 code
  if (!payload || (payload.code !== undefined && payload.code !== 0)) {
    throw new Error('eastmoney margin code=' + (payload && payload.code));
  }
  const rows = ((payload.result && payload.result.data) || []);
  // 存储顺序：单日期内 SCDM（市场代码）分行。按日期聚合沪深。
  const byDate = new Map();
  rows.forEach((r) => {
    const day = String(r.DIM_DATE || '').slice(0, 10);
    if (!day) return;
    const cur = byDate.get(day) || {
      trade_date: day,
      financing_balance: 0,
      securities_lending_balance: 0,
      margin_balance: 0,
      margin_balance_change: 0,
      financing_buy_amount: 0,
      financing_repay_amount: 0,
      financing_net_buy_amount: 0,
      securities_lending_sell_volume: 0,
      securities_lending_repay_volume: 0,
      meta: nowMeta('eastmoney:margin')
    };
    cur.financing_balance += numOrZero(r.RZYE);
    cur.securities_lending_balance += numOrZero(r.RQYE);
    cur.margin_balance += numOrZero(r.RZRQYE);
    cur.financing_buy_amount += numOrZero(r.RZMRE);
    cur.financing_repay_amount += numOrZero(r.RZCHE);
    cur.financing_net_buy_amount += numOrZero(r.RZJME);
    cur.securities_lending_sell_volume += numOrZero(r.RQMCL);
    cur.securities_lending_repay_volume += numOrZero(r.RQCHL);
    byDate.set(day, cur);
  });
  const points = Array.from(byDate.values()).sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  // 余额变化 = 当日 - 前一日
  for (let i = 1; i < points.length; i += 1) {
    points[i].margin_balance_change = points[i].margin_balance - points[i - 1].margin_balance;
  }
  const trimmed = points.slice(-limit);
  return { value: trimmed, meta: nowMeta('eastmoney:margin') };
}

// ==================== 龙虎榜 ====================
// ★ 字段名以实测为准（容易踩坑的两个）：
//   - 原因在 **EXPLANATION**（不是 EXPLAIN，EXPLAIN 是「4家机构买入，成功率48.17%」这类解读）；
//   - 席位数量在 **BUY_SEAT_NEW / SELL_SEAT_NEW**（不是 BUY_SEAT_NUM）；
//   - 不能带 `columns: 'ALL'` + 自定义 sortColumns=BILLBOARD_NET_AMT，会被拒（code=9201）；
//     但 sortColumns=TRADE_DATE,BILLBOARD_NET_AMT 是合法的。
function latestTradeDateString() {
  // 当天为交易日则用当天，否则往前退（不含节假日表，交给东财过滤兜底）
  const d = new Date();
  for (let i = 0; i < 10; i += 1) {
    const probe = new Date(d.getTime() - i * 86400000);
    const dow = probe.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = probe.getFullYear();
      const m = String(probe.getMonth() + 1).padStart(2, '0');
      const dd = String(probe.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + dd;
    }
  }
  return new Date().toISOString().slice(0, 10);
}

async function fetchBillboard(tradeDate, limit) {
  // 指定日期时用 filter 精确取当天；不指定时按日期倒序取最新一批
  // （一天可能有多条同一股票的多个上榜原因）
  // ★ 指定日期但当天还没出榜时，东财返回 code=9201「返回数据为空」，这不是故障：
  //   盘后 18:00 左右才发布当日榜单。此处自动回退到「最新一期」，并在 meta 里说明，
  //   前端把日期框回填成实际数据日期，避免用户对着当天日期看到一片空白。
  const wantDay = tradeDate || '';
  // 一只股票当天可能有多行（多个上榜原因），合并后条数会变少，所以多取一倍再截断
  const pageSize = Math.min(limit * 2, 400);
  const buildUrl = (day) => BASE_DATA + '/api/data/v1/get?' + qs({
    reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
    columns: 'ALL',
    filter: day ? "(TRADE_DATE='" + day + " 00:00:00')" : '',
    pageNumber: 1,
    pageSize: pageSize,
    sortColumns: 'TRADE_DATE,BILLBOARD_NET_AMT',
    sortTypes: '-1,-1',
    source: 'WEB',
    client: 'WEB'
  });

  let payload = await httpsGetJSON(buildUrl(wantDay));
  let fallback = '';
  const isEmpty = (p) => !p || (p.code !== undefined && p.code !== 0) ||
    !p.result || !Array.isArray(p.result.data) || p.result.data.length === 0;
  if (wantDay && isEmpty(payload)) {
    payload = await httpsGetJSON(buildUrl(''));
    if (!isEmpty(payload)) fallback = wantDay + ' 当日龙虎榜尚未发布，已显示最近一期';
  }
  if (!payload || (payload.code !== undefined && payload.code !== 0)) {
    const msg = (payload && payload.message) || '';
    throw new Error('eastmoney billboard code=' + (payload && payload.code) + (msg ? ' (' + msg + ')' : ''));
  }
  const rows = ((payload.result && payload.result.data) || []);
  const meta = nowMeta('eastmoney:billboard');
  if (fallback) meta.reason = fallback;
  // ★ 同一只股票当天可能因多个「上榜原因」各占一行，直接铺开会重复展示、
  //   还会让用户误以为净买入是两笔。这里按股票代码合并：原因用「；」串起来，
  //   买卖额与席位取各行中的最大值（东财这几个字段在原因行之间是重复的同一笔，取最大不会重复累加）。
  const merged = new Map();
  rows.forEach((r) => {
    const code = String(r.SECURITY_CODE || '');
    const reason = String(r.EXPLANATION || '').trim();
    const prev = merged.get(code);
    if (!prev) {
      merged.set(code, {
        row: r,
        reasons: reason ? [reason] : []
      });
      return;
    }
    if (reason && prev.reasons.indexOf(reason) === -1) prev.reasons.push(reason);
    // 保留净买入更大的那条为主行，其余数值取最大
    ['BILLBOARD_NET_AMT', 'BILLBOARD_BUY_AMT', 'BILLBOARD_SELL_AMT'].forEach((k) => {
      if (Math.abs(numOrZero(r[k])) > Math.abs(numOrZero(prev.row[k]))) prev.row[k] = r[k];
    });
  });
  const items = Array.from(merged.values()).map(({ row: r, reasons }) => ({
    trade_date: String(r.TRADE_DATE || wantDay).slice(0, 10),
    symbol: String(r.SECURITY_CODE || ''),
    name: String(r.SECURITY_NAME_ABBR || ''),
    close_price: numOrZero(r.CLOSE_PRICE),
    change_percent: numOrZero(r.CHANGE_RATE),
    turnover_rate: numOrZero(r.TURNOVERRATE),
    reason: reasons.join('；'),
    summary: String(r.EXPLAIN || ''),
    buy_amount: numOrZero(r.BILLBOARD_BUY_AMT),
    sell_amount: numOrZero(r.BILLBOARD_SELL_AMT),
    net_amount: numOrZero(r.BILLBOARD_NET_AMT),
    institution_buyers: 0,
    buy_seats: numOrZero(r.BUY_SEAT_NEW || r.BUY_SEAT || 0),
    sell_seats: numOrZero(r.SELL_SEAT_NEW || r.SELL_SEAT || 0),
    meta: meta
  })).sort((a, b) => Math.abs(b.net_amount) - Math.abs(a.net_amount)).slice(0, limit);
  return { value: items, meta: meta };
}

// ==================== 对外入口（带缓存） ====================
async function getMarketIndexes(scope) {
  const s = scope === 'core' ? 'core' : 'global';
  return loadWithCache('indexes:' + s, SNAPSHOT_TTL_MS, () => fetchMarketIndexes(s));
}

async function getMarketIndexSeries(id, period, limit) {
  const key = 'index-series:' + id + ':' + (period || 'day') + ':' + (limit || 120);
  return loadWithCache(key, SNAPSHOT_TTL_MS, () => fetchMarketIndexSeries(id, period || 'day', limit || 120));
}

async function getIndustryMomentum(limit) {
  return loadWithCache('industries:' + limit, SNAPSHOT_TTL_MS, () => fetchIndustryMomentum(limit));
}

async function getFundFlows(dimension, sortKey, limit) {
  const key = 'flows:' + dimension + ':' + sortKey + ':' + limit;
  return loadWithCache(key, SNAPSHOT_TTL_MS, () => fetchFundFlows(dimension, sortKey, limit));
}

async function getMarginBalance(limit) {
  return loadWithCache('margin:' + limit, 10 * 60 * 1000, () => fetchMarginBalance(limit));
}

async function getBillboard(tradeDate, limit) {
  const key = 'billboard:' + (tradeDate || 'latest') + ':' + limit;
  return loadWithCache(key, 5 * 60 * 1000, () => fetchBillboard(tradeDate, limit));
}

module.exports = {
  MARKET_INDEX_CATALOG: MARKET_INDEX_CATALOG,
  getMarketIndexes: getMarketIndexes,
  getMarketIndexSeries: getMarketIndexSeries,
  getIndustryMomentum: getIndustryMomentum,
  getFundFlows: getFundFlows,
  getMarginBalance: getMarginBalance,
  getBillboard: getBillboard,
  // 测试用
  _clearsnapshots: function () { snapshots.clear(); },
  _latestTradeDateString: latestTradeDateString
};
