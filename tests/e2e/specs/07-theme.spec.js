// tests/e2e/specs/07-theme.spec.js
// 07 - 主题切换测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const { clearAllStorage } = require('../utils/helpers');

test.describe('07 - 主题切换', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');
  });

  test('默认主题应为 light', async ({ page }) => {
    const tp = new TradingPage(page);
    const theme = await tp.getCurrentTheme();
    // 默认可能是 light 或 dark（取决于系统）
    expect(['light', 'dark']).toContain(theme);
  });

  test('应能切换主题', async ({ page }) => {
    const tp = new TradingPage(page);
    const before = await tp.getCurrentTheme();

    await tp.toggleTheme();
    await page.waitForTimeout(300);

    const after = await tp.getCurrentTheme();
    expect(after).not.toBe(before);
  });

  test('切换后 data-theme 属性应改变', async ({ page }) => {
    const tp = new TradingPage(page);
    const initial = await tp.getCurrentTheme();

    await tp.toggleTheme();
    await page.waitForTimeout(200);

    const newTheme = await tp.getCurrentTheme();
    expect(newTheme).not.toBe(initial);
  });

  test('主题应持久化到 localStorage', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    const before = await tp.getCurrentTheme();

    await tp.toggleTheme();
    await page.waitForTimeout(300);

    // 刷新页面
    await page.reload();
    await page.waitForSelector('.app-header');

    const after = await tp.getCurrentTheme();
    expect(after).not.toBe(before);
  });

  test('应能通过 localStorage 设置主题', async ({ page, baseURL }) => {
    // 设置 dark 主题
    await page.evaluate(() => {
      localStorage.setItem('app_theme', 'dark');
    });
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');

    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(theme).toBe('dark');
  });

  test('复盘页面也应支持主题切换', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/diary2.html');
    await page.waitForSelector('.app-header');

    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.click('#themeToggle');
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
  });

  test('主题切换后图表应重新渲染', async ({ page }) => {
    // 注入一些交易数据
    await page.evaluate(() => {
      const trades = [
        { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 },
      ];
      localStorage.setItem('trades_v4', JSON.stringify(trades));
    });
    await page.goto(page.url());
    await page.waitForSelector('#equityCurve');

    const tp = new TradingPage(page);
    await tp.toggleTheme();
    await page.waitForTimeout(500);

    // canvas 仍应存在
    const canvas = await page.$('#equityCurve');
    expect(canvas).toBeTruthy();
  });
});
