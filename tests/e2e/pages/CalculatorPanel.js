// tests/e2e/pages/CalculatorPanel.js
// 开仓仓位计算器
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class CalculatorPanel extends BasePage {
  constructor(page) {
    super(page);
  }

  get selectors() {
    return {
      card: '.calc-card',
      symbol: '#calcSymbol',
      buyTypeSelect: '#buyTypeSelect',
      buyTypeOptions: '#buyTypeOptions',
      buyTypeHidden: '#calcBuyType',
      dirSelect: '#dirSelect',
      dirOptions: '#dirOptions',
      dirHidden: '#calcDir',
      entry: '#calcEntry',
      stop: '#calcStop',
      targetR: '#calcTargetR',
      recoLots: '#calcRecoLots',
      actualLots: '#calcActualLots',
      openDate: '#calcOpenDate',
      lotHint: '#lotHint',

      // 计算结果
      resR: '#res_R',
      resStopPct: '#res_stopPct',
      resTpDist: '#res_tpDist',
      resTp: '#res_tp',
      resBreakeven: '#res_breakeven',
      resPosSize: '#res_posSize',
      resRecoLots: '#res_recoLots',
      resActualLots: '#res_actualLots',
      resActualPos: '#res_actualPos',
      resActualRisk: '#res_actualRisk',
      resPosPct: '#res_posPct',

      // 操作按钮
      addBtn: '.calc-actions button:has-text("添加到交易记录")',
      clearBtn: '.calc-actions button:has-text("清空")',
    };
  }

  /**
   * 等待计算器就绪
   */
  async waitForReady() {
    await this.page.waitForSelector(this.selectors.card, { state: 'visible' });
  }

  /**
   * 设置品种
   */
  async setSymbol(symbol) {
    await this.page.fill(this.selectors.symbol, symbol);
  }

  /**
   * 设置方向（多/空）
   */
  async setDirection(dir) {
    await this.page.evaluate((d) => {
      if (typeof setDir === 'function') setDir(d);
      else {
        var hidden = document.getElementById('calcDir');
        if (hidden) hidden.value = d;
      }
    }, dir);
    await this.waitForAutoSave(200);
  }

  /**
   * 设置买点类型
   */
  async setBuyType(buyType) {
    await this.page.evaluate((t) => {
      if (typeof setBuyType === 'function') setBuyType(t);
      else {
        var hidden = document.getElementById('calcBuyType');
        if (hidden) hidden.value = t;
      }
    }, buyType);
    await this.waitForAutoSave(200);
  }

  /**
   * 设置入场价
   */
  async setEntry(value) {
    await this.page.fill(this.selectors.entry, String(value));
    await this.page.locator(this.selectors.entry).dispatchEvent('input');
    await this.waitForAutoSave(200);
  }

  /**
   * 设置止损价
   */
  async setStop(value) {
    await this.page.fill(this.selectors.stop, String(value));
    await this.page.locator(this.selectors.stop).dispatchEvent('input');
    await this.waitForAutoSave(200);
  }

  /**
   * 设置目标 R 倍数
   */
  async setTargetR(value) {
    await this.page.fill(this.selectors.targetR, String(value));
    await this.page.locator(this.selectors.targetR).dispatchEvent('input');
    await this.waitForAutoSave(200);
  }

  /**
   * 设置实际手数
   */
  async setActualLots(value) {
    await this.page.fill(this.selectors.actualLots, String(value));
    await this.page.locator(this.selectors.actualLots).dispatchEvent('input');
    await this.waitForAutoSave(200);
  }

  /**
   * 设置开仓日期
   */
  async setOpenDate(dateStr) {
    await this.page.fill(this.selectors.openDate, dateStr);
  }

  /**
   * 获取计算结果
   */
  async getResults() {
    return {
      r: (await this.page.textContent(this.selectors.resR)).trim(),
      stopPct: (await this.page.textContent(this.selectors.resStopPct)).trim(),
      tpDist: (await this.page.textContent(this.selectors.resTpDist)).trim(),
      tp: (await this.page.textContent(this.selectors.resTp)).trim(),
      breakeven: (await this.page.textContent(this.selectors.resBreakeven)).trim(),
      posSize: (await this.page.textContent(this.selectors.resPosSize)).trim(),
      recoLots: (await this.page.textContent(this.selectors.resRecoLots)).trim(),
      actualLots: (await this.page.textContent(this.selectors.resActualLots)).trim(),
      actualPos: (await this.page.textContent(this.selectors.resActualPos)).trim(),
      actualRisk: (await this.page.textContent(this.selectors.resActualRisk)).trim(),
      posPct: (await this.page.textContent(this.selectors.resPosPct)).trim(),
    };
  }

  /**
   * 一键填写计算器
   */
  async fillForm({ symbol, dir, buyType, entry, stop, targetR, actualLots, openDate }) {
    if (symbol !== undefined) await this.setSymbol(symbol);
    if (dir !== undefined) await this.setDirection(dir);
    if (buyType !== undefined) await this.setBuyType(buyType);
    if (entry !== undefined) await this.setEntry(entry);
    if (stop !== undefined) await this.setStop(stop);
    if (targetR !== undefined) await this.setTargetR(targetR);
    if (actualLots !== undefined) await this.setActualLots(actualLots);
    if (openDate !== undefined) await this.setOpenDate(openDate);
  }

  /**
   * 添加到交易记录
   */
  async addToTrade() {
    // 监听 alert（"请填写..." 错误信息）
    const dialogPromise = this.page.waitForEvent('dialog', { timeout: 3000 }).catch(() => null);
    await this.page.click(this.selectors.addBtn);
    const dialog = await dialogPromise;
    if (dialog) {
      const msg = dialog.message();
      await dialog.accept();
      return { success: false, message: msg };
    }
    return { success: true };
  }

  /**
   * 清空计算器
   */
  async clear() {
    await this.page.click(this.selectors.clearBtn);
    await this.waitForAutoSave(200);
  }
}

module.exports = CalculatorPanel;
