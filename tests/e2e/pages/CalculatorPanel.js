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
   * 等待计算器就绪（并确保已展开）
   * ★ 计算器面板默认折叠（#calcToggleBtn 切换），折叠时 .calc-actions 内的
   *   「清空」「添加到交易记录」按钮不可见，点击会一直等到超时 → 先展开再操作。
   * ★ 判定用 aria-expanded 而不是按钮文案：按钮内同时存在
   *   <span>展开 ▼</span> 和 <span>收起 ▲</span>（CSS 隐藏其一），
   *   textContent 永远同时含"展开"和"收起"，按文案判断会反复误切换。
   */
  async waitForReady() {
    await this.page.waitForSelector(this.selectors.card, { state: 'visible' });
    const toggle = this.page.locator('#calcToggleBtn');
    if (await toggle.count() > 0 && await toggle.first().isVisible()) {
      const expanded = await toggle.first().getAttribute('aria-expanded');
      if (expanded !== 'true') {
        await toggle.first().click();
        await this.waitForAutoSave(300);
      }
    }
    // 确认动作按钮可见
    await this.page.waitForSelector(this.selectors.addBtn, { state: 'visible', timeout: 8000 });
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
    // 折叠状态下字段不可见，先展开
    await this.waitForReady();
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
    // ★ 校验失败提示已从原生 alert 改为 showToast（见 calculator.js 的 showToast 分支），
    //   因此不能再等 dialog，改为等待 .ui-toast-body 出现。
    await this.clearToasts();
    await this.waitForReady();
    await this.page.click(this.selectors.addBtn);

    // 出错时 calculator.js 会 markInputError + showToast 并 return，不会开确认弹窗
    const errToast = await this.waitForToast(2500);
    if (errToast) {
      return { success: false, message: errToast };
    }

    // 正常路径会弹出「🛡️ 开仓前确认」确认框（#tradeConfirmModal），
    // 需勾选「我已确认…」(#tradeConfirmAgree) 后点「确认添加」才会真正写入 trades。
    const modal = this.page.locator('#tradeConfirmModal');
    await this.page.waitForSelector('#tradeConfirmModal', { state: 'visible', timeout: 6000 });
    await this.page.check('#tradeConfirmAgree', { force: true });
    await this.page.click('#tradeConfirmModal button:has-text("确认添加")', { force: true });
    await this.page.waitForSelector('#tradeConfirmModal', { state: 'hidden', timeout: 6000 }).catch(() => {});

    await this.waitForAutoSave(400);
    return { success: true };
  }

  /**
   * 清空既有 toast，避免读到上一次的提示
   */
  async clearToasts() {
    await this.page.evaluate(() => {
      document.querySelectorAll('.ui-toast').forEach((t) => t.remove());
    }).catch(() => {});
  }

  /**
   * 等待 toast 提示并返回文案
   * ★ 只取 .ui-toast-body：整个 toast 的 textContent 会带上门关闭按钮的 "✕"
   */
  async waitForToast(timeout = 3000) {
    await this.page.waitForFunction(() => {
      const nodes = Array.from(document.querySelectorAll('.ui-toast-body'));
      return nodes.some((n) => (n.textContent || '').trim().length > 0);
    }, null, { timeout }).catch(() => {});
    return this.page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('.ui-toast-body'));
      const texts = nodes.map((n) => (n.textContent || '').trim()).filter(Boolean);
      return texts.length ? texts[texts.length - 1] : '';
    });
  }

  /**
   * 清空计算器
   */
  async clear() {
    await this.waitForReady();
    await this.page.click(this.selectors.clearBtn);
    await this.waitForAutoSave(200);
  }
}

module.exports = CalculatorPanel;
