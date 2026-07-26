// 生成测试 JWT
const auth = require('./auth.js');
const token = auth.sign({ id: 1, username: 'test', role: 'admin' });
console.log(token);
