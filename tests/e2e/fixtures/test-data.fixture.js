// tests/e2e/fixtures/test-data.fixture.js
// 测试数据夹具：预填充交易/资金/日记
const { test: base, expect } = require('@playwright/test');
const { buildTrade, buildClosedTrade, buildDeposit, buildWithdrawal, buildDiaryEntry } = require('../utils/data-builder');

/**
 * 扩展基础 test：提供预填充的测试数据
 */
const test = base.extend({
  /**
   * 预填充交易数据 - 在内存中设置 trades 全局变量
   */
  seededTrades: async ({ page, baseURL }, use) => {
    await page.goto(baseURL + '/index.html');
    await page.evaluate(() => { try { localStorage.clear(); } catch(e) {} });
    await page.goto(baseURL + '/index.html');
    await page.waitForLoadState('domcontentloaded');

    const trades = [
      buildClosedTrade({ symbol: 'BTC' }),
      buildClosedTrade({ symbol: 'ETH', dir: '空' }),
      buildTrade({ symbol: 'AAPL' }),
    ];

    // 通过 localStorage 注入，然后刷新
    await page.evaluate((trades) => {
      localStorage.setItem('trades_v4', JSON.stringify(trades));
    }, trades);

    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#tradeTable');

    await use(trades);
  },

  /**
   * 预填充入金出金数据
   */
  seededFunds: async ({ page, baseURL }, use) => {
    await page.goto(baseURL + '/index.html');
    await page.evaluate(() => { try { localStorage.clear(); } catch(e) {} });
    await page.goto(baseURL + '/index.html');
    await page.waitForLoadState('domcontentloaded');

    const deposits = [
      buildDeposit({ amount: 50000, date: '2025-01-01' }),
      buildDeposit({ amount: 30000, date: '2025-02-01' }),
    ];
    const withdrawals = [
      buildWithdrawal({ amount: 10000, date: '2025-03-01' }),
    ];

    await page.evaluate(({ deposits, withdrawals }) => {
      localStorage.setItem('deposits', JSON.stringify(deposits));
      localStorage.setItem('withdrawals', JSON.stringify(withdrawals));
    }, { deposits, withdrawals });

    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');

    await use({ deposits, withdrawals });
  },

  /**
   * 预填充复盘日记数据
   */
  seededDiary: async ({ page, baseURL }, use) => {
    await page.goto(baseURL + '/diary2.html');
    await page.evaluate(() => { try { localStorage.clear(); } catch(e) {} });
    await page.goto(baseURL + '/diary2.html');
    await page.waitForLoadState('domcontentloaded');

    const entries = [
      buildDiaryEntry({ symbol: 'BTC', pnlPercent: 5.5 }),
      buildDiaryEntry({ symbol: 'ETH', pnlPercent: -3.2, followSystem: '否' }),
    ];

    // 写入 localStorage 并刷新
    await page.evaluate((entries) => {
      localStorage.setItem('diary2_data', JSON.stringify(entries));
    }, entries);

    await page.goto(baseURL + '/diary2.html');
    await page.waitForLoadState('domcontentloaded');
    // 等待页面渲染
    await page.waitForTimeout(500);

    await use(entries);
  },
});

module.exports = { test, expect };
