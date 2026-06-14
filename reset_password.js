// 重置用户密码工具
// 使用方法: node reset_password.js <username> <new_password>
const sqlite3 = require('./server/node_modules/sqlite3').verbose();
const bcrypt = require('./server/node_modules/bcryptjs');
const path = require('path');

const [, , username, newPassword] = process.argv;

if (!username || !newPassword) {
  console.log('用法: node reset_password.js <username> <new_password>');
  console.log('示例: node reset_password.js wbai 123456');
  process.exit(1);
}

if (newPassword.length < 6) {
  console.log('❌ 密码长度至少 6 位');
  process.exit(1);
}

const db = new sqlite3.Database(path.join(__dirname, 'server/data.db'));

// 1. 检查用户是否存在
db.get('SELECT id, username, role FROM users WHERE username = ?', [username], (err, user) => {
  if (err) { console.error('查询失败:', err); db.close(); process.exit(1); }
  if (!user) {
    console.log(`❌ 用户 "${username}" 不存在`);
    db.close();
    process.exit(1);
  }
  console.log(`✅ 找到用户: ${user.username} (${user.role})`);

  // 2. 生成新的 bcrypt 哈希
  const hash = bcrypt.hashSync(newPassword, 10);
  console.log('🔐 已生成新密码哈希');

  // 3. 更新数据库
  db.run(
    'UPDATE users SET password = ? WHERE id = ?',
    [hash, user.id],
    function (err) {
      if (err) { console.error('❌ 更新失败:', err); db.close(); process.exit(1); }
      console.log(`✅ 密码重置成功 (影响 ${this.changes} 条)`);
      console.log('');
      console.log('====== 新凭据 ======');
      console.log('用户名:', user.username);
      console.log('新密码:', newPassword);
      console.log('角色:', user.role);
      db.close();
    }
  );
});
