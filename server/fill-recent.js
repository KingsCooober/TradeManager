// 补齐 market_history 最近 N 天的缺失字段（成交额 / 两融余额）
// 数据源：东方财富（push2his 指数 K线成交额 + datacenter 两融历史）
// 原则：**只补 NULL，绝不覆盖已有真实值**
//
// 注意：远程服务器 node 的 sqlite3 原生模块 require 会 segfault（与 node v18 不兼容），
//       因此本脚本改用 **sqlite3 CLI** 读写数据库（child_process 调用），不依赖 node sqlite3 模块。
//
// 运行：node server/fill-recent.js [扫描天数] [--apply]
//   不带 --apply 时为 dry-run（只打印将要做的变更，不写库）
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const DB_PATH = process.env.TM_DB || path.join(__dirname, 'data.db');
const SCAN_DAYS = parseInt(process.argv[2], 10) || 15;
const APPLY = process.argv.includes('--apply');

// 用 sqlite3 CLI 查询（JSON 输出）
function sqlQuery(sql) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'
  });
  return out.trim() ? JSON.parse(out) : [];
}

// 串行 + 重试：东财对并发/频繁请求会直接断连（curl 返回非 0）
async function curlGet(url, retries = 3) {
  var lastErr;
  for (var i = 0; i < retries; i++) {
    try {
      const { stdout } = await execFileP('curl', [
        '-4', '-s', '--connect-timeout', '10', '--max-time', '30',
        '-A', 'Mozilla/5.0', '-H', 'Referer: https://quote.eastmoney.com/', url
      ], { maxBuffer: 20 * 1024 * 1024 });
      if (stdout && stdout.trim()) return stdout;
      lastErr = new Error('空响应');
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));   // 退避
  }
  throw lastErr || new Error('curl 失败');
}

// 成交额数据源：优先复用本项目已验证的行情模块（Baostock → 腾讯兜底），
// 东财 push2his 作为备份（该接口对服务器 IP 会限流返回空响应）
async function fetchAmountByDate(days) {
  // 1) 东财（快，但会被限流）
  try {
    const sh = await fetchEMKLine('1.000001', days);
    const sz = await fetchEMKLine('0.399001', days);
    if (Object.keys(sh).length && Object.keys(sz).length) return { sh: sh, sz: sz, src: 'eastmoney' };
  } catch (e) {
    console.log('  (东财成交额不可用: ' + e.message + '，改用行情模块)');
  }
  // 2) 本项目行情模块（Baostock → 腾讯）
  const mq = require('./market-quote');
  const shK = await mq.fetchKLine('sh000001', days);
  const szK = await mq.fetchKLine('sz399001', days);
  const sh = {}, sz = {};
  shK.forEach(k => { sh[k.date] = k.amount / 1e8; });   // 元 → 亿元
  szK.forEach(k => { sz[k.date] = k.amount / 1e8; });
  return { sh: sh, sz: sz, src: 'market-quote(Baostock/腾讯)' };
}

async function fetchEMKLine(secid, count) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + secid + '&fields1=f1,f2,f3,f4,f5' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    '&klt=101&fqt=0&end=20991231&lmt=' + count;
  const json = JSON.parse(await curlGet(url));
  if (!json.data || !Array.isArray(json.data.klines)) throw new Error('K线无数据 secid=' + secid);
  const out = {};
  json.data.klines.forEach(line => {
    const f = line.split(',');
    out[f[0]] = (parseFloat(f[6]) || 0) / 1e8;   // 元 → 亿元
  });
  return out;
}

async function fetchMargin(days) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
    '&columns=ALL&pageSize=' + days + '&sortColumns=dim_date&sortTypes=-1';
  const json = JSON.parse(await curlGet(url));
  const rows = (json.result && json.result.data) || [];
  const out = {};
  rows.forEach(r => {
    out[String(r.DIM_DATE).slice(0, 10)] = {
      rzye: parseFloat(r.RZYE) || null,
      rzrqye: parseFloat(r.RZRQYE) || null
    };
  });
  return out;
}

(async () => {
  console.log('===== 补齐最近缺失数据 ' + (APPLY ? '[APPLY 写入]' : '[DRY-RUN 只读]') + ' =====');
  console.log('数据库: ' + DB_PATH);

  // 串行拉取（并发会被东财断连）
  const amount = await fetchAmountByDate(SCAN_DAYS + 10);
  const shAmount = amount.sh, szAmount = amount.sz;
  const margin = await fetchMargin(SCAN_DAYS + 5);
  console.log('成交额数据源：' + amount.src + '（sh ' + Object.keys(shAmount).length + ' 天 / sz ' + Object.keys(szAmount).length + ' 天）');
  const marginDates = Object.keys(margin).sort();
  console.log('东财两融　：' + marginDates.length + ' 天，最新 ' + marginDates[marginDates.length - 1]);

  const rows = sqlQuery('SELECT date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi ' +
    'FROM market_history ORDER BY date DESC LIMIT ' + SCAN_DAYS);

  function changePct(date) {
    const i = marginDates.indexOf(date);
    if (i <= 0) return null;
    const cur = margin[date].rzye, prev = margin[marginDates[i - 1]].rzye;
    if (!cur || !prev) return null;
    return ((cur - prev) / prev) * 100;
  }

  const stmts = [];
  for (const r of rows) {
    const d = r.date;
    const needAmount = (r.amount_total_yi === null || r.amount_total_yi === 0) && shAmount[d] && szAmount[d];
    const needMargin = (r.rzye === null) && margin[d] && margin[d].rzye;
    const needChangePct = (r.margin_change_pct === null) && margin[d];
    if (!needAmount && !needMargin && !needChangePct) continue;

    const sets = [];
    if (needAmount) {
      const sh = shAmount[d], sz = szAmount[d];
      sets.push('amount_sh_yi=' + sh.toFixed(4), 'amount_sz_yi=' + sz.toFixed(4), 'amount_total_yi=' + (sh + sz).toFixed(4));
      console.log('  [成交额] ' + d + '  沪=' + sh.toFixed(1) + '亿 深=' + sz.toFixed(1) + '亿 合计=' + (sh + sz).toFixed(1) + '亿');
    }
    if (needMargin) {
      sets.push('rzye=' + margin[d].rzye, 'rzrqye=' + margin[d].rzrqye);
      console.log('  [两融]   ' + d + '  融资=' + (margin[d].rzye / 1e8).toFixed(2) + '亿 两融=' + (margin[d].rzrqye / 1e8).toFixed(2) + '亿');
    }
    if (needChangePct) {
      const cp = changePct(d);
      if (cp !== null) {
        sets.push('margin_change_pct=' + cp.toFixed(4));
        console.log('  [两融变动] ' + d + '  ' + cp.toFixed(3) + '%');
      }
    }
    if (sets.length) {
      stmts.push("UPDATE market_history SET " + sets.join(', ') +
        ", fetched_at='" + new Date().toISOString() + "' WHERE date='" + d + "';");
    }
  }

  if (!stmts.length) {
    console.log('\n✅ 最近 ' + SCAN_DAYS + ' 天无缺失（或数据源尚未发布）');
  } else if (APPLY) {
    const sqlFile = '/tmp/fill-recent.sql';
    require('fs').writeFileSync(sqlFile, stmts.join('\n'));
    execFileSync('sqlite3', [DB_PATH, '.read ' + sqlFile], { encoding: 'utf8' });
    console.log('\n✅ 已写入 ' + stmts.length + ' 天');
  } else {
    console.log('\n⚠️ DRY-RUN：以上 ' + stmts.length + ' 天待写入，加 --apply 执行');
  }

  const after = sqlQuery('SELECT date, rzye, rzrqye, amount_total_yi, zt_count, dt_count, up_count, down_count ' +
    'FROM market_history ORDER BY date DESC LIMIT 5');
  console.log('\n=== 数据库最近 5 天 ===');
  console.log('date         融资(亿)      两融(亿)   成交额(亿)  涨停 跌停 上涨  下跌');
  after.forEach(x => {
    const f = (v, w, dec) => String(v === null || v === undefined ? 'NULL' : (typeof v === 'number' ? v.toFixed(dec === undefined ? 1 : dec) : v)).padEnd(w);
    console.log(f(x.date, 13), f(x.rzye ? x.rzye / 1e8 : null, 13, 2), f(x.rzrqye ? x.rzrqye / 1e8 : null, 11, 2),
      f(x.amount_total_yi, 11), f(x.zt_count, 5, 0), f(x.dt_count, 5, 0), f(x.up_count, 6, 0), f(x.down_count, 6, 0));
  });
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
