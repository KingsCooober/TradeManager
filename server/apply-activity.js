// 把 Baostock 重算出的涨跌家数 / 涨跌停家数写入 market_history
// 安全策略：**只覆盖「异常值」（up_count 为 NULL 或 0）的行**，已有真实数据绝不覆盖
//
// 运行：node server/apply-activity.js <json文件> [--force]
//   json 文件：bs-activity.py 输出的结果（每行一个 JSON，或单个 JSON）
//   --force ：跳过保护，强制覆盖（谨慎）
//
// 注：远程服务器 node 的 sqlite3 原生模块 require 会 segfault，统一走 sqlite3 CLI
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.TM_DB || path.join(__dirname, 'data.db');
const jsonFile = process.argv[2];
const FORCE = process.argv.includes('--force');

if (!jsonFile) { console.error('用法: node server/apply-activity.js <json文件> [--force]'); process.exit(1); }

function sqlQuery(sql) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : [];
}

// 解析：支持单行 JSON / 多行 JSON / 夹杂日志的混合输出
const raw = fs.readFileSync(jsonFile, 'utf8').trim().split('\n');
const results = [];
for (const line of raw) {
  const t = line.trim();
  if (!t.startsWith('{')) continue;
  try { results.push(JSON.parse(t)); } catch (e) { /* 忽略非 JSON 行 */ }
}
if (!results.length) { console.error('❌ 未解析到 JSON 结果'); process.exit(1); }

console.log('===== 写入涨跌家数 ' + (FORCE ? '[FORCE]' : '[仅覆盖异常值]') + ' =====');
const stmts = [];
for (const r of results) {
  const d = r.date;
  const rows = sqlQuery("SELECT date, up_count, down_count, flat_count, zt_count, dt_count, zt_dt_diff, sample_size, source " +
    "FROM market_history WHERE date='" + d + "'");
  if (!rows.length) { console.log('⚠️ ' + d + ' 数据库中不存在该日期，跳过'); continue; }
  const cur = rows[0];

  // 保护：只在当前是异常值（NULL 或全 0）时写入
  const isEmpty = (cur.up_count === null || cur.up_count === 0) && (cur.down_count === null || cur.down_count === 0);
  if (!isEmpty && !FORCE) {
    console.log('⏭️ ' + d + ' 已有数据（涨' + cur.up_count + '/跌' + cur.down_count + '/涨停' + cur.zt_count + '），跳过');
    continue;
  }

  console.log('  ' + d + '  涨=' + r.up_count + ' 跌=' + r.down_count + ' 平=' + r.flat_count +
    ' 涨停=' + r.zt_count + ' 跌停=' + r.dt_count + ' 样本=' + r.sample_size +
    '  (原值: 涨' + cur.up_count + '/跌' + cur.down_count + '/涨停' + cur.zt_count + ')');

  stmts.push("UPDATE market_history SET " +
    "up_count=" + r.up_count + ", down_count=" + r.down_count + ", flat_count=" + r.flat_count +
    ", zt_count=" + r.zt_count + ", dt_count=" + r.dt_count + ", zt_dt_diff=" + r.zt_dt_diff +
    ", sample_size=" + r.sample_size +
    ", source='baostock-recalc', fetched_at='" + new Date().toISOString() + "' " +
    "WHERE date='" + d + "';");
}

if (!stmts.length) {
  console.log('\n⚠️ 无需要写入的行');
} else {
  const sqlFile = path.join(__dirname, 'apply-activity.sql');
  fs.writeFileSync(sqlFile, stmts.join('\n'));
  execFileSync('sqlite3', [DB_PATH, '.read ' + sqlFile], { encoding: 'utf8' });
  console.log('\n✅ 已写入 ' + stmts.length + ' 天');
}

const after = sqlQuery('SELECT date, zt_count, dt_count, up_count, down_count, flat_count, sample_size, source ' +
  'FROM market_history ORDER BY date DESC LIMIT 5');
console.log('\n=== 数据库最近 5 天 ===');
console.log('date         涨停 跌停 上涨  下跌  平盘  样本   source');
after.forEach(x => {
  const f = (v, w) => String(v === null || v === undefined ? 'NULL' : v).padEnd(w);
  console.log(f(x.date, 13), f(x.zt_count, 5), f(x.dt_count, 5), f(x.up_count, 6), f(x.down_count, 6), f(x.flat_count, 6), f(x.sample_size, 7), x.source || '');
});
