// tests/e2e/utils/data-builder.js
// 测试数据构造器
const { randomString, randomNumber, randomInt, getDateString } = require('./helpers');

/**
 * 构造交易记录数据
 * @param {object} overrides 字段覆盖
 * @returns {object} 交易记录
 */
function buildTrade(overrides = {}) {
  return {
    date: getDateString(-randomInt(1, 30)),
    symbol: overrides.symbol || `TEST${randomString(4).toUpperCase()}`,
    buyType: '15分钟回踩',
    dir: '多',
    entry: randomNumber(10, 100, 2),
    stop: randomNumber(5, 9, 2),
    target: null,
    posSize: randomNumber(10000, 50000, 0),
    actualLots: 200,
    riskAmount: randomNumber(1000, 5000, 0),
    exit: null,
    exitDate: null,
    pnl: null,
    pnlR: null,
    status: 'open',
    note: '',
    ...overrides,
  };
}

/**
 * 构造已平仓的交易（带盈亏）
 */
function buildClosedTrade(overrides = {}) {
  const isWin = Math.random() > 0.5;
  const entry = overrides.entry || randomNumber(10, 100, 2);
  const exit = isWin
    ? entry * (1 + randomNumber(1, 5, 2) / 100)
    : entry * (1 - randomNumber(1, 5, 2) / 100);
  const posSize = overrides.posSize || randomNumber(10000, 50000, 0);
  const pnl = (exit - entry) * (overrides.actualLots || 200);

  return buildTrade({
    exit: Math.round(exit * 100) / 100,
    exitDate: getDateString(0),
    pnl: Math.round(pnl * 100) / 100,
    pnlR: Math.round((pnl / 2000) * 100) / 100,
    status: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'be',
    ...overrides,
  });
}

/**
 * 构造做空的交易
 */
function buildShortTrade(overrides = {}) {
  const isWin = Math.random() > 0.5;
  const entry = overrides.entry || randomNumber(50, 200, 2);
  const exit = isWin
    ? entry * (1 - randomNumber(1, 5, 2) / 100)
    : entry * (1 + randomNumber(1, 5, 2) / 100);
  return buildTrade({
    dir: '空',
    exit: Math.round(exit * 100) / 100,
    exitDate: getDateString(0),
    status: isWin ? 'win' : 'loss',
    ...overrides,
  });
}

/**
 * 构造入金数据
 */
function buildDeposit(overrides = {}) {
  return {
    amount: randomNumber(10000, 100000, 0),
    date: getDateString(-randomInt(0, 30)),
    ...overrides,
  };
}

/**
 * 构造出金数据
 */
function buildWithdrawal(overrides = {}) {
  return {
    amount: randomNumber(5000, 50000, 0),
    date: getDateString(-randomInt(0, 30)),
    ...overrides,
  };
}

/**
 * 构造复盘日记条目
 */
function buildDiaryEntry(overrides = {}) {
  return {
    tradeDate: getDateString(-randomInt(0, 30)),
    symbol: overrides.symbol || `DIARY${randomString(3).toUpperCase()}`,
    pnlPercent: randomNumber(-10, 10, 2),
    tradeLogic: '测试买入逻辑 - ' + randomString(8),
    mood: '测试当时心态 - 冷静',
    followSystem: Math.random() > 0.5 ? '是' : '否',
    lesson: '教训: ' + randomString(10),
    improvement: '改进: ' + randomString(10),
    ...overrides,
  };
}

/**
 * 构造用户数据
 */
function buildUser(overrides = {}) {
  const username = overrides.username || `user_${Date.now()}_${randomString(4)}`;
  return {
    username,
    password: 'test123456',
    ...overrides,
  };
}

/**
 * 构造多个交易记录
 */
function buildTrades(count = 5, factory = buildClosedTrade) {
  return Array.from({ length: count }, () => factory());
}

/**
 * 构造多个日记条目
 */
function buildDiaryEntries(count = 3) {
  return Array.from({ length: count }, () => buildDiaryEntry());
}

module.exports = {
  buildTrade,
  buildClosedTrade,
  buildShortTrade,
  buildDeposit,
  buildWithdrawal,
  buildDiaryEntry,
  buildUser,
  buildTrades,
  buildDiaryEntries,
};
