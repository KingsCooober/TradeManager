#!/usr/bin/env node
// 用腾讯行情重算「指定交易日」的全市场涨跌家数 / 涨跌停家数（Baostock 的快速替代）
//
// 为什么需要它：Baostock 逐只 query_history_k_data_plus 很慢（5000+ 只 ≈ 8.5 分钟），
//   且偶发网络空等卡死（实测 16 分钟跑不到 500 只）。腾讯 K 线并发拉取快 50 倍以上。
//
// 口径（与新浪/项目一致）：
//   - 涨/跌/平：按当日涨跌幅（腾讯 qfq 收盘价 ÷ 上一交易日收盘价 - 1）
//   - 涨停阈值：主板 10%、创业板/科创板 20%、ST 5%（容差 0.3%，抵消价格四舍五入）
//   - 当日无 K 线（停牌/未上市）→ 计入 halted/skipped，不参与统计
//
// 输出：stdout 最后一行 JSON（字段与 bs-activity.py 一致，可直接喂 apply-activity.js）
//
// 用法：node tx-activity.js YYYY-MM-DD [--limit N]
const https = require('https');

const TARGET = process.argv[2];
const LIMIT = process.argv.includes('--limit')
  ? parseInt(process.argv[process.argv.indexOf('--limit') + 1], 10) : 0;

if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET || '')) {
  console.error('用法: node tx-activity.js YYYY-MM-DD [--limit N]');
  process.exit(1);
}

// ---------- 通用 GET ----------
function httpsGet(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 3) return reject(new Error('too many redirects'));
    const u = new URL(url);
    const req = https.get({
      host: u.host, path: u.pathname + u.search, family: 4, timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
        'Accept': '*/*', 'Referer': 'https://finance.sina.com.cn/', 'Connection': 'close'
      }
    }, res => {
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

async function withRetry(fn, times) {
  let lastErr;
  for (let i = 0; i < (times || 3); i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- 1) 全市场股票列表（新浪 hs_a，~55 页） ----------
async function fetchStockList() {
  const pages = 55, BATCH = 10, out = [];
  for (let start = 1; start <= pages; start += BATCH) {
    const jobs = [];
    for (let p = start; p < Math.min(start + BATCH, pages + 1); p++) {
      const url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/' +
        'Market_Center.getHQNodeData?node=hs_a&sort=symbol&asc=1&page=' + p + '&num=100';
      jobs.push(withRetry(() => httpsGet(url), 2).then(buf => {
        const t = buf.toString('utf8').trim();
        if (!t || t === 'null') return [];
        try { const a = JSON.parse(t); return Array.isArray(a) ? a : []; } catch (e) { return []; }
      }).catch(() => []));
    }
    (await Promise.all(jobs)).forEach(arr => arr.forEach(s => out.push(s)));
    process.stderr.write('   列表已取 ' + out.length + ' 只…\r');
  }
  process.stderr.write('\n');
  return out;
}

// ---------- 2) 单只股票指定日涨跌幅（腾讯 qfq 日线） ----------
//
// ★ 必须多域名轮询：web.ifzq.gtimg.cn 在高频批量请求后会被 WAF 拦（返回 ~326 字节错误体），
//   而 ifzq.gtimg.cn / proxy.finance.qq.com 仍然可用 —— 实测一次全市场扫描就会触发。
//   （与 market-quote.js 的 TX_KLINE_HOSTS 策略一致：把 web.ifzq 排在最后）
const TX_HOSTS = ['ifzq.gtimg.cn', 'proxy.finance.qq.com/ifzqgtimg', 'web.ifzq.gtimg.cn'];
let txHostIdx = 0;

async function txGet(param) {
  let lastErr;
  for (let i = 0; i < TX_HOSTS.length * 2; i++) {
    const host = TX_HOSTS[txHostIdx % TX_HOSTS.length];
    try {
      const buf = await httpsGet('https://' + host + '/appstock/app/fqkline/get?param=' +
        encodeURIComponent(param));
      if (buf.length > 500) return buf;                  // 小于 500 字节基本是 WAF 错误体
      lastErr = new Error('响应过短(' + buf.length + 'B)，疑似被拦');
    } catch (e) { lastErr = e; }
    txHostIdx = (txHostIdx + 1) % TX_HOSTS.length;       // 换域名重试
  }
  throw lastErr || new Error('腾讯 K 线所有域名均失败');
}

async function fetchPct(symbol, target) {
  const buf = await txGet(symbol + ',day,,,12,qfq');
  const json = JSON.parse(buf.toString('utf8'));
  const sym = json.data && json.data[symbol];
  if (!sym) return null;
  const arr = sym.qfqday || sym.day;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const i = arr.findIndex(r => r[0] === target);
  if (i <= 0) return null;                    // 当日无 K 线（停牌/未上市）或没有前一日
  const close = parseFloat(arr[i][2]), prev = parseFloat(arr[i - 1][2]);
  if (!(close > 0) || !(prev > 0)) return null;
  return (close / prev - 1) * 100;
}

function limitPct(code, name) {
  if (code.startsWith('30') || code.startsWith('68')) return 20.0;
  if (/ST/i.test(name || '')) return 5.0;
  return 10.0;
}

// ---------- 主流程 ----------
(async () => {
  console.error('===== 腾讯源全市场重算 ' + TARGET + ' =====');
  let list = await fetchStockList();
  // 只保留 A 股（沪 6xx / 深 00x、30x），排除指数、基金、B股
  list = list.filter(s => /^(sh6|sz00|sz30)/.test((s.symbol || '').toLowerCase()));
  if (LIMIT) list = list.slice(0, LIMIT);
  console.error('A 股目标 ' + list.length + ' 只，开始并发拉取…');

  const stats = { up: 0, down: 0, flat: 0, zt: 0, dt: 0, skipped: 0, halted: 0 };
  const CONC = 12;
  let done = 0;

  for (let i = 0; i < list.length; i += CONC) {
    const batch = list.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async s => {
      try { return { s: s, pct: await fetchPct((s.symbol || '').toLowerCase(), TARGET) }; }
      catch (e) { return { s: s, pct: null, err: e.message }; }
    }));
    for (const r of res) {
      done++;
      if (r.pct === null) {
        if (r.err) stats.skipped++; else stats.halted++;
        continue;
      }
      const pct = r.pct;
      const th = limitPct(r.s.code || '', r.s.name) - 0.3;
      if (pct > 0.001) stats.up++;
      else if (pct < -0.001) stats.down++;
      else stats.flat++;
      if (pct >= th) stats.zt++;
      if (pct <= -th) stats.dt++;
    }
    if (done % 500 < CONC) {
      console.error('   进度 ' + done + '/' + list.length + '  涨' + stats.up + ' 跌' + stats.down +
        ' 涨停' + stats.zt + ' 跌停' + stats.dt);
    }
  }

  const result = {
    date: TARGET,
    up_count: stats.up,
    down_count: stats.down,
    flat_count: stats.flat,
    zt_count: stats.zt,
    dt_count: stats.dt,
    zt_dt_diff: stats.zt - stats.dt,
    sample_size: stats.up + stats.down + stats.flat,
    skipped: stats.skipped,
    halted: stats.halted,
    source: 'tencent-recalc'
  };
  console.log(JSON.stringify(result, null, 0));
})().catch(e => { console.error('❌ 失败: ' + e.message); process.exit(1); });
