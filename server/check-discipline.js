const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

const userId = 'a468b6d4-8be3-4282-89d0-b5d642992c94';

console.log('========== 数据库交易纪律核查 ==========');
console.log('user_id:', userId);

db.get(
  "SELECT user_id, init_capital, risk_pct, max_risk, fee_rate, discipline_rules_json, updated_at FROM settings WHERE user_id = ?",
  [userId],
  (err, row) => {
    if (err) {
      console.error('查询失败:', err.message);
      db.close();
      return;
    }
    if (!row) {
      console.log('未找到该用户的 settings 记录');
      db.close();
      return;
    }
    console.log('---');
    console.log('init_capital:', row.init_capital);
    console.log('risk_pct:', row.risk_pct);
    console.log('max_risk:', row.max_risk);
    console.log('fee_rate:', row.fee_rate);
    console.log('updated_at:', row.updated_at);
    console.log('---');
    if (row.discipline_rules_json) {
      try {
        const rules = JSON.parse(row.discipline_rules_json);
        console.log('交易纪律 (', rules.length, '条):');
        rules.forEach((r, i) => console.log('  ' + (i+1) + '. ' + r));
      } catch(e) {
        console.log('discipline_rules_json 解析失败:', e.message);
        console.log('原始值:', row.discipline_rules_json);
      }
    } else {
      console.log('discipline_rules_json 为空');
    }
    db.close();
  }
);
