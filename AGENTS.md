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

### 研报库（集成功能，独立进程）

- `research-hub/` 是一个独立的 Python（FastAPI）服务 + 原生 JS 前端，**不属于 Node 应用**，
  前端共享的 `public/js/header.js` 里有一个指向它的导航入口 `📑 研报库` → `/research/`。
- `server/research-proxy.js` 把 `/research/*` 反向代理到 `127.0.0.1:8765`，让两者同源同端口。
  - 只挂在 `/research` 前缀下，**不要**把代理挪到根路径或 `/api`，否则会盖掉既有路由；
  - 上游未启动时返回 503（页面给引导页、`/research/api/*` 给 JSON），不得抛异常影响主站。
- 研报库前端是「子路径感知」的：`web/app.js` 顶部用 `BASE` 推导挂载前缀，所有请求走 `BASE + path`。
  直接以根路径运行该服务时 `BASE` 为空串，行为不变 —— 改动那边代码时保持这个约定。
- **随交易台一起启动**：`server.js` 启动时 `research-proxy.mount()` 会把研报库作为子进程拉起
  （已在跑则复用、挂了 5 秒后自动重启、交易台退出时一并 kill）。不需要额外 npm 脚本，
  也不要再给 deploy.sh 加单独的启动步骤 —— 否则会起两个实例抢 8765 端口。
- `RESEARCH_AUTOSTART=0` 可关闭自动启动；`mount()` 传入 `autostart: require.main === module`，
  这样被测试 require 时不会误启子进程。
- `GET /api/research/status`、`POST /api/research/start` 是引导页的重试通道，**只接受本机请求**
  （`isLocalRequest()` 同时校验 socket IP 与 `X-Forwarded-For` / `X-Real-IP`，防反代穿透），
  外部 IP 一律 403。改这块务必保留这个闸门。子进程日志在 `server/research.log`（已 gitignore）。
- **静态资源缓存**：研报库的 Python 服务对**所有响应**加了
  `Cache-Control: no-store, no-cache, must-revalidate`（与交易台 `express.static` 的约定一致）。
  不加的话浏览器会按启发式缓存留下旧的 `style.css`，改完样式用户看到的还是旧版（表现为"页面像没样式"）。
  改研报库前端资源时，若担心用户手上还有旧缓存，可同步把 `web/index.html` 里的 `?v=N` 递增。
- ⚠ 代理必须挂在 `express.json()` **之前**：否则 POST/PATCH 的 JSON body 会先被解析消费，
  转发给上游变成空 body，上游一直等直到超时（研报库写操作全废）。代理内部还有一层兜底：
  检测到 `req.body` 已解析时重新序列化转发。
- 数据在 `research-hub/data/`，与 `server/data.db` 无关，互不影响。

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
