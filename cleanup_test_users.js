// 清理测试账户脚本
// 保留: wbai, admin
// 删除: 其他所有测试账户及其关联数据
const sqlite3 = require('./server/node_modules/sqlite3').verbose();
const db = new sqlite3.Database('./server/data.db');

const KEEP_USERS = ['wbai', 'admin'];

db.serialize(() => {
  // 1. 统计待删除账户及其关联数据
  db.get(
    `SELECT COUNT(*) as c FROM users WHERE username NOT IN (${KEEP_USERS.map(() => '?').join(',')})`,
    KEEP_USERS,
    (err, row) => {
      console.log('待删除账户数:', row.c);
    }
  );

  // 2. 查询每个被删账户的关联数据
  db.all(
    `SELECT id, username FROM users WHERE username NOT IN (${KEEP_USERS.map(() => '?').join(',')})`,
    KEEP_USERS,
    (err, users) => {
      if (!users || users.length === 0) {
        console.log('没有需要删除的账户');
        db.close();
        return;
      }
      const userIds = users.map((u) => u.id);
      const placeholders = userIds.map(() => '?').join(',');

      let stats = { trades: 0, deposits: 0, withdrawals: 0, settings: 0, diary2: 0, users: 0 };

      function countAndDelete(table, cb) {
        db.get(
          `SELECT COUNT(*) as c FROM ${table} WHERE user_id IN (${placeholders})`,
          userIds,
          (e, r) => {
            stats[table] = r.c;
            db.run(
              `DELETE FROM ${table} WHERE user_id IN (${placeholders})`,
              userIds,
              function (err) {
                cb();
              }
            );
          }
        );
      }

      // 链式删除
      countAndDelete('trades', () => {
        countAndDelete('deposits', () => {
          countAndDelete('withdrawals', () => {
            countAndDelete('settings', () => {
              countAndDelete('diary2', () => {
                // 最后删除用户
                db.run(
                  `DELETE FROM users WHERE username NOT IN (${KEEP_USERS.map(() => '?').join(',')})`,
                  KEEP_USERS,
                  function (err) {
                    stats.users = this.changes;
                    console.log('');
                    console.log('====== 清理完成 ======');
                    console.log('已删除用户:', stats.users, '个');
                    console.log('已删除交易记录:', stats.trades, '条');
                    console.log('已删除入金记录:', stats.deposits, '条');
                    console.log('已删除出金记录:', stats.withdrawals, '条');
                    console.log('已删除账户设置:', stats.settings, '条');
                    console.log('已删除复盘总结:', stats.diary2, '条');
                    console.log('');

                    // 验证最终状态
                    db.get('SELECT COUNT(*) as c FROM users', (e, r) => {
                      console.log('====== 剩余账户 ======');
                      console.log('总数:', r.c, '个');
                      db.all('SELECT username, role, created_at FROM users', (e, rs) => {
                        rs.forEach((u, i) => console.log((i + 1) + '. ' + u.username + ' (' + u.role + ') - ' + u.created_at));
                        console.log('');

                        // VACUUM 回收空间
                        db.run('VACUUM', () => {
                          console.log('数据库已整理（VACUUM）');
                          db.close();
                        });
                      });
                    });
                  }
                );
              });
            });
          });
        });
      });
    }
  );
});
