# E2E 测试说明 (Playwright)

## 📁 目录结构

```
tests/e2e/
├── fixtures/             # 测试夹具（自动登录、测试数据）
│   ├── auth.fixture.js
│   └── test-data.fixture.js
├── pages/                # 页面对象模型 (POM)
│   ├── BasePage.js
│   ├── TradingPage.js
│   ├── CalculatorPanel.js
│   ├── TradeTable.js
│   ├── FundPanel.js
│   ├── ChartPanel.js
│   ├── LoginModal.js
│   └── DiaryPage.js
├── specs/                # 测试规格
│   ├── 01-page-load.spec.js       # 页面加载和导航
│   ├── 02-auth.spec.js            # 用户认证
│   ├── 03-calculator.spec.js      # 开仓结算计算器
│   ├── 04-trade-management.spec.js# 交易管理
│   ├── 05-fund-management.spec.js # 入金出金管理
│   ├── 06-stats-panel.spec.js     # 统计面板
│   ├── 07-theme.spec.js           # 主题切换
│   ├── 08-sync.spec.js            # 数据同步
│   ├── 09-diary.spec.js           # 复盘总结
│   └── 10-edge-cases.spec.js      # 边界条件
├── utils/                # 工具函数
│   ├── helpers.js
│   └── data-builder.js
└── README.md             # 本文档
```

## 🚀 快速开始

### 安装 Playwright

```bash
# 安装依赖
npm install

# 安装浏览器（首次运行）
npx playwright install
```

### 运行测试

```bash
# 运行所有 E2E 测试（默认使用 Edge 浏览器）
npm run test:e2e

# UI 模式（可视化调试）
npm run test:e2e:ui

# 调试模式（逐步骤调试）
npm run test:e2e:debug

# 指定 Edge 项目
npm run test:e2e:edge
npm run test:e2e:edge:light
npm run test:e2e:edge:dark
npm run test:e2e:edge:mobile

# 查看 HTML 报告
npm run test:e2e:report
```

> **注意**：项目仅配置了 Microsoft Edge 浏览器（`channel: 'msedge'`），如需启用其他浏览器请修改 `playwright.config.js`。

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `BASE_URL` | `http://localhost:3000` | 被测应用地址 |
| `CI` | - | 设置后启用 CI 模式（重试2次，单worker）|

```bash
# 远程环境测试
BASE_URL=https://example.com npm run test:e2e

# CI 环境
CI=1 npm run test:e2e
```

## 🏗️ 页面对象模型 (POM)

### BasePage
所有页面的基类，提供通用方法：

```javascript
const { test, expect } = require('@playwright/test');
const BasePage = require('./pages/BasePage');

test('示例', async ({ page }) => {
  const basePage = new BasePage(page);
  await basePage.goto();
  await basePage.waitForVisible('.app-header');
  await basePage.screenshot('home-page');
});
```

### 自定义页面对象
继承 `BasePage` 并封装页面元素和操作：

```javascript
// pages/CalculatorPanel.js
const BasePage = require('./BasePage');

class CalculatorPanel extends BasePage {
  constructor(page) {
    super(page);
    this.directionSelect = page.locator('#calcDirection');
    this.entryPriceInput = page.locator('#calcEntryPrice');
    this.calculateButton = page.locator('button:has-text("计算")');
  }

  async selectDirection(direction) {
    await this.directionSelect.selectOption(direction);
  }

  async fillEntryPrice(price) {
    await this.entryPriceInput.fill(String(price));
  }

  async calculate() {
    await this.calculateButton.click();
    await this.waitForAutoSave();
  }
}
```

## 🧩 测试夹具 (Fixtures)

### 认证夹具

```javascript
const { test, expect } = require('../fixtures/auth.fixture');

test('需要登录的操作', async ({ loggedInPage }) => {
  // 自动注册并登录
  const { page, user } = loggedInPage;
  expect(user.username).toContain('e2e_');
});

test('匿名访问', async ({ anonPage }) => {
  // 干净的未登录状态
  await expect(anonPage.locator('button:has-text("登录")')).toBeVisible();
});
```

## 🔧 工具函数

### 数据生成器

```javascript
const { buildTrade, buildFund, buildUser } = require('../utils/data-builder');

const trade = buildTrade({
  symbol: 'BTC/USDT',
  direction: 'long',
  entryPrice: 50000,
  exitPrice: 55000,
});
```

### 测试辅助

```javascript
const {
  clearAllStorage,
  uniqueUsername,
  waitForApi,
  mockServerResponse,
} = require('../utils/helpers');

// 清理 localStorage 和 IndexedDB
await clearAllStorage(page);

// 等待特定 API 响应
const response = await waitForApi(page, '/api/sync/', 'POST');

// Mock 服务器响应
await mockServerResponse(page, '**/api/login', {
  success: true,
  token: 'fake-token',
});
```

## 📊 报告和产物

### 测试报告位置

```
playwright-report/        # HTML 报告
├── index.html
├── results.json
└── junit.xml

test-results/             # 失败时的截图/视频/追踪
├── {test-name}/
│   ├── test-failed-1.png
│   ├── video.webm
│   └── trace.zip

screenshots/              # 主动调用的截图
```

### 配置说明

`playwright.config.js` 中已配置：
- **截图**：失败时自动截图 (`screenshot: 'only-on-failure'`)
- **视频**：失败时保留视频 (`video: 'retain-on-failure'`)
- **追踪**：首次重试时保存 (`trace: 'on-first-retry'`)
- **多浏览器**：仅 Edge（edge / edge-light / edge-dark / edge-mobile）
- **主题测试**：浅色/深色专用项目

## ✍️ 编写测试的最佳实践

### 1. 元素定位策略
```javascript
// ✅ 推荐：使用 data-testid 属性（最稳定）
await page.click('[data-testid="submit-button"]');

// ✅ 推荐：使用语义化定位
await page.click('button:has-text("提交")');

// ✅ 推荐：使用 ARIA 角色
await page.getByRole('button', { name: '提交' }).click();

// ⚠️ 避免：依赖具体样式或层级
await page.click('.modal > div:nth-child(2) > button');
```

### 2. 处理动态元素
```javascript
// 等待元素出现
await page.waitForSelector('.loading', { state: 'hidden' });

// 等待特定条件
await page.waitForFunction(() => {
  return document.querySelectorAll('.trade-row').length > 0;
});

// 等待网络空闲
await page.waitForLoadState('networkidle');
```

### 3. 表单输入
```javascript
// 文本输入
await page.fill('#username', 'test_user');

// 数字输入
await page.locator('#price').fill('50000');

// 复选框
await page.check('#agree');

// 下拉选择
await page.selectOption('#direction', 'long');
```

### 4. 断言
```javascript
// 可见性
await expect(page.locator('.success-msg')).toBeVisible();

// 文本内容
await expect(page.locator('.price')).toHaveText('50000');

// 属性
await expect(page.locator('input')).toHaveAttribute('type', 'number');

// 元素数量
await expect(page.locator('.trade-row')).toHaveCount(5);
```

### 5. 处理异步操作
```javascript
// 等待 API 响应
const [response] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/save')),
  page.click('#save-btn'),
]);

// 等待防抖
await page.waitForTimeout(800);

// 等待动画完成
await page.waitForFunction(() => 
  !document.querySelector('.animating')
);
```

## 🔍 调试技巧

### 1. 调试模式
```bash
npm run test:e2e:debug
```
会打开 Playwright Inspector，可以逐步执行。

### 2. UI 模式
```bash
npm run test:e2e:ui
```
可视化界面，可看所有测试用例和执行历史。

### 3. 失败时查看追踪
```bash
# 失败测试会自动保存 trace.zip 到 test-results/
npx playwright show-trace test-results/{test-name}/trace.zip
```

### 4. 主动截图
```javascript
await page.screenshot({ path: 'screenshots/debug.png', fullPage: true });
```

### 5. 打印页面内容
```javascript
const html = await page.content();
console.log(html);
```

## ⚠️ 注意事项

1. **测试隔离**：每个测试用 `clearAllStorage()` 清理状态
2. **避免硬编码等待**：使用 `waitFor*` 系列方法而非 `waitForTimeout`
3. **独立测试**：测试之间不应有依赖关系
4. **登录复用**：使用 `loggedInPage` fixture 复用登录流程
5. **跨浏览器**：使用 `--project=chromium` 等单独指定浏览器

## 📈 测试统计

当前 E2E 测试套件覆盖：

| 模块 | 测试用例数 | 覆盖场景 |
|------|-----------|---------|
| 页面加载 | 6 | 加载、错误处理、导航 |
| 用户认证 | 10 | 登录、注册、密码、退出 |
| 开仓计算器 | 14 | 各种仓位计算场景 |
| 交易管理 | 10+ | CRUD、批量操作 |
| 入金出金 | 6 | 资金变动 |
| 统计面板 | 10+ | 数据计算 |
| 主题切换 | 3 | 浅色/深色模式 |
| 数据同步 | 6 | 登录同步、冲突处理 |
| 复盘总结 | 8 | 复盘页面操作 |
| 边界条件 | 10+ | 异常情况处理 |
