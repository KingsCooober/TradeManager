// 直接测试 fetchKLine - 跳过 auth
const mq = require('./market-quote.js');

(async () => {
  // 测试 1: 10 年 = 2500 根
  console.log('=== 测试 1: sh600000, 2500 根（10年）===');
  const data1 = await mq.fetchKLine('sh600000', 2500);
  console.log('成功! 长度:', data1.length);
  console.log('首日:', data1[0].date, '收:', data1[0].close, '量:', data1[0].volume, '额:', data1[0].amount);
  console.log('末日:', data1[data1.length-1].date, '收:', data1[data1.length-1].close, '量:', data1[data1.length-1].volume, '额:', data1[data1.length-1].amount);
  const years = ((new Date(data1[data1.length-1].date) - new Date(data1[0].date)) / (365.25 * 24 * 60 * 60 * 1000)).toFixed(2);
  console.log('覆盖年数:', years);

  // 测试 2: 8 年
  console.log('\n=== 测试 2: sh600519, 2000 根（8年）===');
  const data2 = await mq.fetchKLine('sh600519', 2000);
  console.log('成功! 长度:', data2.length);
  console.log('首日:', data2[0].date, '收:', data2[0].close);
  console.log('末日:', data2[data2.length-1].date, '收:', data2[data2.length-1].close);

  // 测试 3: 5 年
  console.log('\n=== 测试 3: sz000001, 1200 根（5年）===');
  const data3 = await mq.fetchKLine('sz000001', 1200);
  console.log('成功! 长度:', data3.length);
  console.log('首日:', data3[0].date);
  console.log('末日:', data3[data3.length-1].date);
})().catch(e => { console.error('失败:', e); process.exit(1); });
