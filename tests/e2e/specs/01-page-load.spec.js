// tests/e2e/specs/01-page-load.spec.js
// 01 - 页面加载测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const DiaryPage = require('../pages/DiaryPage');
const { clearAllStorage } = require('../utils/helpers');

test.describe('01 - 页面加载', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
  });

  test('主交易页面应正常加载并显示关键元素', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    await tp.load();

    // 验证关键元素
    await expect(page).toHaveTitle(/Trade Manager/);
    await expect(page.locator('.app-logo')).toBeVisible();
    await expect(page.locator('.app-title h1')).toContainText('Trade Manager');
    await expect(page.locator('.app-subtitle')).toContainText('交易管理系统');

    // 验证各模块
    await tp.verifyAllSections();

    // 验证初始资金显示
    const initCap = await page.inputValue('#initCapital');
    expect(parseFloat(initCap)).toBeGreaterThan(0);
  });

  test('未登录时应显示登录按钮', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');

    // 验证未登录状态显示
    const loginBtn = page.locator('button:has-text("登录同步")');
    await expect(loginBtn).toBeVisible();
  });

  test('复盘总结页面应正常加载', async ({ page, baseURL }) => {
    const dp = new DiaryPage(page);
    await dp.load();

    // 验证标题
    await expect(page.locator('.app-title h1')).toContainText('复盘总结');

    // 验证表格和工具栏
    await expect(page.locator(dp.selectors.toolbar)).toBeVisible();
    await expect(page.locator(dp.selectors.filters)).toBeVisible();
    await expect(page.locator(dp.selectors.table)).toBeVisible();

    // 验证新增按钮
    await expect(page.locator(dp.selectors.addBtn)).toBeVisible();
  });

  test('主页面应包含导航到复盘页面的链接', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');

    const diaryLink = page.locator('a:has-text("复盘总结")');
    await expect(diaryLink).toBeVisible();
    const href = await diaryLink.getAttribute('href');
    expect(href).toMatch(/diary2\.html/);
  });

  test('应正确设置初始日期', async ({ page, baseURL }) => {
    const tp = new TradingPage(page);
    await tp.load();

    // 计算器开仓日期应默认为今天
    const today = new Date().toISOString().split('T')[0];
    const openDate = await page.inputValue('#calcOpenDate');
    expect(openDate).toBe(today);
  });

  test('应能处理静态资源加载错误', async ({ page, baseURL }) => {
    // 监听页面错误
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(baseURL + '/index.html');
    await page.waitForLoadState('networkidle');

    // 关键函数应已定义（加载顺序正确）
    const fnsDefined = await page.evaluate(() => {
      return {
        calcPosition: typeof calcPosition === 'function',
        addTradeFromCalc: typeof addTradeFromCalc === 'function',
        updateAll: typeof updateAll === 'function',
        handleLogin: typeof handleLogin === 'function',
        drawEquityCurve: typeof drawEquityCurve === 'function',
        drawPositionPie: typeof drawPositionPie === 'function',
      };
    });

    expect(fnsDefined.calcPosition).toBe(true);
    expect(fnsDefined.addTradeFromCalc).toBe(true);
    expect(fnsDefined.updateAll).toBe(true);
    expect(fnsDefined.handleLogin).toBe(true);
  });

  test('错误路径应能优雅处理（404）', async ({ page, baseURL }) => {
    const response = await page.goto(baseURL + '/nonexistent-page-12345.html');
    expect(response.status()).toBe(404);
  });
});
