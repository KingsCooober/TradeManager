#!/usr/bin/env node
// 刷新「市值 > 阈值」的标的名单，写入 stock_meta（不清 K 线数据）
//
// 用途：在"按需惰性同步"模式下，stock_meta 主要用来记录**哪些标的值得回测**。
//   实际 K 线仍由用户访问时惰性拉取，这个脚本只维护名单与市值，便于：
//     1) 前端/脚本知道哪些标的是"主流标的"
//     2) 将来若要做批量预热，可以直接按 mcap_yi 排序取前 N 只
//
// 用法：
//   node server/refresh-stock-list.js              # 默认 >50 亿
//   node server/refresh-stock-list.js 100          # >100 亿
//   node server/refresh-stock-list.js 50 --dry     # 只统计不写库
//
// ★ 数据源策略（实测后调整）：
//   原本只用东财 clist 接口（一次拿代码+市值），但实测该接口及 push2 全系域名
//   在连续批量请求后会被 WAF 封禁（socket hang up，持续较长时间）。
//   现改为三级降级：
//     1) 东财 clist（最优：一页同时给代码+市值）
//     2) 新浪列表枚举代码 + 腾讯批量报价取市值（实测两者都稳定）
//   任一可用即可，全部失败才报错。

const https = require('https');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

const klineStore = require('./kline-store');

const EM_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';   // 沪深 A 股（主板/创业板/科创板）
const PAGE_SIZE = 100;
const MAX_PAGES = 80;
const THROTTLE_MS = 150;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGetBuf(opts, retry = 2) {
  return new Promise(function (resolve, reject) {
    const attempt = (left) => {
      const req = https.get(opts, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      });
      req.setTimeout(20000, () => {
        req.destroy();
        if (left > 0) setTimeout(() => attempt(left - 1), 600);
        else reject(new Error('timeout'));
      });
      req.on('error', (e) => {
        if (left > 0) setTimeout(() => attempt(left - 1), 600);
        else reject(e);
      });
    };
    attempt(retry);
  });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ---------- 方案 1：东财 clist（代码 + 市值一次拿到） ----------
async function fetchFromEastmoney() {
  const out = [];
  let total = null;
  for (let pn = 1; pn <= MAX_PAGES; pn++) {
    const path = '/api/qt/clist/get'
      + '?pn=' + pn + '&pz=' + PAGE_SIZE + '&po=1&np=1&fltt=2&invt=2&fid=f3'
      + '&fs=' + EM_FS + '&fields=f12,f13,f14,f20';
    const r = await httpsGetBuf({
      host: 'push2.eastmoney.com', path: path, headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
    });
    let d;
    try { d = JSON.parse(r.buf.toString('utf8')).data; } catch (e) { throw new Error('解析失败 pn=' + pn); }
    if (!d) break;
    if (total == null) total = d.total || 0;
    const rows = d.diff || [];
    if (!rows.length) break;
    for (const x of rows) {
      const code = String(x.f12 || '');
      if (!/^\d{6}$/.test(code)) continue;
      const market = String(x.f13) === '1' ? 'sh' : 'sz';
      if (!isAShare(market, code)) continue;
      out.push({ symbol: market + code, code: code, name: String(x.f14 || ''), mcap_yi: (Number(x.f20) || 0) / 1e8 });
    }
    if (out.length >= total) break;
    await sleep(THROTTLE_MS);
  }
  if (!out.length) throw new Error('东财返回空');
  return out;
}

function isAShare(market, code) {
  return (market === 'sh' && /^(60|68)/.test(code))
      || (market === 'sz' && /^(00|30)/.test(code));
}

// ---------- 方案 2：新浪枚举代码 + 腾讯查市值 ----------
// ★ 注意：新浪 node=hs_a 会**混入北交所（bj 开头）**，且按 symbol 升序时
//   bj 排在 sh/sz 之前（'b' < 's'），前几页可能全是 bj。
//   因此不能因为"本页一条都没入选"就判定到底了（那样会在第 1 页直接退出），
//   必须继续翻页，直到连续多页无新增或超过页数上限。
async function fetchSymbolsFromSina() {
  const out = [];
  const seen = new Set();
  let emptyStreak = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = '/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
      + '?page=' + page + '&num=100&sort=symbol&asc=1&node=hs_a';
    let r;
    try {
      r = await httpsGetBuf({
        host: 'vip.stock.finance.sina.com.cn', path: path,
        headers: { 'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/' },
      });
    } catch (e) {
      emptyStreak++;
      if (emptyStreak >= 3) break;
      await sleep(500);
      continue;
    }
    const txt = r.buf.toString('latin1');   // 新浪返回 GBK，但 symbol 字段是 ASCII
    const syms = txt.match(/"symbol":"((?:sh|sz|bj)\d{6})"/g) || [];
    if (!syms.length) break;                // 真到末页（返回空数组）

    let added = 0;
    for (const s of syms) {
      // s 形如 "symbol":"bj920000"（长度 19）
      //   → 前缀 "symbol":" 占 10 个字符，末尾 1 个引号
      //   ★ 原先写成 slice(12,-1)，把 sh/sz 前缀一起切掉了，导致全部被过滤
      const sym = s.slice(10, -1);
      const market = sym.slice(0, 2), code = sym.slice(2);
      if (!isAShare(market, code)) continue;   // bj 会被这里过滤掉
      if (seen.has(sym)) continue;
      seen.add(sym);
      out.push({ symbol: sym, code: code, name: '', mcap_yi: 0 });
      added++;
    }
    // 连续 5 页没有任何沪深 A 股新增 → 认为后续也没有了，提前结束
    if (added === 0) { emptyStreak++; if (emptyStreak >= 5) break; }
    else emptyStreak = 0;
    await sleep(THROTTLE_MS);
  }
  if (!out.length) throw new Error('新浪返回空');
  return out;
}

// 腾讯批量报价：字段 [45] = 总市值（亿元），[1] = 名称（GBK）
async function fillMcapFromTencent(list) {
  const BATCH = 60;   // 实测单次上限约 87，留余量
  let filled = 0;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const path = '/q=' + batch.map(x => x.symbol).join(',');
    let r;
    try {
      r = await httpsGetBuf({ host: 'qt.gtimg.cn', path: path, headers: { 'User-Agent': UA } });
    } catch (e) {
      await sleep(300);
      continue;
    }
    // 腾讯返回 GBK；名称需要转码，市值是 ASCII 数字可直接解析
    const iconv = tryIconv();
    const text = iconv ? iconv.decode(r.buf, 'gbk') : r.buf.toString('latin1');
    const byCode = {};
    text.split('\n').forEach((line) => {
      const f = line.split('~');
      if (f.length < 46) return;
      const code = f[2];
      if (!code) return;
      byCode[code] = { name: f[1] || '', mcap: Number(f[45]) || 0 };
    });
    for (const item of batch) {
      const hit = byCode[item.code];
      if (hit) {
        item.mcap_yi = hit.mcap;
        if (hit.name) item.name = hit.name;
        filled++;
      }
    }
    await sleep(THROTTLE_MS);
  }
  return filled;
}

// iconv-lite 可能未安装（项目未必依赖），装了就用来正确解码中文名
function tryIconv() {
  try { return require('iconv-lite'); } catch (e) { return null; }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const threshold = Number(args.find(a => !a.startsWith('--'))) || 50;

  console.log('[refresh-stock-list] 阈值 = 市值 > ' + threshold + ' 亿' + (dry ? '（dry-run）' : ''));

  let all = null;
  const t0 = Date.now();
  // 方案 1：东财
  try {
    all = await fetchFromEastmoney();
    console.log('[refresh-stock-list] 数据源: 东财 clist，' + all.length + ' 只，' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  } catch (e) {
    console.warn('[refresh-stock-list] 东财不可用（' + e.message + '），改用 新浪+腾讯');
  }

  // 方案 2：新浪 + 腾讯
  if (!all || !all.length) {
    const t1 = Date.now();
    all = await fetchSymbolsFromSina();
    console.log('[refresh-stock-list] 新浪枚举到 ' + all.length + ' 只，' + ((Date.now() - t1) / 1000).toFixed(1) + 's');
    const t2 = Date.now();
    const filled = await fillMcapFromTencent(all);
    console.log('[refresh-stock-list] 腾讯补齐市值 ' + filled + '/' + all.length + ' 只，' + ((Date.now() - t2) / 1000).toFixed(1) + 's');
    all = all.filter(x => x.mcap_yi > 0);
    if (!all.length) throw new Error('市值全部补齐失败（腾讯接口异常）');
  }

  const picked = all.filter(x => x.mcap_yi > threshold)
                    .sort((a, b) => b.mcap_yi - a.mcap_yi);
  console.log('[refresh-stock-list] 命中 ' + picked.length + ' 只（> ' + threshold + ' 亿）');
  if (picked.length) {
    console.log('  市值最大 3 只: ' + picked.slice(0, 3).map(x => (x.name || x.symbol) + '(' + x.mcap_yi.toFixed(0) + '亿)').join(', '));
    console.log('  市值最小 3 只: ' + picked.slice(-3).map(x => (x.name || x.symbol) + '(' + x.mcap_yi.toFixed(1) + '亿)').join(', '));
  }

  if (dry) {
    console.log('[refresh-stock-list] dry-run，未写库');
    return;
  }

  let written = 0;
  for (let i = 0; i < picked.length; i += 200) {
    written += await klineStore.upsertMetaBatch(picked.slice(i, i + 200));
  }
  console.log('[refresh-stock-list] 已写入 stock_meta ' + written + ' 条');

  const stats = await klineStore.getStats();
  console.log('[refresh-stock-list] 库内现状: ' + stats.symbols + ' 只有 K 线 / ' + stats.bars + ' 行 / meta ' + stats.metas + ' 条');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('[refresh-stock-list] 失败:', e.message);
    process.exit(1);
  });
}

module.exports = { fetchFromEastmoney, fetchSymbolsFromSina, fillMcapFromTencent };

