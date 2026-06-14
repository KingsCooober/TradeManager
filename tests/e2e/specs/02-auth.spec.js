// tests/e2e/specs/02-auth.spec.js
// 02 - 用户认证测试
const { test, expect } = require('@playwright/test');
const LoginModal = require('../pages/LoginModal');
const TradingPage = require('../pages/TradingPage');
const { clearAllStorage, uniqueUsername } = require('../utils/helpers');
const { buildUser } = require('../utils/data-builder');

test.describe('02 - 用户认证', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await page.goto(baseURL + '/index.html');
    await clearAllStorage(page);
    await page.goto(baseURL + '/index.html');
    await page.waitForSelector('.app-header');
  });

  test('应能打开登录弹窗', async ({ page }) => {
    const lm = new LoginModal(page);
    await lm.open();
    await expect(page.locator('#loginModal')).toBeVisible();
    await expect(page.locator('#syncLoginUser')).toBeVisible();
    await expect(page.locator('#syncLoginPass')).toBeVisible();
  });

  test('应能取消登录弹窗', async ({ page }) => {
    const lm = new LoginModal(page);
    await lm.open();
    await lm.close();
    await expect(page.locator('#loginModal')).toBeHidden();
  });

  test('应能成功注册新用户', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('reg') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);

    // 等待登录完成
    await lm.waitForLoginSuccess(user.username, 15000);

    // 验证已登录
    const isLoggedIn = await lm.isLoggedIn();
    expect(isLoggedIn).toBe(true);

    const currentUser = await lm.getCurrentUsername();
    expect(currentUser).toBe(user.username);

    // 验证头部显示用户名
    await expect(page.locator('#headerUsername')).toContainText(user.username);
  });

  test('应能使用已注册用户登录', async ({ page }) => {
    // 先注册一个用户
    const user = buildUser({ username: uniqueUsername('login') });
    const lm = new LoginModal(page);

    // 注册
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 退出
    await lm.logout();
    await page.waitForTimeout(500);

    // 再次登录
    await lm.login(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    const currentUser = await lm.getCurrentUsername();
    expect(currentUser).toBe(user.username);
  });

  test('错误密码应登录失败', async ({ page }) => {
    // 先注册
    const user = buildUser({ username: uniqueUsername('wrongpwd') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);
    await lm.logout();
    await page.waitForTimeout(500);

    // 尝试错误密码
    const dialogPromise = lm.waitForLoginFailure();
    await lm.login(user.username, 'wrongpassword123');
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/失败|错误/);
    await dialog.accept();

    // 弹窗应保持显示
    await expect(page.locator('#loginModal')).toBeVisible();
  });

  test('不存在的用户应登录失败', async ({ page }) => {
    const lm = new LoginModal(page);
    const dialogPromise = lm.waitForLoginFailure();
    await lm.login('nonexistent_user_xyz_99999', 'whatever');
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/失败|错误/);
  });

  test('重复注册应返回错误', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('dup') });
    const lm = new LoginModal(page);

    // 第一次注册
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);
    await lm.logout();
    await page.waitForTimeout(500);

    // 第二次注册相同用户
    const dialogPromise = lm.waitForLoginFailure();
    await lm.register(user.username, user.password);
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/存在|失败/);
  });

  test('密码少于6位应注册失败', async ({ page }) => {
    const lm = new LoginModal(page);
    await lm.open();
    await page.fill('#syncLoginUser', uniqueUsername('short'));
    await page.fill('#syncLoginPass', '123'); // 只有3位

    // 关键: 必须在 click 之前注册 dialog handler（alert 同步阻塞 JS 执行）
    // 使用 once 确保只触发一次
    const dialogPromise = new Promise((resolve) => {
      page.once('dialog', async (dialog) => {
        const msg = dialog.message();
        await dialog.accept();
        resolve(msg);
      });
    });
    // force: 跳过 stability 检查（modal 动画）
    await page.click('#loginModal button:has-text("注册")', { force: true });
    const message = await dialogPromise;
    expect(message).toMatch(/6位/);
  });

  test('空用户名/密码应提示错误', async ({ page }) => {
    const lm = new LoginModal(page);
    await lm.open();

    // 关键: 必须在 click 之前注册 dialog handler（alert 同步阻塞 JS 执行）
    const dialogPromise = new Promise((resolve) => {
      page.once('dialog', async (dialog) => {
        const msg = dialog.message();
        await dialog.accept();
        resolve(msg);
      });
    });
    await page.click('#loginModal button:has-text("登录")', { force: true });
    const message = await dialogPromise;
    expect(message).toMatch(/用户/);
  });

  test('应能退出登录', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('logout') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 退出
    await page.click('button:has-text("退出")');
    await page.waitForTimeout(800);

    // 验证未登录状态
    const isLoggedIn = await lm.isLoggedIn();
    expect(isLoggedIn).toBe(false);
  });

  test('应能修改密码', async ({ page }) => {
    const user = buildUser({
      username: uniqueUsername('chgpwd'),
      password: 'OldPwd1!',
    });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    // 修改密码
    const newPwd = 'NewPwd2@';
    const dialogPromise = page.waitForEvent('dialog', { timeout: 5000 });
    await lm.changePassword(user.password, newPwd, newPwd);
    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/成功/);
    await dialog.accept();

    await page.waitForTimeout(500);

    // 退出后用新密码登录
    await lm.logout();
    await page.waitForTimeout(500);
    await lm.login(user.username, newPwd);
    await lm.waitForLoginSuccess(user.username, 15000);
  });

  test('修改密码时新密码不一致应失败', async ({ page }) => {
    const user = buildUser({ username: uniqueUsername('mismatch') });
    const lm = new LoginModal(page);
    await lm.register(user.username, user.password);
    await lm.waitForLoginSuccess(user.username, 15000);

    await lm.openChangePassword();
    await page.fill('#changePwdOld', user.password);
    await page.fill('#changePwdNew', 'NewPwd1!');
    await page.fill('#changePwdConfirm', 'Different2@');

    // 关键: 必须在 click 之前注册 dialog handler（alert 同步阻塞 JS 执行）
    const dialogPromise = new Promise((resolve) => {
      page.once('dialog', async (dialog) => {
        const msg = dialog.message();
        await dialog.accept();
        resolve(msg);
      });
    });
    // force: 跳过 stability 检查（modal 动画）
    await page.click('button:has-text("确认修改")', { force: true });
    const message = await dialogPromise;
    expect(message).toMatch(/不一致/);
  });
});
