// tests/frontend/quote.test.js
// 单元测试：QuoteAPI（行情获取）
// 注意：fetchQuote 在没有网络时返回 null，但辅助函数 calcPnL / toSecId 可独立测试

const test = require('node:test');
const assert = require('node:assert');

// 模拟浏览器环境
global.window = global;
require('../../public/js/quote.js');

const Q = global.QuoteAPI;

test('QuoteAPI 应暴露 5 个核心方法', () => {
  assert.strictEqual(typeof Q.fetchQuote, 'function');
  assert.strictEqual(typeof Q.fetchQuotes, 'function');
  assert.strictEqual(typeof Q.toSecId, 'function');
  assert.strictEqual(typeof Q.calcPnL, 'function');
  assert.strictEqual(typeof Q.calcPnLPct, 'function');
  assert.strictEqual(typeof Q.clearCache, 'function');
});

test('toSecId - 沪市股票', () => {
  assert.strictEqual(Q.toSecId('600000'), '1.600000');
  assert.strictEqual(Q.toSecId('688160'), '1.688160');
  assert.strictEqual(Q.toSecId('601869'), '1.601869');
});

test('toSecId - 深市股票', () => {
  assert.strictEqual(Q.toSecId('000001'), '0.000001');
  assert.strictEqual(Q.toSecId('300223'), '0.300223');
  assert.strictEqual(Q.toSecId('002384'), '0.002384');
});

test('toSecId - 京市股票', () => {
  assert.strictEqual(Q.toSecId('830001'), '0.830001');
});

test('toSecId - 无效输入返回 null', () => {
  assert.strictEqual(Q.toSecId(''), null);
  assert.strictEqual(Q.toSecId(null), null);
  assert.strictEqual(Q.toSecId(undefined), null);
  assert.strictEqual(Q.toSecId('abc'), null);
  assert.strictEqual(Q.toSecId('12345'), null);
});

test('toSecId - 6位数字但带其他字符', () => {
  assert.strictEqual(Q.toSecId('688160 步科股份'), '1.688160');
  assert.strictEqual(Q.toSecId('300223 龙头'), '0.300223');
});

test('calcPnL - 多头盈利', () => {
  var item = { direction: 'long', actualEntryPrice: 100, quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - 多头亏损', () => {
  var item = { direction: 'long', actualEntryPrice: 100, quantity: 100 };
  var quote = { price: 90 };
  assert.strictEqual(Q.calcPnL(item, quote), -1000);
});

test('calcPnL - 空头盈利（价格下跌）', () => {
  var item = { direction: 'short', actualEntryPrice: 100, quantity: 100 };
  var quote = { price: 90 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - 空头亏损（价格上涨）', () => {
  var item = { direction: 'short', actualEntryPrice: 100, quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), -1000);
});

test('calcPnL - 卖出（sell）等同空头逻辑', () => {
  var item = { direction: 'sell', actualEntryPrice: 100, quantity: 100 };
  var quote = { price: 90 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - 无入场价返回 null', () => {
  var item = { direction: 'long', quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), null);
});

test('calcPnL - 无仓位返回 null', () => {
  var item = { direction: 'long', actualEntryPrice: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), null);
});

test('calcPnL - 使用计划入场价（无 actualEntryPrice）', () => {
  var item = { direction: 'long', entryPriceMax: 100, quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - actualEntryPrice 优先于 entryPriceMax', () => {
  var item = { direction: 'long', actualEntryPrice: 100, entryPriceMax: 90, quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - entryPriceMax 优先于 entryPriceMin', () => {
  var item = { direction: 'long', entryPriceMax: 100, entryPriceMin: 95, quantity: 100 };
  var quote = { price: 110 };
  assert.strictEqual(Q.calcPnL(item, quote), 1000);
});

test('calcPnL - 无价格或无 quote 返回 null', () => {
  assert.strictEqual(Q.calcPnL({ direction: 'long', actualEntryPrice: 100, quantity: 100 }, null), null);
  assert.strictEqual(Q.calcPnL({ direction: 'long', actualEntryPrice: 100, quantity: 100 }, {}), null);
  assert.strictEqual(Q.calcPnL({ direction: 'long', actualEntryPrice: 100, quantity: 100 }, { price: null }), null);
});

test('calcPnLPct - 多头盈利 10%', () => {
  var item = { direction: 'long', actualEntryPrice: 100 };
  assert.strictEqual(Q.calcPnLPct(item, { price: 110 }), 10);
});

test('calcPnLPct - 多头亏损 5%', () => {
  var item = { direction: 'long', actualEntryPrice: 100 };
  assert.strictEqual(Q.calcPnLPct(item, { price: 95 }), -5);
});

test('calcPnLPct - 空头盈利 10%', () => {
  var item = { direction: 'short', actualEntryPrice: 100 };
  assert.strictEqual(Q.calcPnLPct(item, { price: 90 }), 10);
});

test('calcPnLPct - 零价格', () => {
  var item = { direction: 'long', actualEntryPrice: 100 };
  assert.strictEqual(Q.calcPnLPct(item, { price: 100 }), 0);
});

test('fetchQuote - 无效输入返回 null（不抛错）', async () => {
  var r = await Q.fetchQuote(null);
  assert.strictEqual(r, null);
  r = await Q.fetchQuote('');
  assert.strictEqual(r, null);
  r = await Q.fetchQuote('abc');
  assert.strictEqual(r, null);
});

test('fetchQuotes - 空数组返回空数组', async () => {
  var r = await Q.fetchQuotes([]);
  assert.deepStrictEqual(r, []);
  r = await Q.fetchQuotes(null);
  assert.deepStrictEqual(r, []);
});

test('clearCache - 不抛错', () => {
  Q.clearCache();
  // 重复执行也无副作用
  Q.clearCache();
});

test('fetchQuote - 通过本机代理（启动服务器后能获取到行情）', async () => {
  // 这个测试需要服务器在 3000 端口运行
  // 拿一只 A 股试试（贵州茅台 600519）
  if (typeof location === 'undefined' || !location.origin) {
    console.log('  [跳过] Node 环境下没有 location');
    return;
  }
  const r = await Q.fetchQuote('600519');
  // 服务器可能没启动，或者东方财富不可用，都允许返回 null
  if (r === null) {
    console.log('  [跳过] 代理不可用或行情源失败');
    return;
  }
  assert.ok(r.price > 0, '价格应大于 0');
  assert.strictEqual(r.symbol, '600519');
});

test('fetchQuote - 代理响应 400 时返回 null', async () => {
  // 这个测试需要在浏览器环境（带 base URL）下执行
  if (typeof location === 'undefined' || !location.origin) {
    console.log('  [跳过] Node 环境下没有 location.origin');
    return;
  }
  const r = await fetch('/api/quote?secid=invalid');
  assert.strictEqual(r.status, 400);
});
