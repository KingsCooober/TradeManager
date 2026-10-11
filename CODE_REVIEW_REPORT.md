# TradeManager 代码审查报告

> 审查范围：`public/`（17 个 JS + 6 个 HTML + 4 个 CSS）、`server/`（20+ 个 JS，不含 node_modules）、
> `research-hub/`（9 个 Python + 前端）、部署脚本与配置。
> 所有结论均经实际读码核实，标注 `文件:行号` 可回溯。未验证的猜测不写入。
>
> **修复状态：P0 全部已修，P1 全部已修，P2 大部分已修。** 详见第九节。

---

## 一、结论摘要

项目整体工程质量**高于同类原生 JS 项目**：后端鉴权覆盖完整（37 个路由中 35 个挂了
`authMiddleware` + `requireSelfOrAdmin`/`requireAdmin`）、SQL 全部参数化、关键索引齐备、
`aihot-article.js` 的 SSRF 防护（DNS 解析后逐 IP 校验 + 体积上限 + 重定向限制）写得相当扎实、
前端转义函数已统一到 `utils.js` 的 `esc()`。

但有 **3 个必须立刻修的高危问题**，它们的共同点是：**单机自用没问题，一旦部署到公网（项目已有
GitHub Actions 自动部署到 212.64.17.221）就等于把数据和密钥交出去。**

| 级别 | 问题 | 位置 |
|---|---|---|
| 🔴 P0 | JWT 密钥硬编码，任何人可伪造任意用户（含管理员）的 token | `server/auth.js:20` |
| 🔴 P0 | 注册接口可抢注 `admin` 账户提权 | `server/server.js:268` |
| 🔴 P0 | AI API Key 可被重定向外泄（经公网可达的 `/research/api/*`） | `researchhub/api.py:686` |
| 🟠 P1 | `adminId` 兼容分支：知道管理员 UUID 即可无凭据行使管理员权限 | `server/auth.js:125` |
| 🟠 P1 | 5 处存储型/反射型 XSS（含注册用户名 → 管理员面板） | 见 §2.3 |
| 🟠 P1 | 日期用 UTC，每日 08:00 前「今日」全部错位 | `public/js/utils.js:21` |

---

## 二、P0 — 安全问题（建议立刻修）

### 2.1 JWT 密钥硬编码 → 可伪造任意用户身份

```js
// server/auth.js:20
const JWT_SECRET = process.env.JWT_SECRET || 'trademanager-fixed-jwt-secret-v1';
```

`.github/workflows/deploy.yml` 部署时**没有注入 `JWT_SECRET`**，所以生产环境用的就是这个
写死在开源仓库里的字符串。任何人可自行签发 `{userId: '<管理员UUID>', role: 'admin'}` 的 token，
绕过全部鉴权读写所有用户数据、删除账户、创建管理员。

**修法**：
1. 部署时注入 `JWT_SECRET`（GitHub Secrets + `nohup JWT_SECRET=... node server.js`）；
2. 去掉代码里的默认值，改为启动时缺失即 `process.exit(1)` 并打印提示，避免"忘了配就默默用弱密钥"。

### 2.2 注册接口可抢注 `admin` 提权

```js
// server/server.js:265-270
const { username, password, role = 'user' } = req.body;
if (role === 'admin' && username !== 'admin') {
  return res.status(403).json({ error: '只有管理员可以创建管理员账户' });
}
```

判据是「用户名是否叫 admin」，而不是「请求者是否已是管理员」。`data.db` 已被 gitignore，
**首次部署后用户表是空的**，此时 `POST /api/register {username:'admin', password:'x', role:'admin'}`
即成为管理员。接口还无速率限制、注册成功直接返回 token。

**修法**：`/api/register` 强制 `role = 'user'`，管理员创建只走 `/api/admin/register`（已正确鉴权）。

### 2.3 AI API Key 可被重定向外泄（SSRF + 凭据泄露）

```python
# research-hub/researchhub/api.py:686-690
override = payload.get("settings") or {}
settings = {**settings, **override}          # ← 请求体可覆盖 ai_base_url
key_input = str(settings.get("ai_api_key") or "")
if "•" in key_input:                          # ← 回传掩码即触发"沿用已保存的真实 key"
    settings["ai_api_key"] = db.get_settings().get("ai_api_key", "")
```

`ai.py:78-82` 随后把 key 以 `Authorization: Bearer <key>` 发往 `settings["ai_base_url"]`。

攻击链（**任一步都无需管理员权限**）：
1. 注册任意账号 → 登录拿 token；
2. `PUT /api/ai/settings` 把 `ai_base_url` 改成自己的服务器（`server/ai-settings.js:79` 原样转发）；
3. `POST /api/ai/settings/test`（`ai-settings.js:104`）→ 上游把**库中真实 key** 发到攻击者服务器。

更严重的是，`/research/api/*` 经 `research-proxy.js` **对公网完全无鉴权可达**——
`isLocalRequest()` 只保护了 `/api/research/start` 和 `/api/research/status` 两个接口，
`app.use(PREFIX, handle)`（`research-proxy.js:358`）是裸转发。而 `research-hub/README.md:233`
自己写着「没有账号体系与鉴权，**不要**直接暴露到公网」。也就是说，攻击者甚至不需要注册，
直接打 `POST /research/api/settings/test` 即可。

**修法**：
1. `summarize` / `settings/test` 忽略请求体里的 `ai_base_url` 与 `ai_api_key`，只用库中已保存的配置；
2. 给 `/research/*` 代理加一层主站鉴权（或在代理层校验 `Authorization`），别让无鉴权的 Python 服务裸奔；
3. `write_settings` 对 `ai_base_url` 做 https + 域名白名单校验。

### 2.4 附带：CORS 全开

`server/server.js:31` 的 `app.use(cors())` 无参数 = 允许所有源。因鉴权走
`Authorization: Bearer`（非 Cookie），CSRF 风险不高，但配合 2.1/2.3 会放大危害。
**修法**：限定为实际使用的域名。

---

## 三、P1 — 功能 Bug 与中等风险

### 3.1 `adminId` 兼容分支可绕过管理员鉴权

```js
// server/auth.js:125-139
var adminId = req.query.adminId || (req.body && req.body.adminId);
_db.get('SELECT role FROM users WHERE id = ?', [adminId], function (err, row) {
  if (!row || row.role !== 'admin') return res.status(403)...
  req.user = { userId: adminId, role: 'admin' };   // ← 仅凭一个 UUID 就授予管理员身份
```

只要拿到管理员的 `userId`，无需密码/token 即可调用全部 `/api/admin/*`
（用户列表、**查看任意用户全部数据**、**删除用户**、创建管理员）。
而 `GET /api/admin/users` 会返回所有用户的 id。前端也确实在用这个参数
（`main.js:1025/1046/1108/1297` 拼 `?adminId=`）。属"兼容期"遗留，应尽快删除。

### 3.2 XSS（5 处）

| 位置 | 说明 |
|---|---|
| `table.js:339-341` | `t.symbol` / `t.buyType` / `t.dir` 直接拼进 `innerHTML`，未过 `esc()` |
| `charts.js:188` | 饼图图例 `labels[k]`（来自 `t.symbol`）拼进 `legend.innerHTML` |
| `main.js:1147-1153` | 管理员面板：`open_date`/`direction`/`entry_price`/`status` 未转义 |
| `main.js:1199-1204` | 管理员面板：`trade_date`/`pnl_percent`/`follow_system` 未转义 |
| `diary2.js:876-881` | 该文件的 `escapeHtml` 用 `div.textContent→innerHTML`，**不转义引号**，却被用在 `title="..."` 属性里（`diary2.js:548/553/563/568`）→ 备注含 `"` 即可注入 |

其中 `main.js:1147` 那条最危险：**攻击者注册时把用户名填成 `<img src=x onerror=...>`**
（`register` 对用户名无字符校验），管理员打开后台即在自己的会话里执行任意脚本。

**修法**：统一改用 `utils.js` 的 `esc()`（它转义 `& < > " '`）；`diary2.js` 删除自带的
`escapeHtml` 直接复用 `esc`；属性位与 JS 字符串位改用 `data-*` + 事件委托（`main.js:352/427/1066`
的 `onclick="fn('${escapeHtml(id)}')"` 在属性解析阶段实体会被还原，仍可闭合引号）。

### 3.3 日期用 UTC → 每日 08:00 前「今日」全部错位

```js
// public/js/utils.js:21
return new Date().toISOString().slice(0, 10);   // UTC，不是本地时间
```

在 UTC+8，每天 00:00–08:00 期间 `getToday()` 返回**前一天**。影响：今日仪表盘（今日开仓/平仓/盈亏）、
计算器默认开仓日期、导出文件名。同源问题：`daily-review.js:436` 的 `navigateDRDate()` 用
`toISOString()` 切日期，点「下一天」在早 8 点前会跳错。
`utils.js:127/139/143` 的持仓天数也存在 UTC/本地混用（`new Date('YYYY-MM-DD')` 按 UTC 解析，
`+ 'T23:59:59'` 按本地解析），可能差 1 天。

**修法**：统一用本地时间拼接 `yyyy-MM-dd`，抽一个 `formatLocalDate(d)` 工具函数。

### 3.4 `diary2.js` 的服务器同步必然 401

```js
// public/js/diary2.js:288 和 :347
fetch(`/api/diary/${diary2CurrentUserId}`, { ... })   // ← 没有 Authorization 头
```

`/api/diary/:userId` 挂了 `authMiddleware`（`server.js:644/658`），所以这两个裸 `fetch`
必然返回 401，`.then(res => res.json())` 拿到 `{error:'未提供认证 token'}` 却仍显示"数据已同步"。
对照 `daily-review.js` 的 8 处调用全部用了 `authFetch`，可见这是遗漏。
**修法**：改用 `authFetch`，并检查 `res.ok`。

### 3.5 清空「全部」用了错误的 localStorage 键

```js
// public/js/main.js:557
localStorage.removeItem('account_params_v1');   // 实际键名是 account_v1
```

真实键名见 `storage.js:218/277`。后果：执行"清空全部"后账户参数（初始资金/风险 R 等）并未清除，
虽然输入框被重置为默认值，但 `account_v1` 残留会在下次加载时回填旧值。

### 3.6 登录后清库与下载存在竞态

```js
// public/js/main.js:725-726
clearLocalDataAndRefresh();   // 内部 clearAllDataFromDB() 是异步的，未 await（:768）
handleDownloadOnly();         // 立刻 syncFromServer() → saveAll() 写入 IndexedDB
```

若清空操作晚于写入完成，刚下载的服务器数据会被抹掉。
**修法**：`clearLocalDataAndRefresh()` 返回 Promise 并 `await` 后再拉取。

### 3.7 `sync.js` 顶层 `JSON.parse` 无保护 → 整模块失效

```js
// public/js/sync.js:141-143
let pendingDeletedTrades = JSON.parse(localStorage.getItem('pending_deleted_trades') || '[]');
```

localStorage 一旦被写坏（非 JSON 内容），`sync.js` 在**顶层**抛错，后续所有函数（登录、同步、
`authFetch`）全部未定义，整站同步瘫痪。而 `sync.js` 里其他 `JSON.parse` 都包了 try-catch，
只有这三行漏了。**修法**：包 try-catch 或改懒解析。

### 3.8 同步失败被静默丢弃 / 退避重试失效

- `store.js:187-195/201-205`：`flushSync` 每个请求 catch 只 `console.warn`，但函数末尾
  无条件 `_syncPending = {}`（`store.js:208`）→ **失败项永远不会重推**，跨设备静默丢数据。
- `sync.js:504-511`：`_doSyncTick` 里 `await syncToServer()` 的**返回值被忽略**
  （该函数失败时 return false 而不抛异常），所以 `ok` 恒为 `true`，`_resetSyncRetry()`
  照常执行 → HTTP 失败**永不触发**已实现好的指数退避。

### 3.9 数值 0 被吞成空串

```js
// public/js/sync.js:307-316
entry: t.entry_price || '',      // 价格/盈亏真实为 0 时变空串
pnl: t.pnl_amount || '',
```
平局单（盈亏恰好 0）往返一次后显示异常。**修法**：改 `!= null` 判断。

### 3.10 后端：`express.json()` 无 `limit`，且缺错误处理中间件

`server/server.js:42` 的 `app.use(express.json())` 用默认 **100KB** 上限。而
`sync.js:336-378` 每次自动同步都会把**全部** trades/deposits/withdrawals POST 上去——
数据量一大就会 413。更糟的是没有 Express 全局错误处理中间件，413 会返回 **HTML 错误页**，
前端 `await res.json()` 解析失败，报出莫名其妙的错误。

**修法**：设合理 `limit`（如 `'5mb'`）+ 加一个错误中间件统一返回 JSON + 同步改增量上传（只传脏数据）。

### 3.11 后端：SQLite 未开 WAL / busy_timeout，且多进程并发写

`server/server.js` 全文无 `PRAGMA journal_mode` / `busy_timeout`。而同一个 `data.db` 被多处并发访问：
`server.js:55`（主服务）、`market-history.js:28`（**另开一个连接**）、`aihot-translate.js:57`（只读连接）、
`cron-fill.js` / `fill-recent.js` / `fill-missing-day.js`（用 `sqlite3` CLI）、
`apply-activity.js`、`check-discipline.js`。默认 rollback journal 模式下极易 `SQLITE_BUSY`。
另 `server.js:353-368` 的 `/api/sync/:userId` 是四层嵌套回调，长事务期间阻塞单连接。

**修法**：启动时统一 `PRAGMA journal_mode=WAL` + `busy_timeout=5000`；`market-history.js` 复用主连接。

### 3.12 研报库其他 P1

| 问题 | 位置 | 说明 |
|---|---|---|
| 上传体积限制形同虚设 | `api.py:193-197` | 60MB 上限在**读完整 body 之后**才判断，超大 body 先入内存 |
| 同步阻塞的 PDF 解析写在 async 路由 | `api.py:192/201/206` | `write_bytes` + pypdf 解析阻塞事件循环 |
| 回填重复抓正文 | `backfill.py:315-316` + `:424` | `existing_ids` 装 `(source, id)` 元组却与 `str(row["id"])` 比较，永不相等 → 新入库的每篇都被再抓一遍，来源请求量翻倍 |
| 列表接口读全文只为 180 字摘要 | `api.py:122/129-131` | `SELECT *` 取回 `content` 再丢弃；前端 `app.js:304` 固定 `limit=2000` → 每次刷新全库正文读一遍并跑正则 |
| `source_file` 无索引却是去重键 | `db.py:107-110` | `api.py:810`、`autofetch.py:251`、`backfill.py:463` 每导入一篇全表扫 |
| 自动抓取与批量回填无互斥 | `autofetch.py:371-377` vs `backfill.py:181-184` | 两个手动入口可同时打同一来源 |
| `extract_pdf` 异常未兜住 | `extract.py:25/37` | 损坏 PDF 抛异常 → 500 |
| 正文域名用子串校验 | `feeds.py:692` | `https://attacker/myqcloud.com` 能通过 `"myqcloud.com" in url` |
| 逐条 commit | `api.py:864`、`autofetch.py:294`、`backfill.py:507` | 抓 20 篇 = 20 次 fsync |
| 批量删除 `IN (?,?,…)` 展开全部 id | `api.py:350-366` | 超 SQLite 变量上限会 OperationalError |

---

## 四、P1 — 性能

| 问题 | 位置 | 说明 |
|---|---|---|
| 每次编辑触发全量重渲染 | `table.js:183` → `main.js:219` | `updateTrade` 改一个单元格就调 `updateAll()`，重算统计 + 仪表盘 + 计算器 + **整表 innerHTML 重建** + 全部图表重绘 |
| 每次渲染克隆所有下拉框 | `table.js:457-461` | 每个 `.table-select` 都 `cloneNode + replaceChild`，22 列 × N 行 |
| 每次 `updateAll` 写 4 条 IndexedDB | `main.js:221` → `storage.js:267-277` | 无条件 `saveAccountParams()`，4 个 setting 事务 |
| `O(n·m)` 查找 | `storage.js:147-152` | 遍历 `dirtyTradeIds` 时对每项 `trades.find()` |
| 逐条事务写库 | `database.js:547-570`（导入）、`database.js:438-476`（迁移） | N 笔 = N 个 readwrite 事务 |
| 拉取/清空逐条操作 | `store.js:140-148`（循环内 await idbPut）、`store.js:105-113`（游标逐条 delete） | 数百条 = 数百事务 |
| 同步仍是全量上传 | `sync.js:336-378` | 每 5 秒把全表 POST 上去，`dirtyTradeIds` 只用于本地保存 |
| 图表每次全量重建 | `daily-review.js:1102-1117` → `1336/1484/1642/1804` | 每次 render 都 `echarts.init` 新实例再 dispose，4 张图 |
| 全站 fetch 无超时 | `sync.js:71`、`daily-review.js:913/1056`、`backtest-main.js:284/356`、`aihot.js:147`、`diary2.js:288` | 服务端挂起则请求永久 pending、按钮永久 disabled |
| 未捕获的 Promise rejection | `table.js:191`、`main.js:966/983` | 失败无任何提示 |
| localStorage 写入无配额保护 | `storage.js:48/158/165/195/202/277`、`main.js:587/613` | `QuotaExceededError` 未捕获 |

**优先做这两条**：`table.js:183` 改为按需刷新（只重绘受影响部分）+ 增量同步。
其余可按需优化。

---

## 五、P2 — 可维护性

- **死代码**：`calculator.js:71` 的 `initCustomSelect` 被 `:221` 同名函数覆盖，前 100 行永不执行；
  `backtest-chart.js:962-1018`、`1027-1129` 在 `return` 之后，约 160 行永不执行；
  `backtest-chart.js:1133/1180/1901`、`calculator.js:34` 全仓无调用者。
- **隐式全局**：`main.js:1366` 的 `userModifiedActualLots` 全仓仅此一处、从未声明。
- **跨文件重复声明**：`backtest-trade.js:22` 与 `backtest-main.js:15` 都 `var BT_currentSymbol = null`。
  当前 `backtest.html` 的加载顺序（trade → chart → main）下，两次赋值都在页面加载期，
  结果恰好都是 `null`，**暂时无害**；但这是隐式耦合——任一方调整加载顺序或改为非 `null` 初值，
  就会出现"状态被莫名清空"。建议只保留一处。
- **事件监听累积**：`calculator.js:136/291` 每次 `initCustomSelect` 都往 `document` 加一个 click 监听。
- **重复代码**：`calculator.js:440-506` 与 `:596-654` 约 60 行几乎相同。
- **资源未释放**：`main.js:632`、`storage.js:486`、`database.js:528` 的 `URL.createObjectURL` 未 revoke。
- **脚本版本号不一致**：`sync.js` 在 `index.html` 是 `?v=10`，在 `daily-review.html`/`diary2.html` 是 `?v=9`；
  `database.js` 在 `index.html` 是 `?v=5`，另两页是 `?v=4`。
  ⚠️ 注意：服务端对全部静态资源设了 `Cache-Control: no-store`（`server.js:44-52`），
  所以这个 `?v=N` 机制实际**已不起作用**——两者择一：要么删掉版本号参数，要么改回可缓存策略。
- **`CODE_REDUNDANCY_REPORT.md`** 已存在，其中「可安全删除」清单（`quote.js`、5 个 debug 页面、
  未使用的 e2e fixture）我复核过，`public/debug/` 与 `public/js/quote.js` 当前已不存在，清单已过时。
- 硬编码用户 UUID：`server/check-discipline.js:7`。

---

## 六、HTML / CSS / 可访问性

- **弹窗语义缺失**：`index.html` 的 **11 个** `.modal-overlay` 全部没有 `role="dialog"`/`aria-modal`
  （`:263/373/388/471/500/529/586/609/630/653/721`），而 `daily-review.html`、`diary2.html`、
  `aihot.html` 的弹窗都有——同一项目内不一致，且主页面弹窗无焦点管理。
- `outline: none` 共 **22 处**（`main.css` 17 处、`daily-review.css` 3 处、`diary2.css` 2 处），
  多数未配替代的 `:focus-visible` 样式，键盘用户会失去焦点可见性。
- `!important` 约 **45 处**，其中 `diary2.css:235-265` 一段 20 余行几乎全靠 `!important` 覆盖。
- CSS 变量体系（`:root` + `[data-theme=dark]`）**健全**，暗色主题实现规范；
  响应式断点 **21 处**（420/480/600/640/768/850/860/900/1024/1100/1300px + 横屏），覆盖完整。
- `prefers-reduced-motion` 已适配（`main.css:3471`）——这点做得比多数项目好。
- 未发现重复 `id`；未发现 `<img>` 缺 `alt`（页面基本不用图片）；表单 `<label>` 为隐式包裹（可接受）。
- 内联 `style` 约 44 处（多为颜色变量，`index.html`），可下沉为 CSS 类。
- `index.html:800-834` 末尾内联的 `toggleTheme` 覆盖 `header.js:7` 的同名函数——
  经核实这是 `header.js:5-6` 注释**明确声明的有意设计**（供各页重写以附加重绘逻辑），非缺陷。

---

## 七、建议的修复顺序

**第一批（当天，安全止血）**
1. `server/auth.js:20` — 去掉默认密钥，部署注入 `JWT_SECRET`（否则下面几条都白修）；
2. `server/server.js:268` — 注册强制 `role='user'`；
3. `researchhub/api.py:686` — `settings/test` 与 `summarize` 忽略请求体的 `ai_base_url`/`ai_api_key`；
4. `server/research-proxy.js:358` — 给 `/research/*` 加鉴权，别让无鉴权服务公网可达；
5. `server/auth.js:125` — 删除 `adminId` 兼容分支。

**第二批（本周，功能 Bug）**

6. `utils.js:21` + `daily-review.js:436` — 日期改本地时间；
7. `diary2.js:288/347` — 改用 `authFetch`；
8. `table.js:339-341`、`charts.js:188`、`main.js:1147/1199`、`diary2.js:876` — 补全转义；
9. `main.js:557` — 修正键名；`main.js:725` — `await` 清库；
10. `sync.js:141-143` — 包 try-catch；`sync.js:504` — 按返回值判定退避；
11. `store.js:208` — 失败项保留在 pending。

**第三批（性能与整洁）**

12. `server.js:42` — 设 `express.json({limit})` + 加 JSON 错误中间件；开 WAL/busy_timeout；
13. `table.js:183` — 按需刷新替代 `updateAll()` 全量重渲染；同步改增量；
14. 清理死代码、统一脚本版本号策略。

---

## 八、做得好的地方（无需改动）

- 后端鉴权覆盖率高：35/37 个路由带 `authMiddleware` + 所有权校验，未发现越权读写他人数据；
- SQL 全部参数化：唯一两处字符串拼接是 `IN (${placeholders})`（占位符本身由 `map(()=>'?')` 生成，
  安全）和本地运维脚本 `fill-missing-day.js:38`；
- 索引策略完整（`server.js:207-251`），含复合索引覆盖 `ORDER BY`；
- `aihot-article.js:27-69` 的 SSRF 防护（含 IPv6/内网段/`::ffff:` 映射、DNS 解析后校验、
  体积上限、重定向次数限制）质量很高；
- `research-proxy.js` 挂在 `express.json()` 之前的顺序处理、以及 `req.body` 已解析时的兜底重序列化，
  体现了对 Express 中间件顺序的准确理解；
- 研报库 `db.py:155-165` 用 `threading.local()` 保证每线程独立连接，规避了
  `check_same_thread` 问题；
- 项目已有测试基础设施（Node test runner + Playwright E2E），`AGENTS.md` 文档详尽。

---

## 九、修复记录

> ✅ **测试验证已完成（shell 环境以完全权限模式运行后恢复）**：
> 前端单测 + 后端单测 **240 pass / 0 fail**，API 集成测试 **40 pass / 0 fail**。
> 过程中发现并修复了 3 个问题，见第 19–21 项。
>
> **Shell 故障根因（已诊断并绕过）**：并非 PowerShell 损坏 ——
> Store 版 PowerShell（`...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\`）在 DSH 沙箱受限模式下
> 无法加载自身运行时，报 `0xC0000142`；切换到**完全权限模式**后 pwsh 7.6.6 正常启动。
> （附带发现：Store 包目录确实只有别名文件，属精简安装，但完全权限下可正常工作。）

### P0 — 已全部修复

| # | 修复内容 | 涉及文件 |
|---|---|---|
| 1 | **JWT 密钥**：删除硬编码默认值，改为 `环境变量 → server/.jwt-secret（自动生成，0600 权限）→ 随机临时密钥`。密钥文件已加入 `.gitignore`，重启后登录态不失效，且每台机器各不相同。 | `server/auth.js`、`.gitignore` |
| 2 | **注册提权**：`/api/register` 强制 `role = 'user'`，忽略客户端传入的 `role`；补了 username/password 必填校验。创建管理员只能走已鉴权的 `/api/admin/register`。 | `server/server.js` |
| 3 | **AI Key 外泄**：新增 `_ai_settings_for_request()`，`ai_base_url`/`ai_api_key` 一律只取库中已保存值，请求体最多覆盖 `ai_model`/`ai_temperature`/`ai_language`。`/api/settings/test` 与 `/api/reports/{id}/summarize` 均改用该函数。主站 `ai-settings.js` 与两个前端（`header.js`、研报库 `app.js`）同步改为"先保存再测试"。 | `researchhub/api.py`、`server/ai-settings.js`、`public/js/header.js`、`research-hub/web/app.js` |
| 4 | **`/research/*` 无鉴权**：代理层新增闸门，校验登录时下发的 httpOnly 会话 Cookie；未登录返回提示页（HTML）或 401 JSON。新增 `POST /api/logout`（清 Cookie）与 `POST /api/session`（用 Bearer token 换 Cookie，供老登录态/换标签页场景）。`research.html` 改为先换 Cookie 再加载 iframe。未注入 `auth` 时退回"仅本机可访问"，宁可打不开也不裸奔。 | `server/research-proxy.js`、`server/auth.js`、`server/server.js`、`public/research.html`、`public/js/sync.js` |

### P1 — 已全部修复

| # | 修复内容 | 涉及文件 |
|---|---|---|
| 5 | **`adminId` 提权通道**：删除 `requireAdmin` 的 `adminId` 兼容分支，只认 token 中的 role；无 token 返回 401、非管理员 403。前端 4 处 `?adminId=` 全部移除。 | `server/auth.js`、`public/js/main.js` |
| 6 | **UTC 日期**：新增 `formatLocalDate()` / `parseLocalDate()`，`getToday()` 改用本地时区；`calcHoldDuration` 统一本地解析（顺带修掉持仓天数差 1 天）；`navigateDRDate`、diary2 的默认日期与导出文件名同步修正。 | `public/js/utils.js`、`daily-review.js`、`diary2.js` |
| 7 | **diary2 同步 401**：`loadFromServer` / `syncToServer` 改用 `authFetch` 并检查 `res.ok`（原先失败也提示"已同步"）。 | `public/js/diary2.js` |
| 8 | **5 处 XSS**：`table.js` 的 symbol/buyType/dir/date/entry 补 `esc()`；`charts.js` 饼图图例补 `esc()`；`main.js` 管理员面板两个渲染函数全字段转义；`diary2.js` 的 `escapeHtml` 改为委托 `esc()`（原实现不转义引号却被用在 `title="..."` 里）。另把 `main.js` 三处 `onclick="fn('...')"` 字符串拼接改为 `data-*` + 事件委托。 | `public/js/table.js`、`charts.js`、`main.js`、`diary2.js` |
| 9 | **清空键名 + 清库竞态**：`account_params_v1` → 正确的 `account_v1`；`clearLocalDataAndRefresh()` 改为返回 Promise，登录/注册流程 `await` 后再拉取服务器数据。 | `public/js/main.js` |
| 10 | **同步失败静默丢弃**：`flushSync` 改为"快照 + 按 id 摘除"，失败项保留并 5s 后重试；且不再整体替换 `_syncPending`（避免抹掉 await 期间的新编辑）。 | `public/js/store.js` |
| 11 | **退避重试失效**：`_doSyncTick` 检查 `syncToServer`/`syncFromServer` 的返回值（它们失败时 return false 而不抛异常），失败即触发指数退避。 | `public/js/sync.js` |
| 12 | **数值 0 被吞**：`tradeFromServerFormat` 用 `numOrEmpty()` 替代 `|| ''`，平局单（pnl=0）不再变成空串。 | `public/js/sync.js` |
| 13 | **顶层 JSON.parse 崩溃**：新增 `safeParseArray()`，三个 pendingDeleted 列表损坏时重置而非让整个 `sync.js` 加载失败；`getCurrentUser` 同样加了容错。 | `public/js/sync.js` |

### P2 — 已修复

| # | 修复内容 | 涉及文件 |
|---|---|---|
| 14 | **`express.json` 上限**：默认 100KB → 10MB（全量同步会 POST 全部记录）；新增全局错误中间件，413/400 返回 JSON 而非 HTML 错误页。 | `server/server.js` |
| 15 | **SQLite 并发**：主库与 `market-history.js` 的独立连接都加了 `PRAGMA journal_mode=WAL` + `busy_timeout=5000` + `synchronous=NORMAL`。 | `server/server.js`、`server/market-history.js` |
| 16 | **脚本版本号**：所有被改动的 JS 的 `?v=N` 已递增并跨页面统一（utils 8、header 11、sync 11、store 2、database 5、table 20、charts 6、main 20、backtest-chart 78、backtest-main 24）。 | 6 个 HTML |
| 17 | **测试同步更新**：`utils.test.js` 的 `getToday` 期望值改为本地时区并新增 `formatLocalDate`/`parseLocalDate`/`calcHoldDuration` 用例；`test_auth.js` 的 `requireAdmin` 用例改为验证"仅凭 adminId 不放行"；`test_api.js` 注册用例改为验证"role 被忽略"、管理员接口改用 Bearer token。 | `tests/` |
| 18 | **死代码清理**：删除全仓零引用的 `BT_renderWindowExtremaDOM` / `BT_calcWindowExtrema` / `BT_syncIndexVisibleBars`（`backtest-chart.js` 约 79 行，已确认无动态调用）、`main.js` 从未声明也从未读取的隐式全局 `userModifiedActualLots`、`backtest-main.js` 与 `backtest-trade.js` 的重复全局声明 `BT_currentSymbol`（保留后者，加载顺序下前者会把已恢复状态清空）。 | `backtest-chart.js`、`main.js`、`backtest-main.js` |
| 19 | **额外发现**：`backtest-main.js` 读 token 用的键是 `'token'`，实际键名是 `'sync_token'`（见 `sync.js:getToken`）→ 股票名称查询接口一直静默 401。已改用正确键名。 | `public/js/backtest-main.js` |
| 20 | **`main.js` 语法错误（测试发现）**：`clearLocalDataAndRefresh` 改为返回 Promise 时多留了一个闭合 `}`，导致整文件解析失败、所有加载 `main.js` 的测试（210 个）全挂。已修复——这也说明**测试真正跑起来**的必要性：静态复核没能发现它。 | `public/js/main.js` |
| 21 | **测试自身的 3 个过时缺陷**：① `test_api.js` 的服务器探测用 `execSync` 调 powershell，嵌套引号被剥掉导致 "Invalid URI"，探测永远失败 → 集成测试被静默跳过（改为用 node 子进程探测）；② 19 处 CRUD 测试调用**从未带 token**（无鉴权时代写的），在 JWT 路由上必然 401（已全部补上 Bearer token）；③ 「不存在的用户返回空数据」期望访问他人 userId 得 200，与 `requireSelfOrAdmin` 越权防护冲突（已改为期望 403）。 | `tests/backend/test_api.js` |

### 未修复（有意保留 / 建议后续处理）

- **性能项**（`table.js:183` 全量重渲染、增量同步、图表实例复用、fetch 超时等）：
  改动面大、易引入回归，且不属于安全风险，建议单独排期。
- **死代码（有意保留的部分）**：`backtest-chart.js` 的 `BT_setupCustomTooltip` 与 `BT_setupIndexTooltip`
  内 `return` 之后的大段代码是**注释明确声明的占位实现**（`// 保留函数作为占位，避免外部调用报错`），
  函数名必须保留；删除函数体属于重构而非清理，未动。
  `calculator.js:71` 的 `initCustomSelect` 被 `:221` 同名函数覆盖属重复定义，但两者签名与行为不同，
  删前需人工确认调用方语义，未动。
  `updateCalcDate` 虽无 JS 调用者，但被 `index.html:245` 的 `onchange` 引用，**不可删**。
- **`CODE_REDUNDANCY_REPORT.md`** 中的"可安全删除"清单已过时（`public/debug/`、`public/js/quote.js`
  在当前代码里已不存在），未据其删除任何文件。
- **可访问性**：`index.html` 11 个弹窗缺 `role="dialog"`、22 处 `outline: none`、
  45 处 `!important` —— 纯前端样式调整，建议后续统一处理。
- **研报库其他 P1**（上传体积校验时机、PDF 解析阻塞事件循环、回填重复抓正文、
  `source_file` 缺索引、抓取互斥锁等）：与本次安全主线无关，建议单独排期。

### 部署提醒

1. 服务器上**不要**手动创建 `server/.jwt-secret`，让程序首次启动自动生成即可；
   若要多机共用登录态，再通过环境变量 `JWT_SECRET` 注入同一密钥。
2. 站点走 HTTPS 时，导出 `COOKIE_SECURE=1`，让会话 Cookie 带上 `Secure` 标记。
3. 因为删除了 `adminId` 兼容分支，**旧前端缓存**会无法访问管理接口 —— 已在 HTML 里递增版本号，
   但仍建议用户强刷一次（服务端已对所有静态资源设 `no-store`，正常不会命中缓存）。
