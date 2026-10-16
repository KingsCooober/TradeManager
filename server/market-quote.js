// 行情数据代理：从腾讯股票 API 获取指数实时行情和 K 线
// 优点：免 Key、稳定、支持 A 股 + 港股
// 字段索引详见 https://stock.gtimg.cn/data/index.php?type=stock
// 数据延迟：约 15 分钟（免费版）

const https = require('https');
const path  = require('path');

// 个股 K 线本地库（按需惰性同步）—— 见 kline-store.js 顶部注释了解设计取舍
const klineStore = require('./kline-store');

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

// 腾讯 K线接口可用域名
//
// ★ 2026-10 实测：web.ifzq.gtimg.cn 在连续批量请求后会返回 **HTTP 501**，
//   响应体是腾讯 WAF 的跳转页（`https://waf.tencent.com/501page.html?...&id=xxx`），
//   带 per-IP 的封禁 id，冷却 30 秒也不恢复。
//   同一时刻同路径的 **ifzq.gtimg.cn（去掉 web. 前缀）完全正常**，
//   且返回内容与 proxy.finance.qq.com/ifzqgtimg/... 逐字节等价（实测各 16526 字节、
//   243 根、首根 ["2020-01-02","3.870",...]）。
//   因此这里改成多域名轮询：一个被 WAF 拦了就换下一个。
//   注意：批量预热时最容易被拦的是 web.ifzq，所以把它排在最后。
const TX_KLINE_HOSTS = [
  'ifzq.gtimg.cn',
  'proxy.finance.qq.com/ifzqgtimg',
  'web.ifzq.gtimg.cn',
];
let _txHostIdx = 0;   // 当前首选域名下标（成功即固定，失败则轮换）

/** 按当前首选域名拼 URL；proxy 域名路径多一段 /ifzqgtimg */
function buildTencentKLineUrl(symbol, period, startDate, endDate, count, adjust) {
  // adjust: 'qfq' | 'hfq' | ''（不复权）
  const adj = adjust == null ? 'qfq' : adjust;
  const param = [symbol, period, startDate || '', endDate || '', count].join(',') +
    (adj ? ',' + adj : '');
  const pathPart = '/appstock/app/fqkline/get?param=' + encodeURIComponent(param);
  return 'https://' + TX_KLINE_HOSTS[_txHostIdx] + pathPart;
}

/**
 * 带域名轮换的腾讯 K 线请求。
 * 依次尝试各域名，任一成功就把它设为下次首选（避免每次都先撞一次被封的域名）。
 * 全部失败时抛最后一个错误。
 */
async function httpsGetTencentKLine(symbol, period, startDate, endDate, count, adjust) {
  let lastErr = null;
  const startIdx = _txHostIdx;
  for (let i = 0; i < TX_KLINE_HOSTS.length; i++) {
    const idx = (startIdx + i) % TX_KLINE_HOSTS.length;
    const saved = _txHostIdx;
    _txHostIdx = idx;
    try {
      const buf = await httpsGet(buildTencentKLineUrl(symbol, period, startDate, endDate, count, adjust));
      // ★ WAF 拦截时状态码是 501，但 httpsGet 只返回 body。
      //   这里用内容特征识别：WAF 页面以 <!DOCTYPE 开头，正常响应是 JSON。
      const text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0x3C /* '<' */) {
        throw new Error('被 WAF 拦截（主机 ' + TX_KLINE_HOSTS[idx] + '）');
      }
      _txHostIdx = idx;     // 成功：记住这个域名
      return buf;
    } catch (e) {
      lastErr = e;
      _txHostIdx = saved;   // 失败：恢复，继续试下一个
    }
  }
  throw lastErr || new Error('腾讯 K 线所有域名均失败');
}

// 腾讯 K线接口
// day 数组字段：[日期, 开, 收, 高, 低, 成交额(元), 成交量(手), 涨跌幅%, ...]
// 通用腾讯 K线接口（支持 day/week/month 三种周期）
async function fetchKLineFromTencentPeriod(symbol, count, period) {
  // period: 'day' | 'week' | 'month'
  const buf = await httpsGetTencentKLine(symbol, period, '', '', count);
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
//
// ★ 段长上限的由来：腾讯「区间」接口单次最多返回 640 根，超出就**静默截断**
//   （丢弃最早的部分，不报错、不提示）。A 股约 243 个交易日/年，所以
//   2 个自然年 ≈ 486 根（安全），3 个自然年 ≈ 729 根（会被砍掉约 90 根）。
//   这里必须用整数年步进，否则像 2.5 这样的步长会让相邻段错位成"3 年一段"。
const TX_SEG_YEARS = 2;        // 每段覆盖年数（2 年 ≈ 486 个交易日，低于 640 上限）
const TX_MAX_SEGMENTS = 6;     // 最多切几段（6 × 2 = 12 年，覆盖 10 年有余）

/** 估算 [start, end] 之间的 A 股交易日数（约 243 天/年），用于判断是否会被 640 根上限截断 */
function estTradingDays(start, end) {
  const days = (new Date(end) - new Date(start)) / 86400000;
  return Math.round(days / 365 * 243);
}
// 单段可用交易日上限：腾讯区间接口单次最多 640 根，留一点余量
const TX_MAX_SEG_DAYS = 620;

/** 腾讯日线「区间」查询：直接指定 [start, end]，不受 641 根上限约束
 *
 *  adjust: 'qfq'（前复权，默认）| 'hfq'（后复权）| ''（不复权）
 *  ★ 关于 hfq：前复权在高分红股上会把早期价格算成负数
 *    （实测兖矿能源 2015-12-01 前复权 O=-2.965，后复权 O=25.185）。
 *    负价会让前端 BT_calcBuyVolume 直接返回 0（买不进），回测形同虚设。
 *    后复权永不出现负价，所以检测到负价时自动改用 hfq（见 ensureNoNegativePrices）。
 */
async function fetchKLineFromTencentRange(symbol, startDate, endDate, period, adjust) {
  period = period || 'day';
  const adj = adjust == null ? 'qfq' : adjust;
  // 区间查询时 count 传 640（实测传更大也没副作用，但保持与单段上限一致）
  const buf = await httpsGetTencentKLine(symbol, period, startDate, endDate, 640, adj);
  if (buf.length === 0) throw new Error('腾讯K线区间接口返回空');
  let json;
  try { json = JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('腾讯K线区间返回非 JSON'); }
  if (json.code !== 0) throw new Error('腾讯K线区间返回 code=' + json.code);
  const symData = json.data && json.data[symbol];
  if (!symData) return [];   // 该区间无数据（如股票尚未上市）→ 返回空而不是抛错
  // 依次尝试 qfq/hfq/day：接口按请求的复权口径返回对应 key
  const arr = (adj ? symData[adj + period] : null) || symData[period] ||
              symData['qfq' + period] || symData['hfq' + period];
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

/**
 * 把 [startDate..now] 切分成若干段（返回 [{start,end}] 升序）
 *
 * ★ 段长必须保证「每段交易日数 < 腾讯单次返回上限 640」。
 *   曾经的写法用 TX_SEG_YEARS=2.5 递进，但结束年份取 Math.ceil(y + 2.5)
 *   会向上取整到整年 → 每段实际跨 3 个自然年 ≈ 729 个交易日，
 *   超过 640 后上游**静默截断，丢弃最早的那 ~90 根**（不报错），
 *   表现为库里每段都缺约 4~5 个月的 K 线（实测兖矿能源
 *   2019-01-02 ~ 2019-05-20 共 90 个交易日整段丢失）。
 *   现在改用「自然年切分，单段最多 TX_SEG_YEARS 年且必须 ≤ 2 年」，
 *   2 个自然年 ≈ 486 个交易日，留足余量。
 *
 * @param {string|number} startDate 起始日期 'YYYY-MM-DD'（兼容传 years 数字：
 *                                  按"今天往回数 N 年"换算成起始日期）
 */
function buildTencentSegments(startDate) {
  const today = new Date();
  const endY = today.getFullYear();
  let start;
  if (typeof startDate === 'number' || (typeof startDate === 'string' && !/-/.test(startDate))) {
    // 兼容旧签名：传年数
    const years = Math.max(1, Number(startDate) || 10);
    const sy = endY - Math.ceil(years);
    start = sy + '-01-01';
  } else {
    start = String(startDate || '2016-01-01');
  }
  let startY = parseInt(start.slice(0, 4), 10);
  // 起始日不是 1 月 1 日时，第一段也从该自然年的 1 月 1 日开始拉（多拉无害，
  // 最终按 need 裁剪），这样后续段都能对齐自然年边界
  const segs = [];
  for (let s = startY; s <= endY; s += TX_SEG_YEARS) {
    // ★ 结束年份 = 起始年 + 段长 - 1，保证整段恰好 TX_SEG_YEARS 个自然年
    const e = Math.min(endY, s + TX_SEG_YEARS - 1);
    const segStart = s + '-01-01';
    // 最后一段用今天作为结束，避免未来日期
    const end = (e >= endY ? today.toISOString().slice(0, 10) : e + '-12-31');
    segs.push({ start: segStart, end: end });
  }
  // 首段如果晚于请求的起始日期，收敛到请求值（例如 start=2016-05-03 → 首段 2016-01-01 起）
  if (segs.length && segs[0].start < start) segs[0].start = start;
  // 段数超限时从最早的段开始合并（保证最近的数据优先精确）。
  // ★ 但合并绝不能把一段撑到超过 640 个交易日（会被上游静默截断），
  //   所以合并后的跨度也必须 ≤ TX_MAX_SEG_DAYS；否则宁可丢掉最早那段。
  while (segs.length > TX_MAX_SEGMENTS) {
    const a = segs.shift();
    const merged = { start: a.start, end: segs[0].end };
    if (estTradingDays(merged.start, merged.end) <= TX_MAX_SEG_DAYS) {
      segs[0].start = a.start;
    }
    // 超限则直接丢弃 a（最近的数据优先），segs[0] 保持原样
  }
  return segs;
}

/**
 * 腾讯长历史拉取：分段并发 + 合并去重排序
 * @param {string} symbol sh600000 / sz000001
 * @param {number} years  需要覆盖的年数（或传 startDate 字符串，此时本参数忽略）
 * @param {number} want   期望的根数（用于最终裁剪）
 * @param {string} adjust 'qfq'（前复权，默认）| 'hfq'（后复权）
 * @param {string} [startDate] 起始日期 'YYYY-MM-DD'：传了则按日期窗口拉
 *                             （忽略 years），如 '2016-01-01' 表示 2016 年至今
 */
async function fetchKLineFromTencentLong(symbol, years, want, adjust, startDate) {
  const adj = adjust == null ? 'qfq' : adjust;
  const segs = buildTencentSegments(startDate != null ? startDate : years);
  const t0 = Date.now();
  // 并发请求所有段；单段失败不影响其它段（返回空数组）
  const parts = await Promise.all(segs.map(function(s) {
    return fetchKLineFromTencentRange(symbol, s.start, s.end, 'day', adj)
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
    (merged.length ? '（' + merged[0].date + ' ~ ' + merged[merged.length - 1].date + '）' : '') +
    (adj === 'hfq' ? ' [hfq]' : ''));
  if (merged.length === 0) throw new Error('腾讯区间接口未返回任何数据');
  // 按日期窗口拉取时不做尾部裁剪（调用方要的就是 startDate 至今的完整序列）
  if (startDate != null) return merged;
  // 裁到最后 want 根（与调用方语义一致）
  return want && merged.length > want ? merged.slice(-want) : merged;
}

/** K 线序列里是否存在 <= 0 的价格（前复权高分红股的典型症状） */
function hasNegativePrice(klines) {
  if (!Array.isArray(klines)) return false;
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    if (!k) continue;
    if (!(k.close > 0) || !(k.open > 0)) return true;   // NaN 也视作异常
  }
  return false;
}

// 涨跌停上限按板块区分：主板 10%、创业板/科创板 20%、北交所 30%。
// 留 1 个百分点的余量吸收四舍五入与新股首日的差异。
const LIMIT_PCT_MAIN = 11;      // 60/00 开头（沪深主板）
const LIMIT_PCT_GEM = 21;       // 30 开头（创业板）、688 开头（科创板）
const LIMIT_PCT_BSE = 31;       // 8/4 开头（北交所）
// 相邻两根间隔超过这个天数就认为是跨长假，不参与跳空判定（长假后跳空是真实的）。
const ADJACENT_GAP_DAYS = 10;

/**
 * 按标的代码推断单日涨跌幅上限（含 1% 余量）。
 *
 * ★ 为什么必须区分板块：创业板/科创板的涨跌停是 20%，北交所是 30%。
 *   早期版本对所有标的用统一的 11% 阈值，会把创业板正常的 20% 涨停
 *   误判成"假跳空"。实测 sz300903（创业板）2021-07-27 不复权真实涨幅
 *   20.01%（标准 20% 涨停），qfq 与 hfq 口径都显示 ~20% —— 属真实行情，
 *   却被 11% 阈值判为异常，进而触发无谓的降级/报错。
 */
function getPriceLimitPct(symbol) {
  const s = String(symbol || '').toLowerCase();
  const code = s.replace(/^(sh|sz|bj)/, '');
  if (/^68/.test(code)) return LIMIT_PCT_GEM;          // 科创板 688xxx
  if (/^30/.test(code)) return LIMIT_PCT_GEM;          // 创业板 300xxx
  if (/^[84]/.test(code)) return LIMIT_PCT_BSE;        // 北交所 8xxxxx / 4xxxxx
  return LIMIT_PCT_MAIN;                                // 沪深主板
}

/**
 * 检测相邻交易日是否存在「数学上不可能」的涨跌幅。
 *
 * ★ 为什么需要：腾讯的前复权在除权日附近折算不准，会把「分红除权」错误地
 *   复权成一根暴涨/暴跌。实测：
 *     - 浦发银行 2017-05-25（分红除权日）不复权价 15.47 → 11.75（跌 24%），
 *       前复权却变成 +14.21%（主板不可能）；
 *     - 工商银行 2016-03-04 前复权 +16.06%、农业银行 2016-01-26 +16.80%；
 *       同日期后复权分别为 +3.21% / +3.95%，是正常波动。
 *   全库扫描：1866/2579 只（72.4%）存在单日超过涨跌停上限的异常波动，
 *   集中在 2016-2021（累计分红多的年份），2022 年后骤降。
 *   用户会在这些日期看到凭空的暴赚/暴亏，回测结果失真。
 *
 * ★ 已知的良性残留（不是缺陷，无需处理）：
 *   创业板/科创板新股上市前 5 个交易日不设涨跌幅限制，会出现 100%+ 的真实涨幅。
 *   实测 sz300939 秋田微 2021-01-28 上市，2021-02-01 前复权 +105.63%、
 *   后复权 +100.99% —— 两个口径都如此，属实盘行情。这类标的两个口径的
 *   badness 同分，按「同分保留前复权」的规则不会被错误降级，数据无害。
 *   （曾尝试按下标跳过上市初期若干根，但本库的 10 年窗口并不从上市日开始，
 *    跳过会漏掉 2016-2021 的真实除权假跳空，故不做下标豁免。）
 *
 * @param {Array} klines K 线序列
 * @param {string} symbol 标的代码（用于按板块取涨跌停上限）
 * @returns {{count:number, worst:number, sample:string, limit:number}} 异常根数与最大偏离
 */
function detectAbnormalJump(klines, symbol) {
  const limit = getPriceLimitPct(symbol);
  const res = { count: 0, worst: 0, sample: '', limit: limit };
  if (!Array.isArray(klines) || klines.length < 2) return res;
  for (let i = 1; i < klines.length; i++) {
    const prev = klines[i - 1], cur = klines[i];
    if (!prev || !cur) continue;
    if (!(prev.close > 0) || !(cur.close > 0)) continue;
    const days = (new Date(cur.date) - new Date(prev.date)) / 86400000;
    if (!(days > 0) || days > ADJACENT_GAP_DAYS) continue;   // 跨长假，跳过
    const chg = Math.abs(cur.close - prev.close) / prev.close * 100;
    if (chg > limit) {
      res.count++;
      if (chg > res.worst) { res.worst = chg; res.sample = prev.date + '→' + cur.date; }
    }
  }
  return res;
}

/**
 * 评估一份 K 线数据的「问题严重度」，用于在前复权/后复权之间择优。
 *
 * ★ 为什么需要打分而不是「必须完美」：
 *   早期实现要求后复权必须 0 负价且 0 跳空才肯采用，否则退回前复权。
 *   但存在这样的标的：前复权 34 根负价 + 221 处跳空（含 121% 的假暴涨），
 *   后复权只有 1 处 11.14% 的正常涨停（恰好越过 11% 阈值 0.14 个百分点）。
 *   此时后复权明显更好，却因「不够完美」被退回前复权 → 用户拿到的正是坏数据。
 *   实测 sh600256 广汇能源即为此例。
 *
 * 权重：负价是致命缺陷（前端 BT_calcBuyVolume 遇 price<=0 直接返回 0，根本买不进），
 * 定权重 1000；跳空只是涨跌幅失真，定权重 1。分值越低越好。
 */
function klineBadness(klines, symbol) {
  const neg = klines.filter(function(k) { return !(k.close > 0) || !(k.open > 0); }).length;
  const jump = detectAbnormalJump(klines, symbol);
  return {
    neg: neg,
    jumps: jump.count,
    worst: jump.worst,
    sample: jump.sample,
    score: neg * 1000 + jump.count
  };
}

/**
 * 拉取 K 线；当前复权口径出现「负价」或「不可能的涨跌幅」时，自动降级为后复权重拉。
 *
 * ★ 为什么需要（两个独立的 qfq 缺陷）：
 *   1. 负价：前复权按"减去累计分红"折算，高分红股在分红总额超过早期股价时，
 *      早年价格会被算成负数。实测兖矿能源 2015-12-24 收盘 -2.719、
 *      贵州茅台 2015-12-01 收盘 -83.955（上游腾讯原始数据，非我方算错）。
 *      前端 BT_calcBuyVolume 遇到 price <= 0 直接返回 0 → 根本买不进。
 *   2. 假跳空：除权日附近折算不准，把分红除权做成暴涨暴跌（浦发 +14.21%）。
 *      详见 detectAbnormalJump 注释。
 *   后复权对这两种情况都是正确的（同一根兖矿 hfq 为 25.405、茅台 1330.837；
 *   浦发 2017-05-25 hfq 为 +8.30%），代价是价格数值不等于当年真实盘面价。
 *
/**
 * 按指定复权口径拉取长历史 K 线。
 * @param {string} prefer 指定口径：
 *   - 缺省 / 'auto'：先 qfq，发现负价或假跳空时与 hfq 按严重度择优（原有行为）
 *   - 'qfq' | 'hfq'：直接拉指定口径，**不做任何自动降级**
 *     （口径选择权交给前端后，用户明确要前复权就给前复权——
 *      即使它有负价，那也是用户知情后的选择，后端不应擅自替换）
 *   - 'raw'：不复权（param 不带 adjust 段）
 * @param {string} [startDate] 起始日期 'YYYY-MM-DD'：传了则按日期窗口拉
 *                             （忽略 count/years），如 '2016-01-01'
 * @returns {Promise<{klines: Array, adjust: string, degraded: boolean}>}
 */
async function fetchKLineSafe(symbol, count, years, prefer, startDate) {
  const p = prefer == null ? 'auto' : String(prefer).toLowerCase();

  // 用户指定了明确口径：直接拉，不做降级
  if (p === 'qfq' || p === 'hfq' || p === 'raw') {
    const klines = await fetchKLineFromTencentLong(symbol, years, count, p, startDate);
    return { klines: klines, adjust: p, degraded: false };
  }

  // auto：原有逻辑 —— qfq 优先，异常时与 hfq 择优
  const qfq = await fetchKLineFromTencentLong(symbol, years, count, 'qfq', startDate);
  if (qfq.length === 0) throw new Error('腾讯区间接口未返回任何数据');
  const q = klineBadness(qfq, symbol);
  // 前复权干净 → 直接用（价格贴近当年真实盘面价，是首选）
  if (q.score === 0) return { klines: qfq, adjust: 'qfq', degraded: false };

  const reason = q.neg > 0
    ? '出现 ' + q.neg + '/' + qfq.length + ' 根负价'
    : '出现 ' + q.jumps + ' 处异常涨跌幅（最大 ' + q.worst.toFixed(2) + '% @ ' + q.sample + '）';
  console.warn('[kline] ' + symbol + ' 前复权' + reason + '，尝试后复权(hfq)对比');
  try {
    const hfq = await fetchKLineFromTencentLong(symbol, years, count, 'hfq', startDate);
    if (hfq.length > 0) {
      const h = klineBadness(hfq, symbol);
      // 后复权更干净才换（两者都脏时择优，而不是要求后复权必须完美）
      if (h.score < q.score) {
        console.warn('[kline] ' + symbol + ' → 采用后复权(hfq)（严重度 ' + h.score +
          ' 优于前复权 ' + q.score + '；hfq 负价 ' + h.neg + ' 根、跳空 ' + h.jumps + ' 处）');
        return { klines: hfq, adjust: 'hfq', degraded: true };
      }
      console.warn('[kline] ' + symbol + ' → 保留前复权（严重度 ' + q.score +
        ' 不劣于后复权 ' + h.score + '；hfq 负价 ' + h.neg + ' 根、跳空 ' + h.jumps + ' 处）');
      return { klines: qfq, adjust: 'qfq', degraded: false };
    }
  } catch (e) {
    console.warn('[kline] ' + symbol + ' 后复权重拉失败: ' + e.message);
  }
  // hfq 也拿不到 → 宁可返回前复权数据（至少根数对），也不返回空
  return { klines: qfq, adjust: 'qfq', degraded: false };
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

async function fetchKLine(symbol, count = 30, period = 'day', opts) {
  // 数据源优先级（2024 重构）：
  //   1) 腾讯「日期区间」分段并发 —— 实测 10 年 140ms，长历史唯一快路径
  //      （旧写法 param=symbol,day,,,N,qfq 的 N 有硬上限：N>=2500 直接返回 0 根，
  //       这正是"选了 10 年却只有 641 根"的根因之一）
  //   2) 腾讯单次（短历史兜底）
  //   3) Baostock —— 仅当腾讯完全失败时用。它单次 6.7~16 秒（Python 子进程
  //      + 登录 + 游标逐行读），只适合作为最后兜底，不再作为首选。
  const meta = Object.values(INDEX_MAP).find(function(m) { return m.symbol === symbol; });
  const displayName = meta ? meta.name : null;

  // 1) 腾讯区间分段并发（首选）；负价自动降级后复权（除非调用方指定了口径）
  //    opts.startDate：按起始日期拉（如 '2016-01-01'），此时 count 只是裁剪上限
  try {
    const startDate = opts && opts.startDate;
    const years = startDate
      ? null
      : Math.max(1, count / 250 * 1.15);   // 多取 15% 余量，保证裁到 count 根
    const safe = await fetchKLineSafe(symbol, count, years, opts && opts.adjust, startDate);
    const data = safe.klines;
    if (data.length > 0) {
      if (displayName) data[0].__name = displayName;
      // ★ 把实际使用的口径挂到首条，buildKLineSnapshot 读取后写入响应
      //   （显式指定口径时可能是 'raw'，缺省 auto 时可能是降级后的 'hfq'）
      data[0].__adjust = safe.adjust;
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
  //    opts.adjust：'qfq'|'hfq'|'raw' 指定复权口径；缺省 auto（异常时自动择优）
  //    opts.startDate：按起始日期拉（如 '2016-01-01' → 2016 年至今全部）
  const rawKlines = await fetchKLineWithPagination(symbol, count + 35, opts);
  if (rawKlines.length === 0) throw new Error('K线数据为空');

  // 透传 name（fetchKLine 把 INDEX_MAP 的 name 挂到首条 __name）
  const finalName = name || (rawKlines[0] && rawKlines[0].__name) || symbol;

  // 2. 截取数据：
  //    - startDate 模式（全局窗口 KLINE_STORE_START）：全量保留——落库必须
  //      是 2016 起完整历史，根数裁剪由上层 getKLineSnapshotForSymbol 按
  //      前端请求的 count 再做（库里裁 ≠ 拉少）
  //    - 根数模式：截取最后 count 根
  const klines = opts && opts.startDate ? rawKlines : rawKlines.slice(-count);
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
    // 复权口径：'qfq' 常规前复权 / 'hfq' 负价降级后复权（高分红股）
    adjust:  (rawKlines[0] && rawKlines[0].__adjust) || 'qfq',
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
async function fetchKLineWithPagination(symbol, count, opts) {
  return await fetchKLine(symbol, count, 'day', opts);
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
//
// ★ 本地库 + 按需惰性同步（kline-store.js）：
//   1) 内存缓存 → 2) 本地 SQLite → 3) 回源上游
//   命中本地库时是纯 SQL 查询（毫秒级），只有数据缺失或过期才打上游。
//   拉回上游后会写库，同一标的二次加载直接命中。
//   可用 KLINE_STORE=0 关闭本地库（回退到纯缓存行为，便于排查）。
//   opts.noCache = true 时跳过内存缓存读写（批量预热用：避免把上千只标的
//   的完整 K 线驻留在进程内存里，本地库已经是持久层，内存缓存无收益）。
async function getKLineSnapshotForSymbol(symbol, count = 1200, opts) {
  // 复权口径：'auto'（缺省，异常时自动择优）| 'qfq' | 'hfq' | 'raw'（不复权）
  // 口径必须参与缓存键 —— 同一标的两种口径的数据完全不同，
  // 共用键会让用户切换口径后拿到上一种口径的缓存。
  const ADJUST_WHITELIST = ['auto', 'qfq', 'hfq', 'raw'];
  const reqAdjust = (opts && opts.adjust && ADJUST_WHITELIST.indexOf(String(opts.adjust).toLowerCase()) >= 0)
    ? String(opts.adjust).toLowerCase() : 'auto';
  // ★ 全局数据窗口（用户决策 2026-10：所有标的一律从 2016-01-04 拉至今）
  //   2016-01-04 是 2016 年首个交易日。任何请求（无论 count 多少）落库时都
  //   按此窗口拉全量 —— 根数窗口模式（count）只影响"返回给前端的裁剪"，
  //   不影响"库里存多少"。这样本地库永远保持 2016 起的完整历史，
  //   前端要 1 年还是 10 年都从库里直接裁剪返回，不必回源。
  const KLINE_STORE_START = '2016-01-04';
  // 日期窗口模式：opts.startDate = 'YYYY-MM-DD'（如 '2016-01-01' → 2016 年至今）
  const reqStart = (opts && opts.startDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.startDate)) ? opts.startDate : null;
  // 日期窗口模式下 count 只是安全上限（防止极端异常导致超大响应），
  // 覆盖判断以日期为准。2016 至今约 2700 个交易日，给 3500 上限。
  const effCount = reqStart ? 3500 : count;
  // ★ 缓存键必须反映"实际拉取窗口"：回源一律按 KLINE_STORE_START 拉全量，
  //   但返回裁剪由 count/reqStart 决定，所以键里保留 count 与 reqStart
  const cacheKey = 'kline-stock:' + symbol + ':' + count + ':' + reqAdjust +
    (reqStart ? ':' + reqStart : '');
  // 一级：内存（预热模式下由调用方显式跳过，见末尾 noCache 说明）
  const skipMemCache = !!(opts && opts.noCache === true);
  if (!skipMemCache) {
    const cached = getCache(cacheKey);
    if (cached) return Object.assign({ key: null, cached: true }, cached);
  }

  const storeEnabled = process.env.KLINE_STORE !== '0';
  // ★ opts.force = true 时跳过本地库直接回源，
  //   用于修复"库里已存了坏数据"的场景（如历史上写入的前复权负价）。
  //   注意：noCache 只跳内存缓存，不跳本地库 —— 本地库是持久层，
  //   光靠 noCache 无法强制回源。
  const forceUpstream = !!(opts && opts.force === true);
  let meta = null;
  if (storeEnabled && !forceUpstream) {
    try {
      meta = await klineStore.getMeta(symbol);
      // 二级：本地库（根数够 + 数据新鲜 → 直接返回，不回源）
      // ★ 口径守卫：库里存的是 meta.adjust 口径（自动择优的结果，多为 qfq 或 hfq）。
      //   用户明确指定其他口径（如 raw 不复权）时不能拿库里的直接顶上，
      //   必须回源拉对应口径 —— 否则切换口径永远不生效。
      //   'auto' 请求只接受库内口径为 qfq/hfq 的数据（raw 只会由显式请求产生）。
      const metaAdjust = (meta && meta.adjust) || 'qfq';
      const adjustMatch = (reqAdjust === 'auto')
        ? (metaAdjust === 'qfq' || metaAdjust === 'hfq')
        : (metaAdjust === reqAdjust);
      // ★ 本地库命中条件（全局窗口 KLINE_STORE_START=2016-01-04 起整段保存）：
      //   - 库已覆盖窗口：first_date ≤ 2016-01-04，或 2016 后上市（首根=上市日）
      //   - 日期窗口模式另要求 last_date 在 4 天内；根数模式要求 bar_count ≥ count
      //   isFresh（≤4 天）已保证新鲜度
      //   ★ 新股豁免不能用"first_date ≤ reqStart"：reqStart=2016-01-04 时
      //     2016 年 IPO（首根 2016-03 等）会被误判未覆盖而整日回源。
      //     正确规则：first_date > 窗口起点时视为新股，首根即上市日，天然完整。
      //   ★ 但纯靠 first_date 无法区分"2016 后上市"与"早年短窗口落库"（如指数
      //     按5年请求存入、first_date=2021）——后者其实是未覆盖，应回源补齐。
      //     简化处理：bar_count 明显小于 2016 至今应有根数（~2620）且 first_date
      //     晚于窗口起点 + 2 年时视为未覆盖回源（命中后走 replace 补齐）。
      const isLateListing = meta.first_date && meta.first_date > KLINE_STORE_START;
      const shortLegacy = isLateListing && meta.first_date > '2018-01-01' &&
        meta.bar_count < 2620 - 30;
      const windowCovered = meta.first_date && ((meta.first_date <= KLINE_STORE_START || isLateListing) && !shortLegacy);
      let staleCutoff = null;
      if (reqStart) {
        const d = new Date(Date.now() - 4 * 86400000);
        staleCutoff = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0');
      }
      if (meta && klineStore.isUpToDate(meta) && adjustMatch && windowCovered &&
          (reqStart ? meta.last_date >= staleCutoff : meta.bar_count >= count)) {
        // 日期窗口模式：按 startDate 返回全部行；根数模式：返回最近 count 根
        const local = await klineStore.loadKLine(symbol, count, reqStart);
        if (local && local.dates.length > 0) {
          const out = {
            name: meta.name || null,
            symbol: symbol,
            count: local.dates.length,
            dates: local.dates,
            ohlc: local.ohlc,
            volumes: local.volumes,
            key: null,
            cached: true,
            fromStore: true,
            // 告诉前端该标的用的是前复权还是后复权（高分红股会降级为 hfq）
            adjust: meta.adjust || 'qfq',
            fetchedAt: new Date().toISOString(),
          };
          setCache(cacheKey, out);
          return out;
        }
      }
    } catch (e) {
      console.warn('[kline-store] 读取本地库失败，回源上游: ' + e.message);
    }
  }

  // 拉一次实时行情顺便取名称（与 K 线并联，减少总延迟）
  const namePromise = fetchQuotes([symbol]).then(function(q) {
    return (q[symbol] && q[symbol].name) || null;
  }).catch(function() { return null; });

  const [name, klineData] = await Promise.all([
    namePromise,
    // ★ withIndicators 缺省 false：去掉 ma5/ma10/ma20/macd/amounts，
    //   传输量从 96.5KB 降到约 25KB（实测 641 根）
    // ★ 回源时一律按全局窗口 KLINE_STORE_START 拉全量（2016-01-04 至今），
    //   根数/count 只影响返回裁剪，不影响落库 —— 保证库内始终是完整历史
    buildKLineSnapshot(symbol, null, effCount, { adjust: reqAdjust, startDate: KLINE_STORE_START })
  ]);
  klineData.name = name || klineData.name || null;
  klineData.key = null;
  // 该标的实际使用的复权口径：'qfq' 常规 / 'hfq' 负价降级
  const usedAdjust = klineData.adjust || 'qfq';
  klineData.adjust = usedAdjust;
  // 批量预热时上百只标的顺序写入内存缓存会把 Map 撑大且毫无意义
  // （预热进程结束即释放），因此允许调用方跳过。
  // （此处 setCache 的对象在下方裁剪为 out 后会被覆盖写入正确的裁剪版本）
  if (!opts || opts.noCache !== true) setCache(cacheKey, klineData);
  setDiskCache(cacheKey, klineData);

  // ★ 返回裁剪：落库的是 2016 起全量，返回给前端时按请求参数裁剪
  //   - 根数模式（无 reqStart）：返回最近 count 根
  //   - 日期窗口模式（reqStart）：返回 reqStart 至今全部
  //   注意：裁剪只作用于「返回值/缓存值」，落库必须用全量 klineData。
  //   缓存键已含 count/reqStart，因此缓存裁剪后的对象是安全的。
  let out = klineData;
  if (reqStart) {
    if (klineData.dates[0] < reqStart) {
      const i = klineData.dates.findIndex(d => d >= reqStart);
      if (i > 0) {
        out = {
          name: klineData.name, symbol: klineData.symbol, count: klineData.count - i,
          dates: klineData.dates.slice(i), ohlc: klineData.ohlc.slice(i),
          volumes: klineData.volumes.slice(i),
          adjust: klineData.adjust, key: null, cached: false,
        };
      }
    }
  } else if (klineData.count > count) {
    const c = klineData.count;
    out = {
      name: klineData.name, symbol: klineData.symbol, count: count,
      dates: klineData.dates.slice(c - count), ohlc: klineData.ohlc.slice(c - count),
      volumes: klineData.volumes.slice(c - count),
      adjust: klineData.adjust, key: null, cached: false,
    };
  }
  // 用裁剪后的对象覆盖内存/磁盘缓存（键已含 count/reqStart）
  if (out !== klineData && (!opts || opts.noCache !== true)) setCache(cacheKey, out);
  if (out !== klineData) setDiskCache(cacheKey, out);

  // 日期窗口模式：库里已有完整 startDate 覆盖但返回时只裁了 count 根 → 会丢历史；
  // 因此本地库命中分支需按「库里有多少给多少（≥count 或覆盖日期窗口）」返回。
  // ★ 回源已改为固定按 KLINE_STORE_START（2016-01-04）拉全量落库，前端任何
  //   根数/窗口请求都从库里裁剪返回，不再单独回源短窗口。
  if (storeEnabled) {
    const metaAdjust0 = (meta && meta.adjust) || 'qfq';
    const canPersist = (reqAdjust === 'auto') || (reqAdjust === usedAdjust && metaAdjust0 === usedAdjust);
    if (!canPersist) {
      console.log('[kline-store] ' + symbol + ' 请求口径 ' + reqAdjust +
        ' 与库内口径 ' + metaAdjust0 + ' 不同，本次数据只回前端不落库');
    } else {
    const metaOpt = { name: klineData.name, adjust: usedAdjust };
    try {
      // ★ 复权口径变了（qfq→hfq）说明旧数据整段不可比，必须整只覆盖
      const adjustSwitched = meta && meta.adjust && meta.adjust !== usedAdjust;      if (adjustSwitched) {
        console.log('[kline-store] ' + symbol + ' 复权口径由 ' + meta.adjust +
          ' 变为 ' + usedAdjust + '，整只覆盖重写');
      }
      // ★ 首次入库 / 复权口径变更 / 库内起点不满足全局窗口：整只覆盖写
      //   （append 只增不减，库里缺 2016 起的历史时必须 replace 才能补上）
      //   新股豁免：2016 后上市（first_date > KLINE_STORE_START）的标的
      //   首根=上市日即已完整，走 append 分支即可。
      //   ★ 豁免必须用「上游首根」而非「库内 first_date」判断：库里只有短
      //     历史的数据（如指数早年按近5年请求落库、first_date=2021）会被
      //     误判为新股而永远 append、永远补不上 2016 起的历史。回源是按
      //     KLINE_STORE_START 全量拉的，上游首根 > 窗口起点才真是新股。
      const upFirst = klineData.dates && klineData.dates[0];
      const lateListing = upFirst && upFirst > KLINE_STORE_START;
      if (!meta || !meta.bar_count || adjustSwitched || !lateListing ||
          (meta.first_date && meta.first_date > upFirst + '')) {
        // meta.first_date > 上游首根：库里比上游还少（旧短窗口数据）→ 整只覆盖
        if (meta && meta.first_date && meta.first_date > upFirst + '') {
          console.log('[kline-store] ' + symbol + ' 库内起点 ' + meta.first_date +
            ' 晚于上游首根 ' + upFirst + '，整只覆盖补齐 ' + KLINE_STORE_START + ' 起历史');
        }
        await klineStore.replaceKLine(symbol, klineData, metaOpt);
      } else {
        // 已有数据：先用尾部比对检测前复权基准是否变化
        const changed = await klineStore.detectAdjustChange(symbol, klineData, 20);
        if (changed) {
          // ★ 复权基准变了（除权除息）→ 前复权历史被整体重算，
          //   绝不能只追加最新的几根，必须整只覆盖，否则接缝处会假跳空
          console.log('[kline-store] ' + symbol + ' 检测到复权基准变化，整只重拉覆盖');
          await klineStore.replaceKLine(symbol, klineData, metaOpt);
        } else {
          await klineStore.appendKLine(symbol, klineData, metaOpt);
        }
      }
    } catch (e) {
      console.warn('[kline-store] 写入本地库失败（不影响本次返回）: ' + e.message);
    }
    }   // end canPersist else
  }

  return out;
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
  INDEX_MAP,
  // 供诊断脚本核对分段拉取结果（不对外接口使用）
  _testRange: fetchKLineFromTencentRange,
  _testSegments: buildTencentSegments,
  _testLong: fetchKLineFromTencentLong,
  _hasNegativePrice: hasNegativePrice,
  _detectAbnormalJump: detectAbnormalJump,
  _getPriceLimitPct: getPriceLimitPct,
  _klineBadness: klineBadness,
  _estTradingDays: estTradingDays,
  _TX_MAX_SEG_DAYS: TX_MAX_SEG_DAYS,
};
