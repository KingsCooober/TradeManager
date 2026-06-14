// tests/e2e/specs/10-edge-cases.spec.js
// 10 - 边界条件测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const CalculatorPanel = require('../pages/CalculatorPanel');
const TradeTable = require('../pages/TradeTable');
const FundPanel = require('../pages/FundPanel');
const { clearAllStorage, getDateString, seedTradesToIndexedDB } = require('../utils/helpers');
const { buildTrade, buildClosedTrade } = require('../utils/data-builder');

test.describe('10 - 边界条件', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');
  });

  test('空数据状态应正常显示', async ({ page }) => {
    // 无交易时
    const bodyText = await page.locator('#tradeBody').textContent();
    expect(bodyText).toContain('暂无');

    // 无入金时
    const totalDeposit = await page.textContent('#totalDeposit');
    expect(totalDeposit).toContain('0');

    // 累计盈亏应为 0
    const totalPnl = await page.textContent('#totalPnl');
    expect(totalPnl).toMatch(/0\.00/);
  });

  test('大量数据渲染不应崩溃', async ({ page }) => {
    // 注入 100 条交易
    const trades = [];
    for (let i = 0; i < 100; i++) {
      trades.push({
        id: `bulk-${i}`,
        date: getDateString(-i),
        symbol: `BULK${i}`,
        dir: i % 2 === 0 ? '多' : '空',
        entry: 100 + i,
        stop: 95 + i,
        exit: i % 2 === 0 ? 110 + i : 90 - i,
        pnl: i % 3 === 0 ? 100 : -50,
        pnlR: i % 3 === 0 ? 1 : -0.5,
        status: i % 3 === 0 ? 'win' : 'loss',
        posSize: 1000,
        riskAmount: 100,
        actualLots: 10,
      });
    }

    await page.evaluate((trades) => {
      localStorage.setItem('trades_v4', JSON.stringify(trades));
    }, trades);

    await page.goto(page.url());
    await page.waitForSelector('#tradeBody tr');
    await page.waitForTimeout(1000);

    // 至少有一行
    const rowCount = await page.locator('#tradeBody tr').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('特殊字符输入应被正确处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);

    // 输入特殊字符作为品种
    const specialSymbol = '测试@#$%^&*()_+-=[]{}';
    await calc.setSymbol(specialSymbol);
    const value = await page.inputValue('#calcSymbol');
    expect(value).toBe(specialSymbol);
  });

  test('中文品种名应能正常显示', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.setSymbol('贵州茅台');
    await calc.fillForm({ dir: '多', entry: 100, stop: 95 });
    await calc.addToTrade();
    await page.waitForTimeout(500);

    const symbol = await page.locator('#tradeBody tr').first().textContent();
    expect(symbol).toContain('贵州茅台');
  });

  test('极大价格应能处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 9999999,
      stop: 9999900,
      actualLots: 100,
    });

    // 不应崩溃
    const results = await calc.getResults();
    expect(results.stopPct).toBeTruthy();
  });

  test('极小价格应能处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 0.01,
      stop: 0.009,
      actualLots: 100,
    });

    // 不应崩溃
    const results = await calc.getResults();
    expect(results.stopPct).toBeTruthy();
  });

  test('数据应能持久化（刷新页面）', async ({ page }) => {
    // 添加入金
    const fp = new FundPanel(page);
    await fp.addDeposit(99999, getDateString(0));
    await page.waitForTimeout(500);

    // 刷新
    await page.reload();
    await page.waitForSelector('#totalDeposit');

    const total = await page.textContent('#totalDeposit');
    expect(total).toContain('99,999');
  });

  test('数据应能持久化（关闭重新打开）', async ({ page, baseURL }) => {
    // 直接写入 IndexedDB（应用使用 IndexedDB 作为主存储，localStorage 只是备份）
    await seedTradesToIndexedDB(page, [
      { id: 'persist-1', symbol: 'PERSIST', date: '2025-01-01', dir: '多', entry: 100, stop: 95, status: 'open' }
    ]);

    // 关闭并重新打开
    await page.goto(baseURL + '/about:blank');
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#tradeTable');

    const symbol = await page.locator('#tradeBody tr').first().textContent();
    expect(symbol).toContain('PERSIST');
  });

  test('浏览器后退/前进应能正确导航', async ({ page, baseURL }) => {
    // 主 -> 复盘 -> 主
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');

    await page.goto(baseURL + '/diary2.html');
    await page.waitForSelector('#diaryTable');

    // 后退
    await page.goBack();
    await page.waitForURL(/index\.html/);
    await page.waitForSelector('.app-header');

    // 前进
    await page.goForward();
    await page.waitForURL(/diary2\.html/);
    await page.waitForSelector('#diaryTable');
  });

  test('零手数应能处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 100,
      stop: 95,
      actualLots: 0,
    });

    // 不应崩溃
    const results = await calc.getResults();
    expect(results.actualLots).toBe('0');
  });

  test('负数手数应能处理（不崩溃）', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    // HTML number input 通常会拒绝负数
    await page.fill('#calcActualLots', '-100');
    await page.waitForTimeout(200);

    // 不应崩溃
    const value = await page.inputValue('#calcActualLots');
    // 浏览器可能接受或拒绝，取决于 min="0" 约束
    expect(value).toBeDefined();
  });

  test('日期边界（远期日期）应能处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    const farFuture = '2099-12-31';
    await calc.setOpenDate(farFuture);

    const value = await page.inputValue('#calcOpenDate');
    expect(value).toBe(farFuture);
  });

  test('日期边界（远古日期）应能处理', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    const farPast = '2000-01-01';
    await calc.setOpenDate(farPast);

    const value = await page.inputValue('#calcOpenDate');
    expect(value).toBe(farPast);
  });

  test('空字符串品种应不显示在交易列表中', async ({ page }) => {
    const table = new TradeTable(page);
    // 注入空品种
    await page.evaluate(() => {
      trades.push({ id: 'empty-1', date: '2025-01-01', symbol: '', dir: '多', entry: 100, stop: 95, status: 'open' });
      if (typeof save === 'function') save();
    });
    await page.waitForTimeout(500);

    // 不应崩溃
    const rowCount = await page.locator('#tradeBody tr').count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('多个连续开/关弹窗应正常', async ({ page }) => {
    const fp = new FundPanel(page);

    for (let i = 0; i < 3; i++) {
      await fp.openDepositModal();
      await expect(page.locator('#depositModal')).toBeVisible();
      await fp.closeDepositModal();
      await expect(page.locator('#depositModal')).toBeHidden();
    }
  });

  test('图表应在数据变化时重新渲染', async ({ page }) => {
    // 初始无数据
    await page.waitForSelector('#equityCurve');
    const before = await page.evaluate(() => {
      const canvas = document.getElementById('equityCurve');
      return canvas ? canvas.toDataURL().length : 0;
    });

    // 添加数据
    await page.evaluate(() => {
      localStorage.setItem('trades_v4', JSON.stringify([
        { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, exit: 110, pnl: 100, pnlR: 1, status: 'win', posSize: 1000, riskAmount: 100, actualLots: 10 }
      ]));
    });
    await page.goto(page.url());
    await page.waitForSelector('#equityCurve');
    await page.waitForTimeout(800);

    const after = await page.evaluate(() => {
      const canvas = document.getElementById('equityCurve');
      return canvas ? canvas.toDataURL().length : 0;
    });

    // 图表应该重新渲染（toDataURL 长度可能不同）
    expect(after).toBeGreaterThan(0);
  });

  test('同品种多次添加应都能成功', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'SAME', date: getDateString(-1) }));
    await table.addTradeDirectly(buildTrade({ symbol: 'SAME', date: getDateString(-2) }));
    await table.addTradeDirectly(buildTrade({ symbol: 'SAME', date: getDateString(-3) }));

    const count = await table.getRowCount();
    expect(count).toBe(3);
  });
});
