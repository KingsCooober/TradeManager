// 行情数据代理：从腾讯股票 API 获取指数实时行情和 K 线
// 优点：免 Key、稳定、支持 A 股 + 港股
// 字段索引详见 https://stock.gtimg.cn/data/index.php?type=stock
// 数据延迟：约 15 分钟（免费版）

const https = require('https');

// 指数代码（腾讯格式：sh=沪市 sz=深市）
// 4 个大盘指数：symbol 用于腾讯行情接口，secid 用于东方财富 K线接口
// secid 格式: 1.000001 = 沪市(sh)，0.399001 = 深市(sz)
const INDEX_MAP = {
  sh:     { symbol: 'sh000001', secid: '1.000001', name: '上证指数' },
  zza500: { symbol: 'sh000510', secid: '1.000510', name: '中证A500' },
  cyb50:  { symbol: 'sz399673', secid: '0.399673', name: '创业板50' },
  kc50:   { symbol: 'sh000688', secid: '1.000688', name: '科创50' }
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
// ★ 强制 IPv4：东方财富 push2his 在 Node https 模块走 IPv6 时偶尔 socket hang up
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('Too many redirects'));
    const u = new URL(url);
    const req = https.get({
      host: u.host,
      path: u.pathname + u.search,
      family: 4,   // ★ 强制 IPv4，避免 push2his 偶发 hang up
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://quote.eastmoney.com/',
        'Connection': 'close'
      },
      timeout: 15000
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
// 全局串行锁：避免对 push2his.eastmoney.com 短时间并发请求触发 WAF/限流
// 同一时刻只允许 1 个请求到该 host，后续请求排队等待
// ★ 修复：之前用 promise chain + 闭包 release 变量实现的"伪锁"在第 2 次
//   调用时会死锁（因为内层 release 被覆盖后，链上的 next 永远 pending）。
//   改用最直观的 mutex：locked 标志 + 等待队列，O(1) 且无死锁。
let _emLocked = false;
let _emWaiters = [];
function acquireEMLock() {
  if (!_emLocked) {
    _emLocked = true;
    return Promise.resolve();
  }
  return new Promise(function(resolve) { _emWaiters.push(resolve); });
}
function releaseEMLock() {
  const next = _emWaiters.shift();
  if (next) {
    // 链上还有等待者：直接把锁交给它（_emLocked 保持 true）
    next();
  } else {
    _emLocked = false;
  }
}

// 腾讯 K线接口：web.ifzq.gtimg.cn 可用
// day 数组字段：[日期, 开, 收, 高, 低, 成交额(元), 成交量(手), 涨跌幅%, ...]
// 重要：当 param 末尾带 ,qfq 时返回 qfqday（前复权），不带时返回 day（不复权）。
// 旧代码只查 day 会导致个股/指数都报"无 day 数组"——实际是字段名错了。
// 限制：单次最多返回 640 行（约 2.5 年），超过需要分页（见 fetchKLineFromTencentPaginated）
async function fetchKLineFromTencent(symbol, count) {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    encodeURIComponent(symbol + ',day,,,' + count + ',qfq');
  const buf = await httpsGet(url);
  if (buf.length === 0) throw new Error('腾讯K线接口返回空');
  const json = JSON.parse(buf.toString('utf8'));
  if (json.code !== 0) throw new Error('腾讯K线返回 code=' + json.code);
  const symData = json.data && json.data[symbol];
  if (!symData) throw new Error('腾讯K线无 ' + symbol + ' 数据');
  // 兼容：qfqday（带,qfq 时）/ day（不带时）
  const arr = symData.qfqday || symData.day;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('腾讯K线无 day 数组');
  return arr.map(function(line) {
    return {
      date:   line[0],
      open:   parseFloat(line[1]),
      close:  parseFloat(line[2]),
      high:   parseFloat(line[3]),
      low:    parseFloat(line[4]),
      amount: parseFloat(line[5]) || 0,  // 成交额（元）
      volume: parseFloat(line[6]) || 0   // 成交量（手）
    };
  });
}

// 腾讯 K线分页：单次上限 640 行，按 [startDate, endDate] 区间请求
// 用于回测等需要 >2.5 年历史的场景
async function fetchKLineFromTencentPaginated(symbol, startDate, endDate) {
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    encodeURIComponent(symbol + ',day,' + startDate + ',' + endDate + ',640,qfq');
  const buf = await httpsGet(url);
  if (buf.length === 0) throw new Error('腾讯K线分页接口返回空');
  const json = JSON.parse(buf.toString('utf8'));
  if (json.code !== 0) throw new Error('腾讯K线分页返回 code=' + json.code);
  const symData = json.data && json.data[symbol];
  if (!symData) throw new Error('腾讯K线分页无 ' + symbol + ' 数据');
  const arr = symData.qfqday || symData.day;
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('腾讯K线分页无 day 数组');
  return arr.map(function(line) {
    return {
      date:   line[0],
      open:   parseFloat(line[1]),
      close:  parseFloat(line[2]),
      high:   parseFloat(line[3]),
      low:    parseFloat(line[4]),
      amount: parseFloat(line[5]) || 0,
      volume: parseFloat(line[6]) || 0
    };
  });
}

// symbol → secid 转换（用于东方财富 K线接口）
// 1.xxxxxx = 沪市(sh)，0.xxxxxx = 深市(sz)，116.xxxxxx = 北交所(bj)
function symbolToSecid(symbol) {
  if (!symbol) return null;
  if (symbol.startsWith('sh')) return '1.' + symbol.slice(2);
  if (symbol.startsWith('sz')) return '0.' + symbol.slice(2);
  if (symbol.startsWith('bj')) return '116.' + symbol.slice(2);
  return null;
}

async function fetchKLine(symbol, count = 30) {
  // 默认走腾讯（可访问）；东方财富 push2his 经常 socket hang up，仅作回退
  // 兼容 INDEX_MAP 中的指数（带 name 元信息），也支持任意 sh/sz/bj 个股
  const meta = Object.values(INDEX_MAP).find(function(m) { return m.symbol === symbol; });
  const displayName = meta ? meta.name : null;
  const secid = symbolToSecid(symbol);
  if (!secid) throw new Error('K线接口不支持的代码: ' + symbol);

  // 1) 腾讯
  try {
    const data = await fetchKLineFromTencent(symbol, count);
    if (displayName && data.length > 0) data[0].__name = displayName; // 透传 name
    return data;
  } catch (e1) {
    console.warn('[fetchKLine] 腾讯失败，回退东方财富: ' + e1.message);
  }

  // 2) 东方财富 push2his
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&klt=101&fqt=0&end=20991231&lmt=' + count;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await acquireEMLock();
    try {
      const buf = await httpsGet(url);
      if (buf.length < 200 || buf[0] !== 0x7B) {
        throw new Error('返回非JSON (length=' + buf.length + ')');
      }
      const json = JSON.parse(buf.toString('utf8'));
      if (!json.data || !Array.isArray(json.data.klines)) {
        releaseEMLock(); return [];
      }
      const result = json.data.klines.map(function(line) {
        const f = line.split(',');
        return {
          date:   f[0],
          open:   parseFloat(f[1]),
          close:  parseFloat(f[2]),
          high:   parseFloat(f[3]),
          low:    parseFloat(f[4]),
          volume: parseFloat(f[5]) || 0,
          amount: parseFloat(f[6]) || 0
        };
      });
      releaseEMLock();
      return result;
    } catch (e) {
      releaseEMLock();
      lastErr = e;
      console.warn('[fetchKLine] 东方财富 ' + symbol + ' attempt ' + attempt + ' failed: ' + e.message);
      if (attempt < 3) await new Promise(function(r) { setTimeout(r, 1000 + 2000 * attempt); });
    }
  }
  throw lastErr;
}

// 计算 N 日均价（用最近 N 天收盘价平均）
function ma(klines, n) {
  if (!klines || klines.length < n) return null;
  const slice = klines.slice(-n);
  const sum = slice.reduce((s, k) => s + k.close, 0);
  return sum / slice.length;
}

// ==================== 均线/MACD 状态自动识别 ====================
// 与前端 SCORE_MA_MAP / SCORE_MACD_MAP 一一对应，必须保持 label 字符串完全一致
// MA 状态（基于最近 2 个交易日的 MA5/MA10 对比）：
//   5-10金叉：今日 MA5 > MA10 且昨日 MA5 <= MA10（向上穿越）
//   5-10死叉：今日 MA5 < MA10 且昨日 MA5 >= MA10（向下穿越）
//   5-10粘合：|MA5 - MA10| / MA10 <= 0.5%  （窄幅粘合，方向待选择）
//   多头排列：MA5 > MA10 持续（无穿越）
//   空头排列：MA5 < MA10 持续（无穿越）
// MACD 状态（基于最近 2 个交易日的 DIF/DEA 对比 + MACD 柱变化）：
//   水上金叉：DIF > DEA 且 DIF 上穿 DEA 且今日 MACD 柱 > 0
//   水上死叉：DIF < DEA 且 DIF 下穿 DEA 且昨日 MACD 柱 > 0
//   水上多头：DIF > 0, DEA > 0, MACD 柱 > 0
//   水上空头：DIF < 0, DEA > 0（DIF 下穿 0 轴中）
//   水上顶背离：DIF > 0, DEA > 0, MACD 柱缩短（红柱变短，趋势减弱）
//   水下金叉：DIF > DEA 且 DIF 上穿 DEA 且今日 MACD 柱可能仍 < 0
//   水下死叉：DIF < DEA 且 DIF 下穿 DEA
//   水下多头：DIF > 0, DEA < 0（弱势转强中）
//   水下空头：DIF < 0, DEA < 0, MACD 柱 < 0
//   水下底背离：DIF < 0, DEA < 0, MACD 柱缩短（绿柱变短，酝酿反弹）
// 注：因 K 线最新一根可能尚未收盘，使用"昨日 + 前昨日"组合作为对比基准
function detectMaState(klines) {
  if (!klines || klines.length < 11) return '';
  const closes = klines.map(k => k.close);
  const fullMA5  = calcMA(closes, 5);
  const fullMA10 = calcMA(closes, 10);
  const cur5  = fullMA5[fullMA5.length  - 1];
  const cur10 = fullMA10[fullMA10.length - 1];
  const prev5  = fullMA5[fullMA5.length  - 2];
  const prev10 = fullMA10[fullMA10.length - 2];
  if (cur5 == null || cur10 == null || prev5 == null || prev10 == null) return '';

  // 金叉：今天 MA5 > MA10，昨天 MA5 <= MA10
  if (cur5 > cur10 && prev5 <= prev10) return '5-10金叉';
  // 死叉：今天 MA5 < MA10，昨天 MA5 >= MA10
  if (cur5 < cur10 && prev5 >= prev10) return '5-10死叉';
  // 粘合：|差| / MA10 <= 0.5%
  const diffPct = Math.abs(cur5 - cur10) / cur10;
  if (diffPct <= 0.005) return '5-10粘合';
  // 多头排列：MA5 > MA10 持续
  if (cur5 > cur10 && prev5 >= prev10) return '多头排列';
  // 空头排列：MA5 < MA10 持续
  if (cur5 < cur10 && prev5 <= prev10) return '空头排列';
  return '';
}

function detectMacdState(klines) {
  if (!klines || klines.length < 27) return '';
  const closes = klines.map(k => k.close);
  const m = calcMACD(closes);
  const dif = m.dif, dea = m.dea, macd = m.macd;
  const n = dif.length;
  const curDif = dif[n - 1], curDea = dea[n - 1], curMacd = macd[n - 1];
  const prevDif = dif[n - 2], prevDea = dea[n - 2], prevMacd = macd[n - 2];
  if (curDif == null || curDea == null || prevDif == null || prevDea == null) return '';

  const curMacdPos  = curMacd > 0;
  const prevMacdPos = prevMacd > 0;
  const difCrossUp   = curDif > curDea && prevDif <= prevDea;  // DIF 上穿 DEA
  const difCrossDown = curDif < curDea && prevDif >= prevDea;  // DIF 下穿 DEA
  const bothAboveZero = curDif > 0 && curDea > 0;
  const bothBelowZero = curDif < 0 && curDea < 0;
  const macdShrink   = Math.abs(curMacd) < Math.abs(prevMacd); // 柱变短

  if (bothAboveZero) {
    if (difCrossUp)            return '水上金叉';
    if (difCrossDown)          return '水上死叉';
    if (curMacdPos && macdShrink) return '水上顶背离';
    if (curMacdPos)            return '水上多头';
    return '水上空头';
  }
  if (bothBelowZero) {
    if (difCrossUp)            return '水下金叉';
    if (difCrossDown)          return '水下死叉';
    if (curMacdPos)            return '水下多头';
    if (macdShrink)            return '水下底背离';
    return '水下空头';
  }
  // DIF、DEA 异侧（穿过 0 轴过程中）
  if (curDif > 0 && curDea < 0) {
    if (difCrossUp)  return '水上金叉';
    return '水下多头';
  }
  if (curDif < 0 && curDea > 0) {
    if (difCrossDown) return '水上死叉';
    return '水上空头';
  }
  // 单 0 轴（DIF 或 DEA 之一为 0）
  if (curDif > 0 || curDea > 0) return curMacdPos ? '水上多头' : '水上空头';
  return curMacdPos ? '水下多头' : '水下空头';
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
// 构造 K线快照的核心逻辑（被 getKLineSnapshot / getKLineSnapshotForSymbol 共用）
// 入参：symbol, name, count
// 返回：{ key/symbol, name, symbol, count, dates[], ohlc[], volumes[], ma5/10/20[], macd:{dif,dea,macd}[] }
async function buildKLineSnapshot(symbol, name, count) {
  // 1. 拉取 K线原始数据（多取 35 根用于计算 MA26/MACD 的预热期）
  //    腾讯单次最多 640 行，超过则按 2.5 年/段自动分页
  const rawKlines = await fetchKLineWithPagination(symbol, count + 35);
  if (rawKlines.length === 0) throw new Error('K线数据为空');

  // 透传 name（fetchKLine 把 INDEX_MAP 的 name 挂到首条 __name）
  const finalName = name || (rawKlines[0] && rawKlines[0].__name) || symbol;

  // 2. 截取最后 count 根作为主数据，前面 pre 根用于指标预热
  const klines = rawKlines.slice(-count);
  const dates = klines.map(k => k.date);
  const ohlc  = klines.map(k => [k.open, k.close, k.low, k.high]);
  // 成交额：k.amount（腾讯返回的是元）→ 转为万元
  const amounts = klines.map(k => Math.round((k.amount || 0) / 10000));

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

  return {
    name:    finalName,
    symbol:  symbol,
    count:   count,
    dates:   dates,
    ohlc:    ohlc,
    volumes: amounts,   // 兼容字段名（前端仍用 data.volumes）
    amounts: amounts,   // 语义化字段名（万元）
    ma5:     ma5,
    ma10:    ma10,
    ma20:    ma20,
    macd:    { dif: dif, dea: dea, macd: macd },
    fetchedAt: new Date().toISOString()
  };
}

// K线分页拉取：自动判断单次/多次
// count <= 640：单次 fetchKLine
// count >  640：先用 fetchKLine 拉最近 count 行（拿到最新日期 endDate），
//               再向前按 2.5 年/段分页拉，最后合并去重排序
async function fetchKLineWithPagination(symbol, count) {
  if (count <= 640) {
    return await fetchKLine(symbol, count);
  }

  // 先取最近 640 行拿到 endDate 和名称信息
  const firstBatch = await fetchKLine(symbol, 640);
  if (firstBatch.length === 0) return firstBatch;

  const endDate = firstBatch[firstBatch.length - 1].date;
  const name = firstBatch[0].__name;

  // 估算还需多少段：每段 640 行，向上取整
  const totalBatches = Math.ceil(count / 640);
  const allBatches = [firstBatch];

  for (let i = 1; i < totalBatches; i++) {
    // 上一段最旧日期的前一天 = 下一段 endDate
    const prevStartDate = allBatches[allBatches.length - 1][0].date;
    const prevEndDate   = allBatches[allBatches.length - 1][allBatches[allBatches.length - 1].length - 1].date;
    // 下一段：startDate 推到比 prevStartDate 更早的某个日期，endDate = prevStartDate
    // 用 prevStartDate 的前一天作为新段的 endDate
    const segEnd = prevStartDate; // 取到这前一天为止（不重叠）
    const segStart = subtractYears(segEnd, 3); // 向前 3 年一段（每段实际最多 640）
    try {
      const seg = await fetchKLineFromTencentPaginated(symbol, segStart, segEnd);
      if (seg.length === 0) break;
      // 透传 name
      if (name && seg.length > 0) seg[0].__name = name;
      // 去除与已有数据重叠的部分（按日期）
      const lastOldDate = allBatches[allBatches.length - 1][0].date;
      const deduped = seg.filter(k => k.date < lastOldDate);
      if (deduped.length === 0) break;
      allBatches.unshift(deduped);
      // 如果这一段没填满 640，说明已经到历史最远了
      if (deduped.length < 600) break;
    } catch (e) {
      console.warn('[fetchKLineWithPagination] 分页失败: ' + e.message);
      break;
    }
  }

  // 合并 + 按日期升序 + 截取 count
  const merged = [].concat(...allBatches).sort((a, b) => a.date.localeCompare(b.date));
  return merged.slice(-count);
}

// 日期减 N 年（YYYY-MM-DD → YYYY-MM-DD）
function subtractYears(dateStr, years) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function getKLineSnapshot(key, count = 120) {
  const meta = INDEX_MAP[key];
  if (!meta) throw new Error('Unknown index key: ' + key);

  const cacheKey = 'kline:' + key + ':' + count;
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ key: key, cached: true }, cached);

  const data = await buildKLineSnapshot(meta.symbol, meta.name, count);
  data.key = key;
  setCache(cacheKey, data);
  return data;
}

// 单只个股 K线（symbol=sh600000 / sz000001 / bj8xxxxxx）
// 与 getKLineSnapshot 输出结构一致，额外带 key=null（标识非指数）
async function getKLineSnapshotForSymbol(symbol, count = 1200) {
  const cacheKey = 'kline-stock:' + symbol + ':' + count;
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ key: null, cached: true }, cached);

  const data = await buildKLineSnapshot(symbol, null, count);
  data.key = null;
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
    maState:  detectMaState(klines),
    macdState: detectMacdState(klines),
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
      maState:  detectMaState(klines),
      macdState: detectMacdState(klines),
      klineCount: klines.length
    };
  });

  const result = { data, fetchedAt: new Date().toISOString() };
  setCache(cacheKey, result);
  return result;
}

// ==================== 沪深两市总成交额 ====================
// 沪市总成交 ≈ 上证指数 sh000001 的 amount 字段（万元）
// 深市总成交 ≈ 深证成指 sz399001 的 amount 字段（万元）
// 两市合计返回 = sh000001.amount + sz399001.amount（单位：万元）
// 缓存 5 分钟（与指数行情共用一个 cache，便于复用 fetchQuotes 的结果）
const MARKET_AMOUNT_SYMBOLS = ['sh000001', 'sz399001'];

async function fetchMarketTotalAmount() {
  // 复用指数行情的 5 分钟缓存：fetchQuotes 内部会走 https
  const quotes = await fetchQuotes(MARKET_AMOUNT_SYMBOLS);
  const shAmount = (quotes.sh000001 && quotes.sh000001.amount) || 0; // 万元
  const szAmount = (quotes.sz399001 && quotes.sz399001.amount) || 0; // 万元
  return {
    shWan: shAmount,
    szWan: szAmount,
    totalWan: shAmount + szAmount,
    shYi: shAmount / 1e4,
    szYi: szAmount / 1e4,
    totalYi: (shAmount + szAmount) / 1e4,
    fetchedAt: new Date().toISOString()
  };
}

module.exports = {
  getIndexMarket,
  getAllIndicesMarket,
  fetchMarketTotalAmount,
  fetchKLine,
  fetchQuotes,
  getKLineSnapshot,
  getKLineSnapshotForSymbol,
  INDEX_MAP
};
