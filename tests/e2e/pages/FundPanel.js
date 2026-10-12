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
      // ★ 实际按钮文案是「＋ 添加」和「关闭」（不是"确认"/"取消"）
      depositModal: '#depositModal',
      depositAmount: '#depositAmount',
      depositDate: '#depositDate',
      confirmDepositBtn: '#depositModal button:has-text("添加")',
      cancelDepositBtn: '#depositModal button:has-text("关闭")',
      openDepositModalBtn: 'button:has-text("入金")',

      // 出金弹窗
      withdrawModal: '#withdrawModal',
      withdrawAmount: '#withdrawAmount',
      withdrawDate: '#withdrawDate',
      confirmWithdrawBtn: '#withdrawModal button:has-text("添加")',
      cancelWithdrawBtn: '#withdrawModal button:has-text("关闭")',
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
    // ★ 校验失败提示已由原生 alert 改为页面内 toast（showToast），
    //   因此不能只监听 dialog；改为提交后同时检查"是否写入"与 toast 文案。
    const before = await this.getDepositCount();
    await this.page.click(this.selectors.confirmDepositBtn, { force: true }).catch(() => {});
    await this.page.waitForTimeout(700);

    const after = await this.getDepositCount();
    if (after <= before) {
      // 未写入 → 被拒绝，取 toast 文案（可能为"请输入有效金额"）
      const msg = await this.getLastToastText();
      return { success: false, message: msg };
    }
    // 写入成功：输入框会被清空作为"已提交"的信号
    await this.waitForAutoSave(400);
    await this.closeDepositModal().catch(() => {});
    return { success: true };
  }

  /**
   * 当前入金记录条数（用于判断提交是否真的写入）
   */
  async getDepositCount() {
    return this.page.evaluate(() => (Array.isArray(window.deposits) ? window.deposits.length : 0));
  }

  /**
   * 最近一条 toast 的**正文**（showToast 生成的提示）
   * ★ 必须取 .ui-toast-body：toast 结构是 [.ui-toast > .ui-toast-icon + .ui-toast-body + 关闭按钮]，
   *   直接取整个 toast 的 textContent 会把关闭按钮的 "✕" 一起带出来。
   */
  async getLastToastText() {
    return this.page.evaluate(() => {
      const bodies = Array.from(document.querySelectorAll('.ui-toast-body'));
      const texts = bodies.map((n) => (n.textContent || '').trim()).filter(Boolean);
      return texts.length ? texts[texts.length - 1] : '';
    });
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
    // 同上：校验失败走 toast，通过"是否写入"判定结果
    const before = await this.getWithdrawCount();
    await this.page.click(this.selectors.confirmWithdrawBtn, { force: true }).catch(() => {});
    await this.page.waitForTimeout(700);

    const after = await this.getWithdrawCount();
    if (after <= before) {
      const msg = await this.getLastToastText();
      return { success: false, message: msg };
    }
    await this.waitForAutoSave(400);
    await this.closeWithdrawModal().catch(() => {});
    return { success: true };
  }

  /**
   * 当前出金记录条数
   */
  async getWithdrawCount() {
    return this.page.evaluate(() => (Array.isArray(window.withdrawals) ? window.withdrawals.length : 0));
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
