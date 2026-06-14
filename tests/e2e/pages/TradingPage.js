// tests/e2e/pages/TradingPage.js
// 主交易页面
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class TradingPage extends BasePage {
  constructor(page) {
    super(page);
    this.url = '/index.html';
  }

  get selectors() {
    return {
      header: '.app-header',
      logo: '.app-logo',
      title: '.app-title h1',
      subtitle: '.app-subtitle',
      diaryLink: 'a:has-text("复盘总结")',

      // 资金卡片
      fundCard: '.left-sidebar .card:has(h2:has-text("账户资金"))',
      initCapital: '#initCapital',
      currentCapital: '#currentCapital',
      totalPnl: '#totalPnl',
      totalReturn: '#totalReturn',
      totalDeposit: '#totalDeposit',
      totalWithdraw: '#totalWithdraw',
      feeRate: '#feeRate',
      totalFees: '#totalFees',
      depositBtn: 'button:has-text("入金")',
      withdrawBtn: 'button:has-text("出金")',

      // 风险参数
      riskCard: '.left-sidebar .card:has(h2:has-text("风险参数"))',
      riskPct: '#riskPct',
      rAmount: '#rAmount',
      maxRisk: '#maxRisk',
      usedRisk: '#usedRisk',
      remainRisk: '#remainRisk',

      // 图表
      positionPie: '#positionPie',
      pieLegend: '#pieLegend',
      equityCurve: '#equityCurve',
      maxDrawdownPct: '#maxDrawdownPct',
      maxDrawdownAmt: '#maxDrawdownAmt',
      peakCapital: '#peakCapital',
      valleyCapital: '#valleyCapital',

      // 交易记录
      tradeTable: '#tradeTable',
      tradeBody: '#tradeBody',
      sTotal: '#s_total',
      sWins: '#s_wins',
      sLosses: '#s_losses',
      sWinrate: '#s_winrate',
      sAvgrr: '#s_avgrr',
      sEv: '#s_ev',
      sMaxdd: '#s_maxdd',
      sTotalR: '#s_totalR',

      // 弹窗
      depositModal: '#depositModal',
      withdrawModal: '#withdrawModal',
      loginModal: '#loginModal',
      changePasswordModal: '#changePasswordModal',
      deleteConfirmModal: '#deleteConfirmModal',
      equityModal: '#equityModal',

      // 同步状态
      syncStatus: '#syncStatus',
      syncLoggedIn: '#headerSyncLoggedIn',
      syncLoggedOut: '#headerSyncLoggedOut',
      headerUsername: '#headerUsername',
      btnSync: 'button:has-text("同步"):not(:has-text("自动"))',
      btnAutoSync: '#headerBtnAutoSync',
    };
  }

  /**
   * 加载主页面
   */
  async load() {
    await this.goto(this.url);
    await this.page.waitForSelector(this.selectors.header, { state: 'visible' });
    await this.page.waitForSelector(this.selectors.fundCard, { state: 'visible' });
    await this.page.waitForSelector(this.selectors.tradeTable, { state: 'visible' });
  }

  /**
   * 验证页面所有关键模块存在
   */
  async verifyAllSections() {
    const checks = [
      [this.selectors.header, '顶部导航栏'],
      [this.selectors.fundCard, '账户资金卡片'],
      [this.selectors.riskCard, '风险参数卡片'],
      [this.selectors.tradeTable, '交易记录表格'],
      [this.selectors.positionPie, '持仓分布图'],
      [this.selectors.equityCurve, '收益曲线图'],
    ];

    for (const [sel, name] of checks) {
      const visible = await this.page.locator(sel).first().isVisible().catch(() => false);
      if (!visible) {
        throw new Error(`关键模块缺失: ${name} (${sel})`);
      }
    }
  }

  /**
   * 获取当前资金
   */
  async getCurrentCapital() {
    return (await this.page.textContent(this.selectors.currentCapital)).trim();
  }

  /**
   * 获取总盈亏
   */
  async getTotalPnl() {
    return (await this.page.textContent(this.selectors.totalPnl)).trim();
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
   * 设置初始资金
   */
  async setInitCapital(value) {
    await this.page.fill(this.selectors.initCapital, String(value));
    await this.page.locator(this.selectors.initCapital).dispatchEvent('change');
    await this.waitForAutoSave();
  }

  /**
   * 设置风险百分比
   */
  async setRiskPct(value) {
    await this.page.fill(this.selectors.riskPct, String(value));
    await this.page.locator(this.selectors.riskPct).dispatchEvent('change');
    await this.waitForAutoSave();
  }

  /**
   * 设置最大风险
   */
  async setMaxRisk(value) {
    await this.page.fill(this.selectors.maxRisk, String(value));
    await this.page.locator(this.selectors.maxRisk).dispatchEvent('change');
    await this.waitForAutoSave();
  }

  /**
   * 设置手续费率
   */
  async setFeeRate(value) {
    await this.page.fill(this.selectors.feeRate, String(value));
    await this.page.locator(this.selectors.feeRate).dispatchEvent('change');
    await this.waitForAutoSave();
  }

  /**
   * 获取交易行数
   */
  async getTradeRowCount() {
    return this.page.locator(`${this.selectors.tradeBody} tr`).count();
  }

  /**
   * 获取统计指标
   */
  async getStats() {
    return {
      total: (await this.page.textContent(this.selectors.sTotal)).trim(),
      wins: (await this.page.textContent(this.selectors.sWins)).trim(),
      losses: (await this.page.textContent(this.selectors.sLosses)).trim(),
      winrate: (await this.page.textContent(this.selectors.sWinrate)).trim(),
      avgrr: (await this.page.textContent(this.selectors.sAvgrr)).trim(),
      ev: (await this.page.textContent(this.selectors.sEv)).trim(),
      maxdd: (await this.page.textContent(this.selectors.sMaxdd)).trim(),
      totalR: (await this.page.textContent(this.selectors.sTotalR)).trim(),
    };
  }

  /**
   * 点击同步按钮
   */
  async clickSync() {
    await this.page.click(this.selectors.btnSync);
  }

  /**
   * 切换自动同步
   */
  async toggleAutoSync() {
    await this.page.click(this.selectors.btnAutoSync);
    await this.waitForAutoSave();
  }

  /**
   * 获取自动同步状态
   */
  async getAutoSyncStatus() {
    return (await this.page.textContent(this.selectors.btnAutoSync)).trim();
  }

  /**
   * 通过直接调用函数清空所有数据
   */
  async clearAllData() {
    this.page.once('dialog', (d) => d.accept());
    await this.page.evaluate(() => {
      try { clearAll && clearAll(); } catch(e) {}
    });
    await this.waitForAutoSave();
  }
}

module.exports = TradingPage;
