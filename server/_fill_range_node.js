// 批量补 market_history 缺失交易日（node sqlite3 落库版）
// 成交额：东财指数K线一次拉整段区间；情绪面：新浪逐日（实时接口只反映最近交易日 → 仅对最近缺失日有效，历史日跳过情绪面）
// 用法: node server/_fill_range_node.js START END [--apply]
const sqlite3 = require('sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, 'data.db');
const START = process.argv[2], END = process.argv[3];
const APPLY = process.argv.includes('--apply');
if (!START || !END) { console.error('用法: node _fill_range_node.js START END [--apply]'); process.exit(1); }

function dbAll(db, sql, params) { return new Promise((res, rej) => db.all(sql, params || [], (e, r) => e ? rej(e) : res(r))); }
function dbRun(db, sql, params) { return new Promise((res, rej) => db.run(sql, params || [], function (e) { e ? rej(e) : res(this); })); }

async function emAmountMaps() {
  // Baostock 指数日K（amount=元），绕开东财 push2his WAF；子进程跑 python
  const { execFile } = require('child_process');
  const execFileP = require('util').promisify(execFile);
  const py = `
import baostock as bs, json
lg = bs.login()
out = {}
for code, key in (("sh.000001","sh"), ("sz.399001","sz")):
    rs = bs.query_history_k_data_plus(code, "date,amount", start_date='${START}', end_date='${END}', frequency="d")
    m = {}
    while rs.error_code == '0' and rs.next():
        d, amt = rs.get_row_data()
        m[d] = float(amt) / 1e8
    out[key] = m
bs.logout()
print(json.dumps(out))
`;
  const { stdout } = await execFileP('python', ['-c', py], { maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
  const parsed = JSON.parse(stdout.trim().split('\n').pop());
  return { sh: parsed.sh, sz: parsed.sz };
}

(async () => {
  console.log('===== 批量补 ' + START + ' ~ ' + END + (APPLY ? ' [APPLY]' : ' [DRY-RUN]') + ' =====');
  const db = new sqlite3.Database(DB_PATH);
  db.run('PRAGMA busy_timeout = 5000');

  // 交易日历：东财 sh000001 区间K线的日期即交易日
  console.log('[1/2] 拉取东财指数K线（交易日历 + 成交额）…');
  const { sh, sz } = await emAmountMaps();
  const dates = Object.keys(sh).sort();
  if (!dates.length) { console.error('❌ 拿不到交易日历'); process.exit(1); }
  console.log('   交易日 ' + dates.length + ' 天: ' + dates[0] + ' ~ ' + dates[dates.length - 1]);
  const missingAmount = dates.filter(d => !sz[d]);
  if (missingAmount.length) { console.error('❌ 深市缺: ' + missingAmount.join(',')); process.exit(1); }

  // 找需要补的日：整行缺失，或 amount_total_yi 为空/0
  console.log('[2/2] 比对库内缺口…');
  const need = [];
  for (const d of dates) {
    const rows = await dbAll(db, 'SELECT * FROM market_history WHERE date = ?', [d]);
    const r = rows[0];
    if (!r || !(r.amount_total_yi > 0) || (r.up_count === 0 && r.down_count === 0)) need.push(d);
  }
  console.log('   待补: ' + (need.length ? need.join(', ') : '无'));
  if (!need.length) { console.log('✅ 无缺口'); process.exit(0); }

  // 情绪面只对「最新交易日」有效（新浪实时接口只反映最近收盘）；更早的日只补成交额/两融，情绪面留 0 并标注
  const latest = dates[dates.length - 1];
  let sentiment = null;
  if (need.includes(latest)) {
    console.log('   拉取新浪情绪快照（仅 ' + latest + '）…');
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
    }
    sentiment = { ...stats, sampleSize };
    console.log('   涨停=' + stats.zt + ' 跌停=' + stats.dt + ' 涨=' + stats.up + ' 跌=' + stats.down + ' 样本=' + sampleSize);
  }

  // 两融（东财，一次拉最近 500 天）
  console.log('   拉取东财两融…');
  let marginMap = {};
  try {
    const { execFile } = require('child_process');
    const execFileP = require('util').promisify(execFile);
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ' +
      '&columns=ALL&pageSize=500&sortColumns=dim_date&sortTypes=-1';
    const { stdout } = await execFileP('curl', ['-4', '-s', '--connect-timeout', '10', '--max-time', '30',
      '-A', 'Mozilla/5.0', '-H', 'Referer: https://quote.eastmoney.com/', url], { maxBuffer: 20 * 1024 * 1024 });
    const rows = JSON.parse(stdout).result.data || [];
    rows.forEach((r, i) => {
      const d = String(r.DIM_DATE).slice(0, 10);
      const prev = rows[i + 1] ? parseFloat(rows[i + 1].RZYE) : null;
      marginMap[d] = {
        rzye: parseFloat(r.RZYE), rzrqye: parseFloat(r.RZRQYE),
        chg: prev ? ((parseFloat(r.RZYE) - prev) / prev) * 100 : null
      };
    });
    console.log('   两融 ' + Object.keys(marginMap).length + ' 天');
  } catch (e) {
    console.log('   (两融失败: ' + e.message.slice(0, 60) + '，留 NULL)');
  }

  console.log('\n=== 将写入 ===');
  need.forEach(d => {
    const m = marginMap[d];
    console.log('  ' + d + ' 成交额=' + (sh[d] + sz[d]).toFixed(1) + '亿' +
      (d === latest && sentiment ? ' 涨停=' + sentiment.zt + ' 跌停=' + sentiment.dt + ' 涨=' + sentiment.up + ' 跌=' + sentiment.down : ' (情绪面留0)') +
      (m ? ' 两融=' + (m.rzrqye / 1e8).toFixed(0) + '亿' : ' 两融=NULL'));
  });
  if (!APPLY) { console.log('DRY-RUN，加 --apply'); process.exit(0); }

  for (const d of need) {
    const m = marginMap[d];
    const s = (d === latest && sentiment) ? sentiment : { up: 0, down: 0, flat: 0, zt: 0, dt: 0, sampleSize: 0 };
    await dbRun(db,
      `INSERT INTO market_history
        (date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi,
         zt_count, dt_count, zt_dt_diff, up_count, down_count, flat_count, sample_size,
         north_net_yi, fetched_at, source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(date) DO UPDATE SET
         rzye=COALESCE(excluded.rzye, rzye),
         rzrqye=COALESCE(excluded.rzrqye, rzrqye),
         margin_change_pct=COALESCE(excluded.margin_change_pct, margin_change_pct),
         amount_sh_yi=excluded.amount_sh_yi, amount_sz_yi=excluded.amount_sz_yi,
         amount_total_yi=excluded.amount_total_yi,
         zt_count=CASE WHEN excluded.up_count>0 THEN excluded.zt_count ELSE zt_count END,
         dt_count=CASE WHEN excluded.up_count>0 THEN excluded.dt_count ELSE dt_count END,
         zt_dt_diff=CASE WHEN excluded.up_count>0 THEN excluded.zt_dt_diff ELSE zt_dt_diff END,
         up_count=CASE WHEN excluded.up_count>0 THEN excluded.up_count ELSE up_count END,
         down_count=CASE WHEN excluded.up_count>0 THEN excluded.down_count ELSE down_count END,
         flat_count=CASE WHEN excluded.up_count>0 THEN excluded.flat_count ELSE flat_count END,
         sample_size=CASE WHEN excluded.up_count>0 THEN excluded.sample_size ELSE sample_size END,
         fetched_at=excluded.fetched_at, source=excluded.source`,
      [d, m ? m.rzye : null, m ? m.rzrqye : null, m ? m.chg : null,
       sh[d], sz[d], sh[d] + sz[d],
       s.zt, s.dt, s.zt - s.dt, s.up, s.down, s.flat, s.sampleSize,
       0, new Date().toISOString(), 'sina+em']);
  }
  console.log('\n✅ 已写入 ' + need.length + ' 天');
  const after = await dbAll(db, 'SELECT date, amount_total_yi, up_count, zt_count, rzrqye FROM market_history WHERE date>=? AND date<=? ORDER BY date', [START, END]);
  after.forEach(x => console.log('  ' + x.date + ' 成交=' + (x.amount_total_yi || 0).toFixed(0) + '亿 涨=' + x.up_count + ' 涨停=' + x.zt_count + ' 两融=' + (x.rzrqye ? (x.rzrqye / 1e8).toFixed(0) + '亿' : 'NULL')));
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
