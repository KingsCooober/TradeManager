// tests/e2e/pages/LoginModal.js
// 登录/注册弹窗
const { expect } = require('@playwright/test');

class LoginModal {
  /**
   * @param {import('@playwright/test').Page} page
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * 选择器
   */
  get selectors() {
    return {
      modal: '#loginModal',
      username: '#syncLoginUser',
      password: '#syncLoginPass',
      serverUrl: '#syncServerUrl',
      loginBtn: 'button:has-text("登录"):not(:has-text("登录同步"))',
      registerBtn: 'button:has-text("注册")',
      cancelBtn: '#loginModal button:has-text("取消")',
      changePwdModal: '#changePasswordModal',
      oldPwd: '#changePwdOld',
      newPwd: '#changePwdNew',
      confirmPwd: '#changePwdConfirm',
      submitChangePwd: 'button:has-text("确认修改")',
    };
  }

  /**
   * 打开登录弹窗
   */
  async open() {
    // 尝试点击头部"登录同步"按钮
    const loginBtn = this.page.locator('button:has-text("登录同步")');
    if (await loginBtn.count() > 0 && await loginBtn.first().isVisible()) {
      await loginBtn.first().click();
    } else {
      // 已登录时直接调用全局函数
      await this.page.evaluate(() => openLoginModal && openLoginModal());
    }
    await this.page.waitForSelector(this.selectors.modal, { state: 'visible' });
  }

  /**
   * 关闭登录弹窗
   */
  async close() {
    await this.page.click(this.selectors.cancelBtn);
    await this.page.waitForSelector(this.selectors.modal, { state: 'hidden' });
  }

  /**
   * 填写用户名密码
   */
  async fillCredentials(username, password) {
    await this.page.fill(this.selectors.username, username);
    await this.page.fill(this.selectors.password, password);
  }

  /**
   * 登录
   */
  async login(username, password) {
    await this.open();
    await this.fillCredentials(username, password);
    // force: 跳过 stability 检查（modal 动画会让按钮 "not stable"）
    // noWaitAfter: 避免 click 后等待 navigation（点击会触发 alert）
    await this.page.click(this.selectors.loginBtn, { force: true, noWaitAfter: true });
  }

  /**
   * 注册
   */
  async register(username, password) {
    await this.open();
    await this.fillCredentials(username, password);
    // force: 跳过 stability 检查
    await this.page.click(this.selectors.registerBtn, { force: true, noWaitAfter: true });
  }

  /**
   * 等待登录完成（弹窗关闭 + 头部显示用户名）
   */
  async waitForLoginSuccess(username, timeout = 10000) {
    await this.page.waitForSelector(this.selectors.modal, { state: 'hidden', timeout });
    if (username) {
      await this.page.waitForFunction(
        (u) => {
          const el = document.getElementById('headerUsername');
          return el && el.textContent === u;
        },
        username,
        { timeout }
      );
    }
  }

  /**
   * 等待登录失败（弹窗保持可见 + alert 出现）
   */
  async waitForLoginFailure(timeout = 5000) {
    const alertPromise = this.page.waitForEvent('dialog', { timeout });
    return alertPromise;
  }

  /**
   * 打开修改密码弹窗
   */
  async openChangePassword() {
    await this.page.click('button:has-text("修改密码")');
    await this.page.waitForSelector(this.selectors.changePwdModal, { state: 'visible' });
  }

  /**
   * 修改密码
   */
  async changePassword(oldPwd, newPwd, confirmPwd = newPwd) {
    await this.openChangePassword();
    await this.page.fill(this.selectors.oldPwd, oldPwd);
    await this.page.fill(this.selectors.newPwd, newPwd);
    await this.page.fill(this.selectors.confirmPwd, confirmPwd);
    // force: 跳过 stability 检查（modal 动画）
    await this.page.click(this.selectors.submitChangePwd, { force: true, noWaitAfter: true });
  }

  /**
   * 退出登录
   */
  async logout() {
    // 直接调用全局函数（避免被对话框阻塞）
    await this.page.evaluate(() => {
      try { handleLogout && handleLogout(); } catch(e) {}
    });
    await this.page.waitForSelector(this.selectors.modal, { state: 'hidden' }).catch(() => {});
  }

  /**
   * 检查是否已登录
   */
  async isLoggedIn() {
    return this.page.evaluate(() => {
      return !!(window.syncModule && window.syncModule.getCurrentUser && window.syncModule.getCurrentUser());
    });
  }

  /**
   * 获取当前登录用户名
   */
  async getCurrentUsername() {
    return this.page.evaluate(() => {
      try {
        const u = window.syncModule && window.syncModule.getCurrentUser && window.syncModule.getCurrentUser();
        return u ? u.username : null;
      } catch (e) { return null; }
    });
  }
}

module.exports = LoginModal;
