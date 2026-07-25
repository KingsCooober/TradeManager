// 行情数据代理：从腾讯股票 API 获取指数实时行情和 K 线
// 优点：免 Key、稳定、支持 A 股 + 港股
// 字段索引详见 https://stock.gtimg.cn/data/index.php?type=stock
// 数据延迟：约 15 分钟（免费版）

const https = require('https');

// 指数代码（腾讯格式：sh=沪市 sz=深市）
const INDEX_MAP = {
  sh:     { symbol: 'sh000001', name: '上证指数' },
  zza500: { symbol: 'sh000510', name: '中证A500' },
  cyb50:  { symbol: 'sz399673', name: '创业板50' },
  kc50:   { symbol: 'sh000688', name: '科创50' }
};

// 5 分钟内存缓存
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

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

// 通用 HTTPS GET（响应可能是 GBK 编码的纯文本也可能是 UTF-8 JSON）
function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://gu.qq.com/',
        'Connection': 'keep-alive'
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

// GBK → UTF-8
function decodeGBK(buf) {
  try {
    const { iconv } = require('iconv-lite');
    return iconv.decode(buf, 'gbk');
  } catch (e) {
    // 退化方案：node 18+ 内置 TextDecoder 支持 gb18030
    return new TextDecoder('gb18030').decode(buf);
  }
}

// 1) 实时行情（多只指数一次性获取）
// 响应：v_sh000001="...";v_sz399673="...";
// 字段按 ~ 分割：[0]市场 [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开
//                [6]成交量(手) [7-30]买卖盘 [31]涨跌额 [32]涨跌幅%
//                [33]最高 [34]最低 [37]成交额(万元) [38]换手率% [39]市盈率
async function fetchQuotes(symbols) {
  const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
  const buf = await httpsGet(url);
  const text = decodeGBK(buf);

  const result = {};
  // 解析每行 v_xxxxxx="..."
  const re = /v_(\w+)="([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const symbol = m[1];
    const fields = m[2].split('~');
    if (fields.length < 40) continue;
    result[symbol] = {
      price:        parseFloat(fields[3])  || null,
      prevClose:    parseFloat(fields[4])  || null,
      open:         parseFloat(fields[5])  || null,
      volume:       parseFloat(fields[6])  || null,    // 手
      change:       parseFloat(fields[31]) || null,    // 元
      changePct:    parseFloat(fields[32]) || null,    // %
      high:         parseFloat(fields[33]) || null,
      low:          parseFloat(fields[34]) || null,
      amount:       parseFloat(fields[37]) || null,    // 万元
      turnover:     parseFloat(fields[38]) || null,    // 换手率%
      pe:           parseFloat(fields[39]) || null,    // 市盈率
      timestamp:    fields[30] || null
    };
  }
  return result;
}

// 2) 日 K 线（用于计算 N 日均价）
// 字段：[日期, 开, 收, 高, 低, 成交额, [成交量?], 振幅, 涨跌幅, 换手率]
async function fetchKLine(symbol, count = 30) {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,' + count + ',qfq';
  const buf = await httpsGet(url);
  const text = decodeGBK(buf);
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error('K线 JSON 解析失败: ' + e.message); }
  const arr = json && json.data && json.data[symbol] && json.data[symbol].day;
  if (!Array.isArray(arr)) return [];
  return arr.map(row => ({
    date:   row[0],
    open:   parseFloat(row[1]),
    close:  parseFloat(row[2]),
    high:   parseFloat(row[3]),
    low:    parseFloat(row[4]),
    amount: parseFloat(row[5])
  }));
}

// 计算 N 日均价（用最近 N 天收盘价平均）
function ma(klines, n) {
  if (!klines || klines.length < n) return null;
  const slice = klines.slice(-n);
  const sum = slice.reduce((s, k) => s + k.close, 0);
  return sum / slice.length;
}

// ==================== 技术指标计算 ====================
// 简单移动平均线（返回与 klines 等长数组，前 n-1 位置为 null）
function calcMA(closes, n) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < n) return result;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += closes[i];
  result[n - 1] = sum / n;
  for (let i = n; i < closes.length; i++) {
    sum += closes[i] - closes[i - n];
    result[i] = sum / n;
  }
  return result;
}

// 指数移动平均（递归），返回与 closes 等长数组
function calcEMA(closes, n) {
  const result = new Array(closes.length).fill(null);
  if (closes.length === 0) return result;
  const k = 2 / (n + 1);
  // 第一个值用 closes[0] 初始化（业界常见做法）
  result[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// MACD(12, 26, 9)：返回 { dif, dea, macd }，每个数组与 closes 等长
// dif = EMA12 - EMA26, dea = EMA9(dif), macd = (dif - dea) * 2
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const dif = closes.map((_, i) => (ema12[i] != null && ema26[i] != null) ? (ema12[i] - ema26[i]) : null);
  const difValid = dif.filter(v => v != null);
  const deaRaw = calcEMA(difValid, 9);
  // deaRaw 长度 = difValid 长度，需要对齐到 closes
  const offset = closes.length - difValid.length;
  const dea = new Array(closes.length).fill(null);
  for (let i = 0; i < deaRaw.length; i++) dea[offset + i] = deaRaw[i];
  const macd = closes.map((_, i) => (dif[i] != null && dea[i] != null) ? (dif[i] - dea[i]) * 2 : null);
  return { dif, dea, macd };
}

// ==================== K线完整快照（含技术指标） ====================
// 入参：key - 指数 key (sh/zza500/cyb50/kc50)，count - 根数 (默认 120)
// 返回：{ key, name, symbol, dates[], ohlc[], volumes[], ma5/10/20[], macd: {dif,dea,macd}[] }
async function getKLineSnapshot(key, count = 120) {
  const meta = INDEX_MAP[key];
  if (!meta) throw new Error('Unknown index key: ' + key);

  const cacheKey = 'kline:' + key + ':' + count;
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  // 1. 拉取 K线原始数据（多取 35 根用于计算 MA26/MACD 的预热期）
  const rawKlines = await fetchKLine(meta.symbol, count + 35);
  if (rawKlines.length === 0) throw new Error('K线数据为空');

  // 2. 截取最后 count 根作为主数据，前面 pre 根用于指标预热
  const klines = rawKlines.slice(-count);
  const dates = klines.map(k => k.date);
  const ohlc  = klines.map(k => [k.open, k.close, k.low, k.high]);  // ECharts candlestick 顺序
  // 成交量（用成交额万元代替，原数据是元）
  const volumes = klines.map(k => Math.round((k.amount || 0) / 10000));

  // 3. 计算指标（基于完整 pre+count 序列保证 MA26/MACD 正确）
  const fullCloses = rawKlines.map(k => k.close);
  const fullMA5    = calcMA(fullCloses, 5);
  const fullMA10   = calcMA(fullCloses, 10);
  const fullMA20   = calcMA(fullCloses, 20);
  const fullMACD   = calcMACD(fullCloses);

  // 4. 截取最后 count 根对齐
  const preLen = rawKlines.length - count;
  const ma5   = fullMA5.slice(preLen);
  const ma10  = fullMA10.slice(preLen);
  const ma20  = fullMA20.slice(preLen);
  const dif   = fullMACD.dif.slice(preLen);
  const dea   = fullMACD.dea.slice(preLen);
  const macd  = fullMACD.macd.slice(preLen);

  const data = {
    key:     key,
    name:    meta.name,
    symbol:  meta.symbol,
    count:   count,
    dates:   dates,
    ohlc:    ohlc,
    volumes: volumes,
    ma5:     ma5,
    ma10:    ma10,
    ma20:    ma20,
    macd:    { dif: dif, dea: dea, macd: macd },
    fetchedAt: new Date().toISOString()
  };

  setCache(cacheKey, data);
  return data;
}

// 入口：单只指数的完整行情
async function getIndexMarket(key) {
  const meta = INDEX_MAP[key];
  if (!meta) throw new Error('Unknown index key: ' + key);

  const cacheKey = 'idx:' + key;
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  const [quotes, klines] = await Promise.all([
    fetchQuotes([meta.symbol]),
    fetchKLine(meta.symbol, 60)
  ]);

  const quote = quotes[meta.symbol] || {};

  const data = {
    key: key,
    name: meta.name,
    symbol: meta.symbol,
    quote: quote,
    ma5:   ma(klines, 5),
    ma10:  ma(klines, 10),
    ma20:  ma(klines, 20),
    ma60:  ma(klines, 60),
    klineCount: klines.length,
    fetchedAt: new Date().toISOString()
  };

  setCache(cacheKey, data);
  return data;
}

// 批量：一次获取所有指数（前端轮询用，避免 4 次串行请求）
async function getAllIndicesMarket() {
  const symbols = Object.values(INDEX_MAP).map(m => m.symbol);
  const cacheKey = 'all:indices';

  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ cached: true }, cached);

  const quotes = await fetchQuotes(symbols);
  const klinePromises = symbols.map(s => fetchKLine(s, 60).then(kl => [s, kl]));

  const klineResults = await Promise.all(klinePromises);
  const klinesBySymbol = Object.fromEntries(klineResults);

  const data = {};
  Object.keys(INDEX_MAP).forEach(key => {
    const meta = INDEX_MAP[key];
    const quote = quotes[meta.symbol] || {};
    const klines = klinesBySymbol[meta.symbol] || [];
    data[key] = {
      key: key,
      name: meta.name,
      symbol: meta.symbol,
      quote: quote,
      ma5:   ma(klines, 5),
      ma10:  ma(klines, 10),
      ma20:  ma(klines, 20),
      ma60:  ma(klines, 60),
      klineCount: klines.length
    };
  });

  const result = { data, fetchedAt: new Date().toISOString() };
  setCache(cacheKey, result);
  return result;
}

module.exports = { getIndexMarket, getAllIndicesMarket, getKLineSnapshot, INDEX_MAP };
