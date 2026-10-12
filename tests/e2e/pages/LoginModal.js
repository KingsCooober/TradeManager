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
   * 清空既有 toast，避免读到上一次的提示
   * ★ toast 约 3s 才消失，连续操作时旧 toast 会污染断言
   */
  async clearToasts() {
    await this.page.evaluate(() => {
      document.querySelectorAll('.ui-toast').forEach((t) => t.remove());
    }).catch(() => {});
  }

  /**
   * 登录
   */
  async login(username, password) {
    await this.clearToasts();
    await this.open();
    await this.fillCredentials(username, password);
    // force: 跳过 stability 检查（modal 动画会让按钮 "not stable"）
    // noWaitAfter: 避免 click 后等待 navigation
    await this.page.click(this.selectors.loginBtn, { force: true, noWaitAfter: true });
  }

  /**
   * 注册
   */
  async register(username, password) {
    await this.clearToasts();
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
   * 等待登录失败
   * ★ 提示方式已从原生 alert 改为页面内 toast（showToast(..., 'error')，
   *   见 main.js 登录/注册/改密的失败分支），不能再等 dialog 事件。
   *
   * 用 waitForFunction 等"带非空文案的 .ui-toast-body"：
   *   toast 约 3s 后自动消失，且容器初始可能是隐藏状态，
   *   等"元素出现"不够稳，等"出现且有文案"才拿到真实提示。
   */
  async waitForLoginFailure(timeout = 6000) {
    await this.page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('.ui-toast-body'));
      return nodes.some((n) => (n.textContent || '').trim().length > 0);
    }, null, { timeout }).catch(() => {});
    return this.getLastToastText();
  }

  /**
   * 最近一条 toast 正文
   * ★ 只取 .ui-toast-body：整个 toast 的 textContent 会带上门关闭按钮的 "✕"
   */
  async getLastToastText() {
    return this.page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('.ui-toast-body'));
      const texts = nodes.map((n) => (n.textContent || '').trim()).filter(Boolean);
      return texts.length ? texts[texts.length - 1] : '';
    });
  }

  /**
   * 打开修改密码弹窗
   * ★ 「🔐 修改密码」按钮已移到 header 的「⚙️ 设置」面板里（id=appSetPassword），
   *   页面上不再有裸的"修改密码"按钮，需先打开设置。
   */
  async openChangePassword() {
    // 优先直接用设置面板里的按钮；找不到再退回 openChangePasswordModal()
    const inSettings = this.page.locator('#appSetPassword');
    if (await inSettings.count() > 0 && await inSettings.first().isVisible()) {
      await inSettings.first().click();
    } else {
      // 打开「⚙️ 设置」
      const settingsBtn = this.page.locator('.app-header button:has-text("设置")').first();
      if (await settingsBtn.count() > 0) {
        await settingsBtn.click();
        await this.page.waitForTimeout(400);
      }
      const btn = this.page.locator('#appSetPassword, button:has-text("修改密码")').first();
      await btn.click();
    }
    await this.page.waitForSelector(this.selectors.changePwdModal, { state: 'visible', timeout: 8000 });
  }

  /**
   * 修改密码
   */
  async changePassword(oldPwd, newPwd, confirmPwd = newPwd) {
    await this.clearToasts();
    await this.openChangePassword();
    await this.page.fill(this.selectors.oldPwd, oldPwd);
    await this.page.fill(this.selectors.newPwd, newPwd);
    await this.page.fill(this.selectors.confirmPwd, confirmPwd);
    // force: 跳过 stability 检查（modal 动画）
    await this.page.click(this.selectors.submitChangePwd, { force: true, noWaitAfter: true });
  }

  /**
   * 退出登录
   * ★ handleLogout 已改为 showConfirm 二次确认（原生 confirm 的替代），
   *   必须等 .ui-modal-overlay 出现并点击主按钮确认，否则会一直停留在登录态。
   */
  async logout() {
    await this.clearToasts();
    const sel = '.ui-modal-overlay';
    const has = await this.page.locator(sel).count();
    if (has > 0) {
      await this.page.click('.ui-modal-overlay .btn-primary');
    } else {
      await this.page.evaluate(() => {
        try { handleLogout && handleLogout(); } catch (e) {}
      });
      // showConfirm 是异步弹窗，等它出现再确认
      await this.page.waitForSelector(sel, { state: 'visible', timeout: 3000 }).catch(() => {});
      if (await this.page.locator(sel).count() > 0) {
        await this.page.click('.ui-modal-overlay .btn-primary');
      }
    }
    await this.page.waitForSelector(this.selectors.modal, { state: 'hidden', timeout: 5000 }).catch(() => {});
    await this.page.waitForTimeout(300);
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
