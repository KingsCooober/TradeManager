// 指数成交额（两市总成交）权威取数模块
//
// ★ 为什么需要这个模块：
//   腾讯 K 线 day 数组的字段是 [日期, 开, 收, 高, 低, 成交量(手)] —— **没有成交额**！
//   market-quote.js 的 `k.amount` 实际是「成交量(手)」（历史遗留误标），
//   直接 `k.amount / 1e8` 会得到 4~5 亿这种离谱的「成交额」（量级差 1000 倍）。
//   本模块绕开它，直接用两个权威源：
//     1) 东财 push2his K 线 f57 = 成交额（元）—— 快，但会被限流（返回空）
//     2) Baostock baostock-helper.py 的 amount（元）—— 慢（登录 ~10s）但稳定
//
// 单位：对外统一返回 **亿元**
//
// 用法：
//   const ia = require('./index-amount');
//   const amt = await ia.fetchIndexAmountByDate('sh000001', 20);   // { '2026-10-15': 7743.92, ... }
//   const all = await ia.fetchMarketAmountByDate(20);              // { date: {sh, sz, total} }
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const HELPER = path.join(__dirname, 'baostock-helper.py');

// 合理区间（亿元）：两市合计 5000 ~ 50000 亿，单市 2000 ~ 30000 亿
const SANE_SH = [1000, 30000];
const SANE_SZ = [1000, 30000];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function curlGet(url, retries) {
  let lastErr;
  for (let i = 0; i < (retries || 3); i++) {
    try {
      const { stdout } = await execFileP('curl', [
        '-4', '-s', '--connect-timeout', '10', '--max-time', '30',
        '-A', 'Mozilla/5.0', '-H', 'Referer: https://quote.eastmoney.com/', url
      ], { maxBuffer: 20 * 1024 * 1024 });
      if (stdout && stdout.trim()) return stdout;
      lastErr = new Error('空响应（疑似被限流）');
    } catch (e) { lastErr = e; }
    await sleep(1500 * (i + 1));
  }
  throw lastErr || new Error('curl 失败');
}

const EM_SECID = { sh000001: '1.000001', sz399001: '0.399001' };

/** 东财 push2his：指数成交额（亿元），失败抛错 */
async function fetchByEastmoney(symbol, days) {
  const secid = EM_SECID[symbol];
  if (!secid) throw new Error('未支持的指数: ' + symbol);
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + secid + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57' +
    '&klt=101&fqt=0&end=20991231&lmt=' + days;
  const json = JSON.parse(await curlGet(url));
  if (!json.data || !Array.isArray(json.data.klines)) throw new Error('东财K线无数据 ' + symbol);
  const out = {};
  json.data.klines.forEach(line => {
    const f = line.split(',');
    out[f[0]] = (parseFloat(f[6]) || 0) / 1e8;   // 元 → 亿
  });
  return out;
}

/** Baostock：指数成交额（亿元），失败抛错（登录约 10s） */
async function fetchByBaostock(symbol, days) {
  const code = symbol.slice(0, 2) + '.' + symbol.slice(2);   // sh000001 → sh.000001
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - (days + 30) * 86400000).toISOString().slice(0, 10);
  const { stdout } = await execFileP('python3', [HELPER, code, start, end, 'd', '3'],
    { maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  const rows = JSON.parse(stdout.trim());
  if (!Array.isArray(rows)) throw new Error('baostock 返回异常: ' + stdout.slice(0, 120));
  const out = {};
  rows.forEach(r => {
    const a = parseFloat(r.amount);
    if (r.date && a > 0) out[r.date] = a / 1e8;   // 元 → 亿
  });
  return out;
}

/** 单指数成交额 by date（亿元）：东财优先，Baostock 兜底 */
async function fetchIndexAmountByDate(symbol, days) {
  try {
    const m = await fetchByEastmoney(symbol, (days || 20) + 10);
    if (Object.keys(m).length) return { map: m, src: 'eastmoney' };
  } catch (e) {
    console.log('  (东财 ' + symbol + ' 成交额不可用: ' + e.message + '，改用 Baostock)');
  }
  const m = await fetchByBaostock(symbol, days || 20);
  return { map: m, src: 'baostock' };
}

/** 两市成交额 by date：{ date: { sh, sz, total } }，单位亿元 */
async function fetchMarketAmountByDate(days) {
  const sh = await fetchIndexAmountByDate('sh000001', days);
  const sz = await fetchIndexAmountByDate('sz399001', days);
  const out = {};
  Object.keys(sh.map).forEach(d => {
    if (sz.map[d] === undefined) return;
    out[d] = { sh: sh.map[d], sz: sz.map[d], total: sh.map[d] + sz.map[d] };
  });
  return { map: out, src: sh.src + '+' + sz.src };
}

/** 合理性校验：单市成交额是否在正常量级（防「成交量当成交额」这类单位错误写入数据库） */
function isSaneAmount(shYi, szYi) {
  return shYi >= SANE_SH[0] && shYi <= SANE_SH[1] &&
         szYi >= SANE_SZ[0] && szYi <= SANE_SZ[1];
}

module.exports = {
  fetchIndexAmountByDate,
  fetchMarketAmountByDate,
  fetchByEastmoney,
  fetchByBaostock,
  isSaneAmount,
  SANE_SH,
  SANE_SZ
};
