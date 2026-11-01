// 补齐「整行缺失」的交易日（fill-recent.js 只 UPDATE 已有行，不 INSERT 新行）
//
// 场景：某个交易日收盘后无人打开页面 → 后端没触发抓取 → market_history 完全没这行
// 本脚本：拉「新浪情绪快照（涨跌家数/涨跌停，实时接口，**只能拿最新交易日**）」
//       + 「指数成交额（index-amount：东财 push2his → Baostock，亿元）」
//       + 「东财两融（T+1，未提供则留 NULL）」
//       → INSERT OR REPLACE 写入
//
// 限制：TARGET 必须是最新交易日（新浪情绪接口无法回溯历史），
//       补更早日期请用 bs-activity.py（Baostock 全市场重算）+ apply-activity.js。
//
// 注意：远程 node 的 sqlite3 原生模块 require 会 segfault → 统一走 sqlite3 CLI
//
// 运行：node server/fill-missing-day.js YYYY-MM-DD [--apply]
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.TM_DB || path.join(__dirname, 'data.db');
const TARGET = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!TARGET) {
  console.error('用法: node fill-missing-day.js YYYY-MM-DD [--apply]');
  process.exit(1);
}

function sqlQuery(sql) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'
  });
  return out.trim() ? JSON.parse(out) : [];
}
function sqlExec(sql) {
  execFileSync('sqlite3', [DB_PATH, sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
function esc(v) { return String(v).replace(/'/g, "''"); }

(async () => {
  console.log('===== 补齐缺失交易日 ' + TARGET + (APPLY ? ' [APPLY]' : ' [DRY-RUN]') + ' =====');

  const exist = sqlQuery("SELECT * FROM market_history WHERE date='" + TARGET + "'");
  if (exist.length) {
    console.log('⚠️ 该日期已存在记录，请用 fill-recent.js 做局部补齐');
    console.log('   当前: 成交额=' + exist[0].amount_total_yi + ' 涨=' + exist[0].up_count +
      ' 两融=' + (exist[0].rzrqye ? (exist[0].rzrqye / 1e8).toFixed(2) + '亿' : 'NULL'));
    process.exit(0);
  }

  // 1) 情绪面（新浪 hs_a 全量，实时接口 → 非交易日返回最近交易日收盘）
  //
  // ⚠️ 不能用 getSentimentSnapshot()：它有「非交易日短路」分支（周六/周日直接返回全 0），
  //    且短路分支内部 require('./market-history') → require('sqlite3') → 远程 node 段错误，进程无声死亡。
  //    这里直接复用已导出的 fetchStocksPage + classifyStock，自己分页拉全量统计。
  console.log('[1/3] 拉取新浪情绪快照…（约 55 页，需 30~60 秒）');
  const ms = require('./market-sentiment');
  const stats = { up: 0, down: 0, flat: 0, zt: 0, dt: 0 };
  let sampleSize = 0;
  const TOTAL_PAGES = 55, BATCH = 10;
  for (let start = 1; start <= TOTAL_PAGES; start += BATCH) {
    const jobs = [];
    for (let p = start; p < Math.min(start + BATCH, TOTAL_PAGES + 1); p++) {
      jobs.push(ms.fetchStocksPage(p, 100).catch(() => []));
    }
    const pages = await Promise.all(jobs);
    for (const page of pages) {
      for (const st of page) {
        const c = ms.classifyStock(st);
        stats.up += c.up; stats.down += c.down; stats.flat += c.flat;
        stats.zt += c.zt; stats.dt += c.dt;
        sampleSize++;
      }
    }
    process.stdout.write('   已扫 ' + sampleSize + ' 只…\r');
  }
  const sm = stats;
  console.log('\n   涨停=' + sm.zt + ' 跌停=' + sm.dt + ' 涨=' + sm.up +
    ' 跌=' + sm.down + ' 平=' + sm.flat + ' 样本=' + sampleSize);

  // 2) 成交额（index-amount 模块：东财 push2his → Baostock，单位亿元）
  //
  // ★ 不要用 market-quote.fetchKLine 的 k.amount：腾讯 day 数组没有成交额字段，
  //   k.amount 实际是「成交量(手)」，直接 /1e8 会写出差 1000 倍的脏数据。
  console.log('[2/3] 拉取成交额…');
  const indexAmount = require('./index-amount');
  const amtRes = await indexAmount.fetchMarketAmountByDate(15);
  const amtMap = amtRes.map;
  const amtDates = Object.keys(amtMap).sort();
  console.log('   数据源=' + amtRes.src + '  最新 3 天=' + JSON.stringify(amtDates.slice(-3)));

  if (!amtMap[TARGET]) {
    console.error('❌ 权威源没有 ' + TARGET + ' 的成交额（可能非交易日或数据源未更新）');
    process.exit(1);
  }

  // ★ 日期守卫：新浪情绪接口只有「实时」，非交易日返回最近交易日收盘。
  //   所以只有当 TARGET 就是最新交易日时，快照才是 TARGET 当天的数据；
  //   补更早的历史日期必须走 Baostock 全市场重算（bs-activity.py），否则会把
  //   最新交易日的涨跌家数错配到 TARGET 上。
  const latestTradeDate = amtDates[amtDates.length - 1];
  if (TARGET !== latestTradeDate && !process.argv.includes('--force')) {
    console.error('❌ ' + TARGET + ' 不是最新交易日（最新=' + latestTradeDate + '）');
    console.error('   新浪情绪接口无法回溯历史，补历史日期请用：');
    console.error('     python3 bs-activity.py ' + TARGET + '   （全市场重算，约 8.5 分钟）');
    console.error('     node apply-activity.js bs-<MMDD>.log');
    process.exit(2);
  }

  const sh = amtMap[TARGET].sh, sz = amtMap[TARGET].sz;
  if (!indexAmount.isSaneAmount(sh, sz)) {
    console.error('❌ ' + TARGET + ' 成交额数值异常：沪=' + sh.toFixed(2) + '亿 深=' + sz.toFixed(2) +
      '亿（疑似单位错误），已中止');
    process.exit(3);
  }

  // 3) 两融（东财 T+1）
  console.log('[3/3] 拉取东财两融…');
  let rzye = 'NULL', rzrqye = 'NULL', chg = 'NULL';
  try {
    const { execFile } = require('child_process');
    const util = require('util');
    const execFileP = util.promisify(execFile);
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
      '&columns=ALL&pageSize=10&sortColumns=dim_date&sortTypes=-1';
    const { stdout } = await execFileP('curl', ['-4', '-s', '--connect-timeout', '10',
      '--max-time', '30', '-A', 'Mozilla/5.0', '-H', 'Referer: https://quote.eastmoney.com/', url],
      { maxBuffer: 20 * 1024 * 1024 });
    const rows = JSON.parse(stdout).result.data || [];
    const dates = rows.map(r => String(r.DIM_DATE).slice(0, 10));
    console.log('   东财两融最新=' + dates[0] + '（共 ' + dates.length + ' 天）');
    const hit = rows.find(r => String(r.DIM_DATE).slice(0, 10) === TARGET);
    if (hit) {
      rzye = String(parseFloat(hit.RZYE));
      rzrqye = String(parseFloat(hit.RZRQYE));
      const idx = dates.indexOf(TARGET);
      if (idx >= 0 && idx < rows.length - 1) {
        const prev = parseFloat(rows[idx + 1].RZYE);
        if (prev) chg = String(((parseFloat(hit.RZYE) - prev) / prev) * 100);
      }
      console.log('   ✅ 命中 ' + TARGET + ' 融资=' + (parseFloat(hit.RZYE) / 1e8).toFixed(2) + '亿');
    } else {
      console.log('   ⏭️ 东财尚未发布 ' + TARGET + ' 两融（T+1），留 NULL');
    }
  } catch (e) {
    console.log('   (两融拉取失败: ' + e.message + '，留 NULL)');
  }

  const zt = sm.zt || 0, dt = sm.dt || 0;

  console.log('\n=== 将写入 ===');
  console.log('  日期      : ' + TARGET);
  console.log('  成交额    : 沪 ' + sh.toFixed(1) + '亿 + 深 ' + sz.toFixed(1) + '亿 = ' + (sh + sz).toFixed(1) + '亿');
  console.log('  涨跌家数  : 涨 ' + (sm.up || 0) + ' / 跌 ' + (sm.down || 0) + ' / 平 ' + (sm.flat || 0));
  console.log('  涨跌停    : ' + zt + ' / ' + dt + ' / 差 ' + (zt - dt));
  console.log('  两融      : ' + (rzrqye === 'NULL' ? 'NULL（待发布）' : (parseFloat(rzrqye) / 1e8).toFixed(2) + '亿'));

  if (!APPLY) {
    console.log('\n⚠️ DRY-RUN：加 --apply 写入');
    process.exit(0);
  }

  const sql = "INSERT OR REPLACE INTO market_history " +
    "(date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi," +
    " zt_count, dt_count, zt_dt_diff, up_count, down_count, flat_count, sample_size," +
    " north_net_yi, fetched_at, source) VALUES ('" +
    TARGET + "', " + rzye + ", " + rzrqye + ", " + chg + ", " +
    sh.toFixed(4) + ", " + sz.toFixed(4) + ", " + (sh + sz).toFixed(4) + ", " +
    zt + ", " + dt + ", " + (zt - dt) + ", " +
    (sm.up || 0) + ", " + (sm.down || 0) + ", " + (sm.flat || 0) + ", " + sampleSize + ", " +
    "0, '" + new Date().toISOString() + "', 'sina+em');";
  sqlExec(sql);

  console.log('\n✅ 已写入');
  const after = sqlQuery("SELECT date, rzye, rzrqye, amount_total_yi, up_count, down_count, zt_count, dt_count, source " +
    "FROM market_history WHERE date>='" + TARGET.slice(0, 8) + "01' ORDER BY date");
  console.log('\n=== 本月数据 ===');
  console.log('date         融资(亿)      两融(亿)   成交额(亿)  涨停 跌停 上涨  下跌  source');
  after.forEach(x => {
    const f = (v, w, dec) => String(v === null || v === undefined ? 'NULL' : (typeof v === 'number' ? v.toFixed(dec || 1) : v)).padEnd(w);
    console.log(f(x.date, 13), f(x.rzye ? x.rzye / 1e8 : null, 13, 2), f(x.rzrqye ? x.rzrqye / 1e8 : null, 11, 2),
      f(x.amount_total_yi, 11), f(x.zt_count, 5, 0), f(x.dt_count, 5, 0),
      f(x.up_count, 6, 0), f(x.down_count, 6, 0), x.source || '');
  });
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
