// tests/e2e/specs/06-stats-panel.spec.js
// 06 - 统计指标测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const { clearAllStorage, seedTradesToIndexedDB } = require('../utils/helpers');
const { buildTrade, buildClosedTrade } = require('../utils/data-builder');

test.describe('06 - 统计指标', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#tradeTable');
  });

  test('空数据时统计应为 0', async ({ page }) => {
    const tp = new TradingPage(page);
    const stats = await tp.getStats();
    expect(stats.total).toBe('0');
    expect(stats.wins).toBe('0');
    expect(stats.losses).toBe('0');
  });

  test('应正确显示总交易数', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', date: '2025-01-01', symbol: 'A', dir: '多', entry: 100, stop: 95, exit: 110, exitDate: '2025-01-02', pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', date: '2025-01-03', symbol: 'B', dir: '多', entry: 200, stop: 190, exit: 220, exitDate: '2025-01-04', pnl: 200, pnlR: 2, status: 'win', posSize: 2000, riskAmount: 200, actualLots: 10 },
      { id: '3', date: '2025-01-05', symbol: 'C', dir: '多', entry: 50, stop: 48, exit: 45, exitDate: '2025-01-06', pnl: -50, pnlR: -0.5, status: 'loss', posSize: 500, riskAmount: 100, actualLots: 10 },
    ];
    // 直接写入 IndexedDB（绕过 localStorage 迁移机制）
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_total');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    expect(stats.total).toBe('3');
  });

  test('应正确计算胜率', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 200, stop: 190, exit: 220, pnl: 200, pnlR: 2, status: 'win', posSize: 2000, riskAmount: 200, actualLots: 10 },
      { id: '3', symbol: 'C', date: '2025-01-03', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -0.5, status: 'loss', posSize: 500, riskAmount: 100, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_winrate');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    // 2 胜 / 3 总 = 66.7%
    expect(stats.winrate).toBe('66.7%');
  });

  test('应正确计算盈亏比', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 200, pnlR: 2, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 50, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_avgrr');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    // 平均盈 R = 2, 平均亏 R = 1, 比 = 1:2
    expect(stats.avgrr).toBe('1:2.00');
  });

  test('应正确计算期望值', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 300, pnlR: 3, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -100, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 100, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_ev');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    // (3 + -1) / 2 = 1R
    expect(stats.ev).toBe('1.00R');
  });

  test('应正确计算最大连亏', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 50, actualLots: 10 },
      { id: '3', symbol: 'C', date: '2025-01-03', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 50, actualLots: 10 },
      { id: '4', symbol: 'D', date: '2025-01-04', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 50, actualLots: 10 },
      { id: '5', symbol: 'E', date: '2025-01-05', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_maxdd');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    expect(parseInt(stats.maxdd)).toBe(3);
  });

  test('应正确计算累计 R', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 2, status: 'win', posSize: 1000, riskAmount: 50, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 200, stop: 190, exit: 230, pnl: 300, pnlR: 3, status: 'win', posSize: 2000, riskAmount: 100, actualLots: 10 },
      { id: '3', symbol: 'C', date: '2025-01-03', dir: '多', entry: 50, stop: 48, exit: 45, pnl: -50, pnlR: -1, status: 'loss', posSize: 500, riskAmount: 50, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_totalR');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    // 总 R = 2 + 3 - 1 = 4
    expect(stats.totalR).toContain('+4.00');
  });

  test('全部盈利时胜率应为 100%', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const trades = [
      { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      { id: '2', symbol: 'B', date: '2025-01-02', dir: '多', entry: 200, stop: 190, exit: 220, pnl: 200, pnlR: 1, status: 'win', posSize: 2000, riskAmount: 200, actualLots: 10 },
    ];
    await seedTradesToIndexedDB(page, trades);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#s_winrate');
    await page.waitForTimeout(800);

    const stats = await tp.getStats();
    expect(stats.winrate).toBe('100.0%');
  });
});
