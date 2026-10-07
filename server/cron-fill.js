// 每个交易日收盘后自动补数总控（由服务器 crontab 调度，每周一至五 20:30）
//
// 职责：
//   1. 用指数 K 线生成「真实交易日历」（天然兼容节假日/周末，节假日 K 线里没有该日期）
//   2. 对 market_history 中整行缺失的交易日 → 调 fill-missing-day.js 补整行
//   3. 对已存在行的局部缺失（成交额/两融，含 T+1 发布的两融）→ 调 fill-recent.js
//
// 复用现有脚本，本脚本只做「日历比对 + 调度」，不改任何数据逻辑。
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'data.db');
const SCAN_DAYS = 15;   // 回看最近 15 个交易日

function sqlQuery(sql) {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    maxBuffer: 32 * 1024 * 1024, encoding: 'utf8'
  });
  return out.trim() ? JSON.parse(out) : [];
}

(async () => {
  console.log('\n===== cron-fill 启动 ' + new Date().toISOString() + ' =====');

  // 1) 真实交易日历（来自行情模块：Baostock → 腾讯兜底）
  const mq = require('./market-quote');
  const k = await mq.fetchKLine('sh000001', SCAN_DAYS);
  const tradeDates = k.map(x => x.date);
  if (!tradeDates.length) throw new Error('拿不到交易日历（K 线为空）');
  console.log('交易日历（近 ' + tradeDates.length + ' 个交易日）: ' +
    tradeDates[0] + ' ~ ' + tradeDates[tradeDates.length - 1]);

  // 2) 找整行缺失的交易日
  const rows = sqlQuery("SELECT date FROM market_history WHERE date >= '" + tradeDates[0] + "'");
  const have = new Set(rows.map(r => r.date));
  const missing = tradeDates.filter(d => !have.has(d));
  console.log('整行缺失: ' + (missing.length ? missing.join(', ') : '无'));

  // 3) 逐个补整行（fill-missing-day 自带守卫：行情模块没有该日数据时会安全退出）
  for (const d of missing) {
    console.log('\n--- 补整行 ' + d + ' ---');
    try {
      execFileSync('node', [path.join(__dirname, 'fill-missing-day.js'), d, '--apply'],
        { stdio: 'inherit', timeout: 5 * 60 * 1000 });
    } catch (e) {
      console.log('⚠️ ' + d + ' 补整行失败: ' + e.message + '（下个周期重试）');
    }
  }

  // 4) 局部补齐（只补 NULL，不覆盖已有值；顺带把 T+1 发布的两融补上）
  console.log('\n--- 局部补齐（成交额/两融）---');
  try {
    execFileSync('node', [path.join(__dirname, 'fill-recent.js'), '10', '--apply'],
      { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  } catch (e) {
    console.log('⚠️ 局部补齐失败: ' + e.message + '（下个周期重试）');
  }

  console.log('\n===== cron-fill 完成：缺行 ' + missing.length + ' 天' +
    (missing.length ? '（' + missing.join(',') + '）' : '') + ' =====');
})().catch(e => {
  console.error('❌ cron-fill 失败:', e.message);
  process.exit(1);
});
