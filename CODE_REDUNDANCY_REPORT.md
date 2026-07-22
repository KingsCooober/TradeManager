# TradeManager 代码冗余分析报告

> 分析范围：`c:\Users\ADMIN\Desktop\TradeManager`
> 分析时间：2026-07-22
> 关键约束：单页原生 JS（无 ES Modules，全局作用域通信）；所有 JS 通过 `<script>` 标签按顺序加载；HTML 通过 `onclick="..."` 调用全局函数；无构建步骤。

---

## 一、可安全删除（Safe to Delete）

### 1.1 未使用的 JS 文件

| 文件 | 行数 | 类型 | 判断依据 | 删除建议 |
|---|---|---|---|---|
| `c:\Users\ADMIN\Desktop\TradeManager\public\js\quote.js` | 130 | 未引用模块 | 全文搜索 `quote.js` / `QuoteAPI` / `fetchQuote` 仅命中该文件本身及其单测 `tests\frontend\quote.test.js`；3 个 HTML（`index.html` / `daily-review.html` / `diary2.html`）均无 `<script src="...quote.js">` 标签 | 安全删除。`server/server.js:20` 仍保留了 `/api/quote` 代理端点（66 行），如不再使用可一并删除。 |
| `c:\Users\ADMIN\Desktop\TradeManager\tests\frontend\quote.test.js` | 185 | 未使用单测 | 仅依赖 `quote.js`，引用链一并失效 | 同步删除，避免误以为有覆盖。 |

### 1.2 未使用的 debug HTML 页面

`public/debug/` 目录下的 5 个 HTML 全部是"开发调试工具"，均不通过任何 HTML 链接、`<a href>`、JS `window.location` 进入，且 `index.html` 等也未引用。

| 文件 | 行数 | 类型 | 判断依据 | 删除建议 |
|---|---|---|---|---|
| `c:\Users\ADMIN\Desktop\TradeManager\public\debug\debug_data.html` | 121 | 调试页 | 仅 README.md:38 提到；引用过时的 `TradeDB`（当前项目用 `PositionManagerDB`），已不可用 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\public\debug\debug_delete.html` | 50 | 调试页 | 仅 README.md:39 提到；只测试 `deleteTrade` 的 `onclick` 转义 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\public\debug\debug_storage.html` | 184 | 调试页 | 仅 README.md:40 提到 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\public\debug\debug_table.html` | 69 | 调试页 | 仅 README.md:41 提到；引用旧的 `positionManagerDB` 名称 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\public\debug\test_delete.html` | 73 | 调试页 | 仅 README.md:42 提到 | 安全删除 |

> 这些文件属于"非生产环境调试页"，按 `AGENTS.md` 描述本就是"非生产环境使用"，但与当前代码（数据库名、列结构）已脱节，建议整目录删除。

### 1.3 未使用的 e2e 测试 fixture / 工具

| 文件 | 行数 | 类型 | 判断依据 | 删除建议 |
|---|---|---|---|---|
| `c:\Users\ADMIN\Desktop\TradeManager\tests\e2e\fixtures\test-data.fixture.js` | 92 | 测试夹具 | 全文搜索 `test-data.fixture` 仅命中 README.md:9 和自身，无任何 `*.spec.js` 通过 `require('../fixtures/test-data.fixture')` 引用；其内部定义的 `seededTrades` / `seededFunds` / `seededDiary` 三个 fixture 全是死代码 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\tests\e2e\fixtures\auth.fixture.js` | 69 | 测试夹具 | 全文搜索 `fixtures/auth` 仅命中 README.md:139 文档示例，无任何 `*.spec.js` 通过 `require('../fixtures/auth.fixture')` 引用；`loggedInPage` / `anonPage` 完全是死代码 | 安全删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\tests\e2e\pages\ChartPanel.js` | 96 | PageObject | 全文搜索 `ChartPanel` 仅命中自身文件，无 spec 引用 | 安全删除（但建议保留 `BasePage.js`） |

### 1.4 未使用的 e2e helper / data-builder 导出

`tests/e2e/utils/helpers.js` 中导出但 spec 实际未使用的函数（仅在 `helpers.js` / `BasePage.js` / `data-builder.js` 内部及 README.md 中出现）：

| 函数 | 行号 | 判断依据 |
|---|---|---|
| `waitForApi` | helpers.js:64 | 仅 README.md:182 文档示例引用 |
| `mockServerResponse` | helpers.js:80 | 仅 README.md:185 文档示例引用 |
| `seedPlansToIndexedDB` | helpers.js:190 | 无外部使用 |
| `seedTemplatesToIndexedDB` | helpers.js:243 | 无外部使用 |
| `setupDialogHandler` | helpers.js:287 | `BasePage.js:61` 内有等价实现 `setupDialogHandler`，外层无引用 |
| `waitForVisible` | helpers.js:300 | `BasePage.js:24` 内有等价实现 `waitForVisible`，外层无引用 |
| `safe` | helpers.js:307 | 无外部使用 |
| `pause` | helpers.js:318 | 无外部使用 |

`tests/e2e/utils/data-builder.js` 中导出但 spec 未使用的函数：

| 函数 | 行号 | 判断依据 |
|---|---|---|
| `buildTrades` | data-builder.js:126 | 导出但无 spec 调用 |
| `buildDiaryEntries` | data-builder.js:133 | 导出但无 spec 调用 |
| `buildFund` | — | README.md:158 引用，但 data-builder.js 中**根本未实现该函数**，是文档错误 |

> 删除建议：可在 `helpers.js` / `data-builder.js` 的 `module.exports` 中移除这些条目，或整体保留作为"工具库"（影响极小）。**功能可立即删，但风险低优先级**。

---

## 二、需要谨慎确认（Needs Careful Confirmation）

### 2.1 根目录杂项脚本

| 文件 | 行数 | 用途 | 判断依据 | 建议 |
|---|---|---|---|---|
| `c:\Users\ADMIN\Desktop\TradeManager\cleanup_test_users.js` | 97 | 清理测试账户（保留 wbai / admin） | 直接 `require('./server/node_modules/sqlite3')`，需先安装依赖；不在 `package.json` scripts 中；无 `npm` 命令触发 | **保留为运维工具**（一次性脚本，但有实用价值）；如确认永不再用，可删除；如保留，建议改用 `path.join(__dirname, 'server/node_modules/sqlite3')` |
| `c:\Users\ADMIN\Desktop\TradeManager\query_users.js` | 32 | 打印账户统计信息 | 同上 | 同上；价值不高（信息可在管理面板看到），可考虑删除 |
| `c:\Users\ADMIN\Desktop\TradeManager\reset_password.js` | 51 | 命令行重置密码 | 同上；管理面板也有改密功能 | **保留**（CLI 工具，与 `cleanup_test_users.js` 一类） |
| `c:\Users\ADMIN\Desktop\TradeManager\playwright-results.json` | — | 旧的 Playwright 运行结果 | 已被 `playwright-report/` 取代；不是代码 | 建议**删除**（`playwright.config.js:29` 已改用 `playwright-report/results.json`） |
| `c:\Users\ADMIN\Desktop\TradeManager\playwright-report\index.html` 等 | — | Playwright 报告目录 | 构建产物，应在 `.gitignore` | 建议**加入 `.gitignore`**；已存在仓库中说明历史未忽略 |

### 2.2 `tests/backend/test_api.js` / `tests/backend/test_utils.js` 的归属问题

- `package.json:7` 中 `"test": "node --test tests/frontend/*.test.js tests/backend/*.js"` 会运行 `tests/backend/*.js`。
- 但 `tests/backend/test_api.js` 是**集成测试**（依赖服务器运行于 3000 端口），而 `tests/backend/test_utils.js` 实际是**前端 utils 的单测**（加载 `browser-mock.js`），命名与目录都易混淆。

> 建议：把 `test_utils.js` 改名为 `frontend/utils.test.js` 或移到 `tests/frontend/`。**功能不冗余，但分类混乱，是改进项。**

### 2.3 CSS 文件中的疑似未使用类

> 由于 CSS 动态应用（JS 拼字符串、模板字符串添加 className）较多，无法完全静态判定"未使用"。下列是基于字面搜索、HTML `class=""` 中无引用的类（**仅作风险信号，不建议盲目删**）：

| 选择器 | 所在 CSS | 说明 | 风险 |
|---|---|---|---|
| `.drawdown-stats` / `.drawdown-row` / `.drawdown-item` / `.drawdown-item .s-label` / `.drawdown-item .s-val` | main.css:2119-2155 | `charts.js` 实际通过 `canvas` 渲染图表 + 文本拼接，文本元素使用了 `.s-val` / `.s-label` | **中** — 字符串动态拼接难判定，删前需 `grep "drawdown"` |
| `.stat-label` / `.stat-value` | main.css:1750-1760, 3234-3246 | 两处定义（在 `.equity-modal` 上下文 + `.admin-panel` 上下文）；两个上下文**均使用** | **低** — 实际上是被复用的同名类，非冗余 |
| `.empty, .loading, .error` | main.css:3392 | `.loading` 在 `BasePage.js` 或 HTML 中**未直接使用**（只用了 `.error`） | **低** — 一行 CSS，影响可忽略 |
| `.admin-badge` | main.css:3460 | 仅在 main.js `renderAdminUserList` 中动态使用（已确认） | **无风险** |
| `.diary2` 等只在 `diary2.css` 中定义的类 | diary2.css | 检查 `diary2.html` 与 `diary2.js` 字符串中 className | 见 §2.4 |

### 2.4 单一 HTML 页面专用 CSS 选择器

`diary2.css` 和 `daily-review.css` 是单页专用 CSS。删除前需确认：
- `diary2.css` 中的 `.diary-*` 系列（`diary2.html` 直接静态类名 + `diary2.js` 动态 className 拼装）— **使用中**。
- `daily-review.css` 中的 `.dr-*` 系列 — **使用中**。

> 详细统计因 CSS class 多由 JS 字符串拼接而成，需要对每个文件逐个 `Grep "class.*[className]"` 才能完全确认。**结论：CSS 文件整体使用中，不建议批量删除。**

### 2.5 `public/index.html` 内的同步状态重复定义

`index.html` 文件末尾 `<script>` 块中的 `toggleSyncPanel` / `toggleTheme` 等内联函数（参考 summary 描述），**头部**有专门的 `header.js` 处理主题切换，**末尾**又有内联 `toggleTheme`：

> 实际读 `index.html` 头部已加载 `header.js?v=3`，但末尾 `<script>` 块又定义了 `toggleTheme`。如果 `header.js` 内部也定义了 `toggleTheme`（并通过 `window` 暴露），那内联版本会**覆盖**。需要确认这是**有意为之**还是**冗余定义**。

| 项目 | 文件 | 说明 |
|---|---|---|
| `toggleTheme` | header.js（导出）+ index.html 末尾 `<script>`（内联） | 双重定义风险 |
| `toggleSyncPanel` | index.html 内联 + sync.js 通过 `window.syncModule` 暴露 | 双重定义风险 |

> **建议**：内联在 HTML 的小函数是历史遗留（在没有 `header.js` 之前就存在），目前功能正常但维护成本高。如能删除内联版本，会更清晰。

### 2.6 `custom-select.js` 中 `dataset.csUpgraded='1'` 的幂等保护

- 已确认是项目刻意保留的（AGENTS.md 与 project_memory 多次提及）。
- 属于**设计而非冗余**。**不要删。**

### 2.7 `playwright.config.js` 中 `'line'` reporter

`playwright.config.js:33` 同时定义 `['list']` 和 `['line']` 两种 reporter。两者输出基本一致（`line` 是简洁单行版）。属于**重复配置**，可删除其一。

---

## 三、建议保留（Recommended to Keep）

### 3.1 核心 JS 文件

- 所有 `public/js/*.js`（utils / database / sync / storage / calculator / table / charts / main / header / custom-select / daily-review / diary2）均**全部使用中**。
- `public/js/quote.js` 例外（见 §1.1）。

### 3.2 核心 HTML 页面

- `public/index.html`、`public/daily-review.html`、`public/diary2.html` — 三个生产页面，**全部使用中**。

### 3.3 核心 CSS 文件

- `public/css/main.css`（3472 行）— 通用基础样式 + 管理员面板；被三个 HTML 都引用，**全部使用中**。
- `public/css/diary2.css` — 仅 `diary2.html` 引用，使用中。
- `public/css/daily-review.css` — 仅 `daily-review.html` 引用，使用中。

### 3.4 e2e 测试（`tests/e2e/specs/*.spec.js`）

10 个 spec 文件**全部**对应功能模块：

| Spec | 覆盖功能 |
|---|---|
| 01-page-load.spec.js | 页面加载 |
| 02-auth.spec.js | 注册/登录/登出 |
| 03-calculator.spec.js | 仓位计算器 |
| 04-trade-management.spec.js | 交易管理 |
| 05-fund-management.spec.js | 入金/出金 |
| 06-stats-panel.spec.js | 统计面板 |
| 07-theme.spec.js | 主题切换 |
| 08-sync.spec.js | 数据同步 |
| 09-diary.spec.js | 复盘总结 |
| 10-edge-cases.spec.js | 边界情况 |

> 全部为活跃测试。**建议保留**。

### 3.5 单元测试（`tests/frontend/*.test.js`）

| 测试 | 覆盖 | 状态 |
|---|---|---|
| utils.test.js | `formatNumber` / `CNY` / `esc` 等纯函数 | 活跃 |
| calculator.test.js | 仓位计算 | 活跃 |
| storage.test.js | storage.js 数据存取 | 活跃 |
| sync.test.js | sync.js 同步逻辑 | 活跃 |
| quote.test.js | quote.js（**关联文件被删后此测试必删**） | 待删 |

### 3.6 服务器（`server/server.js`、`server/package.json`）

- 30K+ 行的 Express + SQLite 后端，提供登录/同步/CRUD/行情代理。
- 全部路由被前端 `sync.js` 或 `quote.js` 调用。
- `quote.js` 删除后，**`/api/quote` 端点（server.js:20 起的约 66 行）变成无消费方**——可考虑同步删除（见 §4.3）。

---

## 四、行动建议（按优先级）

### 高优先级（明确可删）

1. **删除 `public/js/quote.js` + `tests/frontend/quote.test.js`**
   - 无任何 HTML 引用，纯属孤立模块
2. **删除 `public/debug/` 整目录（5 个文件）**
   - 非生产调试页，且多数引用旧数据库名
3. **删除 `tests/e2e/fixtures/test-data.fixture.js` + `tests/e2e/fixtures/auth.fixture.js` + `tests/e2e/pages/ChartPanel.js`**
   - 无 spec 引用，纯死代码
4. **删除 `playwright-results.json`**
   - 已被 `playwright-report/results.json` 取代

### 中优先级（清理收益较低，需谨慎）

5. **`tests/e2e/utils/helpers.js` / `data-builder.js`**：移除未使用的导出条目（`waitForApi` / `mockServerResponse` / `seedPlansToIndexedDB` / `seedTemplatesToIndexedDB` / `safe` / `pause` / `buildTrades` / `buildDiaryEntries`）。功能可立即删，**影响可忽略**。
6. **`playwright.config.js`**：移除 `'line'` reporter（与 `'list'` 重复），或移除 `'list'`。
7. **`tests/backend/test_utils.js` 改名或迁移到 `tests/frontend/`**（命名归类问题，非冗余）。
8. **`README.md` 中 `buildFund` 引用** — 实际函数未实现，需修正文档或补函数。
9. **`tests/e2e/README.md:139`** — 演示代码引用 `auth.fixture`，但 spec 未使用该 fixture，需修正文档。

### 低优先级 / 风险需评估

10. **删除 `server/server.js` 的 `/api/quote` 端点**（约 66 行）— 需在删除 `quote.js` 后做。
11. **`public/index.html` 末尾内联 `toggleTheme` / `toggleSyncPanel`** — 与 `header.js` 重复定义，需确认是否真重复。
12. **`cleanup_test_users.js` / `query_users.js` / `reset_password.js`** — 一次性运维脚本，建议保留但加注释说明用途。
13. **`playwright-report/` 与 `test-results/`** — 报告/截图目录，应加入 `.gitignore`（如未在 git 中追踪）。

### 不动（项目记忆明确要求保留）

- `custom-select.js`（含 `dataset.csUpgraded` 幂等保护）
- 所有 `public/js/*.js`（除 `quote.js`）
- `BUY_TYPES` 共享数组
- `drFocusTrapHandler` / `drLastFocused` / 焦点陷阱
- `forceSyncDisciplineRulesToServer` 等同步函数
- 任何 `localStorage` 同步逻辑

---

## 五、附录：分析方法

- **静态扫描**：用 `Grep` 在整个项目中查找函数名、class 名、id 名的引用
- **模块化判定**：HTML 中无 `<script src="quote.js">` 标签 → 视为未加载
- **PageObject 引用链**：在 `tests/e2e/specs/*.js` 中搜索 `require('../pages/ChartPanel')` 等
- **导出 vs 使用**：`module.exports` 中的条目若仅在 `helpers.js` / `BasePage.js` 内部自引用，视为可疑
- **CSS class 使用**：搜索 HTML 静态 `class="..."` 和 JS 字符串模板 `class="...${className}..."`

> **本报告为静态分析结果**。对于 JS 字符串拼接动态生成的 className（如 `daily-review.js` 中的 `dr-trend-*`），未逐一交叉验证 — 建议在删除 CSS 前用浏览器开发者工具确认。
