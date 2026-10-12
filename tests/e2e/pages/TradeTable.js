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
      // ★ 实际 UI 文案是「🗑️ 清空交易」，且位于「⚙️ 设置」弹窗（#settingsModal）的
      //   "危险操作"区；清空走二次确认弹窗（需输入验证码），不是原生 confirm()。
      // ★ 页面上有多个「⚙️ 设置」按钮（header 内两个不可见的走 openAppSettings），
      //   只有调用 openSettingsModal() 的那个是数据管理弹窗入口 → 用 onclick 精确定位。
      settingsBtn: 'button[onclick="openSettingsModal()"]',
      settingsModal: '#settingsModal',
      clearAllBtn: 'button:has-text("清空交易")',
      expandColsBtn: 'button:has-text("展开全部列")',

      // 清空二次确认弹窗
      clearConfirmModal: '#clearConfirmModal',
      clearConfirmInput: '#clearConfirmInput',
      clearConfirmBtn: '#clearConfirmBtn',

      exportCSVBtn: 'button:has-text("导出 CSV")',
      exportJSONBtn: 'button:has-text("导出 JSON")',
      importJSONBtn: 'button:has-text("导入 JSON")',
      importFile: '#importFile',

      sortDate: '#sortDate',
      sortSymbol: '#sortSymbol',
      sortBuyType: '#sortBuyType',
      sortOrder: '#sortOrder',

      // 删除：行内 🗑 按钮（事件委托 data-action="delete"）
      // → openDeleteConfirm() 用 ui.js 的 showConfirm() 动态创建确认弹窗
      //   （不是原生 confirm()，也没有固定的 #deleteConfirmModal 元素）
      deleteRowBtn: 'button[data-action="delete"], button[title="删除"]',
      uiConfirmOverlay: '.ui-modal-overlay',
      uiConfirmOkBtn: '.ui-modal-overlay .btn-primary',
      uiConfirmCancelBtn: '.ui-modal-overlay .btn-gray',
      // 编辑弹窗内的删除按钮
      editModalDeleteBtn: '#te_deleteBtn',
      editModal: '#tradeEditModal',
      editModalTitle: '#te_title',
    };
  }

  /**
   * 等待 ui.js 的确认弹窗出现
   */
  async waitForUiConfirm() {
    await this.page.waitForSelector(this.selectors.uiConfirmOverlay, { state: 'visible', timeout: 10000 });
  }

  /**
   * 点击 ui 确认弹窗的确认按钮
   */
  async acceptUiConfirm() {
    await this.page.click(this.selectors.uiConfirmOkBtn);
    await this.page.waitForSelector(this.selectors.uiConfirmOverlay, { state: 'detached', timeout: 5000 }).catch(() => {});
    await this.waitForAutoSave(600);
  }

  /**
   * 点击 ui 确认弹窗的取消按钮
   */
  async dismissUiConfirm() {
    await this.page.click(this.selectors.uiConfirmCancelBtn);
    await this.page.waitForSelector(this.selectors.uiConfirmOverlay, { state: 'detached', timeout: 5000 }).catch(() => {});
    await this.waitForAutoSave(300);
  }

  /**
   * 打开「设置」弹窗（清空类操作都在这里）
   */
  async openSettingsModal() {
    await this.page.click(this.selectors.settingsBtn);
    await this.page.waitForSelector(this.selectors.settingsModal, { state: 'visible' });
  }

  /**
   * 关闭「设置」弹窗
   */
  async closeSettingsModal() {
    await this.page.evaluate(() => {
      if (typeof closeSettingsModal === 'function') closeSettingsModal();
    });
    await this.page.waitForSelector(this.selectors.settingsModal, { state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  /**
   * 展开被折叠的次要列（备注/出场日期等 col-secondary 默认 display:none，
   * 不展开则无法 fill —— 这是页面刻意的列折叠设计）
   */
  async expandColumns() {
    const btn = this.page.locator(this.selectors.expandColsBtn);
    if (await btn.count()) {
      const text = await btn.first().textContent();
      // 仅在"展开"状态时点击（按钮文案为「展开 ▼」）
      if (/展开/.test(text || '') && !/收起/.test(text || '')) {
        await btn.first().click();
        await this.page.waitForTimeout(300);
      }
    }
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
      // ★ 备注 / 出场日期属于 col-secondary 次要列，默认折叠（display:none），
      //   必须先展开才能 fill —— 否则 Playwright 会一直等元素可见直到超时。
      await this.expandColumns();
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
   * 行内删除按钮是 🗑 图标 + 事件委托（data-action="delete"），
   * 因此用 title/data-action 定位而非 :has-text("删除")。
   * 它会调 openDeleteConfirm() → ui.js showConfirm() 弹出确认框。
   */
  async deleteTrade(symbol) {
    const row = this.getRowBySymbol(symbol);
    await row.locator(this.selectors.deleteRowBtn).first().click();
    await this.waitForUiConfirm();
  }

  /**
   * 确认删除（ui 确认弹窗）
   */
  async confirmDelete() {
    await this.acceptUiConfirm();
  }

  /**
   * 取消删除（ui 确认弹窗）
   */
  async cancelDelete() {
    await this.dismissUiConfirm();
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
   * 清空所有交易
   * ★ 清空入口在「⚙️ 设置」弹窗的"危险操作"区（不是页面上直接可见），
   *   且清空流程为"二次确认弹窗 + 输入验证码"（不再是原生 confirm()）：
   *   打开设置 → 点「🗑️ 清空交易」→ 输入验证码 → 点「确认清空」
   */
  async clearAll() {
    await this.openSettingsModal();
    await this.page.click(this.selectors.clearAllBtn);
    await this.page.waitForSelector(this.selectors.clearConfirmModal, { state: 'visible' });
    // 弹窗里的验证码取自 #clearConfirmCode（不同动作验证码不同）
    const code = await this.page.textContent('#clearConfirmCode');
    await this.page.fill(this.selectors.clearConfirmInput, (code || '').trim());
    await this.page.waitForTimeout(200);
    await this.page.click(this.selectors.clearConfirmBtn);
    await this.page.waitForSelector(this.selectors.clearConfirmModal, { state: 'hidden', timeout: 5000 }).catch(() => {});
    await this.closeSettingsModal();
    await this.waitForAutoSave(800);
  }

  /**
   * 直接通过 JS 添加交易到全局 trades 数组
   */
  async addTradeDirectly(trade) {
    // 确保交易有唯一 ID（结合时间戳 + 计数器 + 随机数）
    const tradeWithId = {
      id: trade.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${Math.floor(Math.random() * 1e6)}`,
      ...trade,
    };
    await this.page.evaluate((t) => {
      try {
        if (typeof trades === 'undefined' || !Array.isArray(trades)) {
          throw new Error('trades 数组未定义');
        }
        trades.push(t);
        if (typeof updateAll === 'function') updateAll();
        if (typeof save === 'function') save();
      } catch (e) { console.error(e); }
    }, tradeWithId);
    // 等待 DOM 渲染稳定
    await this.page.waitForTimeout(150);
    await this.waitForAutoSave(800);
    return tradeWithId;
  }
}

module.exports = TradeTable;
