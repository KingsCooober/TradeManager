// tests/e2e/pages/TradeTable.js
// 交易记录表
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class TradeTable extends BasePage {
  constructor(page) {
    super(page);
  }

  get selectors() {
    return {
      table: '#tradeTable',
      tbody: '#tradeBody',
      row: '#tradeBody tr',
      clearAllBtn: 'button:has-text("清空记录")',
      exportCSVBtn: 'button:has-text("导出 CSV")',
      exportJSONBtn: 'button:has-text("导出 JSON")',
      importJSONBtn: 'button:has-text("导入 JSON")',
      importFile: '#importFile',

      sortDate: '#sortDate',
      sortSymbol: '#sortSymbol',
      sortBuyType: '#sortBuyType',
      sortOrder: '#sortOrder',

      // 删除确认
      deleteConfirmModal: '#deleteConfirmModal',
      deleteSymbol: '#deleteSymbol',
      deleteDir: '#deleteDir',
      deleteEntry: '#deleteEntry',
      confirmDeleteBtn: '#deleteConfirmModal button:has-text("确认删除")',
      cancelDeleteBtn: '#deleteConfirmModal button:has-text("取消")',
    };
  }

  /**
   * 等待表格就绪
   */
  async waitForReady() {
    await this.page.waitForSelector(this.selectors.table, { state: 'visible' });
  }

  /**
   * 获取行数
   */
  async getRowCount() {
    // 排除"暂无交易记录"占位行
    return this.page.evaluate(() => {
      const rows = document.querySelectorAll('#tradeBody tr');
      if (rows.length === 1 && rows[0].textContent.includes('暂无')) return 0;
      return rows.length;
    });
  }

  /**
   * 获取所有交易行数据
   */
  async getAllRows() {
    return this.page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#tradeBody tr'));
      return rows
        .filter((r) => !r.textContent.includes('暂无'))
        .map((r) => {
          const cells = Array.from(r.querySelectorAll('td'));
          return cells.map((c) => c.textContent.trim());
        });
    });
  }

  /**
   * 获取第一行品种
   */
  async getFirstRowSymbol() {
    return this.page.evaluate(() => {
      const rows = document.querySelectorAll('#tradeBody tr');
      if (rows.length === 0) return null;
      const first = rows[0];
      const tds = first.querySelectorAll('td');
      // 索引: 0:#, 1:日期, 2:品种, 3:买点类型, 4:方向, ...
      return tds[2] ? tds[2].textContent.trim() : null;
    });
  }

  /**
   * 根据品种定位行
   */
  getRowBySymbol(symbol) {
    return this.page.locator(`${this.selectors.row}:has(td:has-text("${symbol}"))`).first();
  }

  /**
   * 编辑某个单元格的输入框
   */
  async editCellByField(symbol, field, value) {
    const row = this.getRowBySymbol(symbol);
    // 找到对应字段的 input
    const inputSelector = {
      exit: '.in-exit',
      exitDate: '.in-date',
      note: '.in-note',
    }[field];

    if (inputSelector) {
      const input = row.locator(inputSelector).first();
      await input.fill(String(value));
      await input.dispatchEvent('change');
      await this.waitForAutoSave();
      return;
    }

    // 状态/计划等下拉框：调用全局函数
    await this.page.evaluate(
      ({ s, f, v }) => {
        try { updateTrade && updateTrade(s, f, v); } catch(e) {}
      },
      { s: symbol, f: field, v: value }
    );
  }

  /**
   * 删除某品种的交易
   */
  async deleteTrade(symbol) {
    const row = this.getRowBySymbol(symbol);
    await row.locator('button:has-text("删除")').click();
    // 删除确认弹窗
    await this.page.waitForSelector(this.selectors.deleteConfirmModal, { state: 'visible' });
  }

  /**
   * 确认删除
   */
  async confirmDelete() {
    this.page.once('dialog', (d) => d.accept());
    await this.page.click(this.selectors.confirmDeleteBtn);
    await this.page.waitForSelector(this.selectors.deleteConfirmModal, { state: 'hidden', timeout: 5000 }).catch(() => {});
    await this.waitForAutoSave();
  }

  /**
   * 取消删除
   */
  async cancelDelete() {
    await this.page.click(this.selectors.cancelDeleteBtn);
    await this.page.waitForSelector(this.selectors.deleteConfirmModal, { state: 'hidden' });
  }

  /**
   * 排序
   */
  async sortBy(field) {
    const sel = {
      date: this.selectors.sortDate,
      symbol: this.selectors.sortSymbol,
      buyType: this.selectors.sortBuyType,
    }[field];
    if (sel) {
      await this.page.click(sel);
      await this.waitForAutoSave();
    }
  }

  /**
   * 切换排序顺序
   */
  async toggleSortOrder() {
    await this.page.click(this.selectors.sortOrder);
    await this.waitForAutoSave();
  }

  /**
   * 清空所有
   */
  async clearAll() {
    this.page.once('dialog', (d) => d.accept());
    await this.page.click(this.selectors.clearAllBtn);
    await this.waitForAutoSave(1500);
  }

  /**
   * 直接通过 JS 添加交易到全局 trades 数组
   */
  async addTradeDirectly(trade) {
    // 确保交易有唯一 ID
    const tradeWithId = { id: trade.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...trade };
    await this.page.evaluate((t) => {
      try {
        trades.push(t);
        if (typeof updateAll === 'function') updateAll();
        if (typeof save === 'function') save();
      } catch (e) { console.error(e); }
    }, tradeWithId);
    await this.waitForAutoSave(800);
    return tradeWithId;
  }
}

module.exports = TradeTable;
