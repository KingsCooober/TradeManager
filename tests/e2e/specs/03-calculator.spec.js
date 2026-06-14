// tests/e2e/specs/03-calculator.spec.js
// 03 - 开仓计算器测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const CalculatorPanel = require('../pages/CalculatorPanel');
const TradeTable = require('../pages/TradeTable');
const { clearAllStorage } = require('../utils/helpers');

test.describe('03 - 开仓仓位计算器', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.calc-card');
  });

  test('应能选择做多方向', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.setDirection('多');

    const dir = await page.inputValue('#calcDir');
    expect(dir).toBe('多');
  });

  test('应能选择做空方向', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.setDirection('空');

    const dir = await page.inputValue('#calcDir');
    expect(dir).toBe('空');
  });

  test('应能选择买点类型', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    const types = ['5分钟回踩', '15分钟回踩', '60分钟回踩', '日线回踩', '金叉共振', '大阳不破', 'N型反转'];

    for (const type of types) {
      await calc.setBuyType(type);
      const value = await page.inputValue('#calcBuyType');
      expect(value).toBe(type);
    }
  });

  test('应能计算止损距离百分比', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      symbol: 'BTC',
      dir: '多',
      entry: 100,
      stop: 95,
      targetR: 2,
      actualLots: 200,
    });

    const results = await calc.getResults();
    // 止损距离 = 5/100 = 5%
    expect(results.stopPct).toBe('5.00%');
  });

  test('应能计算目标价（做多）', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 100,
      stop: 95,
      targetR: 2,
    });

    const results = await calc.getResults();
    // 目标价 = 100 + 5*2 = 110
    expect(parseFloat(results.tp)).toBeCloseTo(110, 1);
  });

  test('应能计算目标价（做空）', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '空',
      entry: 100,
      stop: 105,
      targetR: 2,
    });

    const results = await calc.getResults();
    // 目标价 = 100 - 5*2 = 90
    expect(parseFloat(results.tp)).toBeCloseTo(90, 1);
  });

  test('应能计算推荐手数', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 100,
      stop: 95,
      targetR: 2,
    });

    // R金额 = 100000 * 2 / 100 = 2000
    // 建议仓位 = 2000 / 0.05 = 40000
    // 推荐手数 = 40000 / 100 = 400
    const reco = await page.inputValue('#calcRecoLots');
    expect(parseFloat(reco)).toBeCloseTo(400, 1);
  });

  test('应能计算实际仓位金额', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 50,
      stop: 48,
      actualLots: 100,
    });

    const results = await calc.getResults();
    // 实际买入金额 = 100 * 50 = 5000
    expect(results.actualPos).toContain('5,000.00');
  });

  test('应能计算实际可能止损额', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({
      dir: '多',
      entry: 100,
      stop: 95,
      actualLots: 200,
    });

    const results = await calc.getResults();
    // 实际可能止损 = 200 * 5 = 1000
    expect(results.actualRisk).toContain('1,000.00');
  });

  test('缺少入场价或止损价时不应崩溃', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.setDirection('多');
    // 只设入场价
    await calc.setEntry(100);
    // 结果应显示 '-'
    const tp = await page.textContent('#res_tp');
    expect(tp).toBe('-');

    // 只设止损价
    await calc.setEntry('');
    await calc.setStop(95);
    const tp2 = await page.textContent('#res_tp');
    expect(tp2).toBe('-');
  });

  test('入场价等于止损价时不应崩溃', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({ dir: '多', entry: 100, stop: 100 });

    const tp = await page.textContent('#res_tp');
    expect(tp).toBe('-');
  });

  test('应能清空计算器', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({ symbol: 'TEST', dir: '多', entry: 100, stop: 95, actualLots: 200 });

    await calc.clear();

    const entry = await page.inputValue('#calcEntry');
    const stop = await page.inputValue('#calcStop');
    expect(entry).toBe('');
    expect(stop).toBe('');
  });

  test('应能将计算结果添加到交易记录', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    const table = new TradeTable(page);

    await calc.fillForm({
      symbol: 'BTC',
      dir: '多',
      buyType: '金叉共振',
      entry: 100,
      stop: 95,
      targetR: 2,
      actualLots: 200,
    });

    const result = await calc.addToTrade();
    expect(result.success).toBe(true);

    // 等待表格刷新
    await page.waitForTimeout(500);

    // 验证表格中有 BTC
    const symbol = await table.getFirstRowSymbol();
    expect(symbol).toBe('BTC');
  });

  test('缺少必要字段时添加应失败（alert）', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    // 不填写入场价和止损价
    // 设置对话框处理器（auto accept）
    let dialogMessage = '';
    const dialogHandler = async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    };
    page.on('dialog', dialogHandler);
    try {
      await page.click('button:has-text("添加到交易记录")');
      // 等待 alert 触发
      await page.waitForTimeout(500);
    } finally {
      page.off('dialog', dialogHandler);
    }
    expect(dialogMessage).toMatch(/入场|止损/);
  });

  test('应能切换买点类型并保持计算', async ({ page }) => {
    const calc = new CalculatorPanel(page);
    await calc.fillForm({ dir: '多', entry: 100, stop: 95 });

    const result1 = await page.textContent('#res_tp');

    await calc.setBuyType('60分钟回踩');
    await page.waitForTimeout(200);

    // 切换买点类型不影响计算结果
    const result2 = await page.textContent('#res_tp');
    expect(result2).toBe(result1);
  });
});
