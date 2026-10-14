// 行情数据代理：从腾讯股票 API 获取指数实时行情和 K 线
// 优点：免 Key、稳定、支持 A 股 + 港股
// 字段索引详见 https://stock.gtimg.cn/data/index.php?type=stock
// 数据延迟：约 15 分钟（免费版）

const https = require('https');
const path  = require('path');

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

// ==================== K 线持久化缓存（重启不失效） ====================
// 背景：原来只有 5 分钟内存缓存，服务一重启就全丢；而 K 线数据（尤其 10 年）
//   虽然单次只需 200ms 左右，但每次切标的/改年数都要重新打上游，
//   叠加"上游限流 + 网络抖动"就会明显变慢。
// 设计：
//   - 只缓存 K 线（数据量大、变化慢、按天更新），不缓存实时行情
//   - 落盘到 server/cache/kline-<hash>.json，进程内仍有内存层做一级缓存
//   - TTL 用"自然日"判断：当天已拉过就直接复用，跨天自动失效
//     （日 K 线一天只可能多出一根，跨天重新拉即可，不需要更细的粒度）
//   - 任何 IO 异常都静默降级为"不缓存"，绝不能影响主流程
const fs   = require('fs');
const crypto = require('crypto');
const DISK_CACHE_DIR = path.join(__dirname, 'cache');
const DISK_CACHE_ENABLED = process.env.KLINE_DISK_CACHE !== '0';   // 可用环境变量关闭

function _diskCacheFile(key) {
  const h = crypto.createHash('md5').update(key).digest('hex').slice(0, 16);
  return path.join(DISK_CACHE_DIR, 'kline-' + h + '.json');
}

/** 读磁盘缓存；只在"同一自然日"内有效 */
function getDiskCache(key) {
  if (!DISK_CACHE_ENABLED) return null;
  try {
    const file = _diskCacheFile(key);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !raw.ts || !raw.data) return null;
    // 自然日比较：跨天即失效
    const sameDay = new Date(raw.ts).toDateString() === new Date().toDateString();
    if (!sameDay) return null;
    return raw.data;
  } catch (e) {
    return null;   // 读失败/文件损坏 → 当作没有缓存
  }
}

/** 写磁盘缓存（异步，不阻塞主流程；失败静默） */
function setDiskCache(key, data) {
  if (!DISK_CACHE_ENABLED) return;
  try {
    if (!fs.existsSync(DISK_CACHE_DIR)) fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
    const file = _diskCacheFile(key);
    const payload = JSON.stringify({ ts: Date.now(), key: key, data: data });
    // 原子写：先写临时文件再 rename，避免写一半被读到损坏内容
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFile(tmp, payload, function(err) {
      if (err) return;
      fs.rename(tmp, file, function() { /* 忽略 */ });
    });
  } catch (e) { /* 静默降级 */ }
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
      // 不强制 IPv4，让系统根据 DNS 自动选 A/AAAA 记录
      //   原因：东方财富 push2his / push2 在不同地区 DNS 返回 IPv6 only
      //   而 web.ifzq.gtimg.cn（腾讯）始终返回 IPv4
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
      name:         fields[1] || null,    // ★ 股票/指数名称
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

// 新浪行情 fallback（腾讯返回 missing 时使用）
//   入参：symbols = ['sh600000', 'sz000001', ...]
//   出参：{ 'sh600000': '浦发银行', ... }（找不到的 key 不会出现）
// 把用户输入归一化为 shXXXXXX / szXXXXXX
//   支持：sh600000 / 600000 / SZ000001 / 600000.SH 等常见写法
//   纯 6 位数字按 A 股代码段推断交易所：
//     6/9 开头 → 沪市；0/2/3 开头 → 深市；4/8 开头（北交所/三板）不推断
//   返回 null 表示无法归一化（需要走名称搜索）
function normalizeSymbol(input) {
  const raw = String(input == null ? '' : input).trim().toLowerCase();
  if (!raw) return null;
  // 已带前缀
  let m = raw.match(/^(sh|sz)\s*(\d{6})$/);
  if (m) return m[1] + m[2];
  // 后缀写法 600000.sh / 000001.sz
  m = raw.match(/^(\d{6})\s*\.\s*(sh|sz)$/);
  if (m) return m[2] + m[1];
  // 纯 6 位数字 → 按代码段推断
  m = raw.match(/^(\d{6})$/);
  if (m) {
    const code = m[1];
    const c = code[0];
    if (c === '6' || c === '9') return 'sh' + code;   // 沪市主板/科创板(688)/B股
    if (c === '0' || c === '2' || c === '3') return 'sz' + code;  // 深市主板/创业板
    return null;   // 4/8 开头（北交所/新三板）回测接口不支持
  }
  return null;
}

// 按关键词搜索标的（支持中文名称 / 拼音首字母 / 纯数字代码 / 带前缀代码）
//   数据源：东方财富搜索建议接口 searchapi.eastmoney.com
//   返回：[{ symbol:'sh600000', code:'600000', name:'浦发银行', market:'沪A' }, ...]
//   关键：MktNum=1 → 沪市(sh)，MktNum=0 → 深市(sz)；
//         结果混有板块/三板/港股等，只保留 6 位纯数字的沪深 A 股，
//         因为回测接口只支持 sh/sz 的 A 股 K 线。
async function searchSymbols(keyword, limit = 10) {
  const kw = String(keyword == null ? '' : keyword).trim();
  if (!kw) return [];
  const lim = Math.max(1, Math.min(20, parseInt(limit, 10) || 10));
  const url = 'https://searchapi.eastmoney.com/api/suggest/get'
    + '?input=' + encodeURIComponent(kw)
    + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8'
    + '&count=' + lim;
  const buf = await httpsGet(url);
  let json;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { return []; }
  const table = json && json.QuotationCodeTable;
  const rows = (table && Array.isArray(table.Data)) ? table.Data : [];
  const out = [];
  const seen = {};
  for (const r of rows) {
    if (!r || !r.Code || !r.Name) continue;
    const mkt = String(r.MktNum);
    if (mkt !== '1' && mkt !== '0') continue;          // 排除板块/港股/美股
    const code = String(r.Code);
    if (!/^\d{6}$/.test(code)) continue;               // 排除非 6 位代码
    // 只保留回测接口支持的 A 股代码段：
    //   沪市：60(主板) / 68(科创板) / 90(B股)
    //   深市：00(主板) / 30(创业板) / 20(B股)
    //   排除 4/8 开头（北交所/新三板）—— 东财会以 MktNum=0 返回，但 K 线接口不支持
    const isShA = (mkt === '1') && /^(60|68|90)/.test(code);
    const isSzA = (mkt === '0') && /^(00|30|20)/.test(code);
    if (!isShA && !isSzA) continue;
    const prefix = (mkt === '1') ? 'sh' : 'sz';
    const symbol = prefix + code;
    if (seen[symbol]) continue;
    seen[symbol] = 1;
    out.push({
      symbol,
      code,
      name: String(r.Name),
      market: String(r.SecurityTypeName || (prefix === 'sh' ? '沪A' : '深A')),
      pinyin: String(r.PinYin || '')
    });
    if (out.length >= lim) break;
  }
  return out;
}

//   注意：自动探测 sh/sz 前缀（部分老数据 prefix 可能写反，比如 sh301377 实际是 sz）
//   原因：东方财富/新浪 / 腾讯对同一支股只接受 1 个正确 prefix
async function fetchNamesFromSina(symbols) {
  // 第一遍：用原始 prefix 查
  const originalList = symbols.map(s => s.toLowerCase()).filter(s => /^(sh|sz)\d{6}$/.test(s));
  if (!originalList.length) return {};
  const result = await sinaQuery(originalList);
  // 第二遍：remaining 试反向 prefix
  const remaining = originalList.filter(s => !result[s]);
  if (remaining.length) {
    const flipped = remaining.map(s => (s.startsWith('sh') ? 'sz' : 'sh') + s.slice(2));
    const result2 = await sinaQuery(flipped);
    // 用原始 key 索引回去
    for (let i = 0; i < remaining.length; i++) {
      if (result2[flipped[i]]) result[remaining[i]] = result2[flipped[i]];
    }
  }
  return result;
}

async function sinaQuery(syms) {
  const out = {};
  if (!syms.length) return out;
  // 新浪格式：var hq_str_sh600000=...
  const url = 'https://hq.sinajs.cn/list=' + syms.join(',');
  return new Promise(function(resolve) {
    const req = https.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://finance.sina.com.cn/'
      }
    }, function(res) {
      // 新浪返回 GBK，需要转 UTF-8
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', function() {
        try {
          const buf = Buffer.concat(chunks);
          // 新浪返回 GBK 编码。Node 18+ 自带 TextDecoder('gb18030')
          //   解码后用 utf8 正则匹配
          let text = '';
          try {
            text = new TextDecoder('gb18030').decode(buf);
          } catch (e) {
            // 极端情况下没有 TextDecoder，回退 utf8（数据会乱码但也能拿到 key）
            text = buf.toString('utf8');
          }
          // 正则：hq_str_sh600000="浦发银行,..."   → 排除 "，因为数据里不会有 "
          const re = /hq_str_(\w{2}\d{6})="([^"]+)"/g;
          let m;
          while ((m = re.exec(text)) !== null) {
            const name = m[2].split(',')[0].trim();  // 名称在第一个逗号前
            if (name) out[m[1]] = name;
          }
        } catch (e) {
          console.warn('[sina] 解析失败:', e.message);
        }
        resolve(out);
      });
    });
    req.on('error', function(e) { console.warn('[sina] 请求失败:', e.message); resolve({}); });
    req.on('timeout', function() { req.destroy(); resolve({}); });
  });
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
// 通用腾讯 K线接口（支持 day/week/month 三种周期）
async function fetchKLineFromTencentPeriod(symbol, count, period) {
  // period: 'day' | 'week' | 'month'
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    encodeURIComponent(symbol + ',' + period + ',,,' + count + ',qfq');
  const buf = await httpsGet(url);
  if (buf.length === 0) throw new Error('腾讯K线接口返回空');
  const json = JSON.parse(buf.toString('utf8'));
  if (json.code !== 0) throw new Error('腾讯K线返回 code=' + json.code);
  const symData = json.data && json.data[symbol];
  if (!symData) throw new Error('腾讯K线无 ' + symbol + ' 数据');
  // 兼容：qfqday/qfqweek/qfqmonth（前复权） / day/week/month（不复权）
  const key = 'qfq' + period;
  const arr = symData[key] || symData[period];
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('腾讯K线无 ' + period + ' 数组');
  return arr.map(function(line) {
    var close = parseFloat(line[2]);
    var amount = parseFloat(line[5]) || 0;
    var rawVol = parseFloat(line[6]) || 0;
    return {
      date:   line[0],
      open:   parseFloat(line[1]),
      close:  close,
      high:   parseFloat(line[3]),
      low:    parseFloat(line[4]),
      amount: amount,
      // 成交量（手）：腾讯接口 line[6] 经常返回空字符串导致 0，用 amount ÷ close ÷ 100 反算
      volume: rawVol > 0 ? rawVol : (close > 0 ? +((amount / close / 100)).toFixed(2) : 0)
    };
  });
}

// 日线接口封装（保持向后兼容）
async function fetchKLineFromTencent(symbol, count) {
  return fetchKLineFromTencentPeriod(symbol, count, 'day');
}

// ==================== 腾讯「日期区间」分段并发拉取（长历史） ====================
// 背景（实测结论）：
//   - 腾讯接口 param=symbol,day,,,N,qfq 的 N 有硬上限：N<=1000 时返回 641 根，
//     N>=2500 时直接返回 0 根（不是截断，是空数组）。所以想拿 10 年必须换姿势。
//   - 但同样的接口支持日期区间：param=symbol,day,START,END,count,qfq
//     实测 2010-01-01~2011-12-31 → 473 根，92ms；区间查询没有 641 限制。
//   - 4 段并发（每段 ~2.5 年）总耗时仅 140ms，可得 2249 根（约 9.6 年）。
//   对比 Baostock（Python 子进程 + 登录 + 游标）单次 6.7~16 秒，快 50~100 倍。
//
// 策略：把 [startDate, endDate] 按 SEG_YEARS 年切成若干段并发请求，合并去重排序。
//   段数受 MAX_SEGMENTS 限制，避免请求区间过大时打出过多并发。
const TX_SEG_YEARS = 2.5;      // 每段覆盖年数（2.5 年 ≈ 610 个交易日，稳妥低于单次上限）
const TX_MAX_SEGMENTS = 6;     // 最多切几段（6 × 2.5 = 15 年，覆盖 10 年绰绰有余）

/** 腾讯日线「区间」查询：直接指定 [start, end]，不受 641 根上限约束 */
async function fetchKLineFromTencentRange(symbol, startDate, endDate, period) {
  period = period || 'day';
  // 区间查询时 count 传 640（实测传更大也没副作用，但保持与单段上限一致）
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
    encodeURIComponent(symbol + ',' + period + ',' + startDate + ',' + endDate + ',640,qfq');
  const buf = await httpsGet(url);
  if (buf.length === 0) throw new Error('腾讯K线区间接口返回空');
  let json;
  try { json = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('腾讯K线区间返回非 JSON'); }
  if (json.code !== 0) throw new Error('腾讯K线区间返回 code=' + json.code);
  const symData = json.data && json.data[symbol];
  if (!symData) return [];   // 该区间无数据（如股票尚未上市）→ 返回空而不是抛错
  const key = 'qfq' + period;
  const arr = symData[key] || symData[period];
  if (!Array.isArray(arr)) return [];
  return arr.map(function(line) {
    var close = parseFloat(line[2]);
    var amount = parseFloat(line[5]) || 0;
    var rawVol = parseFloat(line[6]) || 0;
    return {
      date:   line[0],
      open:   parseFloat(line[1]),
      close:  close,
      high:   parseFloat(line[3]),
      low:    parseFloat(line[4]),
      amount: amount,
      volume: rawVol > 0 ? rawVol : (close > 0 ? +((amount / close / 100)).toFixed(2) : 0)
    };
  }).filter(function(k) { return k.date && !isNaN(k.close); });
}

/** 把 [startYear..now] 按 TX_SEG_YEARS 切段（返回 [{start,end}] 升序） */
function buildTencentSegments(years) {
  const today = new Date();
  const endY = today.getFullYear();
  const startY = endY - Math.max(1, Math.ceil(years));
  const segs = [];
  for (let y = startY; y < endY + 1; y += TX_SEG_YEARS) {
    const s = Math.floor(y);
    const e = Math.min(endY + 1, Math.ceil(y + TX_SEG_YEARS));
    const start = s + '-01-01';
    // 最后一段用今天作为结束，避免未来日期
    const end = (e > endY ? today.toISOString().slice(0, 10) : (e - 1) + '-12-31');
    segs.push({ start: start, end: end });
  }
  // 段数超限时从最早的段开始合并（保证最近的数据优先精确）
  while (segs.length > TX_MAX_SEGMENTS) {
    const a = segs.shift();
    segs[0].start = a.start;
  }
  return segs;
}

/**
 * 腾讯长历史拉取：分段并发 + 合并去重排序
 * @param {string} symbol sh600000 / sz000001
 * @param {number} years  需要覆盖的年数
 * @param {number} want   期望的根数（用于最终裁剪）
 */
async function fetchKLineFromTencentLong(symbol, years, want) {
  const segs = buildTencentSegments(years);
  const t0 = Date.now();
  // 并发请求所有段；单段失败不影响其它段（返回空数组）
  const parts = await Promise.all(segs.map(function(s) {
    return fetchKLineFromTencentRange(symbol, s.start, s.end, 'day')
      .catch(function(e) {
        console.warn('[tencent-range] 段 ' + s.start + '~' + s.end + ' 失败: ' + e.message);
        return [];
      });
  }));
  // 合并去重（同一天只保留一条）+ 按日期升序
  const byDate = new Map();
  parts.forEach(function(arr) {
    arr.forEach(function(k) { if (!byDate.has(k.date)) byDate.set(k.date, k); });
  });
  const merged = Array.from(byDate.values()).sort(function(a, b) {
    return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
  });
  console.log('[tencent-range] ' + symbol + ' ' + segs.length + ' 段并发 ' +
    (Date.now() - t0) + 'ms，合并后 ' + merged.length + ' 根' +
    (merged.length ? '（' + merged[0].date + ' ~ ' + merged[merged.length - 1].date + '）' : ''));
  if (merged.length === 0) throw new Error('腾讯区间接口未返回任何数据');
  // 裁到最后 want 根（与调用方语义一致）
  return want && merged.length > want ? merged.slice(-want) : merged;
}

// ==================== Baostock（证券宝）数据源 ====================
// 优势：完全免费、免注册、覆盖 1990-至今 全部 A 股日 K线
// 字段：date, open, high, low, close, volume（股）, amount（元）
// 实现：baostock 是 Python 包，通过 child_process 调用 helper 脚本
let _baostockChecked = false;
let _baostockAvailable = false;
let _baostockPython = null;    // 探测到的可用解释器（python3 / python / py）

// ★ 修复：原实现硬编码 `python3`，在 Windows 上 `python3` 往往是
//   应用商店的 0 字节转发器（执行返回 9009），而真正的解释器叫 `python`。
//   结果 baostockCheck() 探测失败后仍被 `pip install` 的"成功"标记为可用，
//   真正拉数据时 spawnSync('python3') 返回 9009 → 抛错 → 静默回退，
//   用户看到的是"选了 10 年只有 2.5 年数据"却毫无提示。
//   现在改为依次探测候选解释器，找到能 `import baostock` 的那个并记住。
const PY_CANDIDATES = ['python3', 'python', 'py'];

function detectPythonWithBaostock() {
  const { execFileSync } = require('child_process');
  for (const py of PY_CANDIDATES) {
    try {
      execFileSync(py, ['-c', 'import baostock'], { stdio: 'pipe', timeout: 20000 });
      console.log('[baostock] 使用解释器: ' + py);
      return py;
    } catch (e) {
      // 该解释器不存在或没装 baostock → 试下一个
    }
  }
  return null;
}

async function baostockCheck() {
  if (_baostockChecked) return _baostockAvailable;
  _baostockChecked = true;

  // 1) 先找已装好 baostock 的解释器
  let py = detectPythonWithBaostock();
  if (py) {
    _baostockAvailable = true;
    _baostockPython = py;
    return true;
  }

  // 2) 都没装 → 用第一个能跑起来的解释器尝试安装
  console.warn('[baostock] 未检测到已安装 baostock 的解释器，尝试安装...');
  const { execFileSync } = require('child_process');
  for (const candidate of PY_CANDIDATES) {
    try {
      execFileSync(candidate, ['-m', 'pip', 'install', 'baostock', '--quiet'],
        { stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      continue;   // 解释器不存在或安装失败 → 试下一个
    }
    // 装完再确认一次真的能 import（避免 pip 成功但装到了别的环境）
    py = detectPythonWithBaostock();
    if (py) {
      console.log('[baostock] 自动安装成功（' + py + '）');
      _baostockAvailable = true;
      _baostockPython = py;
      return true;
    }
  }

  console.warn('[baostock] 不可用（未找到可 import baostock 的 python 解释器）');
  _baostockAvailable = false;
  return false;
}

// Baostock 拉取 A 股日 K线
// 入参：symbol = sh600000 / sz000001 / bj830xxx
//      startDate / endDate = 'YYYY-MM-DD'
//      frequency = 'd' (日) / 'w' (周) / 'm' (月)
//      adjustflag = '3' 不复权 / '2' 前复权 / '1' 后复权
// 返回：[{ date, open, high, low, close, amount, volume }]  按日期升序
//   volume = 手（已 ÷ 100）；amount = 元
async function fetchKLineFromBaostock(symbol, startDate, endDate, frequency, adjustflag) {
  const ok = await baostockCheck();
  if (!ok) throw new Error('baostock 不可用');

  // 把 symbol 转成 baostock 格式：sh600000 → sh.600000
  let bsCode = symbol;
  if (symbol.startsWith('sh') || symbol.startsWith('sz') || symbol.startsWith('bj')) {
    bsCode = symbol.slice(0, 2) + '.' + symbol.slice(2);
  }

  // 通过 child_process 调用 Python 脚本
  // ★ 用探测到的解释器（可能是 python3 / python / py），不再硬编码 python3
  const { spawnSync } = require('child_process');
  const scriptPath = path.join(__dirname, 'baostock-helper.py');
  const py = _baostockPython || 'python';
  const result = spawnSync(py, [
    scriptPath,
    bsCode,
    startDate || '2015-01-01',
    endDate || new Date().toISOString().slice(0, 10),
    frequency || 'd',
    adjustflag || '3'
  ], {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,   // 50MB
    timeout: 60000
  });

  if (result.error) {
    throw new Error('baostock helper 启动失败(' + py + '): ' + result.error.message);
  }
  if (result.status !== 0) {
    throw new Error('baostock helper 失败(' + py + ', status=' + result.status + '): ' +
      (result.stderr || result.stdout || 'unknown'));
  }

  let rows;
  try {
    // baostock helper 会往 stdout 输出 "login success!" 等日志
    // 只取最后一行有效 JSON 解析
    const lines = result.stdout.trim().split('\n').filter(function(l) { return l.trim().length > 0; });
    const lastLine = lines[lines.length - 1];
    rows = JSON.parse(lastLine);
  } catch (e) {
    throw new Error('baostock helper 返回非 JSON: ' + result.stdout.slice(0, 200));
  }

  if (!Array.isArray(rows)) {
    throw new Error('baostock helper 返回非数组: ' + JSON.stringify(rows).slice(0, 200));
  }

  // 转成统一格式：volume = 手（÷ 100），amount = 元
  return rows.map(function(r) {
    const volShares = parseFloat(r.volume) || 0;
    return {
      date:   r.date,
      open:   parseFloat(r.open),
      high:   parseFloat(r.high),
      low:    parseFloat(r.low),
      close:  parseFloat(r.close),
      amount: parseFloat(r.amount) || 0,
      volume: volShares > 0 ? +((volShares / 100)).toFixed(2) : 0
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

// symbol → baostock 代码转换（证券宝的代码格式：sh.600000 / sz.000001 / bj.830xxx）
//   sh/sz 前缀照搬，bj 改成 bj.
function symbolToBaostock(symbol) {
  if (!symbol) return null;
  if (symbol.startsWith('sh')) return 'sh.' + symbol.slice(2);
  if (symbol.startsWith('sz')) return 'sz.' + symbol.slice(2);
  if (symbol.startsWith('bj')) return 'bj.' + symbol.slice(2);
  return null;
}

// 工具：把 YYYY-MM-DD 变成 YYYYMMDD；并返回"前一天"的 YYYYMMDD 字符串
function dayBeforeTencent(dateStr) {
  // dateStr 支持 'YYYY-MM-DD' 或 'YYYYMMDD'
  var y, m, d;
  if (dateStr.indexOf('-') >= 0) {
    var p = dateStr.split('-');
    y = +p[0]; m = +p[1]; d = +p[2];
  } else {
    y = +dateStr.slice(0, 4); m = +dateStr.slice(4, 6); d = +dateStr.slice(6, 8);
  }
  var dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  var yy = dt.getUTCFullYear();
  var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(dt.getUTCDate()).padStart(2, '0');
  return yy + mm + dd;
}

async function fetchKLine(symbol, count = 30, period = 'day') {
  // 数据源优先级（2024 重构）：
  //   1) 腾讯「日期区间」分段并发 —— 实测 10 年 140ms，长历史唯一快路径
  //      （旧写法 param=symbol,day,,,N,qfq 的 N 有硬上限：N>=2500 直接返回 0 根，
  //       这正是"选了 10 年却只有 641 根"的根因之一）
  //   2) 腾讯单次（短历史兜底）
  //   3) Baostock —— 仅当腾讯完全失败时用。它单次 6.7~16 秒（Python 子进程
  //      + 登录 + 游标逐行读），只适合作为最后兜底，不再作为首选。
  const meta = Object.values(INDEX_MAP).find(function(m) { return m.symbol === symbol; });
  const displayName = meta ? meta.name : null;

  // 1) 腾讯区间分段并发（首选）
  try {
    const years = Math.max(1, count / 250 * 1.15);   // 多取 15% 余量，保证裁到 count 根
    const data = await fetchKLineFromTencentLong(symbol, years, count);
    if (data.length > 0) {
      if (displayName) data[0].__name = displayName;
      return data;
    }
    throw new Error('区间接口返回空');
  } catch (e1) {
    console.warn('[fetchKLine] 腾讯区间失败，尝试单次: ' + e1.message);
  }

  // 2) 腾讯单次（短历史；上限 641 根）
  try {
    const tc = Math.min(count, 640);
    const data = await fetchKLineFromTencent(symbol, tc);
    if (data.length > 0) {
      if (displayName) data[0].__name = displayName;
      console.log('[fetchKLine] 腾讯单次 ' + symbol + ' 拉到 ' + data.length + ' 根 (请求 ' + count + ')');
      return data;
    }
  } catch (e2) {
    console.warn('[fetchKLine] 腾讯单次失败: ' + e2.message);
  }

  // 3) Baostock 最后兜底（慢，但覆盖最全）
  try {
    const years = count / 250 * 1.3;
    const today = new Date();
    const startYear = today.getFullYear() - Math.ceil(years);
    const startDate = startYear + '-01-01';
    const endDate = today.toISOString().slice(0, 10);
    const data = await fetchKLineFromBaostock(symbol, startDate, endDate, 'd', '2');
    if (data.length > 0) {
      const sliced = data.slice(-count);
      if (displayName) sliced[0].__name = displayName;
      console.log('[fetchKLine] Baostock 兜底 ' + symbol + ' 拉到 ' + data.length + ' 根');
      return sliced;
    }
  } catch (e3) {
    console.warn('[fetchKLine] Baostock 兜底也失败: ' + e3.message);
  }

  throw new Error('所有 K线数据源都失败: ' + symbol);
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
//      opts.withIndicators = true 时额外返回 ma5/ma10/ma20/macd/amounts
//        - 指数 K 线（/api/market/kline/:key，供复盘页 daily-review.js）需要这些字段
//        - 个股 K 线（/api/market/kline-stock/:symbol，供回测页）**不需要**：
//          前端 backtest-chart.js 用 BT_computeMAFromCloses() 自行算均线，
//          MACD 面板也已移除。实测 641 根时这五个字段占 74%（71.6KB/96.5KB），
//          去掉后传输量从 96.5KB 降到约 25KB。
// 返回：{ name, symbol, count, dates[], ohlc[], volumes[], [ma5/10/20, macd, amounts] }
async function buildKLineSnapshot(symbol, name, count, opts) {
  const withIndicators = !!(opts && opts.withIndicators);
  // 1. 拉取 K线原始数据（多取 35 根用于计算指标预热期）
  //    腾讯单次最多 641 行，超过则由 fetchKLine 走"日期区间分段并发"
  const rawKlines = await fetchKLineWithPagination(symbol, count + 35);
  if (rawKlines.length === 0) throw new Error('K线数据为空');

  // 透传 name（fetchKLine 把 INDEX_MAP 的 name 挂到首条 __name）
  const finalName = name || (rawKlines[0] && rawKlines[0].__name) || symbol;

  // 2. 截取最后 count 根作为主数据
  const klines = rawKlines.slice(-count);
  const dates = klines.map(k => k.date);
  const ohlc  = klines.map(k => [k.open, k.close, k.low, k.high]);
  // 成交额：k.amount（腾讯返回的是元）→ 转为万元
  const amounts = klines.map(k => Math.round((k.amount || 0) / 10000));

  const out = {
    name:    finalName,
    symbol:  symbol,
    count:   klines.length,
    dates:   dates,
    ohlc:    ohlc,
    volumes: amounts,   // 兼容字段名（前端用 data.volumes）
    fetchedAt: new Date().toISOString()
  };

  if (withIndicators) {
    // 指标基于完整 pre+count 序列计算，保证 MA26/MACD 预热正确
    const fullCloses = rawKlines.map(k => k.close);
    const preLen = rawKlines.length - count;
    out.ma5   = calcMA(fullCloses, 5).slice(preLen);
    out.ma10  = calcMA(fullCloses, 10).slice(preLen);
    out.ma20  = calcMA(fullCloses, 20).slice(preLen);
    const fullMACD = calcMACD(fullCloses);
    out.macd  = {
      dif:  fullMACD.dif.slice(preLen),
      dea:  fullMACD.dea.slice(preLen),
      macd: fullMACD.macd.slice(preLen)
    };
    out.amounts = amounts;   // 语义化字段名（万元）
  }

  return out;
}

// K线分页拉取：现在统一由 fetchKLine 内部处理（Baostock 一次拉到 10 年）
//   保留此函数以兼容旧调用方，内部直接走 fetchKLine
async function fetchKLineWithPagination(symbol, count) {
  return await fetchKLine(symbol, count);
}

// 日期减 N 年（YYYY-MM-DD → YYYY-MM-DD）—— 已不再使用
// function subtractYears(dateStr, years) {
//   const d = new Date(dateStr + 'T00:00:00Z');
//   d.setUTCFullYear(d.getUTCFullYear() - years);
//   return d.toISOString().slice(0, 10);
// }

// 指数 K 线：复盘页（daily-review.js）会消费 ma5/ma10/ma20/macd 画均线与 MACD 副图，
// 因此这里保持 withIndicators: true。
async function getKLineSnapshot(key, count = 120) {
  const meta = INDEX_MAP[key];
  if (!meta) throw new Error('Unknown index key: ' + key);

  const cacheKey = 'kline:' + key + ':' + count;
  // 一级：内存（5 分钟）
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ key: key, cached: true }, cached);
  // 二级：磁盘（当天有效，服务重启后仍可用）
  const disk = getDiskCache(cacheKey);
  if (disk) {
    setCache(cacheKey, disk);
    return Object.assign({ key: key, cached: true, fromDisk: true }, disk);
  }

  const data = await buildKLineSnapshot(meta.symbol, meta.name, count, { withIndicators: true });
  data.key = key;
  setCache(cacheKey, data);
  setDiskCache(cacheKey, data);
  return data;
}

// 单只个股 K线（symbol=sh600000 / sz000001 / bj8xxxxxx）
// 与 getKLineSnapshot 输出结构基本一致，但**不带**指标字段（回测页前端自行计算），
// 额外带 key=null（标识非指数）。
async function getKLineSnapshotForSymbol(symbol, count = 1200) {
  const cacheKey = 'kline-stock:' + symbol + ':' + count;
  // 一级：内存
  const cached = getCache(cacheKey);
  if (cached) return Object.assign({ key: null, cached: true }, cached);
  // 二级：磁盘（当天有效）—— 切回白天看过的标的可秒开
  const disk = getDiskCache(cacheKey);
  if (disk) {
    setCache(cacheKey, disk);
    return Object.assign({ key: null, cached: true, fromDisk: true }, disk);
  }

  // 拉一次实时行情顺便取名称（与 K 线并联，减少总延迟）
  const namePromise = fetchQuotes([symbol]).then(function(q) {
    return (q[symbol] && q[symbol].name) || null;
  }).catch(function() { return null; });

  const [name, klineData] = await Promise.all([
    namePromise,
    // ★ withIndicators 缺省 false：去掉 ma5/ma10/ma20/macd/amounts，
    //   传输量从 96.5KB 降到约 25KB（实测 641 根）
    buildKLineSnapshot(symbol, null, count)
  ]);
  klineData.name = name || klineData.name || null;
  klineData.key = null;
  setCache(cacheKey, klineData);
  setDiskCache(cacheKey, klineData);
  return klineData;
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
  fetchNamesFromSina,
  searchSymbols,
  normalizeSymbol,
  getKLineSnapshot,
  getKLineSnapshotForSymbol,
  INDEX_MAP
};
