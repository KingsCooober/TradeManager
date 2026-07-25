// 资金面数据代理（东方财富 + 腾讯 API 免 Key）
// 数据源：
//   1) 北向资金：https://push2.eastmoney.com/api/qt/kamt/get
//      返回 hk2sh(沪股通净买) / hk2sz(深股通净买) / sh2hk(港股通沪净买) / sz2hk(港股通深净买)
//      单位：元
//   2) 融资融券：https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ
//      返回近 N 日：RZYE(融资余额) / RZJME(融资净买入) / RZRQYE(两融余额)
//      单位：元
//   3) 沪深两市总成交额：sh000001(沪市) + sz399001(深市) 的 amount 字段之和
//      通过 market-quote.fetchMarketTotalAmount() 获取（单位：万元）
//
// 评分维度（0-20 分）：
//   北向资金 0-8 分：净流入 50亿+ = 8 / 0-50亿 = 6 / 净流出 0-50亿 = 4 / >50亿 = 2
//   融资余额变化 0-6 分：环比 +1%+ = 6 / 0-1% = 4 / -1%-0% = 3 / -1%+ = 1
//   成交额 0-6 分：1.5万亿+ = 6 / 1.0-1.5 = 5 / 0.8-1.0 = 4 / 0.6-0.8 = 2 / <0.6 = 0

const https = require('https');
const marketQuote = require('./market-quote');

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const cache = new Map();

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      family: 4,   // ★ 强制 IPv4，避免 push2his / push2 偶发 hang up
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0',
        'Accept': '*/*',
        'Referer': 'https://quote.eastmoney.com/'
      },
      timeout: 10000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// 1) 北向资金
async function fetchNorthbound() {
  const url = 'https://push2.eastmoney.com/api/qt/kamt/get?fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=1&lmt=1&fields=f51,f52,f54,f55';
  const buf = await httpsGet(url);
  const text = buf.toString('utf8');
  const json = JSON.parse(text);
  if (json.rc !== 0) throw new Error('北向资金接口返回错误: ' + json.rt);
  const d = json.data || {};
  // hk2sh=沪股通净买, hk2sz=深股通净买, sh2hk=港股通(沪)净买, sz2hk=港股通(深)净买
  // 注意：dayNetAmtIn 字段是字符串
  const num = (v) => typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : 0);
  const hk2sh = num(d.hk2sh && d.hk2sh.dayNetAmtIn);
  const hk2sz = num(d.hk2sz && d.hk2sz.dayNetAmtIn);
  const sh2hk = num(d.sh2hk && d.sh2hk.dayNetAmtIn);
  const sz2hk = num(d.sz2hk && d.sz2hk.dayNetAmtIn);
  return {
    hk2sh: hk2sh,
    hk2sz: hk2sz,
    sh2hk: sh2hk,
    sz2hk: sz2hk,
    // 北向净流入 = 沪股通 + 深股通 - （港股通沪 + 港股通深） = 资金净流向 A 股
    // 简化版：直接用 hk2sh + hk2sz（A 股净买入）
    netInflow: hk2sh + hk2sz,
    date: (d.hk2sh && d.hk2sh.date2) || (d.hk2sz && d.hk2sz.date2) || ''
  };
}

// 2) 融资融券（取最近 2 日用于算环比）
async function fetchMargin() {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=5&sortColumns=dim_date&sortTypes=-1';
  const buf = await httpsGet(url);
  const text = buf.toString('utf8');
  const json = JSON.parse(text);
  if (!json.result || !Array.isArray(json.result.data) || json.result.data.length === 0) {
    throw new Error('融资融券接口无数据');
  }
  const rows = json.result.data;
  const today = rows[0];
  const yesterday = rows[1] || today;
  const num = (v) => typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : 0);
  return {
    date: today.DIM_DATE,
    rzye:       num(today.RZYE),       // 融资余额
    rzjme:      num(today.RZJME),      // 融资净买入
    rqye:       num(today.RQYE),       // 融券余额
    rzrqye:     num(today.RZRQYE),     // 融资融券余额
    // 昨日值（用于算环比）
    prev: {
      rzye:   num(yesterday.RZYE),
      rzrqye: num(yesterday.RZRQYE)
    }
  };
}

// 3) 评分函数（pure）
// 入参：{ northNetInflow 元, marginChange %(-100~+100), totalAmount 万 }
// 返回：{ total, northScore, marginScore, amountScore, details }
function scoreFund(northNetInflow, marginChangePct, totalAmountWan) {
  // 北向资金：亿元
  const northYi = (northNetInflow || 0) / 1e8;
  let northScore = 4; // 默认中性
  if (northYi > 50) northScore = 8;
  else if (northYi > 0) northScore = 6;
  else if (northYi > -50) northScore = 4;
  else northScore = 2;

  // 融资余额变化
  let marginScore = 3; // 默认中性
  if (marginChangePct > 1) marginScore = 6;
  else if (marginChangePct > 0) marginScore = 4;
  else if (marginChangePct > -1) marginScore = 3;
  else marginScore = 1;

  // 成交额：万元 → 亿元
  const amountYi = (totalAmountWan || 0) / 1e4;
  let amountScore = 0;
  if (amountYi > 15000) amountScore = 6;
  else if (amountYi > 10000) amountScore = 5;
  else if (amountYi > 8000) amountScore = 4;
  else if (amountYi > 6000) amountScore = 2;

  return {
    total: northScore + marginScore + amountScore,
    northScore: northScore,
    marginScore: marginScore,
    amountScore: amountScore,
    northYi: northYi,
    marginChangePct: marginChangePct,
    amountYi: amountYi,
    breakdown: '北向 ' + northScore + ' + 融资 ' + marginScore + ' + 成交 ' + amountScore
  };
}

// 4) 主入口：合并所有数据并计算评分
// 内部自动调用 marketQuote.fetchMarketTotalAmount() 拉沪深两市总成交额
//   （沪市: sh000001 / 深市: sz399001，单位：万元）
// 不再需要 totalAmountWan 入参 —— 由后端统一从行情接口获取
async function getFundSnapshot() {
  const cacheKey = 'fund:snapshot';
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  // 并发获取：北向资金 + 融资融券 + 沪深两市总成交额
  const [north, margin, marketAmount] = await Promise.all([
    fetchNorthbound().catch(e => ({ error: e.message, netInflow: 0 })),
    fetchMargin().catch(e => ({ error: e.message, rzye: 0, rzjme: 0, rqye: 0, rzrqye: 0, prev: { rzye: 0, rzrqye: 0 } })),
    marketQuote.fetchMarketTotalAmount().catch(e => ({ error: e.message, totalWan: 0, shWan: 0, szWan: 0 }))
  ]);

  // 计算融资余额环比 %
  let marginChangePct = 0;
  if (margin && margin.rzye && margin.prev && margin.prev.rzye) {
    marginChangePct = ((margin.rzye - margin.prev.rzye) / margin.prev.rzye) * 100;
  }

  // 计算评分（总成交额单位：万元 → 亿元）
  const totalAmountWan = (marketAmount && marketAmount.totalWan) || 0;
  const score = scoreFund(north.netInflow || 0, marginChangePct, totalAmountWan);

  const data = {
    north: {
      hk2sh: north.hk2sh || 0,
      hk2sz: north.hk2sz || 0,
      sh2hk: north.sh2hk || 0,
      sz2hk: north.sz2hk || 0,
      netInflow: north.netInflow || 0,
      date: north.date || ''
    },
    margin: {
      date: margin.date || '',
      rzye:   margin.rzye || 0,
      rzjme:  margin.rzjme || 0,
      rqye:   margin.rqye || 0,
      rzrqye: margin.rzrqye || 0,
      changePct: marginChangePct,
      error: margin.error || null
    },
    amount: {
      shWan:      (marketAmount && marketAmount.shWan)      || 0,
      szWan:      (marketAmount && marketAmount.szWan)      || 0,
      totalWan:   totalAmountWan,
      shYi:       (marketAmount && marketAmount.shYi)       || 0,
      szYi:       (marketAmount && marketAmount.szYi)       || 0,
      totalYi:    (marketAmount && marketAmount.totalYi)    || (totalAmountWan / 1e4),
      source:     'sh000001+sz399001',  // 数据源标识
      error:      (marketAmount && marketAmount.error)      || null
    },
    score: score,
    errors: [north.error, margin.error, marketAmount && marketAmount.error].filter(Boolean),
    fetchedAt: new Date().toISOString()
  };

  setCache(cacheKey, data);
  return data;
}

module.exports = { getFundSnapshot, scoreFund, fetchNorthbound, fetchMargin };
