// 审计并修正 market_history 的成交额
//
// 权威口径：index-amount 模块（东财 push2his f57 → Baostock amount），单位亿元；
//           两市合计 = 上证指数 amount + 深证成指 amount（与库内既有正确值口径一致，
//           已用 09-30 / 10-09 / 10-13 / 10-16 四天交叉验证）。
//
// 用途：修掉历史上被「成交量当成交额」污染的行（如 2026-10-08、2026-10-14）。
//
// 运行：node server/audit-amount.js [回看天数] [--apply]
const path = require('path');
const { execFileSync } = require('child_process');
const indexAmount = require('./index-amount');

const DB_PATH = process.env.TM_DB || path.join(__dirname, 'data.db');
const LOOKBACK = parseInt(process.argv[2], 10) || 150;
const APPLY = process.argv.includes('--apply');
const TOL_YI = 200, TOL_PCT = 0.02;   // 绝对 200 亿 / 相对 2% 容差

function sqlQuery(sql) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}

(async () => {
  console.log('===== 成交额审计 ' + (APPLY ? '[APPLY]' : '[DRY-RUN]') + ' 回看 ' + LOOKBACK + ' 个交易日 =====');
  const r = await indexAmount.fetchMarketAmountByDate(LOOKBACK);
  const amt = r.map;
  const dates = Object.keys(amt).sort();
  console.log('权威源=' + r.src + '，' + dates.length + ' 天（' + dates[0] + ' ~ ' + dates[dates.length - 1] + '）');

  const rows = sqlQuery("SELECT date, amount_sh_yi, amount_sz_yi, amount_total_yi, source " +
    "FROM market_history WHERE date >= '" + dates[0] + "' ORDER BY date");

  const bad = [];
  for (const row of rows) {
    const d = row.date;
    if (!amt[d]) continue;
    const truth = amt[d].total;
    const cur = row.amount_total_yi;
    if (cur === null || cur === 0) { bad.push({ d, cur, truth, tag: '缺失', src: row.source }); continue; }
    if (Math.abs(cur - truth) > Math.max(TOL_YI, truth * TOL_PCT)) {
      bad.push({ d, cur, truth, tag: (cur / truth).toFixed(3) + 'x', src: row.source });
    }
  }

  console.log('\n比对 ' + rows.length + ' 行，异常 ' + bad.length + ' 行：\n');
  console.log('date         库值(亿)     权威(亿)      倍数  source');
  bad.forEach(b => {
    console.log(b.d.padEnd(13) +
      String(b.cur === null ? 'NULL' : b.cur.toFixed(2)).padStart(11) +
      b.truth.toFixed(2).padStart(12) + b.tag.padStart(10) + '  ' + (b.src || ''));
  });

  if (!bad.length) { console.log('\n✅ 全部一致'); return; }
  if (!APPLY) { console.log('\n⚠️ DRY-RUN：加 --apply 修正'); return; }

  const stmts = bad.map(b => {
    const sh = amt[b.d].sh, sz = amt[b.d].sz;
    const src = (b.src || '').includes('em-fix') ? b.src : (b.src || '') + '+em-fix';
    return "UPDATE market_history SET amount_sh_yi=" + sh.toFixed(4) +
      ", amount_sz_yi=" + sz.toFixed(4) +
      ", amount_total_yi=" + (sh + sz).toFixed(4) +
      ", source='" + src + "', fetched_at='" + new Date().toISOString() +
      "' WHERE date='" + b.d + "';";
  });
  const sqlFile = path.join(__dirname, '.audit-amount.sql');
  require('fs').writeFileSync(sqlFile, stmts.join('\n'));
  execFileSync('sqlite3', [DB_PATH, '.read ' + sqlFile], { encoding: 'utf8' });
  require('fs').unlinkSync(sqlFile);
  console.log('\n✅ 已修正 ' + stmts.length + ' 行');
})().catch(e => { console.error('❌ 失败:', e.message); process.exit(1); });
