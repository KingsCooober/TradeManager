# TradeManager 前端 UI 交互一致性审计报告

> 审计范围：6 个页面（index / daily-review / diary2 / backtest / aihot / research）+ research-hub/web，
> 4 套 CSS、17 个 JS 模块。三路并行审计（弹窗/控件/反馈视觉），所有条目均经实际读码核实并抽查验证，
> 标注 `文件:行号` 可回溯。本次为**只读审计**，未改动任何文件（审计过程中曾误改 aihot.html，已回滚）。

---

## 总览：问题不在"缺规范"，在"有规范但没贯彻"

项目其实已经有一个**质量很高的统一组件库**：`public/js/ui.js`（showToast/showConfirm/alertDialog）——
自带样式注入、CSS 变量 + 暗色适配、Esc/遮罩关闭、焦点管理、textContent 防 XSS。
daily-review 的焦点陷阱（`setupDRFocusTrap`，daily-review.js:2995）同样完整（Tab 循环 + 关闭归还焦点 + MutationObserver 自动挂载）。
图表侧也有现成范式：charts.js 的 `getThemeColors()`（:6-33）是全站唯一完整的 isDark 色板。

问题是：**ui.js 只被 3/6 页面加载**（index/daily-review/diary2；backtest/aihot/research 未加载），
于是同一项目里并存着 **6 条消息提示通道、7 套确认框、4 套下拉**，且混着 **5 个真 bug**。
统一的主线不是"发明新规范"，而是"把已有的 ui.js 推广到全站 + 修掉 bug"。

| 类别 | 数量 | 其中真 bug |
|---|---|---|
| 消息反馈实现 | 6 条通道 | 2（类名冲突致提示无样式；同名函数三份靠加载顺序侥幸） |
| 确认框实现 | 7 套 | 1（双提示同触发） |
| 下拉控件实现 | 4 套 | —（键盘语义矛盾） |
| 死代码 | ~160 行 | 1（onDatePickerChange 无调用者） |
| 头部功能 | 6 页齐全 | 2（搜索框三页永远空结果；research 同步控件死点） |

---

## 一、真 Bug（建议先修，与统一化无关）

### 1. `sync.js` 的提示类名与 CSS 不匹配 → 主页面同步提示是无样式裸文本
- `public/js/sync.js:828` 写入 `className = 'sync-status ' + type`
- 但 CSS 只定义了 `.sync-status-inline` 及其变体（`main.css:309/318/327/332`），**没有 `.sync-status`**
- 同一个 `#syncStatus` 元素（header.js:56 注入）被 6 个文件争抢：daily-review.js:338、diary2.js:409、
  main.js:992/1009 都写 `sync-status-inline`，唯独 sync.js 写 `sync-status`
- **影响**：主页面（index.html）走 `syncModule.showSyncStatus` 的同步成功/失败提示全部丢失样式
  （无底色、无配色、不隐藏），且 3 秒后残留错乱类名。受影响调用：登录成功/注册/自动同步开关
  （main.js:735/823/868-891）、同步成败（sync.js:432/437）等约 13 处。
- **修法**：sync.js:828/832 的 `sync-status` 改为 `sync-status-inline`（一行）。

### 1b. `showSyncStatus` 存在 3 份同名/同逻辑实现，靠加载顺序侥幸不炸
- `sync.js:823`（全局版）、`diary2.js:405`（**同名全局版，后加载直接覆盖前者**）、
  `daily-review.js:334`（第三副本 `showDRStatus`）
- diary2.html 加载顺序 ui.js→sync.js→diary2.js，所以在 diary2 页 sync.js 内部 13 处调用
  全部被劫持到 diary2 版——当前行为恰好兼容（都写 #syncStatus、都 3000ms），但任何一侧
  改动（比如消失时长、样式类）就会静默漂移。
- **修法**：删 diary2.js:405-415 与 daily-review.js:334 两份副本，统一调 `syncModule.showSyncStatus`。

### 1c. 「保存复盘」同一动作触发两条提示（daily-review）
- `daily-review.js:2763-2764` 同时调 `drSaveToast`（右上绿色块 2s，daily-review.css:1066-1085）
  和 `showDRStatus`（行内 3s）——双提示互相抢注意力。
- **修法**：保留行内一个，删 toast（或反之）。

### 2. `main.css` 中 `.modal-overlay` 定义了两次，后者静默覆盖前者
- `main.css:1628`（无背景色/无动画）与 `main.css:2643`（有 `--bg-overlay` + `backdrop-filter: blur(8px)`）
- 同文件还有两套弹窗过渡动画（`fadeIn+slideUp` 0.3s vs `modalIn` 0.4s 弹性）分属这两块。
- **影响**：视觉上生效的是 2643 那份，1628 是死规则，但两份的动画/背景不一致会误导后续调整。
- **修法**：删除 1628 的定义，保留 2643。

### 3. 自造年/月/日三联动下拉是死代码
- `onDatePickerChange`（table.js:370-394）依赖 `_year_/_month_/_day_` 前缀元素，**全项目无任何生成或调用**
  （HTML、JS 均无）；配套 `getYearRange()`（utils.js:97-104，全项目唯一引用是其定义行）同样零调用；
  `main.css:2941-3010` 的 `.date-select/.date-picker-inline/.date-cell/.date-year` 等样式无 HTML 使用。
- **现状**：全站 8 处日期输入全是原生 `type="date"`（index.html:245/417/425/483/512、
  daily-review.html:48、diary2.html:54/56/128、table.js:350 内联）。
- **修法**：删除 table.js:370-394、utils.js:97-104、main.css:2941-3010（约 160 行）。
  注意：`getDaysInMonth`（utils.js:91）被 table.js 使用，**保留**。
- **保留原生 date 是对的**：移动端自动调系统日期滚轮，体验优于任何自造方案。三套近似样式类
  （`.calc-date-input` main.css:935 / `.modal-date-input` :958 / `.in-date` :981）可合并为一套。

### 4. `backtest-main.js` 读 token 键名错误（上轮已修，此处记录）
- `localStorage.getItem('token')` → 实际键是 `'sync_token'`（sync.js:46），股票名称查询一直静默 401。

### 5. 直写 `#syncStatus` 并硬编码颜色的 9 处旁路
- `table.js:1013-1017/1064-1067`、`storage.js:460-492/542-578`（导出/导入提示）、`calculator.js:584-587`
  绕过 `showSyncStatus` 直接 `el.style.color='#00e676'/'#ff5252'` 等，且**不清 className**
  （残留上次的胶囊背景类）、时长 3s/5s 不一。
- **修法**：统一改调 `syncModule.showSyncStatus`。

---

## 二、消息反馈：5 套 toast，1 个基准

| 实现 | 位置 | 类型参数 | 样式 | 加载页 |
|---|---|---|---|---|
| `showToast`（ui.js:78） | 右上角，自动消失，带关闭按钮 | success/error/**warning**/info | CSS 变量+暗色适配，z-index:10000 | index/daily-review/diary2 |
| `BT_toast`（backtest-trade.js:534） | `#btToast` 单元素复写 | **warn**（参数名都不同） | backtest.html:303 内联，z-index:9999 | backtest |
| `toast()`（research-hub/web/app.js:44） | `#toast-root` 追加 | ok/err | 独立 CSS，err 4.8s/其余 2.6s | research |
| `showDRStatus`（daily-review.js:334） | `#syncStatus` 行内 | — | sync-status-inline | daily-review |
| `drAlert`/`drConfirm`（daily-review.js:3058/3068） | 回调式模态 | — | daily-review.css | daily-review |

**统一建议**：以 `ui.js` 为唯一基准。
- backtest.html 补一行 `<script src="js/ui.js">`，`BT_toast` 改为薄封装（`type` 参数 'warn'→'warning' 映射）；
- `showDRStatus`/`drAlert` 可保留为薄壳调用 showToast/alertDialog（不必强拆调用方）；
- research-hub 是独立 Python 应用，自持一套合理，不强求。

**缺失的统一件**：全站**没有输入框错误态样式类**（红边框）。校验失败只闪 toast
（calculator.js:450/604、diary2.js:785），用户不知道哪个字段有问题。
建议在 main.css 加 `.input-error{border-color:var(--color-red)!important}` 并在校验处挂/摘。

---

## 三、弹窗与确认：7 套实现、2 套开关机制

### 3.1 两套开关机制在同一页面混用（index.html）
- 11 个弹窗用 `style.display='flex'/'none'`（main.js:325/332、414/421、499/510、531/535、656/662、
  899/904；table.js:49/54、760/771、807/860/899；calculator.js:503/545）
- 唯独 `equityModal` 用 `classList.add('show')`（charts.js:200/211，main.css:1643）
- 两套机制在 CSS 上互斥（`.modal-overlay` 基类 `display:none`，`.show` 才是 flex），
  导致**无法用单一选择器查"当前打开的弹窗"**——daily-review.js:2966 的 `.modal-overlay.show` 就查不到 index 的弹窗。
- **建议**：index 的 11 个弹窗全部收敛到 `classList('show')`。

### 3.2 index.html 是全站唯一无键盘路径的页面
- Esc 关闭：✅ daily-review 全 5 弹（统一分发 daily-review.js:138→2965）、diary2 全 3 弹（diary2.js:247，
  但一次无条件关三个，叠开时粗暴）、aihot（909/539）、header 设置（500）、ui.js（216）、研报库（app.js:2423）；
  ❌ **index.html 全部 11 弹、backtest（无自建弹窗）**
- 遮罩点击关闭：✅ daily-review（html:236/253/268/282/297 内联）、aihot（:77）、ui.js（210）、研报库（729）；
  ❌ index 11 弹、diary2 3 弹
- **建议**：在 main.js 加一个全局 `keydown` 监听：Esc 时关闭当前 `.modal-overlay.show`（统一切到 show 类后可用单一选择器）。

### 3.3 确认框 7 套的处置
| 实现 | 处置 |
|---|---|
| ui.js `showConfirm`/`alertDialog`（Promise 式） | **基准**（main.js/table.js/diary2.js/storage.js 已在用） |
| `clearConfirmModal`（输入 CLEAR-XXX 强确认，main.js:514） | **保留**——销毁性操作的强确认是正确设计 |
| `tradeConfirmModal`（纪律勾选，calculator.js:503） | 保留业务语义，样式对齐 |
| `deleteConfirmModal`（table.js:49/54） | **与 showConfirm 重复，应替换** |
| `deleteDiaryModal`（diary2.js:823） | **应替换**（role="alertdialog" 但缺 aria-modal） |
| `drConfirm`/`drAlert`（回调式） | 可留作薄壳 |
| 研报库 modal-root | 独立应用合理；补 aria-modal 即可 |

### 3.4 原生 confirm()/alert() 共 8 处（样式突兀、不可防误触）
- backtest-main.js:439（清空交易）、:520（空记录完成回测）、:993（alert 统计）、:998（删记录）、:1015（清空全部）
- backtest-trade.js:307（清仓）、:317（撤销最后一笔）
- research-hub/web/app.js:1295（批量抓取确认）
- **建议**：backtest.html 引入 ui.js 后逐一替换为 `showConfirm`（async 化，注意原代码是同步 return 模式）。

### 3.5 焦点管理与滚动锁定
- **焦点陷阱全站只有 daily-review 有**（`setupDRFocusTrap` daily-review.js:2995：Tab 循环 + 归还焦点 +
  MutationObserver 自动挂载，约 60 行，完全自包含）→ **提升到 ui.js**，index/diary2/backtest 直接受益。
- ai hot/ui.js 聚焦但不归还焦点（aihot.js:85、ui.js:228）。
- **body 滚动锁定全站 0 处**——不算页间不一致，但长弹窗（equityModal、drRiskBacktestModal）打开时背景仍可滚。
  统一方案：ui.js 提供一个 `__setModalOpen(bool)` 切 body class。

---

## 四、控件：4 套下拉、键盘语义互相矛盾

| 套 | 实现 | 键盘行为 | 现役范围 |
|---|---|---|---|
| A | custom-select.js（:149-196） | ↑↓ **直接改值并触发 change**，Esc 关，点外关 | diary2 全页、daily-review(.dr-select)、编辑弹窗、equityModal |
| B | calculator.js 自造 initCustomSelect（:71 被 :221 同名覆盖） | ↑↓ 只移高亮，Enter 才提交 | 开仓计算器 |
| C | table.js table-select（:410-505） | 同 B（hover-highlight 模式） | 表格状态/按计划列（含状态着色） |
| D | 原生 select | 浏览器默认 | backtest、aihot、index:731 |

- **矛盾点**：同一操作（方向键）在套 A 里会改值，在套 B/C 里只是预选——用户在表格里按 ↓ 不改值，
  到计算器里按 ↓ 直接改了。且 4 套都没有 `role="listbox"`/aria。
- **建议**：以**套 A 为基准**（唯一保留原生 select 语义的）。套 B 删除两份 initCustomSelect 改调
  `upgradeSelectToCustom`（低成本）；套 C 保留状态着色、DOM 结构对齐套 A（中成本）；套 D 各页补载 custom-select.js。

---

## 五、按钮 / 表单 / 图标

1. **按钮体系基本统一**（main.css .btn 全变体，:2162-2304，圆角/变量同源——这是做得好的地方），
   但 3 处另起炉灶：backtest.html:317 内联覆盖 `.btn-sm`（4px/13px 覆盖 6px/11px）；
   daily-review.css 自造 .dr-btn-icon 等（623-668）；aihot.css 自造 .ah-inline-btn 等（49-92，圆角硬编码 6/7px）。
2. **语义色冲突**：入金确认用 `btn-danger`（index.html:486，与"确认删除"同色 :663）、出金用 `btn-success`（:515）。
   沿 A 股红涨绿跌可辩，但"添加"与"删除"同色有误触风险——建议改为中性 primary 或加图标区分。
3. **取消按钮分裂**：diary2 弹窗取消 = `btn-gray`（diary2.html:169/186），index = `btn-ghost`（:460）。
   建议"取消/关闭"统一 `btn-gray`。
4. **数字输入 step 不统一**：同为价格，编辑弹窗/计算器 `step="any"`（index.html:185/408）vs 表格内联
   `step="0.1"`（table.js:349，价格 0.0001 元的品种会被强制四舍五入）；同为股数，计算器 `step="100" min="0"`
   vs 编辑弹窗 `step="1"` 无 min。建议价格统一 any、股数统一 1+min=0、金额补 min=0。
5. **回车提交覆盖极低**：主页面 **0 个 `<form>`**；计算器、交易编辑弹窗、出入金弹窗均不支持 Enter 提交
   （仅 backtest-main.js:163、aihot.html:82 真 form、diary2.html:122 有）。建议至少给三个弹窗表单包 `<form>`。
6. **图标**：全站约 59 处 emoji 硬编码；删除图标三种写法（`🗑` / `🗑️` 带变体选择符 / `✕`）。
   统一为 🗑️，行内小删除统一 ✕。

---

## 六、视觉 / 主题 / 响应式

1. **暗色模式跟随风险（量化）**：
   - CSS 侧两极分化：diary2.css / aihot.css **零硬编码**（纯变量，最优）；
     main.css 528 处 var() vs 76 处 hex（大部分在 :root 定义内，真正散落约 15 处，多为刻意强调色，风险低）；
     **daily-review.css 294 处 var() vs 42 处散落 hex**（其中 `#b8860b` warning 金棕出现 6 处：395/442/443/488/1121/1242，
     `#d97706` 830 —— 暗色下对比度偏低）。
   - **JS 侧是主要风险**：daily-review.js **78 处硬编码色**（仅资金走势图 1128-1132 有 isDark 分支，其余不分主题）、
     backtest-chart.js 49 处（但已有 `BT_applyTheme` isDark 双套，:252-306；**MA1 线用 `#000000`（:82），暗色下黑线不可见，需核实**）、
     main.js 2 处；diary2.js / backtest-main.js 为 0（好）。
     对照组：charts.js 的 `getThemeColors()`（:6-33）是全站唯一完整的 isDark 色板实现，**应作为基准推广**。
   - 建议：JS 内色值统一走 charts.js 的 isDark palette 模式；daily-review 的金棕/坐标轴色提取进 CSS 变量。
2. **`prefers-reduced-motion` 只定义在 main.css:3471**，但因它是全局 `*` 选择器且其余三页都加载 main.css，
   **实际已全站生效**——此点无需补（纠正了初判）。
3. **触控目标偏小**：`.btn-sm` padding 6px/12px、字号 11px（main.css:2227）约 26px 高，`.header-tab` 约 26px，
   低于 44px 推荐值；aihot.css:80 已做 `@media (hover:none)` 兜底（全站唯一，好范例），其余 CSS 无。
   建议：移动端给 `.btn-sm/.header-tab` min-height:36px；不必强推全站 44px（桌面工具属性强）。
4. **响应式覆盖差异大**：@media 数量 main 21 / daily-review 8 / aihot 4 / diary2 3；
   移动端隐藏搜索框（main.css:424）与 aihot 隐藏同步控件（aihot.css:145）属**有意瘦身，合理**。
5. **空状态 7 种类名混用**：`.ah-empty`（aihot.css:123）、`.empty`（main.css:3396，无图标无动作）、
   `.dr-empty-guide`（daily-review，有图标+引导语）、`.bt-empty`（backtest.html:301）、
   `.search-result-empty`（main.css:412）、`.funds-history-empty`（main.js:339/428）、
   内联 style（diary2.js:533、table.js:276）。仅 daily-review/backtest 有引导动作。
   建议 main.css 定一个 `.empty-state`（可选图标+引导按钮槽）替换内联三处。
6. **加载态无统一组件**：全站 CSS 无 `.spinner`；事实标准是"按钮 disabled+文案变化"
   （backtest-main.js:280/321、aihot.js:918/681），daily-review 有独有 skeleton（:1954，仅资金卡用），
   index 的入金/出金按钮**无任何加载态**。建议抽 `.btn.is-loading`（disabled+spinner）进 main.css。
7. **错误反馈一闪而过，全站仅 1 个重试入口**：错误提示 3s 内消失、无持久错误条；唯一重试按钮在
   aihot 展开原文失败（aihot.js:692）。管理面板加载失败只写"加载失败"（main.js:1075/1159）、
   daily-review K 线失败写行内（:3182），都无重试。sync.js 的指数退避自动重试存在但用户不可见不可手动触发。
   建议：列表/图表类失败改持久错误块+重试按钮（可仿 aihot 模式）；后台轮询失败维持指示灯即可。
8. **动画过渡三套**：fadeIn+slideUp 0.3s（main.css:1640/1654）、modalIn 弹性 0.4s（:2662）、
   ui.js 自带 0.2s；**aihot 登录模态无任何过渡**（aihot.css:131-142）；toast 存活时长 2s/2.2s/3s/4.8s/5s 不一。
9. **头部功能割裂（导航在、功能不在）**：renderAppHeader 6 页参数齐全正确（aihot 由 aihot.js:944 调用），
   但 ① 全局搜索只实现了 index/daily-review/diary2 三页的数据源（`performGlobalSearch`），
   **backtest/research/aihot 的搜索框永远显示"未找到匹配项"**（header.js:134）；② research 页未加载 sync.js，
   `#syncIndicator`/同步按钮存在但**永远 idle 死点**；③ aihot 的退出登录用原生 `window.confirm`（aihot.js:99）。
   建议：backtest 补搜索数据源（搜历史回测顺理成章）；header.js 按 page 参数裁剪无用控件；
   aihot 补载 ui.js。

---

## 七、合理差异，不必统一

- `clearConfirmModal` 输入验证码强确认（销毁性操作，是正确设计）
- `tradeConfirmModal` 的纪律勾选业务流程
- research-hub（独立 Python 应用）自持 modal/toast 体系；aihot 阅读页 teal 强调色（品牌差异）
- 原生 `type="date"`（移动端系统滚轮体验更好）
- table-select 的状态着色（表格密度需要，只需结构对齐套 A）
- daily-review 的骨架屏 vs aihot 的 loading 文案（场景不同）
- **header-tab 六页六色**（main.css:235-241）：页面身份标识，刻意设计
- **charts.js / backtest-chart.js 的 isDark 双色板**：canvas 不能用 CSS 变量，这是正确实现方式
- **aihot 内容区持久状态（.ah-loading/.ah-error）优于 toast**：内容流场景正确
- **syncIndicator 指示灯**：同步心跳的唯一持久通道，与 toast 分工明确
- **aihot/daily-review 移动端隐藏搜索框与同步控件**（main.css:424、aihot.css:145）：有意瘦身
- **`prefers-reduced-motion` 仅 main.css 一处**：全局 `*` 选择器 + 三页共载 main.css，实际已全站生效

---

## 八、建议实施顺序

**第一批（真 bug，半天）**
1. sync.js:828 类名 `sync-status` → `sync-status-inline`（§一.1）
2. 删 diary2.js/daily-review.js 的两份重复 showSyncStatus，统一走 syncModule（§一.1b）
3. 保存复盘双提示去一（§一.1c）
4. 合并 main.css 重复的 `.modal-overlay` 与两套过渡动画（§一.2）
5. 删除年/月/日死代码 ~160 行（§一.3）
6. table.js/storage.js/calculator.js 的 9 处直写 #syncStatus 改走统一通道（§一.5）

**第二批（消灭原生弹窗，一天）**
7. backtest.html 引入 ui.js，替换 7 处原生 confirm/alert（§3.4）；BT_toast 换壳并统一时长 3s
8. index.html 11 弹统一 `classList('show')` + 全局 Esc 监听（§3.1/3.2）
9. aihot.js:99 的原生 confirm 换 showConfirm；backtest 补全局搜索数据源（§六.9）

**第三批（公共组件，1-2 天）**
10. `setupDRFocusTrap` 提升到 ui.js，全站弹窗接入；body 滚动锁定一并做（§3.5）
11. 三处删除确认迁 `showConfirm`（§3.3）；新增 `.input-error` 错误态（§二）
12. 下拉以套 A（custom-select.js）为基准：删套 B 重复实现、套 C 结构对齐（§四）

**第四批（打磨，按需）**
13. z-index token、按钮语义色（入金 btn-danger vs 删除同色）、step 统一、删除图标统一（§五）
14. JS 硬编码色值统一走 isDark 色板（§六.1，daily-review.js 78 处可分页推进；先核 backtest-chart MA1 的 #000000）
15. `.btn.is-loading` 统一加载态、`.empty-state` 统一空状态（§六.6/5）
16. 失败重试入口推广到列表/图表（§六.7）
