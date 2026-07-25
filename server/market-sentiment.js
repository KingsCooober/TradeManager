// 情绪面数据代理（新浪财经实时 A 股列表 API，免 Key）
// 数据源：
//   1) 沪深 A 股列表：https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData
//      字段：symbol=sh600000 / sz000001 | trade=现价 | changepercent=涨跌幅%
//   2) 一次最多返回 100 条，所以需要分页（约 5200 只 A 股 → 52 页）
//   3) 并发拉取多页后统计：上涨 / 下跌 / 平盘 / 涨停 / 跌停
//
// 评分维度（0-20 分）：
//   涨跌停差    0-8 分：(涨停 - 跌停) >= 80 = 8 / 30-80 = 6 / 0-30 = 4 / -30-0 = 2 / <-30 = 0
//   上涨占比    0-8 分：>=80% = 8 / 60-80% = 6 / 40-60% = 4 / 20-40% = 2 / <20% = 0
//   涨停绝对数  0-4 分：>=80 = 4 / 40-80 = 3 / 20-40 = 2 / <20 = 1

const https = require('https');

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
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0',
        'Accept': '*/*',
        'Referer': 'https://finance.sina.com.cn/',
        'Connection': 'close'
      }
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

// 拉取单页 A 股数据
// page 从 1 开始，num=100（新浪每页最大 100）
async function fetchStocksPage(page, num = 100) {
  const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?node=hs_a&sort=symbol&asc=1&page=' + page + '&num=' + num;
  const buf = await httpsGet(url);
  const text = buf.toString('utf8');
  let arr;
  try { arr = JSON.parse(text); }
  catch (e) {
    // 新浪在空页时返回空字符串或 "null"，按空数组处理
    if (text.trim() === '' || text.trim() === 'null') return [];
    throw new Error('新浪 A 股列表 JSON 解析失败: ' + e.message);
  }
  return Array.isArray(arr) ? arr : [];
}

// 统计单只股票：up/down/flat/zt/dt
// 涨停阈值：沪深主板 10%，创业板/科创板 20%（北交所 30%，但 A 股列表中无北交所）
function classifyStock(stock) {
  const sym = (stock.symbol || '').toLowerCase();
  // 沪深主板（60/00 开头）涨停 10%，创业板（30 开头）/科创板（68 开头）涨停 20%
  const code = stock.code || '';
  let upperLimit, lowerLimit;
  if (code.startsWith('30') || code.startsWith('68')) {
    upperLimit = 19.5;  // 20% 涨停容差 0.5
    lowerLimit = -19.5;
  } else {
    upperLimit = 9.5;   // 10% 涨停容差 0.5
    lowerLimit = -9.5;
  }
  const pct = parseFloat(stock.changepercent);
  if (isNaN(pct)) return { up: 0, down: 0, flat: 1, zt: 0, dt: 0, sh: 0, sz: 0 };
  let up = 0, down = 0, flat = 0, zt = 0, dt = 0;
  if (pct > 0.001) up = 1;
  else if (pct < -0.001) down = 1;
  else flat = 1;
  if (pct >= upperLimit) zt = 1;
  if (pct <= lowerLimit) dt = 1;
  const isSh = sym.startsWith('sh');
  return { up, down, flat, zt, dt, sh: isSh ? 1 : 0, sz: isSh ? 0 : 1 };
}

// 评分函数（pure）
// 入参：{ up, down, flat, zt, dt }
// 返回：{ total, lddScore, upPctScore, ztScore, details }
function scoreSentiment(stats) {
  const up   = stats.up   || 0;
  const down = stats.down || 0;
  const flat = stats.flat || 0;
  const zt   = stats.zt   || 0;
  const dt   = stats.dt   || 0;
  const totalStocks = up + down + flat;  // 上涨 + 下跌 + 平盘 = 总可交易家数

  // 涨跌停差 0-8 分
  const lddDiff = zt - dt;
  let lddScore = 0;
  if (lddDiff >= 80) lddScore = 8;
  else if (lddDiff >= 30) lddScore = 6;
  else if (lddDiff >= 0) lddScore = 4;
  else if (lddDiff >= -30) lddScore = 2;

  // 上涨家数占比 0-8 分
  const upPct = totalStocks > 0 ? (up / totalStocks) * 100 : 0;
  let upPctScore = 0;
  if (upPct >= 80) upPctScore = 8;
  else if (upPct >= 60) upPctScore = 6;
  else if (upPct >= 40) upPctScore = 4;
  else if (upPct >= 20) upPctScore = 2;

  // 涨停绝对数量 0-4 分
  let ztScore = 0;
  if (zt >= 80) ztScore = 4;
  else if (zt >= 40) ztScore = 3;
  else if (zt >= 20) ztScore = 2;
  else if (zt > 0) ztScore = 1;

  const total = lddScore + upPctScore + ztScore;

  return {
    total: total,
    lddScore: lddScore,
    upPctScore: upPctScore,
    ztScore: ztScore,
    lddDiff: lddDiff,
    upPct: upPct,
    totalStocks: totalStocks,
    breakdown: '涨跌停差 ' + lddScore + ' + 上涨占比 ' + upPctScore + ' + 涨停数 ' + ztScore
  };
}

// 主入口：拉取全市场数据并计算评分
async function getSentimentSnapshot() {
  const cacheKey = 'sentiment:snapshot';
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  // 第一步：拉第 1 页确认总数
  const firstPage = await fetchStocksPage(1, 100);
  if (firstPage.length === 0) {
    throw new Error('新浪 A 股列表返回为空，可能已下线');
  }

  // 新浪接口实际限制：单次最多返回 100 条，需分页拉取
  // 先拉前 5 页（共 500 只）估算比例
  // 然后分批拉剩余页（每批 10 页并发，避免触发限流）
  const totalPages = 55;  // 5200 / 100 = 52，预留 3 页
  const BATCH = 10;       // 每批并发 10 页
  let allStocks = firstPage;

  for (let start = 2; start <= totalPages; start += BATCH) {
    const end = Math.min(start + BATCH - 1, totalPages);
    const pagePromises = [];
    for (let p = start; p <= end; p++) {
      pagePromises.push(
        fetchStocksPage(p, 100).catch(e => ({ error: e.message, _page: p }))
      );
    }
    const results = await Promise.all(pagePromises);
    for (const r of results) {
      if (Array.isArray(r) && r.length > 0) {
        allStocks = allStocks.concat(r);
      } else if (r && Array.isArray(r) && r.length === 0) {
        // 空页说明已到末尾，停止后续分页
        break;
      }
    }
    // 如果某批所有页都返回空，说明拉取完成
    const allEmpty = results.every(r => Array.isArray(r) && r.length === 0);
    if (allEmpty) break;
  }

  // 第二步：统计全市场
  const merged = { up: 0, down: 0, flat: 0, zt: 0, dt: 0 };
  const shStats = { up: 0, down: 0, flat: 0, zt: 0, dt: 0 };
  const szStats = { up: 0, down: 0, flat: 0, zt: 0, dt: 0 };

  for (const stock of allStocks) {
    const c = classifyStock(stock);
    merged.up += c.up;
    merged.down += c.down;
    merged.flat += c.flat;
    merged.zt += c.zt;
    merged.dt += c.dt;
    if (c.sh) {
      shStats.up += c.up;
      shStats.down += c.down;
      shStats.flat += c.flat;
      shStats.zt += c.zt;
      shStats.dt += c.dt;
    } else {
      szStats.up += c.up;
      szStats.down += c.down;
      szStats.flat += c.flat;
      szStats.zt += c.zt;
      szStats.dt += c.dt;
    }
  }

  const score = scoreSentiment(merged);

  const data = {
    sh: shStats,
    sz: szStats,
    merged: merged,
    sampleSize: allStocks.length,  // 实际拉到的股票数（可能略少于全市场）
    score: score,
    source: 'sina/hs_a',
    fetchedAt: new Date().toISOString()
  };

  setCache(cacheKey, data);
  return data;
}

module.exports = { getSentimentSnapshot, scoreSentiment, fetchStocksPage, classifyStock };
