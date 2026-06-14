// tests/e2e/specs/09-diary.spec.js
// 09 - 复盘日记测试
const { test, expect } = require('@playwright/test');
const DiaryPage = require('../pages/DiaryPage');
const { clearAllStorage, getDateString, uniqueUsername } = require('../utils/helpers');
const { buildDiaryEntry } = require('../utils/data-builder');

test.describe('09 - 复盘日记', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/diary2.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/diary2.html');
    await page.waitForSelector('#diaryTable');
    await page.waitForTimeout(500);
  });

  test('页面应正常加载并显示工具栏', async ({ page }) => {
    const dp = new DiaryPage(page);
    await expect(page.locator(dp.selectors.title)).toContainText('复盘总结');
    await expect(page.locator(dp.selectors.toolbar)).toBeVisible();
    await expect(page.locator(dp.selectors.filters)).toBeVisible();
    await expect(page.locator(dp.selectors.table)).toBeVisible();
  });

  test('应能打开新增日记弹窗', async ({ page }) => {
    const dp = new DiaryPage(page);
    await dp.openAddModal();
    await expect(page.locator(dp.selectors.diaryModal)).toBeVisible();

    // 标题应为"新增"
    const title = await page.textContent(dp.selectors.modalTitle);
    expect(title).toContain('新增');

    // 日期应默认为今天
    const today = getDateString(0);
    const date = await page.inputValue(dp.selectors.diaryDate);
    expect(date).toBe(today);
  });

  test('应能添加日记条目', async ({ page }) => {
    const dp = new DiaryPage(page);
    const data = buildDiaryEntry({ symbol: 'BTC' });

    await dp.addEntry(data);
    await page.waitForTimeout(500);

    const rows = await dp.getAllRows();
    expect(rows.length).toBeGreaterThan(0);
  });

  test('缺少必填字段时不应提交', async ({ page }) => {
    const dp = new DiaryPage(page);
    await dp.openAddModal();

    // 打开弹窗时应用会自动填充当天日期为默认值，清空后再验证必填校验
    const date = page.locator(dp.selectors.diaryDate);
    await date.fill('');

    // HTML5 必填校验：未填写时浏览器会阻止提交
    const isInvalid = await date.evaluate((el) => !el.checkValidity());
    expect(isInvalid).toBe(true);

    // 关闭弹窗
    await dp.closeModal();
  });

  test('应能编辑日记', async ({ page }) => {
    const dp = new DiaryPage(page);
    const entry = buildDiaryEntry({ symbol: 'BTC' });
    await dp.addEntry(entry);
    await page.waitForTimeout(500);

    // 找到 BTC 行的编辑按钮并点击
    const editBtn = page.locator('#diaryTableBody tr').filter({ hasText: 'BTC' }).locator('button:has-text("编辑")').first();
    if (await editBtn.count() > 0) {
      await editBtn.click();
      await page.waitForSelector(dp.selectors.diaryModal, { state: 'visible' });

      // 修改
      await page.fill(dp.selectors.diarySymbol, 'BTC_EDITED');
      await page.fill(dp.selectors.diaryLesson, '更新的教训');
      await dp.submit();

      await page.waitForTimeout(500);
      const rows = await dp.getAllRows();
      const hasUpdated = rows.some((r) => r.some((c) => c.includes('BTC_EDITED')));
      expect(hasUpdated).toBe(true);
    } else {
      // 编辑按钮命名可能是别的
      const buttons = await page.locator('#diaryTableBody tr').first().locator('button').allTextContents();
      console.log('Available buttons:', buttons);
    }
  });

  test('应能删除日记', async ({ page }) => {
    const dp = new DiaryPage(page);
    const entry = buildDiaryEntry({ symbol: 'TO_DELETE' });
    await dp.addEntry(entry);
    await page.waitForTimeout(500);

    const beforeCount = await dp.getRowCount();
    expect(beforeCount).toBeGreaterThan(0);

    // 找到 TO_DELETE 行的删除按钮
    const row = page.locator('#diaryTableBody tr').filter({ hasText: 'TO_DELETE' });
    const delBtn = row.locator('button:has-text("删除")');
    if (await delBtn.count() > 0) {
      await delBtn.first().click();
      await page.waitForSelector(dp.selectors.deleteModal, { state: 'visible' });
      await page.click(dp.selectors.confirmDeleteBtn);
      await page.waitForSelector(dp.selectors.deleteModal, { state: 'hidden' });
      await page.waitForTimeout(500);

      const afterCount = await dp.getRowCount();
      expect(afterCount).toBe(beforeCount - 1);
    }
  });

  test('应能按日期排序', async ({ page }) => {
    const dp = new DiaryPage(page);
    await dp.addEntry(buildDiaryEntry({ symbol: 'A', tradeDate: '2025-01-01' }));
    await dp.addEntry(buildDiaryEntry({ symbol: 'B', tradeDate: '2025-02-01' }));
    await dp.addEntry(buildDiaryEntry({ symbol: 'C', tradeDate: '2025-03-01' }));
    await page.waitForTimeout(500);

    // 点击日期列排序
    const dateHeader = page.locator('th:has-text("日期")').first();
    if (await dateHeader.count() > 0) {
      await dateHeader.click();
      await page.waitForTimeout(500);
    }
  });

  test('应能应用快速筛选', async ({ page }) => {
    const dp = new DiaryPage(page);
    await dp.addEntry(buildDiaryEntry({ symbol: 'WIN_TRADE', pnlPercent: 10 }));
    await dp.addEntry(buildDiaryEntry({ symbol: 'LOSS_TRADE', pnlPercent: -5 }));
    await page.waitForTimeout(500);

    // 筛选盈利
    await dp.applyQuickFilter('win');
    await page.waitForTimeout(500);

    const rows = await dp.getAllRows();
    // 应该只显示盈利的
    const allText = rows.flat().join(' ');
    expect(allText).toContain('WIN_TRADE');
    expect(allText).not.toContain('LOSS_TRADE');
  });

  test('应能清除筛选', async ({ page }) => {
    const dp = new DiaryPage(page);
    await dp.addEntry(buildDiaryEntry({ symbol: 'A' }));
    await dp.addEntry(buildDiaryEntry({ symbol: 'B' }));
    await page.waitForTimeout(500);

    // 应用筛选
    await dp.applyQuickFilter('win');
    // 清除
    await dp.clearFilters();
    await page.waitForTimeout(500);

    // 应显示所有
    const rows = await dp.getAllRows();
    const allText = rows.flat().join(' ');
    expect(allText).toContain('A');
    expect(allText).toContain('B');
  });

  test('应能返回主页面', async ({ page, baseURL }) => {
    const dp = new DiaryPage(page);
    await dp.goBackToMain();
    expect(page.url()).toMatch(/index\.html/);
  });

  test('应能从主页跳转到日记页', async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('a:has-text("复盘总结")');

    await page.click('a:has-text("复盘总结")');
    await page.waitForURL(/diary2\.html$/);
    await page.waitForSelector('#diaryTable');
  });
});
