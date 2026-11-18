// 一次性回填脚本：补齐 market_history 中 2020-01-01 起的融资融券（rzye/rzrqye）历史
// 数据源：东方财富 datacenter RPTA_RZRQ_LSHJ（全市场两融汇总报表，按日）
// 用法：node server/backfill-margin-2020.js
//
// 注意：
//   - 只回填 rzye / rzrqye / margin_change_pct 三个字段；已有当日的值不覆盖非零字段
//     （ON CONFLICT DO UPDATE 仅在现有值为 NULL/0 时写入，避免覆盖后续更准的实时数据）
//   - 成交额（amount_*）等其他字段不动（由 backfill-history.js 维护）
//   - 该报表从 2010 年起；2020-01-01 至今约 1700 个交易日。

const path = require('path');
const { execFile } = require('child_process');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(DB_PATH);
const SINCE = '2020-01-01';

// 东财 datacenter-web 在 Node https 里偶发 hang up，走 curl 更稳（与 backfill-history.js 一致）
function fetchPage(page) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=500' +
    '&sortColumns=dim_date&sortTypes=-1&pageNumber=' + page;
  return new Promise(function(resolve, reject) {
    execFile('curl', ['-4', '-s', '--connect-timeout', '15', '--max-time', '60', '-A', 'Mozilla/5.0', url],
      function(err, stdout) {
        if (err) return reject(err);
        try {
          const json = JSON.parse(stdout.toString('utf8'));
          if (!json.result || !Array.isArray(json.result.data)) {
            return reject(new Error('两融历史接口无数据（第 ' + page + ' 页）'));
          }
          resolve(json.result);
        } catch (e) { reject(e); }
      });
  });
}

function num(v) { return (typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : 0)); }
function dateFormat(d) { return String(d).slice(0, 10); }

async function main() {
  console.log('===== 回填 2020 年以来融资融券历史 =====');
  const byDate = {};
  for (let page = 1; page <= 8; page++) {
    const result = await fetchPage(page);
    let reachedOld = true;
    for (const r of result.data) {
      const date = dateFormat(r.DIM_DATE);
      if (date < SINCE) continue;
      reachedOld = false;
      // RPTA_RZRQ_LSHJ 是全市场单行/日：rzye=融资余额, rqye=融券余额, rzrqye=两融余额（元）
      byDate[date] = {
        rzye: num(r.RZYE),
        rqye: num(r.RQYE),
        rzrqye: num(r.RZRQYE),
        changePct: num(r.changePct || r.RZRQYE_CHANGE || 0)
      };
    }
    console.log('   第 ' + page + ' 页：' + result.data.length + ' 行');
    if (reachedOld || result.data.length < 500 || (result.pages > 0 && page >= result.pages)) break;
  }
  const dates = Object.keys(byDate).sort();
  console.log('   共 ' + dates.length + ' 个交易日（' + (dates[0] || '-') + ' ~ ' + (dates[dates.length - 1] || '-') + '）');

  let inserted = 0, updated = 0;
  for (const date of dates) {
    const { rzye, rzrqye, changePct } = byDate[date];
    if (!(rzye > 0) || !(rzrqye > 0)) continue;
    await new Promise(function(resolve) {
      // 首次插入直接写；已存在的行仅在现有值为 NULL/0 时补（不覆盖实时写入的更准数据）
      db.run(`INSERT INTO market_history (date, rzye, rzrqye, margin_change_pct, fetched_at, source)
        VALUES (?, ?, ?, ?, ?, 'eastmargin-backfill-2020')
        ON CONFLICT(date) DO UPDATE SET
          rzye = CASE WHEN market_history.rzye IS NULL OR market_history.rzye = 0 THEN excluded.rzye ELSE market_history.rzye END,
          rzrqye = CASE WHEN market_history.rzrqye IS NULL OR market_history.rzrqye = 0 THEN excluded.rzrqye ELSE market_history.rzrqye END,
          margin_change_pct = CASE WHEN market_history.margin_change_pct IS NULL OR market_history.margin_change_pct = 0 THEN excluded.margin_change_pct ELSE market_history.margin_change_pct END,
          fetched_at = excluded.fetched_at`,
        [date, rzye, rzrqye, changePct, new Date().toISOString()],
        function(err) {
          if (err) console.warn('   失败 ' + date + ':', err.message);
          else if (this.lastID) inserted++;
          else updated++;
          resolve();
        });
    });
  }
  console.log('===== 完成：新插 ' + inserted + ' 行，补值 ' + updated + ' 行 =====');
  db.close();
}

main().catch(function(e) {
  console.error('回填失败:', e.message);
  process.exit(1);
});
