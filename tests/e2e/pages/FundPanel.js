// tests/e2e/pages/FundPanel.js
// 资金管理
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class FundPanel extends BasePage {
  constructor(page) {
    super(page);
  }

  get selectors() {
    return {
      fundCard: '.left-sidebar .card:has(h2:has-text("账户资金"))',
      initCapital: '#initCapital',
      currentCapital: '#currentCapital',
      totalPnl: '#totalPnl',
      totalReturn: '#totalReturn',
      totalDeposit: '#totalDeposit',
      totalWithdraw: '#totalWithdraw',
      feeRate: '#feeRate',
      totalFees: '#totalFees',

      // 入金弹窗
      depositModal: '#depositModal',
      depositAmount: '#depositAmount',
      depositDate: '#depositDate',
      confirmDepositBtn: '#depositModal button:has-text("确认")',
      cancelDepositBtn: '#depositModal button:has-text("取消")',
      openDepositModalBtn: 'button:has-text("入金")',

      // 出金弹窗
      withdrawModal: '#withdrawModal',
      withdrawAmount: '#withdrawAmount',
      withdrawDate: '#withdrawDate',
      confirmWithdrawBtn: '#withdrawModal button:has-text("确认")',
      cancelWithdrawBtn: '#withdrawModal button:has-text("取消")',
      openWithdrawModalBtn: 'button:has-text("出金")',

      // 风险参数
      riskPct: '#riskPct',
      rAmount: '#rAmount',
      maxRisk: '#maxRisk',
      usedRisk: '#usedRisk',
      remainRisk: '#remainRisk',
    };
  }

  /**
   * 打开入金弹窗
   */
  async openDepositModal() {
    await this.page.click(this.selectors.openDepositModalBtn);
    await this.page.waitForSelector(this.selectors.depositModal, { state: 'visible' });
  }

  /**
   * 打开出金弹窗
   */
  async openWithdrawModal() {
    await this.page.click(this.selectors.openWithdrawModalBtn);
    await this.page.waitForSelector(this.selectors.withdrawModal, { state: 'visible' });
  }

  /**
   * 关闭弹窗
   */
  async closeDepositModal() {
    await this.page.click(this.selectors.cancelDepositBtn);
    await this.page.waitForSelector(this.selectors.depositModal, { state: 'hidden' });
  }

  async closeWithdrawModal() {
    await this.page.click(this.selectors.cancelWithdrawBtn);
    await this.page.waitForSelector(this.selectors.withdrawModal, { state: 'hidden' });
  }

  /**
   * 添加入金
   */
  async addDeposit(amount, date) {
    await this.openDepositModal();
    await this.page.fill(this.selectors.depositAmount, String(amount));
    if (date) {
      await this.page.fill(this.selectors.depositDate, date);
    }
    // 关键: 先注册 dialog handler（alert 同步阻塞 JS）
    const dialogPromise = new Promise((resolve) => {
      this.page.once('dialog', async (dialog) => {
        const msg = dialog.message();
        await dialog.accept();
        resolve({ message: msg, hasDialog: true });
      });
    });
    // force: 跳过 modal 动画的 stability 检查
    this.page.click(this.selectors.confirmDepositBtn, { force: true }).catch(() => {});
    const dlg = await Promise.race([
      dialogPromise,
      new Promise((r) => setTimeout(() => r({ hasDialog: false }), 2000)),
    ]);
    if (dlg.hasDialog) {
      await this.closeDepositModal().catch(() => {});
      return { success: false, message: dlg.message };
    }
    await this.page.waitForSelector(this.selectors.depositModal, { state: 'hidden' });
    await this.waitForAutoSave();
    return { success: true };
  }

  /**
   * 添加出金
   */
  async addWithdrawal(amount, date) {
    await this.openWithdrawModal();
    await this.page.fill(this.selectors.withdrawAmount, String(amount));
    if (date) {
      await this.page.fill(this.selectors.withdrawDate, date);
    }
    // 关键: 先注册 dialog handler
    const dialogPromise = new Promise((resolve) => {
      this.page.once('dialog', async (dialog) => {
        const msg = dialog.message();
        await dialog.accept();
        resolve({ message: msg, hasDialog: true });
      });
    });
    this.page.click(this.selectors.confirmWithdrawBtn, { force: true }).catch(() => {});
    const dlg = await Promise.race([
      dialogPromise,
      new Promise((r) => setTimeout(() => r({ hasDialog: false }), 2000)),
    ]);
    if (dlg.hasDialog) {
      await this.closeWithdrawModal().catch(() => {});
      return { success: false, message: dlg.message };
    }
    await this.page.waitForSelector(this.selectors.withdrawModal, { state: 'hidden' });
    await this.waitForAutoSave();
    return { success: true };
  }

  /**
   * 获取当前资金
   */
  async getCurrentCapital() {
    return (await this.page.textContent(this.selectors.currentCapital)).trim();
  }

  /**
   * 获取累计入金
   */
  async getTotalDeposit() {
    return (await this.page.textContent(this.selectors.totalDeposit)).trim();
  }

  /**
   * 获取累计出金
   */
  async getTotalWithdraw() {
    return (await this.page.textContent(this.selectors.totalWithdraw)).trim();
  }

  /**
   * 获取单笔 R 金额
   */
  async getRAmount() {
    return (await this.page.textContent(this.selectors.rAmount)).trim();
  }

  /**
   * 获取已使用风险
   */
  async getUsedRisk() {
    return (await this.page.textContent(this.selectors.usedRisk)).trim();
  }

  /**
   * 获取剩余可用风险
   */
  async getRemainRisk() {
    return (await this.page.textContent(this.selectors.remainRisk)).trim();
  }

  /**
   * 设置账户参数
   */
  async setAccountParams({ initCapital, riskPct, maxRisk, feeRate }) {
    if (initCapital !== undefined) {
      await this.page.fill(this.selectors.initCapital, String(initCapital));
      await this.page.locator(this.selectors.initCapital).dispatchEvent('change');
    }
    if (riskPct !== undefined) {
      await this.page.fill(this.selectors.riskPct, String(riskPct));
      await this.page.locator(this.selectors.riskPct).dispatchEvent('change');
    }
    if (maxRisk !== undefined) {
      await this.page.fill(this.selectors.maxRisk, String(maxRisk));
      await this.page.locator(this.selectors.maxRisk).dispatchEvent('change');
    }
    if (feeRate !== undefined) {
      await this.page.fill(this.selectors.feeRate, String(feeRate));
      await this.page.locator(this.selectors.feeRate).dispatchEvent('change');
    }
    await this.waitForAutoSave();
  }

  /**
   * 直接通过 JS 添加入金
   */
  async addDepositDirectly(amount, date) {
    await this.page.evaluate(async ({ a, d }) => {
      try {
        if (typeof addDeposit === 'function') {
          await addDeposit(a, d);
          if (typeof updateAll === 'function') updateAll();
        }
      } catch (e) { console.error(e); }
    }, { a: amount, d: date });
    await this.waitForAutoSave(500);
  }
}

module.exports = FundPanel;
