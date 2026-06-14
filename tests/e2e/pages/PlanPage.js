// tests/e2e/pages/PlanPage.js
const BasePage = require('./BasePage');

class PlanPage extends BasePage {
  constructor(page) {
    super(page);
    // 顶部 - 使用 first() 限定，避免与空状态按钮冲突
    this.newPlanButton = page.locator('.plan-toolbar button:has-text("新建计划")');
    this.exportButton = page.locator('.plan-toolbar button:has-text("导出")');
    this.templateButton = page.locator('.plan-toolbar button:has-text("模板")');
    this.searchInput = page.locator('#searchKeyword');
    this.statusFilter = page.locator('#statusFilter');
    this.quickDateFilter = page.locator('#quickDateFilter');

    // 统计卡片
    this.statTotal = page.locator('#stat-total-count');
    this.statCompleted = page.locator('#stat-completed-count');
    this.statActive = page.locator('#stat-active-count');
    this.statPnl = page.locator('#stat-total-pnl');
    this.statRisk = page.locator('#stat-total-risk');

    // 列表
    this.planList = page.locator('#planList');
    this.planCards = page.locator('.plan-card');
    this.emptyState = page.locator('#planEmptyState');

    // 编辑模态框 - 限定在 planEditModal 内
    this.editModal = page.locator('#planEditModal');
    this.editTitle = page.locator('#planEditTitle');
    this.saveButton = page.locator('#planEditModal button:has-text("💾 保存")');
    this.cancelEditButton = page.locator('#planEditModal .modal-footer button:has-text("取消")');
    this.saveAsTemplateButton = page.locator('#planEditModal button:has-text("保存为模板")');

    // 表单字段
    this.fDate = page.locator('#f-date');
    this.fStatus = page.locator('#f-status');
    this.fStrategy = page.locator('#f-strategy');
    this.fProfitTarget = page.locator('#f-profitTarget');
    this.fRiskTarget = page.locator('#f-riskTarget');
    this.fSession = page.locator('#f-session');
    this.fCustomSession = page.locator('#f-customSession');
    this.fSentiment = page.locator('#f-sentiment');
    this.fNotes = page.locator('#f-notes');

    // 交易市场
    this.marketChips = page.locator('#f-markets .market-chip');
    this.addItemButton = page.locator('.add-item-btn');

    // 模板模态框
    this.templateModal = page.locator('#templateModal');
    this.templateList = page.locator('#templateList');
  }

  async goto() {
    await this.page.goto(this.page.url().replace(/\/[^/]*$/, '') + '/plan.html');
    // 等待首次渲染
    await this.page.waitForSelector('.plan-toolbar', { timeout: 5000 });
  }

  async openNewPlan() {
    await this.newPlanButton.first().click({ force: true });
    await this.editModal.waitFor({ state: 'visible' });
    await this.page.waitForTimeout(400);
  }

  async openFirstPlanEdit() {
    const editBtn = this.planCards.first().locator('button:has-text("编辑")');
    await editBtn.click({ force: true });
    await this.editModal.waitFor({ state: 'visible' });
    await this.page.waitForTimeout(400);
  }

  async clickSave() {
    await this.saveButton.click({ force: true });
    await this.editModal.waitFor({ state: 'hidden' });
    await this.page.waitForTimeout(500);
  }

  async cancelEdit() {
    await this.cancelEditButton.click({ force: true });
    await this.editModal.waitFor({ state: 'hidden' });
  }

  async fillBasic(date, strategy) {
    if (date) await this.fDate.fill(date);
    if (strategy) await this.fStrategy.fill(strategy);
  }

  async selectMarket(name) {
    await this.page.locator(`#f-markets .market-chip:has-text("${name}")`).click({ force: true });
  }

  async addPlanItem(data) {
    await this.addItemButton.click({ force: true });
    await this.page.waitForTimeout(200);
    const last = this.page.locator('.plan-item-block').last();
    if (data.symbol) await last.locator('input[data-field="symbol"]').fill(data.symbol);
    if (data.direction) await last.locator('select[data-field="direction"]').selectOption(data.direction);
    if (data.entryPriceMin != null) await last.locator('input[data-field="entryPriceMin"]').fill(String(data.entryPriceMin));
    if (data.targetPrice != null) await last.locator('input[data-field="targetPrice"]').fill(String(data.targetPrice));
    if (data.stopLossPrice != null) await last.locator('input[data-field="stopLossPrice"]').fill(String(data.stopLossPrice));
    if (data.quantity != null) await last.locator('input[data-field="quantity"]').fill(String(data.quantity));
    if (data.reason) await last.locator('textarea[data-field="reason"]').fill(data.reason);
  }

  async getCardCount() {
    return await this.planCards.count();
  }

  async getStatTotal() {
    return await this.statTotal.textContent();
  }

  async deleteFirstPlan() {
    const first = this.planCards.first();
    await first.locator('button:has-text("🗑")').click({ force: true });
    // 确认弹窗
    this.page.once('dialog', d => d.accept());
    await this.page.waitForTimeout(500);
  }
}

module.exports = PlanPage;
