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
const marketHistory = require('./market-history');

const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_TTL_SHORT = 30 * 1000; // 30 秒（用于数据未发布时的短缓存）
const cache = new Map();

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = entry.ttl || CACHE_TTL;
  if (Date.now() - entry.ts > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now(), ttl: CACHE_TTL });
}
function setCacheShort(key, data) {
  cache.set(key, { data, ts: Date.now(), ttl: CACHE_TTL_SHORT });
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

// 2) 融资融券（一次性拉最近 N 天历史数据）
// 返回：[{date, rzye, rzjme, rqye, rzrqye, changePct}, ...] 按日期降序
//   之前 fetchMargin() 严格判断"接口最新日期必须等于目标写入日期"才返回数据，
//   导致今天（东财尚未发布 8-12 数据）时连同已经发布但未写入的 8-11 一起被丢弃，
//   数据库两融余额永远卡在 8-7。改为一次性拉多天，由调用方按数据本身日期写入。
async function fetchMargin(days) {
  const limitDays = Math.max(days || 5, 2);
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=' + limitDays + '&sortColumns=dim_date&sortTypes=-1';
  const buf = await httpsGet(url);
  const text = buf.toString('utf8');
  const json = JSON.parse(text);
  if (!json.result || !Array.isArray(json.result.data) || json.result.data.length === 0) {
    throw new Error('融资融券接口无数据');
  }
  const rows = json.result.data;
  const num = (v) => typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : 0);
  // rows 已按 dim_date DESC 排序
  const result = rows.map(function(row, i) {
    const prev = rows[i + 1] || row;  // 上一条（更早一天）
    const rzye = num(row.RZYE);
    const prevRzye = num(prev.RZYE);
    const changePct = (prevRzye > 0) ? ((rzye - prevRzye) / prevRzye) * 100 : 0;
    return {
      date:       String(row.DIM_DATE).slice(0, 10),
      rzye:       rzye,
      rzjme:      num(row.RZJME),
      rqye:       num(row.RQYE),
      rzrqye:     num(row.RZRQYE),
      changePct:  changePct
    };
  });
  return result;
}

// 兼容旧调用：返回 fetchMargin 拉到的最新一条的快照（用于 fund 接口实时评分）
async function fetchMarginSnapshot() {
  const rows = await fetchMargin(5);
  return rows[0] || null;
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
  // ★ 非交易日（周末/节假日）短路：直接返回空快照，不调任何接口、不写库
  //   避免北向/两融/成交额 在非交易日返回 0 或前一日数据污染前端
  const isTradingDay = (function () {
    // 测试钩子：环境变量 FORCE_NON_TRADING_DAY=1 可强制走非交易日分支
    if (process.env.FORCE_NON_TRADING_DAY === '1') return false;
    const d = new Date().getDay();
    return d !== 0 && d !== 6;  // 0=周日, 6=周六
  })();
  if (!isTradingDay) {
    return {
      _nonTradingDay: true,
      date: marketHistory.getLastTradingDate(),
      message: '非交易日（周末/节假日）',
      north: { error: 'non_trading_day', netInflow: 0, hk2sh: 0, hk2sz: 0 },
      margin: { error: 'non_trading_day', rzye: 0, rzjme: 0, rqye: 0, rzrqye: 0, prev: { rzye: 0, rzrqye: 0 } },
      amount: { error: 'non_trading_day', totalWan: 0, shWan: 0, szWan: 0, totalYi: 0, shYi: 0, szYi: 0 },
      score: { total: 0, northScore: 0, marginScore: 0, amountScore: 0, details: { northYi: 0, marginChangePct: 0, totalYi: 0 } }
    };
  }

  const cacheKey = 'fund:snapshot';
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  // 并发获取：北向资金 + 融资融券 + 沪深两市总成交额
  // marginHistory 是 fetchMargin 拉到的最近 N 天数据（用于补齐历史缺漏）
  let [north, marginArr, marketAmount] = await Promise.all([
    fetchNorthbound().catch(e => ({ error: e.message, netInflow: 0 })),
    fetchMargin(5).catch(e => []),
    marketQuote.fetchMarketTotalAmount().catch(e => ({ error: e.message, totalWan: 0, shWan: 0, szWan: 0 }))
  ]);

  // 取最新一条作为"今天"快照（用于评分与前端实时展示）
  const latestMargin = (Array.isArray(marginArr) && marginArr.length > 0) ? marginArr[0] : null;
  const lastTradingDate = marketHistory.getLastTradingDate();
  const marginLatestDate = latestMargin ? latestMargin.date : '';
  const marginPending = !latestMargin || marginLatestDate !== lastTradingDate;
  const margin = latestMargin || {
    error: 'margin_not_published',
    rzye: 0, rzjme: 0, rqye: 0, rzrqye: 0, changePct: 0
  };

  // marginHistory 提供给 recordFundSnapshot 写入，按数据本身的 date 字段，
  //   这样可以补齐"东财已发但我们之前没写"的历史日期（如 8-11）。
  const marginHistory = Array.isArray(marginArr) ? marginArr : [];

  // 计算评分（总成交额单位：万元 → 亿元）
  const totalAmountWan = (marketAmount && marketAmount.totalWan) || 0;
  const marginChangePct = margin.changePct || 0;
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

  // ★ 如果两融数据未发布（接口最新日期 ≠ 最近交易日，如 20:00 前），
  //   不写入 5 分钟长缓存。用短缓存（30 秒）让用户刷新后能较快拿到已发布的数据
  if (marginPending) {
    setCacheShort(cacheKey, data);
  } else {
    setCache(cacheKey, data);
  }
  return Object.assign({}, data, { marginHistory: marginHistory });
}

module.exports = { getFundSnapshot, scoreFund, fetchNorthbound, fetchMargin };
