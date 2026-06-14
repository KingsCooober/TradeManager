// tests/e2e/pages/BasePage.js
// 页面对象基类 - 提供通用方法
const { expect } = require('@playwright/test');

class BasePage {
  /**
   * @param {import('@playwright/test').Page} page
   */
  constructor(page) {
    this.page = page;
  }

  /**
   * 导航到指定路径
   */
  async goto(path = '/') {
    await this.page.goto(path);
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * 等待元素可见
   */
  async waitForVisible(selector, timeout = 10000) {
    const locator = typeof selector === 'string' ? this.page.locator(selector) : selector;
    await locator.waitFor({ state: 'visible', timeout });
  }

  /**
   * 等待元素隐藏
   */
  async waitForHidden(selector, timeout = 10000) {
    const locator = typeof selector === 'string' ? this.page.locator(selector) : selector;
    await locator.waitFor({ state: 'hidden', timeout });
  }

  /**
   * 截图
   */
  async screenshot(name, options = {}) {
    await this.page.screenshot({ path: `screenshots/${name}.png`, fullPage: true, ...options });
  }

  /**
   * 等待网络空闲
   */
  async waitForNetworkIdle() {
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * 触发自动保存（等待防抖）
   */
  async waitForAutoSave(ms = 800) {
    await this.page.waitForTimeout(ms);
  }

  /**
   * 抑制浏览器对话框
   */
  setupDialogHandler(action = 'accept', text = '') {
    this.page.on('dialog', async (dialog) => {
      if (action === 'accept') {
        await dialog.accept(text);
      } else {
        await dialog.dismiss();
      }
    });
  }

  /**
   * 切换主题
   */
  async toggleTheme() {
    await this.page.click('#themeToggle');
    await this.page.waitForTimeout(200);
  }

  /**
   * 获取当前主题
   */
  async getCurrentTheme() {
    return this.page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  }

  /**
   * 设置主题
   */
  async setTheme(theme) {
    await this.page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('app_theme', t);
    }, theme);
  }

  /**
   * 点击导航到复盘页面
   */
  async goToDiary() {
    await this.page.click('a:has-text("复盘总结")');
    await this.page.waitForURL(/diary2\.html$/);
  }

  /**
   * 点击返回主页面
   */
  async goBack() {
    await this.page.click('button:has-text("← 返回")');
    await this.page.waitForURL(/index\.html$/);
  }

  /**
   * 刷新页面
   */
  async reload() {
    await this.page.reload({ waitUntil: 'domcontentloaded' });
  }

  /**
   * 关闭弹窗（点击 modal 外部或按 ESC）
   */
  async closeModal(modalSelector) {
    await this.page.evaluate((sel) => {
      const modal = document.querySelector(sel);
      if (modal) modal.style.display = 'none';
    }, modalSelector);
  }

  /**
   * 等待 alert 弹窗
   */
  waitForAlert() {
    return new Promise((resolve) => {
      this.page.once('dialog', async (dialog) => {
        const message = dialog.message();
        const type = dialog.type();
        await dialog.accept();
        resolve({ message, type });
      });
    });
  }
}

module.exports = BasePage;
