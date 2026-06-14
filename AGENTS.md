# TradeManager — Agent 指南

## 项目简介

单页原生 JS 应用（交易日志 / 仓位管理器）+ Node.js/Express 后端。
中文 UI（`lang="zh-CN"`）。无构建步骤、无打包器、无 TypeScript、无测试框架。

## 架构

### 前端（根目录）

`index.html` 通过 `<script>` 标签按严格顺序加载模块：

```
utils.js → database.js → sync.js → storage.js → calculator.js → table.js → charts.js → main.js
```

**加载顺序至关重要。** 后面的文件依赖前面文件的全局变量。新增模块需在 `index.html` 中按正确位置添加 `<script>` 标签。

### 后端（`server/`）

`server/server.js` — Express + SQLite（`sqlite3`），端口 3000。将根目录作为静态文件提供。所有 API 路由在 `/api/` 下。

### 数据流

- **IndexedDB**（浏览器）是主要本地存储 — `database.js`
- **localStorage** 是后备/备份 — `storage.js`
- **服务器 SQLite**（`server/data.db`）用于云端同步 — `server/server.js`
- 前端 ↔ 服务器同步通过 `sync.js`，两侧字段名不同（服务器 snake_case，前端 camelCase）

### 页面

- `index.html` — 主交易日志页面
- `diary2.html` — 复盘总结（独立页面，加载 `diary2.js`、`diary2.css`）
- `debug_*.html` — 本地存储调试页面（非生产环境使用）

## 启动方式

```bash
# 后端
cd server
npm install        # 首次运行
node server.js     # 启动在端口 3000
# 或在 Windows 上：双击 server/start.bat

# 仅前端（无需同步/API）
# 直接在浏览器中打开 index.html（IndexedDB + localStorage 无需服务器即可工作）
```

## 注意事项

- **不存在 lint、typecheck 或 test 命令。** 不要虚构它们。
- **`data.db` 已被 gitignore。** 服务器首次运行时自动创建。不要提交数据库文件。
- **字段名不匹配：** 前端使用 `date`、`dir`、`entry`、`stop`、`pnl`、`pnlR` 等。服务器使用 `open_date`、`direction`、`entry_price`、`stop_loss`、`pnl_amount`、`pnl_r`。映射关系见 `sync.js`（`tradeToServerFormat` / `tradeFromServerFormat`）。
- **脚本版本号：** `index.html` 中的 `<script>` 标签使用 `?v=N` 防缓存。修改任何 JS 文件时需递增版本号。
- **全局作用域污染：** 所有 JS 文件共享全局作用域。变量/函数名没有命名空间。避免冲突 — 添加新的全局变量前先检查已有名称。
- **仅中文 UI。** 所有用户可见的字符串均为中文硬编码。没有国际化系统。
- **无模块系统。** 文件通过全局函数和变量通信（`trades`、`deposits`、`withdrawals` 等）。

## 代码规范

- 前端代码大部分使用 `var`（而非 `const`/`let`）— 旧代码风格。`sync.js` 中新增的异步代码使用 `let`/`const`。
- 暴露给 HTML `onclick` 的函数必须是全局的（不能在闭包/模块内）。
- 弹窗通过 `style.display = 'flex'` / `'none'` 切换 — 无框架。
- 日期格式：`YYYY-MM-DD` 字符串。
- 货币：人民币（￥），通过 `utils.js` 中的 `CNY()` 工具函数格式化。
