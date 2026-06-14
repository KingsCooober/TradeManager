// tests/e2e/specs/05-fund-management.spec.js
// 05 - 资金管理测试
const { test, expect } = require('@playwright/test');
const FundPanel = require('../pages/FundPanel');
const TradingPage = require('../pages/TradingPage');
const { clearAllStorage, getDateString } = require('../utils/helpers');
const { buildDeposit, buildWithdrawal } = require('../utils/data-builder');

test.describe('05 - 资金管理', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.left-sidebar');
  });

  test('应能添加入金', async ({ page }) => {
    const fp = new FundPanel(page);
    const result = await fp.addDeposit(50000, getDateString(0));
    expect(result.success).toBe(true);

    const total = await fp.getTotalDeposit();
    expect(total).toContain('50,000');
  });

  test('应能添加出金', async ({ page }) => {
    const fp = new FundPanel(page);
    const result = await fp.addWithdrawal(10000, getDateString(0));
    expect(result.success).toBe(true);

    const total = await fp.getTotalWithdraw();
    expect(total).toContain('10,000');
  });

  test('添加入金后资金应增加', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    const before = await fp.getCurrentCapital();

    await fp.addDeposit(50000, getDateString(0));
    await page.waitForTimeout(500);

    const after = await fp.getCurrentCapital();
    // 资金应增加
    const beforeNum = parseFloat(before.replace(/[^0-9.-]/g, ''));
    const afterNum = parseFloat(after.replace(/[^0-9.-]/g, ''));
    expect(afterNum).toBeGreaterThan(beforeNum);
  });

  test('添加出金后资金应减少', async ({ page }) => {
    const fp = new FundPanel(page);

    await fp.addDeposit(100000, getDateString(0));
    await page.waitForTimeout(300);

    const before = await fp.getCurrentCapital();
    await fp.addWithdrawal(20000, getDateString(0));
    await page.waitForTimeout(300);

    const after = await fp.getCurrentCapital();
    const beforeNum = parseFloat(before.replace(/[^0-9.-]/g, ''));
    const afterNum = parseFloat(after.replace(/[^0-9.-]/g, ''));
    expect(afterNum).toBeLessThan(beforeNum);
  });

  test('负数入金应被拒绝', async ({ page }) => {
    const fp = new FundPanel(page);
    const result = await fp.addDeposit(-1000, getDateString(0));
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/金额/);
  });

  test('零入金应被拒绝', async ({ page }) => {
    const fp = new FundPanel(page);
    const result = await fp.addDeposit(0, getDateString(0));
    expect(result.success).toBe(false);
  });

  test('应能修改初始资金', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    await tp.setInitCapital(200000);
    await page.waitForTimeout(300);

    const value = await page.inputValue('#initCapital');
    expect(parseFloat(value)).toBe(200000);
  });

  test('应能修改风险百分比', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    await tp.setRiskPct(3);
    await page.waitForTimeout(300);

    const value = await page.inputValue('#riskPct');
    expect(parseFloat(value)).toBe(3);
  });

  test('单笔 R 金额应随风险百分比变化', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    // 设置初始资金 100000，风险 2%
    await tp.setInitCapital(100000);
    await tp.setRiskPct(2);
    await page.waitForTimeout(300);

    // R金额 = 100000 * 2% = 2000
    const r1 = await fp.getRAmount();
    expect(r1).toContain('2,000');

    // 改为 3%
    await tp.setRiskPct(3);
    await page.waitForTimeout(300);

    const r2 = await fp.getRAmount();
    expect(r2).toContain('3,000');
  });

  test('应能修改手续费率', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    await tp.setFeeRate(0.5);
    await page.waitForTimeout(300);

    const value = await page.inputValue('#feeRate');
    expect(parseFloat(value)).toBe(0.5);
  });

  test('应能修改最大风险 R', async ({ page }) => {
    const fp = new FundPanel(page);
    const tp = new TradingPage(page);

    await tp.setMaxRisk(5);
    await page.waitForTimeout(300);

    const value = await page.inputValue('#maxRisk');
    expect(parseFloat(value)).toBe(5);
  });

  test('取消入金应关闭弹窗且不添加', async ({ page }) => {
    const fp = new FundPanel(page);
    await fp.openDepositModal();
    await page.fill('#depositAmount', '50000');
    await fp.closeDepositModal();

    // 验证弹窗已关闭
    await expect(page.locator('#depositModal')).toBeHidden();

    // 累计入金应仍为 0
    const total = await fp.getTotalDeposit();
    expect(total).toContain('0');
  });

  test('入金日期默认为今天', async ({ page }) => {
    const fp = new FundPanel(page);
    await fp.openDepositModal();
    const today = getDateString(0);
    const date = await page.inputValue('#depositDate');
    expect(date).toBe(today);
    await fp.closeDepositModal();
  });
});
