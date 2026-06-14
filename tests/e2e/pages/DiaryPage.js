// tests/e2e/pages/DiaryPage.js
// 复盘日记页面
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class DiaryPage extends BasePage {
  constructor(page) {
    super(page);
    this.url = '/diary2.html';
  }

  get selectors() {
    return {
      header: '.app-header',
      title: '.app-title h1',
      backBtn: 'button:has-text("返回")',
      diaryLink: 'a:has-text("复盘总结")',

      // 工具栏
      toolbar: '.diary-toolbar',
      exportBtn: '.diary-toolbar button:has-text("导出")',
      importBtn: '.diary-toolbar button:has-text("导入")',
      addBtn: 'button:has-text("新增记录")',

      // 筛选
      filters: '.diary-filters',
      quickFilter: '#quickFilter',
      filterStartDate: '#filterStartDate',
      filterEndDate: '#filterEndDate',
      clearFiltersBtn: 'button:has-text("清除筛选")',

      // 表格
      table: '#diaryTable',
      tableBody: '#diaryTableBody',
      tableInfo: '#tableInfo',
      pageInfo: '#pageInfo',
      prevPage: '#prevPage',
      nextPage: '#nextPage',
      pageSize: '#pageSize',

      // 弹窗
      diaryModal: '#diaryModal',
      modalTitle: '#modalTitle',
      diaryId: '#diaryId',
      diaryDate: '#diaryDate',
      diarySymbol: '#diarySymbol',
      diaryPnlPercent: '#diaryPnlPercent',
      diaryTradeLogic: '#diaryTradeLogic',
      diaryMood: '#diaryMood',
      diaryFollowSystem: '#diaryFollowSystem',
      diaryLesson: '#diaryLesson',
      diaryImprovement: '#diaryImprovement',
      saveBtn: '#diaryForm button:has-text("保存")',
      cancelBtn: '#diaryModal button:has-text("取消")',
      closeBtn: '#diaryModal .modal-close',

      // 删除弹窗
      deleteModal: '#deleteDiaryModal',
      confirmDeleteBtn: '#deleteDiaryModal button:has-text("确认删除")',
      cancelDeleteBtn: '#deleteDiaryModal button:has-text("取消")',

      // 查看弹窗
      viewModal: '#viewDiaryModal',
      viewContent: '#viewDiaryContent',
      editFromViewBtn: '#viewDiaryModal button:has-text("编辑")',
    };
  }

  /**
   * 加载复盘页面
   */
  async load() {
    await this.goto(this.url);
    await this.page.waitForSelector(this.selectors.header, { state: 'visible' });
    await this.page.waitForSelector(this.selectors.table, { state: 'visible' });
    // 等待 initDiary2 渲染
    await this.page.waitForTimeout(500);
  }

  /**
   * 打开新增弹窗
   */
  async openAddModal() {
    await this.page.click(this.selectors.addBtn);
    await this.page.waitForSelector(this.selectors.diaryModal, { state: 'visible' });
    await this.page.waitForSelector(`${this.selectors.diaryModal}.show`, { timeout: 3000 }).catch(() => {});
  }

  /**
   * 关闭弹窗
   */
  async closeModal() {
    const closeVisible = await this.page.locator(this.selectors.closeBtn).count() > 0;
    if (closeVisible) {
      await this.page.click(this.selectors.closeBtn);
    } else {
      await this.page.click(this.selectors.cancelBtn);
    }
    await this.page.waitForSelector(this.selectors.diaryModal, { state: 'hidden' });
  }

  /**
   * 填写日记表单
   */
  async fillForm({ tradeDate, symbol, pnlPercent, tradeLogic, mood, followSystem, lesson, improvement }) {
    if (tradeDate !== undefined) await this.page.fill(this.selectors.diaryDate, tradeDate);
    if (symbol !== undefined) await this.page.fill(this.selectors.diarySymbol, symbol);
    if (pnlPercent !== undefined) await this.page.fill(this.selectors.diaryPnlPercent, String(pnlPercent));
    if (tradeLogic !== undefined) await this.page.fill(this.selectors.diaryTradeLogic, tradeLogic);
    if (mood !== undefined) await this.page.fill(this.selectors.diaryMood, mood);
    if (followSystem !== undefined) await this.page.selectOption(this.selectors.diaryFollowSystem, followSystem);
    if (lesson !== undefined) await this.page.fill(this.selectors.diaryLesson, lesson);
    if (improvement !== undefined) await this.page.fill(this.selectors.diaryImprovement, improvement);
  }

  /**
   * 提交保存
   */
  async submit() {
    await this.page.click(this.selectors.saveBtn);
    await this.page.waitForSelector(this.selectors.diaryModal, { state: 'hidden' });
    await this.waitForAutoSave();
  }

  /**
   * 一步添加日记条目
   */
  async addEntry(data) {
    await this.openAddModal();
    await this.fillForm(data);
    await this.submit();
  }

  /**
   * 编辑第一行
   */
  async editFirstEntry(updates) {
    const editBtn = this.page.locator(`${this.selectors.tableBody} button:has-text("编辑")`).first();
    await editBtn.click();
    await this.page.waitForSelector(this.selectors.diaryModal, { state: 'visible' });
    await this.fillForm(updates);
    await this.submit();
  }

  /**
   * 删除第一行
   */
  async deleteFirstEntry() {
    const delBtn = this.page.locator(`${this.selectors.tableBody} button:has-text("删除")`).first();
    await delBtn.click();
    await this.page.waitForSelector(this.selectors.deleteModal, { state: 'visible' });
    await this.page.click(this.selectors.confirmDeleteBtn);
    await this.page.waitForSelector(this.selectors.deleteModal, { state: 'hidden' });
    await this.waitForAutoSave();
  }

  /**
   * 查看第一行
   */
  async viewFirstEntry() {
    const viewBtn = this.page.locator(`${this.selectors.tableBody} button:has-text("查看")`).first();
    await viewBtn.click();
    await this.page.waitForSelector(this.selectors.viewModal, { state: 'visible' });
  }

  /**
   * 获取行数
   */
  async getRowCount() {
    return this.page.locator(`${this.selectors.tableBody} tr`).count();
  }

  /**
   * 获取所有行
   */
  async getAllRows() {
    return this.page.evaluate(() => {
      return Array.from(document.querySelectorAll('#diaryTableBody tr')).map((r) => {
        return Array.from(r.querySelectorAll('td')).map((c) => c.textContent.trim());
      });
    });
  }

  /**
   * 应用快速筛选
   */
  async applyQuickFilter(value) {
    await this.page.selectOption(this.selectors.quickFilter, value);
    await this.waitForAutoSave(500);
  }

  /**
   * 设置日期范围
   */
  async setDateRange(start, end) {
    await this.page.fill(this.selectors.filterStartDate, start);
    await this.page.fill(this.selectors.filterEndDate, end);
    await this.waitForAutoSave(500);
  }

  /**
   * 清除筛选
   */
  async clearFilters() {
    await this.page.click(this.selectors.clearFiltersBtn);
    await this.waitForAutoSave(500);
  }

  /**
   * 返回主页面
   */
  async goBackToMain() {
    await this.page.click(this.selectors.backBtn);
    await this.page.waitForURL(/index\.html$/);
  }
}

module.exports = DiaryPage;
