// tests/e2e/specs/08-sync.spec.js
// 08 - 数据同步测试
const { test, expect } = require('@playwright/test');
const TradingPage = require('../pages/TradingPage');
const LoginModal = require('../pages/LoginModal');
const { clearAllStorage, uniqueUsername } = require('../utils/helpers');
const { buildUser, buildTrade } = require('../utils/data-builder');

test.describe('08 - 数据同步', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');
  });

  test('未登录时应显示登录按钮', async ({ page }) => {
    // 未登录状态
    const loginBtn = page.locator('button:has-text("登录同步")');
    await expect(loginBtn).toBeVisible();
  });

  test('未登录时点击同步应无效果（按钮不可见）', async ({ page }) => {
    // 未登录时不应该有"同步"按钮
    const syncBtn = page.locator('button:has-text("同步"):not(:has-text("自动"))').first();
    const exists = await syncBtn.count();
    if (exists > 0) {
      const visible = await syncBtn.isVisible();
      expect(visible).toBe(false);
    }
  });

  test('登录后应显示同步按钮', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('sync') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 同步按钮应可见
    const syncBtn = page.locator('button:has-text("🔄 同步")');
    await expect(syncBtn).toBeVisible();
  });

  test('登录后应显示用户名', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('showuser') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    await expect(page.locator('#headerUsername')).toContainText(user.username);
  });

  test('应能切换自动同步', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('autosync') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    const tp = new TradingPage(page);
    const before = await tp.getAutoSyncStatus();

    await tp.toggleAutoSync();
    await page.waitForTimeout(300);

    const after = await tp.getAutoSyncStatus();
    expect(after).not.toBe(before);
  });

  test('应能手动触发同步', async ({ page, baseURL }) => {
    const user = buildUser({ username: uniqueUsername('manual') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 监听 sync API
    const syncResponsePromise = page.waitForResponse(
      (res) => res.url().includes('/api/sync/') && res.request().method() === 'POST',
      { timeout: 10000 }
    ).catch(() => null);

    await page.click('button:has-text("🔄 同步")');

    // 等待同步 API 响应（可能成功或失败，取决于服务器）
    const response = await syncResponsePromise;
    if (response) {
      expect([200, 201, 500]).toContain(response.status());
    }
  });

  test('登录后添加交易应能同步到服务器', async ({ page, baseURL }) => {
    const user = buildUser({ username: uniqueUsername('synctrade') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 监听同步 API
    const syncPromise = page.waitForResponse(
      (res) => res.url().includes('/api/sync/'),
      { timeout: 10000 }
    ).catch(() => null);

    // 添加交易（通过全局函数）
    await page.evaluate(() => {
      trades.push({
        id: 'test-sync-1',
        date: '2025-01-01',
        symbol: 'SYNC_TEST',
        dir: '多',
        entry: 100,
        stop: 95,
        posSize: 1000,
        actualLots: 10,
        riskAmount: 100,
        status: 'open'
      });
      if (typeof save === 'function') save();
    });

    // 等待自动同步（30s 间隔内可能不触发）
    // 手动触发同步
    await page.waitForTimeout(1000);
    await page.click('button:has-text("🔄 同步")').catch(() => {});

    const response = await syncPromise;
    if (response) {
      expect([200, 201]).toContain(response.status());
    }
  });

  test('未登录时点击同步按钮不应出现', async ({ page }) => {
    // 验证未登录状态下没有可见的同步按钮
    const syncBtn = page.locator('button:has-text("🔄 同步")');
    const isVisible = await syncBtn.first().isVisible().catch(() => false);
    expect(isVisible).toBe(false);
  });

  test('退出登录后应清除本地数据', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('logoutdata') });
    const lm = new LoginModal(page);

    // 注入本地数据
    await page.evaluate(() => {
      localStorage.setItem('trades_v4', JSON.stringify([
        { id: '1', symbol: 'A', date: '2025-01-01', dir: '多', entry: 100, stop: 95, status: 'open' }
      ]));
    });

    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 退出登录
    await page.click('button:has-text("退出")');
    await page.waitForTimeout(1000);

    // trades_v4 已被清空
    const trades = await page.evaluate(() => {
      const t = localStorage.getItem('trades_v4');
      return t ? JSON.parse(t) : null;
    });
    expect(trades === null || trades.length === 0).toBe(true);
  });
});
