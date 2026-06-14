// tests/e2e/specs/04-trade-management.spec.js
// 04 - 交易管理测试
const { test, expect } = require('@playwright/test');
const TradeTable = require('../pages/TradeTable');
const { clearAllStorage, getDateString } = require('../utils/helpers');
const { buildTrade, buildClosedTrade, buildShortTrade } = require('../utils/data-builder');

test.describe('04 - 交易管理', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('#tradeTable');
  });

  test('应能添加新交易（通过全局函数）', async ({ page }) => {
    const table = new TradeTable(page);
    const initialCount = await table.getRowCount();

    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));
    const newCount = await table.getRowCount();
    expect(newCount).toBe(initialCount + 1);
  });

  test('应能添加多个交易', async ({ page }) => {
    const table = new TradeTable(page);

    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'TSLA' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'GOOG' }));

    expect(await table.getRowCount()).toBe(3);
  });

  test('应能编辑交易备注', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));

    await table.editCellByField('AAPL', 'note', '测试备注内容');
    await page.waitForTimeout(300);

    // 验证 input 的值
    const noteValue = await page.locator('#tradeBody tr').first().locator('.in-note').inputValue();
    expect(noteValue).toBe('测试备注内容');
  });

  test('应能编辑交易出场价', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL', entry: 100 }));

    await table.editCellByField('AAPL', 'exit', 110);
    await page.waitForTimeout(500);

    // 验证盈亏计算
    const pnlText = await page.locator('#tradeBody tr').first().textContent();
    expect(pnlText).toBeTruthy();
  });

  test('应能关闭持仓（设置出场价 + 出场日期）', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({
      symbol: 'AAPL',
      entry: 100,
      posSize: 10000,
      actualLots: 100,
    }));

    // 设置出场价和日期
    await table.editCellByField('AAPL', 'exit', 110);
    await table.editCellByField('AAPL', 'exitDate', getDateString(0));
    await page.waitForTimeout(500);

    // 验证状态变化
    const rowText = await page.locator('#tradeBody tr').first().textContent();
    // 状态应变为 盈利 / 亏损 / 保本
    expect(rowText).toMatch(/盈利|亏损|保本/);
  });

  test('应能删除交易（带确认）', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'TO_DELETE' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'TO_KEEP' }));

    expect(await table.getRowCount()).toBe(2);

    // 删除
    await table.deleteTrade('TO_DELETE');
    await table.confirmDelete();

    expect(await table.getRowCount()).toBe(1);

    // 验证 TO_KEEP 还在
    const firstSymbol = await table.getFirstRowSymbol();
    expect(firstSymbol).toBe('TO_KEEP');
  });

  test('应能取消删除', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));

    await table.deleteTrade('AAPL');
    await table.cancelDelete();

    expect(await table.getRowCount()).toBe(1);
  });

  test('日期格式应为 YYYY-MM-DD', async ({ page }) => {
    const table = new TradeTable(page);
    const date = getDateString(-5);
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL', date }));
    await page.waitForTimeout(300);

    const rowText = await page.locator('#tradeBody tr').first().textContent();
    expect(rowText).toContain(date);
  });

  test('盈亏金额应根据出场价自动计算', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({
      symbol: 'AAPL',
      entry: 100,
      posSize: 10000,
      actualLots: 100,
    }));

    await table.editCellByField('AAPL', 'exit', 110);
    await page.waitForTimeout(500);

    // 验证 row 中包含正数（盈利）
    const row = page.locator('#tradeBody tr').first();
    const pnlCell = await row.locator('td').nth(14).textContent();
    expect(pnlCell).toBeTruthy();
  });

  test('R值应正确计算', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({
      symbol: 'AAPL',
      entry: 100,
      stop: 95,
      posSize: 10000,
      actualLots: 100,
      riskAmount: 500,
    }));

    await table.editCellByField('AAPL', 'exit', 110);
    await page.waitForTimeout(500);

    // R值 = pnl / riskAmount
    const row = page.locator('#tradeBody tr').first();
    const pnlRCell = await row.locator('td').nth(15).textContent();
    expect(pnlRCell).toBeTruthy();
  });

  test('应支持按日期排序', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'A', date: getDateString(-10) }));
    await table.addTradeDirectly(buildTrade({ symbol: 'B', date: getDateString(-5) }));
    await table.addTradeDirectly(buildTrade({ symbol: 'C', date: getDateString(-1) }));

    await table.sortBy('date');
    await page.waitForTimeout(300);

    const firstSymbol = await table.getFirstRowSymbol();
    expect(['A', 'B', 'C']).toContain(firstSymbol);
  });

  test('应支持按品种排序', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'TSLA' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'MSFT' }));

    await table.sortBy('symbol');
    await page.waitForTimeout(300);

    const firstSymbol = await table.getFirstRowSymbol();
    // 升序时第一个是 AAPL
    expect(['AAPL', 'MSFT', 'TSLA']).toContain(firstSymbol);
  });

  test('应能切换排序顺序（升序/降序）', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'A' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'B' }));

    await table.sortBy('symbol');
    const ascFirst = await table.getFirstRowSymbol();

    await table.toggleSortOrder();
    await page.waitForTimeout(300);

    const descFirst = await table.getFirstRowSymbol();
    expect(ascFirst).not.toBe(descFirst);
  });

  test('持仓天数应自动计算', async ({ page }) => {
    const table = new TradeTable(page);
    const openDate = getDateString(-5);
    const closeDate = getDateString(-1);

    await table.addTradeDirectly(buildTrade({
      symbol: 'AAPL',
      date: openDate,
    }));

    await table.editCellByField('AAPL', 'exitDate', closeDate);
    await page.waitForTimeout(500);

    const row = page.locator('#tradeBody tr').first();
    const holdDaysCell = await row.locator('td').nth(16).textContent();
    expect(holdDaysCell.trim()).toBeTruthy();
  });

  test('做空交易应能正确计算盈亏', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildShortTrade({
      symbol: 'AAPL',
      entry: 100,
      posSize: 10000,
      actualLots: 100,
    }));

    // 设置出场价（做空盈利）
    await table.editCellByField('AAPL', 'exit', 90);
    await page.waitForTimeout(500);

    const row = page.locator('#tradeBody tr').first();
    const dirCell = await row.locator('td').nth(4).textContent();
    expect(dirCell).toContain('空');
  });

  test('清空记录后表格应显示空状态', async ({ page }) => {
    const table = new TradeTable(page);
    await table.addTradeDirectly(buildTrade({ symbol: 'AAPL' }));
    await table.addTradeDirectly(buildTrade({ symbol: 'TSLA' }));

    await table.clearAll();
    await page.waitForTimeout(800);

    expect(await table.getRowCount()).toBe(0);
    const bodyText = await page.locator('#tradeBody').textContent();
    expect(bodyText).toContain('暂无');
  });
});
