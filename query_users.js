const sqlite3 = require('./server/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('./server/data.db');

db.serialize(() => {
  db.get(
    "SELECT COUNT(*) as total, SUM(CASE WHEN role='admin' THEN 1 ELSE 0 END) as admin_count, SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) as user_count FROM users",
    (err, row) => {
      console.log('====== 账户统计 ======');
      console.log('总账户数:', row.total);
      console.log('管理员:', row.admin_count, '| 普通用户:', row.user_count);
      console.log('');
    }
  );

  db.all('SELECT username, role, created_at FROM users ORDER BY created_at LIMIT 5', (err, rows) => {
    console.log('====== 最早 5 个账户 ======');
    rows.forEach((r, i) => console.log((i + 1) + '. ' + r.username + ' (' + r.role + ') - ' + r.created_at));
    console.log('');
  });

  db.all('SELECT username, role, created_at FROM users ORDER BY created_at DESC LIMIT 5', (err, rows) => {
    console.log('====== 最新 5 个账户 ======');
    rows.forEach((r, i) => console.log((i + 1) + '. ' + r.username + ' (' + r.role + ') - ' + r.created_at));
    console.log('');
  });

  db.all('SELECT role, COUNT(*) as count FROM users GROUP BY role', (err, rows) => {
    console.log('====== 按角色分组 ======');
    rows.forEach((r) => console.log(r.role + ': ' + r.count + ' 个'));
    db.close();
  });
});
