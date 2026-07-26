// 测试 fetchKLine 拉 10 年日线
const mq = require('./market-quote.js');
(async () => {
  try {
    const data = await mq.fetchKLine('sh600000', 2500);
    console.log('成功! 长度:', data.length);
    console.log('首日:', data[0]);
    console.log('末日:', data[data.length-1]);
  } catch(e) {
    console.error('失败:', e.message, '\n', e.stack);
  }
})();
