// tests/e2e/fixtures/auth.fixture.js
// 认证测试夹具：自动注册并登录测试用户
const { test: base, expect } = require('@playwright/test');
const { clearAllStorage, uniqueUsername } = require('../utils/helpers');
const { buildUser } = require('../utils/data-builder');

/**
 * 扩展基础 test：增加 loggedInPage / anonPage 夹具
 */
const test = base.extend({
  /**
   * 已登录的页面对象（自动注册 + 登录）
   */
  loggedInPage: async ({ page, baseURL }, use, testInfo) => {
    // 先清理 localStorage / IndexedDB，确保干净环境
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForLoadState('domcontentloaded');

    // 生成唯一测试用户
    const user = buildUser({
      username: `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      password: 'Test1234!',
    });

    // 打开登录弹窗 -> 注册
    await page.click('button:has-text("登录同步")');
    await page.waitForSelector('#loginModal', { state: 'visible' });
    await page.fill('#syncLoginUser', user.username);
    await page.fill('#syncLoginPass', user.password);
    await page.click('button:has-text("注册")');

    // 等待登录完成（登录后弹窗关闭 + 头部显示用户名）
    try {
      await page.waitForSelector('#loginModal', { state: 'hidden', timeout: 10000 });
    } catch (e) {
      // 注册失败可能因为用户名冲突，记录并继续（可能因为之前残留）
      testInfo.annotations.push({ type: 'auth', description: `register issue: ${e.message}` });
    }

    // 验证已登录
    await page.waitForSelector('#headerSyncLoggedIn', { state: 'visible', timeout: 10000 });

    // 暴露给测试使用
    await use({ page, user });

    // 测试结束后清理
    try {
      // 退出登录
      await page.click('button:has-text("退出")', { timeout: 3000 });
    } catch (e) {
      // ignore
    }
  },

  /**
   * 匿名（未登录）的页面对象
   */
  anonPage: async ({ page, baseURL }, use) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.app-header', { state: 'visible' });
    await use(page);
  },
});

module.exports = { test, expect };
