// tests/e2e/specs/12-backtest.spec.js
// 12 - 回测练习页（backtest.html）
//
// 本文件把近期修复过的缺陷固化为回归用例，避免同类问题再次出现：
//   1. 「上一根/下一根」按钮失效（窗口不跟随光标滚动）
//   2. 窗口贴最左时点「上一根」反而向前跳格
//   3. 均线默认值/条数/配色（曾从 4 条 5-10-20-60 改为 3 条 5-10-20）
//   4. 均线存档迁移（旧默认值→新默认；用户自定义保留；4 条截断为 3 条）
//   5. 切换主题后右栏 MA 数值丢失（renderMaList 重建 DOM 未回填）
//   6. 可见根数固定 90/120、缩放按钮移除、旧存档非法值吸附
//   7. 成交量纵轴显示数值（与价格轴标签挤在一起）
//   8. 右侧指标卡列数/高度/底部空白
//   9. 指数图标题位置、主图数据栏标的名称
//  10. 图表与两栏布局尺寸
//  11. 蜡烛过细（可见根数过大导致蜡烛体宽不足）
//  12. 资金曲线与 MACD 面板已移除
const { test, expect } = require('@playwright/test');
const BacktestPage = require('../pages/BacktestPage');
const { uniqueUsername } = require('../utils/helpers');

const PASSWORD = 'Test1234!';

/**
 * 注册并登录一个测试账号，把 token 注入 localStorage 后进入回测页。
 * 用 API 直接注册/登录，比走 UI 弹窗更快也更稳定。
 *
 * 注意：布局相关用例需要宽视口（>=1500px），否则会命中"窄屏上下堆叠"回退。
 * Playwright 全局默认视口是 1280x720，因此这里显式设置。
 */
async function enterBacktestWithAuth(page, opts = {}) {
  // 布局用例依赖宽屏；调用方可通过 opts.viewport 覆盖
  await page.setViewportSize(opts.viewport || { width: 1800, height: 1100 });

  const username = uniqueUsername('bt');
  const reg = await page.request.post('/api/register', { data: { username, password: PASSWORD } });
  // 用户名冲突时直接登录（uniqueUsername 已带时间戳，正常不会冲突）
  if (!reg.ok()) {
    await page.request.post('/api/login', { data: { username, password: PASSWORD } });
  }
  const loginRes = await page.request.post('/api/login', { data: { username, password: PASSWORD } });
  const body = await loginRes.json();
  const token = body.token;
  expect(token, '登录应返回 JWT token').toBeTruthy();

  const initScript = (args) => {
    try {
      localStorage.setItem('sync_token', args.t);
      localStorage.setItem('token', args.t);
      if (args.seed) localStorage.setItem('bt_state_form', JSON.stringify(args.seed));
    } catch (e) { /* ignore */ }
  };
  await page.addInitScript(initScript, { t: token, seed: opts.seed || null });

  const bt = new BacktestPage(page);
  await bt.mockMarketData(opts.mock || {});
  await bt.goto();
  return { bt, token };
}

test.describe('12 - 回测练习页', () => {

  // ============================================================
  // 1 & 2. 光标导航（曾出现「按钮失效」与「边界跳格」两个缺陷）
  // ============================================================
  test.describe('光标导航', () => {
    test('「上一根/下一根」应同时移动光标与滚动窗口（回归：按钮看似失效）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const before = { ...(await bt.cursorState()), win: await bt.windowState() };

      // 初始光标钉在窗口最右一根（闭区间下 cursor === win.end）
      expect(bt.windowContains(before.win, before.cursor), '光标初始应在窗口内').toBe(true);
      expect(before.cursor, '初始光标应在窗口最右一根').toBe(before.win.end);

      await bt.clickPrevBar();
      const afterPrev = { ...(await bt.cursorState()), win: await bt.windowState() };

      expect(afterPrev.cursor, '光标必须后退一格').toBe(before.cursor - 1);
      // 面板与指数图同步
      expect(afterPrev.date, '右栏日期应随之变化').not.toBe(before.date);
      expect(afterPrev.idxDate, '指数图右栏应同步').toBe(afterPrev.date);

      await bt.clickNextBar();
      const afterNext = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(afterNext.cursor, '再点「下一根」应回到原位').toBe(before.cursor);
      expect(afterNext.win, '光标回到最右一根，窗口应完全没动').toEqual(before.win);
    });

    // ★ 回归：光标必须能走到"可见的最右一根"并停在那里
    //   窗口不在数据末尾时（用户拖过 slider），ECharts 的 dataZoom end 是
    //   inclusive，早期把窗口右端当"不含"→ 光标一到最右就被误判越界、
    //   触发窗口滚动，导致"K 线一直在动但光标永远停在倒数第 2 根"。
    test('光标应能停在可见的最右一根（回归：永远到不了最右）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 把窗口挪到中段，使"最右侧不是最后一根 K 线"
      const win = await bt.setWindowStart(100);
      await page.waitForTimeout(400);

      // 光标放到窗口最右一根 → 窗口不应滚动
      const atRight = await bt.setCursorToEdge('right');
      const afterSet = await bt.windowState();
      expect(afterSet, '把光标放到最右一根不应改变窗口').toEqual(win);
      expect(atRight.cursor, '光标应停在最右一根').toBe(win.end);

      // 从窗口中间一路点「下一根」，必须能逐格走到最右一根
      await bt.setCursorToWindowCenter();
      const mid = (await bt.cursorState()).cursor;
      const steps = win.end - mid;
      for (let i = 0; i < steps; i++) {
        await bt.clickNextBar();
      }
      const reached = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(reached.cursor, '应逐格走到可见最右一根').toBe(win.end);
      expect(reached.win, '走到最右一根的过程中窗口不应滚动').toEqual(win);

      // 再多点一次才越界滚动，且光标仍贴在新窗口的最右一根
      await bt.clickNextBar();
      const over = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(over.cursor, '再点一次光标应前进一格').toBe(win.end + 1);
      expect(over.win.start, '此时窗口才右移一格').toBe(win.start + 1);
      expect(over.cursor, '光标应贴在新窗口的最右一根').toBe(over.win.end);
    });

    // ★ 新行为（替代旧的"窗口每点一次就平移"）：光标在窗口内部时窗口必须完全不动，
    //   只有光标顶到窗口边缘后继续点，窗口才跟着滚一格。
    test('光标在窗口内时点按，窗口应完全不动', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 把光标放到窗口正中
      const start = await bt.setCursorToWindowCenter();
      expect(start.win.start < start.cursor && start.cursor < start.win.end,
        '光标应落在窗口内部').toBe(true);

      await bt.clickPrevBar(2);
      const afterPrev = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(afterPrev.win, '窗口左/右边界都不应变化').toEqual(start.win);
      expect(afterPrev.cursor, '光标仍应逐格后退').toBe(start.cursor - 2);

      await bt.clickNextBar(2);
      const afterNext = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(afterNext.win, '窗口仍不应变化').toEqual(start.win);
      expect(afterNext.cursor, '光标应回到起始位置').toBe(start.cursor);
    });

    // ★ 光标到达窗口边缘后继续点按，窗口才滚动（两端都要覆盖）
    test('光标到达窗口边缘后继续点按，窗口应滚动一格', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 光标贴窗口左端（闭区间下即 start）→ 点「上一根」→ 窗口左移
      const l = await bt.setCursorToEdge('left');
      expect(l.cursor, '光标应贴在窗口左端').toBe(l.win.start);
      await bt.clickPrevBar();
      const afterLeft = await bt.windowState();
      expect(afterLeft.start, '窗口左端应左移一格').toBe(l.win.start - 1);
      expect(afterLeft.end, '窗口右端应同步左移').toBe(l.win.end - 1);

      // 光标贴窗口右端（闭区间下即 end）→ 点「下一根」→ 窗口右移
      const r = await bt.setCursorToEdge('right');
      expect(r.cursor, '光标应贴在窗口右端').toBe(r.win.end);
      await bt.clickNextBar();
      const afterRight = await bt.windowState();
      expect(afterRight.start, '窗口左端应右移一格').toBe(r.win.start + 1);
      expect(afterRight.end, '窗口右端应同步右移').toBe(r.win.end + 1);
    });

    test('连续点击 5 次应逐格移动（不跳格）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const start = await bt.cursorState();
      await bt.clickPrevBar(5);
      const after = await bt.cursorState();
      expect(after.cursor).toBe(start.cursor - 5);
      expect(after.ma5, 'MA 数值应随光标更新').not.toBe('--');

      await bt.clickNextBar(5);
      expect((await bt.cursorState()).cursor).toBe(start.cursor);
    });

    test('窗口已左对齐时点「上一根」应停在首根，而不是向前跳', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 把光标放到最早一根，此时窗口已左对齐
      await page.evaluate(() => window.BT_setCursor(0));
      await page.waitForTimeout(400);

      await bt.clickPrevBar();
      const st = await bt.cursorState();
      // 回归点：修复前会从 0 跳到 ~119（反而前进一大步）
      expect(st.cursor, '光标应停在 0，不应跳到窗口右边界附近').toBe(0);

      // 从 0 点「下一根」应只前进一格
      await bt.clickNextBar();
      expect((await bt.cursorState()).cursor).toBe(1);
    });

    test('键盘 ← / → 应等价于按钮', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      await page.evaluate(() => document.body.focus());

      const start = await bt.cursorState();
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(400);
      expect((await bt.cursorState()).cursor).toBe(start.cursor - 1);

      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      expect((await bt.cursorState()).cursor).toBe(start.cursor);
    });

    test('切到 120 档后导航仍可用', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      await page.selectOption('#btVisibleBars', '120');
      await page.waitForTimeout(800);

      const before = { ...(await bt.cursorState()), win: await bt.windowState() };
      // 光标在最右端（初始状态，闭区间下 = win.end），点「上一根」→ 光标动、窗口不动
      expect(before.cursor, '初始光标应在窗口最右一根').toBe(before.win.end);
      await bt.clickPrevBar();
      const after = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(after.cursor, '光标应后退一格').toBe(before.cursor - 1);
      expect(after.win, '光标离开最右端后窗口不应滚动').toEqual(before.win);

      // 继续点到左端，再继续点 → 窗口才开始左移
      //（用键盘批量推进比逐次点击快得多，语义完全等价）
      const stepsToLeft = after.cursor - before.win.start;   // 到左端还需几步
      for (let i = 0; i < stepsToLeft + 1; i++) {
        await page.keyboard.press('ArrowLeft');
      }
      await page.waitForTimeout(1200);
      const atLeft = await bt.windowState();
      expect(atLeft.start, '光标到达左端后窗口应左移').toBe(before.win.start - 1);
    });
  });

  // ============================================================
  // 3 & 4. 均线配置与存档迁移
  // ============================================================
  test.describe('均线', () => {
    test('默认应为 3 条均线 5/10/20，且不再有第 4 个输入框', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const ma = await bt.maState();

      expect(ma.periods).toEqual([5, 10, 20]);
      expect(ma.inputs.slice(0, 3)).toEqual(['5', '10', '20']);
      expect(ma.hasMa4Input, '第 4 个均线输入框应已移除').toBe(false);
    });

    test('配色应为 黑灰/深黄/蓝，且图上线色与色板一致', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const ma = await bt.maState();

      // 亮色主题配色
      expect(ma.palette).toEqual(['#374151', '#C99700', '#2563EB']);
      expect(ma.series.map((s) => s.name)).toEqual(['MA5', 'MA10', 'MA20']);
      expect(ma.series.map((s) => s.color)).toEqual(['#374151', '#C99700', '#2563EB']);
    });

    test('暗色主题下均线应切换为提亮配色', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      await bt.setTheme('dark');

      const ma = await bt.maState();
      expect(ma.palette).toEqual(['#CBD5E1', '#E0A800', '#5B8DEF']);
      expect(ma.series.map((s) => s.color)).toEqual(['#CBD5E1', '#E0A800', '#5B8DEF']);
    });

    test('旧存档的旧默认值应迁移为新默认 5/10/20', async ({ page }) => {
      // 上一版默认值 10/20/144/169
      const { bt } = await enterBacktestWithAuth(page, {
        seed: { symbol: 'sh600000', ma1: '10', ma2: '20', ma3: '144', ma4: '169' },
      });
      const ma = await bt.maState();
      expect(ma.inputs.slice(0, 3), '历史默认值应迁移为 5/10/20').toEqual(['5', '10', '20']);
      expect(ma.periods).toEqual([5, 10, 20]);
    });

    test('更早期的旧默认值 5/10/20/60 也应迁移', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, {
        seed: { symbol: 'sh600000', ma1: '5', ma2: '10', ma3: '20', ma4: '60' },
      });
      const ma = await bt.maState();
      expect(ma.inputs.slice(0, 3)).toEqual(['5', '10', '20']);
    });

    test('用户自定义均线应被保留', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, {
        seed: { symbol: 'sh600000', ma1: '7', ma2: '30', ma3: '50' },
      });
      const ma = await bt.maState();
      expect(ma.inputs.slice(0, 3), '用户自定义值不应被默认值覆盖').toEqual(['7', '30', '50']);
      expect(ma.periods).toEqual([7, 30, 50]);
    });

    test('旧的 4 条自定义均线应截断为前 3 条', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, {
        seed: { symbol: 'sh600000', ma1: '7', ma2: '30', ma3: '60', ma4: '120' },
      });
      const ma = await bt.maState();
      expect(ma.inputs.slice(0, 3)).toEqual(['7', '30', '60']);
      expect(ma.periods).toEqual([7, 30, 60]);
    });

    test('切换主题后右栏 MA 数值不应丢失（回归：显示成 "--"）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const before = await page.evaluate(() => ['curMaP_0', 'curMaP_1', 'curMaP_2']
        .map((id) => (document.getElementById(id) || {}).textContent));
      expect(before.every((v) => v && v !== '--'), '切换前应有 MA 数值').toBe(true);

      await bt.setTheme('dark');

      const after = await page.evaluate(() => ['curMaP_0', 'curMaP_1', 'curMaP_2']
        .map((id) => (document.getElementById(id) || {}).textContent));
      // 回归点：BT_applyTheme 调 BT_renderMaList 重建了 DOM，若忘记回填数值会全变 "--"
      expect(after, '切换主题后 MA 数值应被回填').toEqual(before);
    });
  });

  // ============================================================
  // 5. 显示根数固定档位、缩放已取消
  // ============================================================
  test.describe('显示根数与缩放', () => {
    test('默认 90 根，下拉只有 90/120 两档', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const vb = await bt.visibleBarsState();

      expect(vb.defaultBars).toBe(90);
      expect(vb.bars).toBe(90);
      expect(vb.selectValue).toBe('90');
      expect(vb.options, '只保留 90 / 120 两档').toEqual(['90', '120']);
    });

    test('缩放与比例锁定按钮应已移除', async ({ page }) => {
      await enterBacktestWithAuth(page);
      await expect(page.locator('#btnZoomIn')).toHaveCount(0);
      await expect(page.locator('#btnZoomOut')).toHaveCount(0);
      await expect(page.locator('#btnZoomLock')).toHaveCount(0);
    });

    test('切到 120 档后窗口应显示更多根数', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const z90 = await bt.mainZoom();
      await page.selectOption('#btVisibleBars', '120');
      await page.waitForTimeout(800);
      const z120 = await bt.mainZoom();

      expect((await bt.visibleBarsState()).bars).toBe(120);
      expect(z120.end - z120.start, '120 档窗口占比应更大').toBeGreaterThan(z90.end - z90.start);
    });

    test('旧存档里的非法根数应被吸附为 90', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, {
        seed: { symbol: 'sh600000', visibleBars: '350', ma1: '5', ma2: '10', ma3: '20' },
      });
      const vb = await bt.visibleBarsState();
      expect(vb.bars, '350 不在白名单内，应回落默认').toBe(90);
      expect(vb.selectValue).toBe('90');
    });

    test('窗口应钉在最近的数据（右端对齐）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, { mock: { count: 250 } });
      await bt.loadData();
      const r = await page.evaluate(() => {
        const dz = window.BT_chart.getOption().dataZoom[1];
        const total = window.BT_klineData.dates.length;
        return {
          total,
          startIdx: Math.floor(dz.start / 100 * (total - 1)),
          endIdx: Math.floor(dz.end / 100 * (total - 1)),
          bars: window.BT_visibleBars,
        };
      });
      expect(r.endIdx, '窗口右端应贴近最后一根').toBeGreaterThanOrEqual(r.total - 2);
      expect(r.bars).toBe(90);
    });

    test('蜡烛不应过细（90 根下蜡烛体宽 ≥ 3px）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const r = await page.evaluate(() => {
        const opt = window.BT_chart.getOption();
        const g = opt.grid[0];
        const W = window.BT_chart.getWidth();
        const l = typeof g.left === 'number' ? g.left : parseFloat(g.left);
        const rr = typeof g.right === 'number' ? g.right : parseFloat(g.right);
        const plotW = W - l - rr;
        return { pxPerBar: plotW / window.BT_visibleBars, plotW };
      });
      // 90 根 / 约 1100px 绘图区 → 每根 ~12px，蜡烛体约 7px
      expect(r.pxPerBar * 0.6, '蜡烛体宽应清晰可辨').toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // 6. 成交量轴、已移除的面板
  // ============================================================
  test.describe('图表坐标轴与面板', () => {
    test('成交量纵轴不应显示数值，价格轴仍显示', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const s = await bt.chartSummary();

      expect(s.mainVolAxisShow, '主图成交量轴数值应隐藏').toBe(false);
      expect(s.idxVolAxisShow, '指数图成交量轴数值应隐藏').toBe(false);
      expect(s.mainPriceAxisShow, '价格轴数值应保留').toBe(true);
    });

    test('资金曲线与 MACD 面板应已移除', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const s = await bt.chartSummary();

      expect(s.mainSeries, '主图 series 不含资金与 MACD').not.toContain('资金');
      ['DIF', 'DEA', 'MACD'].forEach((n) => expect(s.mainSeries).not.toContain(n));
      if (s.idxSeries) {
        s.idxSeries.forEach((n) => {
          expect(['资金', 'DIF', 'DEA', 'MACD']).not.toContain(n);
        });
      }
      // 对应开关也不应存在
      await expect(page.locator('#showEquity')).toHaveCount(0);
      await expect(page.locator('#showMACD')).toHaveCount(0);
    });
  });

  // ============================================================
  // 7. 布局：图表尺寸、右侧指标卡、数据栏标题
  // ============================================================
  test.describe('布局', () => {
    test('两张图应等高，且 K线 300 / 成交量 60', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const s = await bt.chartSummary();

      const mainH = await page.evaluate(() => Math.round(document.getElementById('btChart').getBoundingClientRect().height));
      const idxH = await page.evaluate(() => Math.round(document.getElementById('btChartIndex').getBoundingClientRect().height));

      // ★ 高度不再写死 432/300/60：改为按视口剩余空间自适应
      //   （写死会让交易栏的「上一根/下一根」被挤出首屏，用户点不到）。
      //   这里断言"两图等高 + 高度在合理区间 + grid 按容器高度等比分配"。
      expect(mainH, '两图应等高').toBe(idxH);
      expect(mainH, '图表高度应在 [240, 432] 内').toBeGreaterThanOrEqual(240);
      expect(mainH, '图表高度不应超过上限').toBeLessThanOrEqual(432);

      // grid[0]（K线）+ grid[1]（成交量）应铺满容器扣掉上下留白后的可用高度
      // （底部留白 58px = 日期标签 ~20 + slider 24 + 间隙，日期被 slider 遮挡的回归预留）
      const klineH = s.mainGrid[0].height;
      const volH = s.mainGrid[1].height;
      expect(klineH, 'K线区应占大部分高度').toBeGreaterThan(volH * 2);
      expect(klineH + volH, 'K线 + 成交量 应接近容器高度').toBeLessThanOrEqual(mainH);
      expect(klineH + volH, '不应在容器里留大片空白（顶部18+底部58=76px 留白）').toBeGreaterThan(mainH - 90);
    });

    test('主图日期标签不应被 dataZoom slider 遮挡', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      // 成交量 grid 底边 + 日期标签（margin6 + 字高11 ≈ 17px）应 ≤ slider 顶边
      const r = await page.evaluate(() => {
        const opt = BT_chart.getOption();
        const g1 = opt.grid[1];
        const dz = opt.dataZoom[1];
        const H = BT_chart.getHeight();
        const volBottom = g1.top + g1.height;
        const sliderTop = H - dz.bottom - dz.height;
        return { volBottom, sliderTop, gap: sliderTop - volBottom };
      });
      expect(r.gap, '日期标签空间（slider 顶 - 成交量底）应 ≥ 20px（回归：日期被滑块盖住）').toBeGreaterThanOrEqual(20);
    });

    test('K 线数据应完好（candlestick 四元数组，未被其它 series 覆盖）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const s = await bt.chartSummary();
      expect(s.mainKlineOk, '主图 K 线数据应为 [open,close,low,high]').toBe(true);
      expect(s.idxKlineOk, '指数图 K 线数据应完好').toBe(true);
    });

    test('右侧指标卡应为单列、9 张、且撑满高度不留大片空白', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const st = await bt.statsLayout();

      expect(st.inRightColumn, '指标卡应在右侧栏内').toBe(true);
      expect(st.columns, '应为单列').toBe(1);
      expect(st.cardCount).toBe(9);
      expect(st.bottomGap, '底部空白应很小').toBeLessThan(20);
    });

    test('右侧栏收窄、K 线图相应变宽，两栏等高', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();
      const st = await bt.statsLayout();

      expect(st.rightWidth, '右栏应已收窄').toBeLessThanOrEqual(260);
      expect(st.leftWidth, '左列应占据大部分宽度').toBeGreaterThan(st.rightWidth * 3);
      expect(st.topAligned, '两栏顶部对齐').toBe(true);
      expect(st.bottomAligned, '两栏底部等高').toBe(true);
    });

    // 回归：交易栏（「上一根/下一根」按钮）必须在首屏内可见
    //（修复前两张图各写死 432px，左列 979px，页面总高 1474px，
    //  按钮被推到 y=1126；窗口高度 < 1160 时用户点了"没反应"，
    //  实际是点到首屏外的滚动条/空白处）
    test('「上一根/下一根」按钮应在首屏内可见（无需滚动）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, { viewport: { width: 1800, height: 1000 } });
      await bt.loadData();
      await page.waitForTimeout(400);

      const r = await page.evaluate(() => {
        const b = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        };
        return {
          vh: window.innerHeight,
          next: b('btnNextBar'),
          prev: b('btnPrevBar'),
          buy: b('btnBuy'),
        };
      });

      expect(r.next.bottom, '「下一根」按钮应在首屏内').toBeLessThanOrEqual(r.vh);
      expect(r.prev.bottom, '「上一根」按钮应在首屏内').toBeLessThanOrEqual(r.vh);
      expect(r.buy.bottom, '「买入」按钮应在首屏内').toBeLessThanOrEqual(r.vh);
    });

    test('交易底栏应为单行，仓位与按钮靠右且顺序正确', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const tb = await bt.tradebarLayout();

      expect(tb.singleRow, '底栏应为单行').toBe(true);
      expect(tb.posBeforeNav, '仓位应在按钮左侧').toBe(true);
      expect(tb.gapRight, '买卖按钮应贴右').toBeLessThan(30);
      expect(tb.tipRight).toBeLessThan(tb.posLeft);
    });

    // 按用户要求调换：「上一根」在左、「下一根」在右
    test('导航按钮顺序应为「上一根」在前、「下一根」在后', async ({ page }) => {
      await enterBacktestWithAuth(page);
      const ids = await page.evaluate(() => {
        const nav = document.querySelector('.bt-btn-group-nav');
        return Array.from(nav.querySelectorAll('button')).map((b) => b.id);
      });
      expect(ids, '「上一根」应在「下一根」左侧').toEqual(['btnPrevBar', 'btnNextBar']);
    });

    test('窄屏应回退为上下堆叠且图表不溢出', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, { viewport: { width: 1300, height: 1000 } });
      await bt.loadData();

      const r = await page.evaluate(() => {
        const layout = document.querySelector('.bt-main-layout');
        const chart = document.getElementById('btChart').getBoundingClientRect();
        const pg = document.querySelector('.bt-page').getBoundingClientRect();
        const cards = Array.from(document.querySelectorAll('.bt-stats-side .bt-stat'));
        return {
          dir: getComputedStyle(layout).flexDirection,
          chartW: Math.round(chart.width),
          pageW: Math.round(pg.width),
          cols: getComputedStyle(document.getElementById('btStats')).gridTemplateColumns.trim().split(/\s+/).length,
          cardH: cards.length ? Math.round(cards[0].getBoundingClientRect().height) : 0,
        };
      });
      expect(r.dir).toBe('column');
      expect(r.chartW).toBeLessThanOrEqual(r.pageW);
      expect(r.cols, '堆叠时指标卡应恢复多列').toBeGreaterThan(1);
      expect(r.cardH, '堆叠时卡片不应被强行拉高').toBeLessThan(90);
    });

    test('指数图标题应在右侧数据栏内，主图数据栏应显示标的名称', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page, {
        mock: { symbolName: '浦发银行', indexName: '上证指数' },
      });
      await bt.loadData();
      await page.waitForTimeout(600);

      const r = await page.evaluate(() => {
        const title = document.getElementById('indexTitle');
        const panel = document.getElementById('idxPanel');
        const nameEl = document.getElementById('curSymbolName');
        const mainPanel = document.getElementById('curPanel');
        return {
          titleInPanel: !!(panel && title && panel.contains(title)),
          titleText: title ? title.textContent : '',
          nameInMainPanel: !!(mainPanel && nameEl && mainPanel.contains(nameEl)),
          nameText: nameEl ? nameEl.textContent : '',
          headBarGone: !document.querySelector('.bt-index-head'),
        };
      });

      expect(r.titleInPanel, '指数标题应在数据栏内').toBe(true);
      expect(r.headBarGone, '原标题横栏应已移除').toBe(true);
      expect(r.titleText).toContain('上证指数');
      expect(r.nameInMainPanel).toBe(true);
      expect(r.nameText).toContain('浦发银行');
      expect(r.nameText).toContain('sh600000');
    });
  });

  // ============================================================
  // 8. 十字光标（回归：hover 时不显示）
  // ============================================================
  test.describe('十字光标', () => {
    // ★ 新交互：鼠标 hover 到哪根光标就在哪根；不再 hover 任何 K 线时，
    //   2 秒后自动跳到当前窗口最右一根（回测最常看最新一根，省一次手动点击）。
    test('hover 离开 2 秒后光标应自动跳到窗口最右一根', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 把窗口挪到中段，使"最右一根"明显区别于光标当前所在
      const win = await bt.setWindowStart(100);
      await page.waitForTimeout(400);

      const box = await page.locator('#btChart').boundingBox();
      // hover 到窗口左侧，光标落在最右一根之外的某根
      await page.mouse.move(box.x + box.width * 0.2, box.y + 130);
      await page.waitForTimeout(400);
      const hovered = await bt.cursorState();
      expect(hovered.cursor, '光标应跟随鼠标落在窗口内').toBeGreaterThanOrEqual(win.start);
      expect(hovered.cursor, '光标此时不应已在最右一根').toBeLessThan(win.end);

      // 鼠标移出图表 → 1 秒时还不应跳（确认有 2 秒延迟）
      await page.mouse.move(box.x - 400, box.y - 400);
      await page.waitForTimeout(1000);
      expect((await bt.cursorState()).cursor, '1 秒时还不应归位').toBe(hovered.cursor);

      // 再等到 2 秒之后 → 光标跳到窗口最右一根
      await page.waitForTimeout(1500);
      const after = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(after.cursor, '2 秒后应归位到窗口最右一根').toBe(after.win.end);
      expect(after.win, '归位不应改变窗口').toEqual(win);
      expect(after.date, '右栏日期应同步到最右一根').toBeTruthy();
    });

    // 归位计时必须可被"再次 hover"取消，否则用户看着某根时会被强行拉走
    test('归位计时应被再次 hover 取消', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      await bt.setWindowStart(100);
      await page.waitForTimeout(400);
      const box = await page.locator('#btChart').boundingBox();

      // hover → 离开（起计时）
      await page.mouse.move(box.x + box.width * 0.3, box.y + 130);
      await page.waitForTimeout(350);
      await page.mouse.move(box.x - 400, box.y - 400);
      await page.waitForTimeout(1200);           // 1.2s < 2s

      // 再次 hover → 应取消计时
      await page.mouse.move(box.x + box.width * 0.35, box.y + 130);
      await page.waitForTimeout(400);
      const rehover = await bt.cursorState();

      // 离开 1.2s（若计时没被取消此刻就会跳）
      await page.mouse.move(box.x - 400, box.y - 400);
      await page.waitForTimeout(1200);
      expect((await bt.cursorState()).cursor, '计时应已被取消，光标保持不动').toBe(rehover.cursor);

      // 再等满 2 秒 → 最终仍会归位
      await page.waitForTimeout(1400);
      const fin = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(fin.cursor, '最终仍应归位到最右一根').toBe(fin.win.end);
    });

    // 鼠标停在"没有 K 线"的区域（y 轴留白 / 底部滑块）也算离开
    test('鼠标移到无 K 线区域也应触发归位', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      await bt.setWindowStart(100);
      await page.waitForTimeout(400);
      const box = await page.locator('#btChart').boundingBox();

      await page.mouse.move(box.x + box.width * 0.5, box.y + 130);
      await page.waitForTimeout(400);
      const inPlot = await bt.cursorState();

      // 移到 y 轴刻度留白（绘图区之外）
      await page.mouse.move(box.x + 20, box.y + 130);
      await page.waitForTimeout(2600);
      const after = { ...(await bt.cursorState()), win: await bt.windowState() };
      expect(after.cursor, '停在无 K 线区域 2 秒后应归位').toBe(after.win.end);
      expect(after.cursor, '确实发生了跳转').not.toBe(inPlot.cursor);
    });

    test('两图 hover 时应显示十字光标，且随鼠标移动', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 扫描覆盖层像素找竖线 x / 横线 y（虚线有间隙，按"命中最多"统计）
      const layerInfo = (domId) => page.evaluate((id) => {
        const l = document.querySelector('#' + id + ' .bt-crosshair-layer');
        if (!l) return { exists: false };
        const c = l.getContext('2d');
        const w = l.width, h = l.height;
        const d = c.getImageData(0, 0, w, h).data;
        const colHits = new Array(w).fill(0);
        const rowHits = new Array(h).fill(0);
        let drawn = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 20) { colHits[x]++; rowHits[y]++; drawn++; }
          }
        }
        let vx = -1, maxC = 0;
        for (let x = 0; x < w; x++) if (colHits[x] > maxC) { maxC = colHits[x]; vx = x; }
        let hy = -1, maxR = 0;
        for (let y = 0; y < h; y++) if (rowHits[y] > maxR) { maxR = rowHits[y]; hy = y; }
        return { exists: true, drawn, vx: maxC >= 5 ? vx : -1, hy: maxR >= 5 ? hy : -1 };
      }, domId);

      const box = await page.locator('#btChart').boundingBox();

      // 位置 A（左侧）
      await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.30);
      await page.waitForTimeout(500);
      const A = await layerInfo('btChart');

      // 位置 B（明显更右）
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.30);
      await page.waitForTimeout(500);
      const B = await layerInfo('btChart');

      expect(A.exists, '应存在自绘十字光标覆盖层').toBe(true);
      expect(A.drawn, 'hover 时应绘制十字光标').toBeGreaterThan(200);
      expect(A.vx, '应能定位到竖线').toBeGreaterThan(0);
      expect(A.hy, '应能定位到横线').toBeGreaterThan(0);
      expect(B.vx, '竖线应随鼠标右移').toBeGreaterThan(A.vx + 100);

      // 移出图表 → 光标**常驻不消失**（鼠标离开后仍停在最后一根所在位置）
      await page.mouse.move(box.x - 200, box.y - 200);
      await page.waitForTimeout(500);
      expect((await layerInfo('btChart')).drawn, '移出后光标应保留').toBeGreaterThan(200);

      // 指数图同样生效
      const idxBox = await page.locator('#btChartIndex').boundingBox();
      await page.mouse.move(idxBox.x + idxBox.width * 0.4, idxBox.y + idxBox.height * 0.3);
      await page.waitForTimeout(500);
      expect((await layerInfo('btChartIndex')).drawn, '指数图 hover 也应显示').toBeGreaterThan(200);
    });

    // 回归：光标常驻 —— 之前 globalout 会清掉覆盖层，
    //       没鼠标 hover 时图上什么都没有，用户看不到当前停在哪根
    test('未 hover 时十字光标也应始终显示', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const drawn = (domId) => page.evaluate((id) => {
        const l = document.querySelector('#' + id + ' .bt-crosshair-layer');
        if (!l) return -1;
        const d = l.getContext('2d').getImageData(0, 0, l.width, l.height).data;
        let n = 0;
        for (let p = 3; p < d.length; p += 4) if (d[p] > 0) n++;
        return n;
      }, domId);

      // 页面刚加载完、鼠标从未进入过图表
      expect((await drawn('btChart')), '主图光标应常驻').toBeGreaterThan(200);
      expect((await drawn('btChartIndex')), '指数图光标应常驻').toBeGreaterThan(200);

      // 点「上一根」后光标应跟着移动到新位置（仍可见）
      await bt.clickPrevBar();
      expect((await drawn('btChart')), '移动光标后仍应可见').toBeGreaterThan(200);

      // hover 一次再移出，光标不应消失
      const box = await page.locator('#btChart').boundingBox();
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
      await page.waitForTimeout(400);
      await page.mouse.move(box.x - 300, box.y - 300);
      await page.waitForTimeout(600);
      expect((await drawn('btChart')), 'hover 后移出，光标仍应保留').toBeGreaterThan(200);
    });

    // 回归：十字光标显示后，右侧 K线 数据栏也必须同步刷新
    //（同根因 —— 原光标链路同样拿不到索引，会导致右栏一直是 "--"）
    test('hover 时右侧 K线 数据栏应同步更新', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      const read = () => page.evaluate(() => {
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
        return {
          idx: window.BT_currentIdx,
          date: t('curDate'), open: t('curOpen'), close: t('curClose'),
          high: t('curHigh'), low: t('curLow'), vol: t('curVol'), ma5: t('curMaP_0'),
          idxDate: t('idxDate'), idxMa5: t('idxMaP_0')
        };
      });

      const box = await page.locator('#btChart').boundingBox();

      await page.mouse.move(box.x + box.width * 0.30, box.y + box.height * 0.30);
      await page.waitForTimeout(600);
      const A = await read();

      await page.mouse.move(box.x + box.width * 0.70, box.y + box.height * 0.30);
      await page.waitForTimeout(600);
      const B = await read();

      expect(A.date, '右栏日期应已填充（非 --）').toBeTruthy();
      expect(A.date).not.toBe('--');
      expect([A.open, A.close, A.high, A.low].every((v) => v && v !== '--'),
        '开/收/高/低应全部填充').toBe(true);
      expect(A.vol && A.vol !== '--', '成交量应填充').toBe(true);
      expect(A.ma5 && A.ma5 !== '--', 'MA 数值应填充').toBe(true);
      expect(B.date, '移动鼠标后右栏应切换到另一根 K线').not.toBe(A.date);
      expect(B.idxDate, '指数图右栏也应同步').toBe(B.date);
    });

    // 回归：两图 hover 必须互相驱动（此前只有鼠标所在那张图有光标，
    //      且指数图 hover 时两侧数据栏完全不刷新，光标与数据都对不上）
    test('指数图/主图 hover 应双向同步（十字光标 + 两侧数据栏）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 覆盖层像素扫描：虚线有间隙，按 alpha>0 的像素总数判断是否绘制
      const drawn = (domId) => page.evaluate((id) => {
        const l = document.querySelector('#' + id + ' .bt-crosshair-layer');
        if (!l) return -1;
        const c = l.getContext('2d');
        const d = c.getImageData(0, 0, l.width, l.height).data;
        let n = 0;
        for (let p = 3; p < d.length; p += 4) if (d[p] > 0) n++;
        return n;
      }, domId);

      const panel = () => page.evaluate(() => {
        const t = (id) => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
        return {
          idx: window.BT_currentIdx,
          curDate: t('curDate'), idxDate: t('idxDate'),
          curClose: t('curClose'), idxClose: t('idxClose')
        };
      });

      const mainBox = await page.locator('#btChart').boundingBox();
      const idxBox = await page.locator('#btChartIndex').boundingBox();
      const CROSS_PX = 200;   // 只有十字线被绘制时才会超过这个量级

      // ---- 方向一：hover 主图 → 指数图光标 + 指数右栏跟随 ----
      await page.mouse.move(mainBox.x + mainBox.width * 0.30, mainBox.y + mainBox.height * 0.30);
      await page.waitForTimeout(600);
      const m1 = await panel();
      expect((await drawn('btChart')), '主图 hover 时主图应有光标').toBeGreaterThan(CROSS_PX);
      expect((await drawn('btChartIndex')), 'hover 主图时指数图也应画出光标').toBeGreaterThan(CROSS_PX);
      expect(m1.curDate && m1.curDate !== '--', '主图右栏日期应填充').toBe(true);
      expect(m1.idxDate, 'hover 主图时指数右栏也应同步到这个日期').toBe(m1.curDate);

      await page.mouse.move(mainBox.x + mainBox.width * 0.70, mainBox.y + mainBox.height * 0.30);
      await page.waitForTimeout(600);
      const m2 = await panel();
      expect(m2.curDate, '主图右栏应随鼠标切换 K线').not.toBe(m1.curDate);
      expect(m2.idxDate, '指数右栏应跟着切到同一根').toBe(m2.curDate);

      // ---- 方向二：hover 指数图 → 主图光标 + 两侧数据栏跟随 ----
      await page.mouse.move(idxBox.x + idxBox.width * 0.20, idxBox.y + idxBox.height * 0.30);
      await page.waitForTimeout(600);
      const i1 = await panel();
      expect((await drawn('btChartIndex')), '指数图 hover 时指数图应有光标').toBeGreaterThan(CROSS_PX);
      expect((await drawn('btChart')), 'hover 指数图时主图也应画出光标').toBeGreaterThan(CROSS_PX);
      expect(i1.idxDate && i1.idxDate !== '--', '指数右栏日期应填充').toBe(true);
      expect(i1.curDate, 'hover 指数图时主图右栏应同步到同一根').toBe(i1.idxDate);

      await page.mouse.move(idxBox.x + idxBox.width * 0.60, idxBox.y + idxBox.height * 0.30);
      await page.waitForTimeout(600);
      const i2 = await panel();
      expect(i2.idxDate, '指数右栏应随鼠标切换 K线').not.toBe(i1.idxDate);
      expect(i2.curDate, '主图右栏应跟着切到同一根').toBe(i2.idxDate);
    });

    // 回归：清仓后立刻连点「下一根」不应丢点击
    //（ui.js 的 showConfirm 淡出动画期间曾有 200ms 仍拦截整屏点击，
    //  导致快速连点被静默吞掉，表现为"下一根只走了一根/步数对不上"）
    // ★ 注：清仓的二次确认框已按用户要求去掉，这里直接点击即生效。
    test('清仓后立即连点「下一根」每次都应生效', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      await page.evaluate(() => {
        BT_setCursor(100);
        BT_doBuy(BT_currentDate, BT_currentClose, 1000);
      });
      await page.waitForTimeout(400);

      // 点清仓（无二次确认，点击即成交）
      await page.click('.bt-tradebar #btnClearPos');
      await page.waitForTimeout(120);

      // 不等待，立刻连点 4 次（此前会丢失点击）
      for (let i = 0; i < 4; i++) {
        await page.click('.bt-tradebar #btnNextBar', { force: true, noWaitAfter: true });
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(900);

      const pos = await page.evaluate(() => ({
        vol: BT_position.volume,
        idx: BT_currentIdx
      }));
      expect(pos.vol, '清仓后持仓应为 0').toBe(0);
      expect(pos.idx, '连点 4 次应精确前进 4 根（104）').toBe(104);
    });

    // 清仓已去掉二次确认：点一下就应该直接成交
    test('「清仓」应无二次确认，点击即成交', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      await page.evaluate(() => {
        BT_setCursor(100);
        BT_doBuy(BT_currentDate, BT_currentClose, 1000);
      });
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => BT_position.volume), '买入后应有持仓').toBeGreaterThan(0);

      await page.click('.bt-tradebar #btnClearPos');
      await page.waitForTimeout(300);

      // 不应出现任何确认弹窗
      await expect(page.locator('.ui-modal-overlay'), '清仓不应弹确认框').toHaveCount(0);
      expect(await page.evaluate(() => BT_position.volume), '点击后应已清仓').toBe(0);
    });

    // 回归：光标只应出现在实际有 K 线的绘图区内
    //（此前 convertFromPixel 会把绘图区外的坐标也换算成索引，
    //  导致 y 轴左侧 / 右侧留白 / 底部滑块上都会"吸附"到某根 K 线并画光标）
    //
    // ★ 注意：光标现在是"常驻"的（鼠标移出不消失），
    //   所以断言对象从"像素数量"改成"竖线所在 x 是否仍在绘图区内"。
    test('光标不应出现在绘图区之外（y轴/留白/滑块）', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      await bt.loadData();

      // 扫描覆盖层找竖线的 x（虚线有间隙，按"命中最多"统计）
      const vlineX = () => page.evaluate(() => {
        const l = document.querySelector('#btChart .bt-crosshair-layer');
        if (!l) return { px: -1, drawn: 0 };
        const c = l.getContext('2d');
        const w = l.width, h = l.height;
        const d = c.getImageData(0, 0, w, h).data;
        const colHits = new Array(w).fill(0);
        let drawn = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 20) { colHits[x]++; drawn++; }
          }
        }
        let px = -1, maxC = 0;
        for (let x = 0; x < w; x++) if (colHits[x] > maxC) { maxC = colHits[x]; px = x; }
        return { px: maxC >= 5 ? px : -1, drawn };
      });
      const geom = await page.evaluate(() => {
        const o = BT_chart.getOption();
        const W = BT_chart.getWidth(), H = BT_chart.getHeight();
        const g = o.grid[0];
        return { left: g.left, right: W - g.right, W, H };
      });
      const box = await page.locator('#btChart').boundingBox();
      const midY = Math.round(geom.H * 0.3);

      // 绘图区内 → 光标应显示，且竖线落在绘图区内
      await page.mouse.move(box.x + 500, box.y + midY);
      await page.waitForTimeout(450);
      const inside = await vlineX();
      expect(inside.drawn, '绘图区内应显示光标').toBeGreaterThan(200);
      expect(inside.px, '竖线 x 应可定位').toBeGreaterThan(0);
      expect(inside.px, '竖线应在绘图区左边界右侧').toBeGreaterThan(geom.left - 2);
      expect(inside.px, '竖线应在绘图区右边界左侧').toBeLessThan(geom.right + 2);

      // 鼠标移到绘图区外：光标不消失（常驻），但**不能**跟着跑到绘图区外
      const outsidePoints = [
        ['y 轴左侧', box.x + Math.max(2, geom.left - 30), box.y + midY],
        ['右侧留白', box.x + Math.min(geom.W - 2, geom.right + 20), box.y + midY],
        ['底部滑块', box.x + Math.round(geom.W / 2), box.y + geom.H - 10],
      ];
      for (const [label, x, y] of outsidePoints) {
        await page.mouse.move(x, y);
        await page.waitForTimeout(450);
        const s = await vlineX();
        expect(s.drawn, `${label}：光标应常驻保留`).toBeGreaterThan(200);
        expect(s.px, `${label}：竖线仍应留在绘图区内`).toBeGreaterThan(geom.left - 2);
        expect(s.px, `${label}：竖线仍应留在绘图区内`).toBeLessThan(geom.right + 2);
      }
    });
  });

  // ============================================================
  // 10. K 线加载：进度反馈 + 长历史覆盖 + 接口瘦身
  // ============================================================
  test.describe('K 线加载', () => {
    // 回归：加载时必须有进度反馈（上游抖动时不能只让按钮变灰）
    test('加载中应显示进度遮罩，完成后自动收起', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      // 人为拖慢 K 线请求，保证能观察到遮罩
      await page.route('**/api/market/kline-stock/**', async (route) => {
        await new Promise((r) => setTimeout(r, 1200));
        return route.continue();
      });

      const maskState = () => page.evaluate(() => {
        const m = document.getElementById('btLoadingMask');
        return {
          show: !!(m && m.classList.contains('show')),
          text: (document.getElementById('btLoadingText') || {}).textContent || '',
          btn: (document.getElementById('btnLoad') || {}).textContent || '',
        };
      });

      await page.selectOption('#btYears', '1');
      page.click('#btnLoad').catch(() => {});
      await page.waitForTimeout(600);

      const during = await maskState();
      expect(during.show, '加载中应显示遮罩').toBe(true);
      expect(during.text, '遮罩应说明正在加载什么').toContain('加载');
      expect(during.btn, '按钮应进入加载态').toContain('加载中');

      // 等遮罩收起
      await page.waitForFunction(
        () => !document.getElementById('btLoadingMask').classList.contains('show'),
        null, { timeout: 20000 });
      const after = await maskState();
      expect(after.show, '完成后遮罩应收起').toBe(false);
      // 遮罩不能残留挡住交互
      const pe = await page.evaluate(() =>
        getComputedStyle(document.getElementById('btLoadingMask')).pointerEvents);
      expect(pe, '遮罩不应拦截点击').toBe('none');
    });

    // 回归：选 10 年必须真的拿到 10 年（此前静默回退腾讯只有 641 根）
    //
    // ⚠ 这条用例刻意**不注入 mock**：mock 数据固定 250 根，正好会掩盖
    //   "真实后端能不能拉满 10 年"这个问题。代价是它依赖真实上游，
    //   在并行 worker 抢同一数据源时可能变慢 —— 因此给了较宽的超时，
    //   并在上游不可用时跳过而不是误报失败。
    test('选 10 年应真的拿到约 2500 根（回归：静默回退只有 641 根）', async ({ page }) => {
      test.setTimeout(90000);
      const { token } = await enterBacktestWithAuth(page);

      let res;
      try {
        res = await page.request.get('/api/market/kline-stock/sh600000?count=2500', {
          headers: { Authorization: 'Bearer ' + token },
          timeout: 60000,
        });
      } catch (e) {
        test.skip(true, '上游数据源不可用（并行 worker 抢占/网络抖动），跳过真实长历史校验');
        return;
      }
      expect(res.ok(), '真实 10 年接口应可访问').toBeTruthy();
      const j = await res.json();
      const n = (j.dates || []).length;

      // 250 交易日/年 × 10 年 ≈ 2500；留余量按 2000 断言
      expect(n, '10 年应有约 2500 根，不应被截断到 641').toBeGreaterThan(2000);
      const y0 = Number(String(j.dates[0]).slice(0, 4));
      const y1 = Number(String(j.dates[n - 1]).slice(0, 4));
      expect(y1 - y0, '日期跨度应接近 10 年').toBeGreaterThanOrEqual(9);
    });

    // 回归：个股 K 线接口不应再下发前端用不到的重字段
    test('个股 K 线接口不应下发 ma/macd/amounts（回归：曾占 74% 体积）', async ({ page }) => {
      const { token } = await enterBacktestWithAuth(page);
      const res = await page.request.get('/api/market/kline-stock/sh600000?count=250', {
        headers: { Authorization: 'Bearer ' + token },
      });
      expect(res.ok()).toBeTruthy();
      const j = await res.json();

      // 前端确实需要的字段
      ['dates', 'ohlc', 'volumes'].forEach((k) => {
        expect(j[k], `应保留 ${k}`).toBeTruthy();
      });
      // 前端自行计算 / 已移除面板 → 不该再传
      ['ma5', 'ma10', 'ma20', 'macd', 'amounts'].forEach((k) => {
        expect(j[k], `不应再下发 ${k}（前端未使用）`).toBeUndefined();
      });
      // 体积：每根应远低于瘦身前的 154 字节
      const body = await res.text();
      const bytesPerBar = body.length / j.dates.length;
      expect(bytesPerBar, '每根字节数应显著下降').toBeLessThan(90);
    });

    // 指数接口仍要保留指标字段（复盘页 daily-review.js 需要）
    test('指数 K 线接口应保留 ma/macd（复盘页依赖）', async ({ page }) => {
      const { token } = await enterBacktestWithAuth(page);
      const res = await page.request.get('/api/market/kline/sh?count=120', {
        headers: { Authorization: 'Bearer ' + token },
      });
      expect(res.ok()).toBeTruthy();
      const j = await res.json();
      expect(j.ma5, '指数接口应保留 ma5').toBeTruthy();
      expect(j.ma10, '指数接口应保留 ma10').toBeTruthy();
      expect(j.ma20, '指数接口应保留 ma20').toBeTruthy();
      expect(j.macd && j.macd.dif, '指数接口应保留 macd').toBeTruthy();
    });
  });
  // ============================================================
  // 复权口径降级（前复权负价 / 除权日假跳空）
  //
  // 背景：腾讯的前复权(qfq) 在两类情况下会给出错误数据：
  //   1. 负价 —— 高分红股早年价格被"减去累计分红"算成负数
  //      （兖矿能源 2015-12-24 收 -2.719），前端 BT_calcBuyVolume
  //      遇 price<=0 直接返回 0，根本买不进；
  //   2. 假跳空 —— 除权日折算不准，把分红除权做成暴涨（浦发银行
  //      2017-05-25 前复权 +14.21%，主板不可能）。
  // 后端 fetchKLineSafe 会比较两个口径的严重度，择优返回，
  // 并在响应里带 adjust 字段。
  //
  // ⚠ 这些用例刻意**不注入 mock**：mock 数据是合成的，没有负价也没有
  //   真实除权日，正好会掩盖这两类缺陷。代价是依赖真实上游与本地库，
  //   上游不可用时跳过而不是误报失败。
  // ============================================================
  test.describe('复权口径降级', () => {
    test('前复权负价的标的不应返回负价（回归：兖矿能源早年收 -2.719）', async ({ page }) => {
      test.setTimeout(90000);
      const { token } = await enterBacktestWithAuth(page);

      let res;
      try {
        res = await page.request.get('/api/market/kline-stock/sh600188?count=2500', {
          headers: { Authorization: 'Bearer ' + token },
          timeout: 60000,
        });
      } catch (e) {
        test.skip(true, '上游数据源不可用，跳过复权降级校验');
        return;
      }
      expect(res.ok()).toBeTruthy();
      const j = await res.json();

      const neg = (j.ohlc || []).filter((o) => !(o[1] > 0)).length;
      expect(neg, '不应存在负价（前端遇 price<=0 无法买入）').toBe(0);
      expect(j.adjust, '负价标的应已降级为后复权').toBe('hfq');
    });

    test('个股接口必须带 adjust 字段（页面提示条依赖）', async ({ page }) => {
      const { token } = await enterBacktestWithAuth(page);
      const res = await page.request.get('/api/market/kline-stock/sh600000?count=250', {
        headers: { Authorization: 'Bearer ' + token },
      });
      expect(res.ok()).toBeTruthy();
      const j = await res.json();
      expect(['qfq', 'hfq'], 'adjust 应为 qfq 或 hfq').toContain(j.adjust);
    });

    test('假跳空标的的单日涨跌幅不应超过板块涨跌停（回归：浦发 +14.21%）', async ({ page }) => {
      test.setTimeout(90000);
      const { token } = await enterBacktestWithAuth(page);

      // 主板标的的相邻交易日涨跌幅上限是 10%（前端留 1pp 余量）
      const LIMIT = 11;
      let checked = 0;
      for (const sym of ['sh600000', 'sh601398']) {
        let res;
        try {
          res = await page.request.get(`/api/market/kline-stock/${sym}?count=2500`, {
            headers: { Authorization: 'Bearer ' + token },
            timeout: 60000,
          });
        } catch (e) { continue; }
        if (!res.ok()) continue;
        const j = await res.json();
        const dates = j.dates || [], ohlc = j.ohlc || [];
        if (dates.length < 100) continue;
        // 只在"真正相邻的交易日"上比较（跨长假跳空是真实的）
        for (let i = 1; i < dates.length; i++) {
          const gap = (new Date(dates[i]) - new Date(dates[i - 1])) / 86400000;
          if (gap > 10) continue;
          const p = ohlc[i - 1][1], c = ohlc[i][1];
          if (!(p > 0)) continue;
          const chg = Math.abs(c - p) / p * 100;
          expect(chg, `${sym} ${dates[i]} 单日 ${chg.toFixed(2)}% 超过主板涨跌停上限`).toBeLessThan(LIMIT);
        }
        checked++;
      }
      if (checked === 0) test.skip(true, '上游数据源不可用，跳过假跳空校验');
    });

    // 复权口径选择权在前端：#btAdjust 下拉（auto/qfq/hfq/raw），
    // 请求应带 adjust 参数；切口径触发重拉；存档持久化。
    test('复权口径下拉应把所选口径带进请求并触发重拉', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const requested = [];
      await page.route('**/api/market/kline-stock/**', (route) => {
        const url = route.request().url();
        const isIndex = /sh000001|sh000510|sz399|sh000688/.test(url);
        const m = url.match(/[?&]adjust=(\w+)/);
        if (!isIndex && m) requested.push(m[1]);
        const body = BacktestPage.buildKline(250, isIndex ? 3000 : 24, isIndex ? '上证指数' : '测试标的');
        body.adjust = isIndex ? 'qfq' : (m ? m[1] : 'auto');
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });

      // 默认 auto
      await bt.loadData();
      expect(requested.filter((v) => v === 'auto').length, '首次加载应请求 adjust=auto').toBeGreaterThan(0);

      // 切到不复权：应立即触发重拉并带上 adjust=raw
      requested.length = 0;
      await page.selectOption('#btAdjust', 'raw');
      await page.waitForTimeout(1500);
      expect(requested, '切换口径应触发重拉并携带 adjust=raw').toContain('raw');

      // 存档应记录所选口径
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bt_state_form') || '{}'));
      expect(saved.adjust, '口径选择应写入存档').toBe('raw');
    });

    test('选「2016 年至今」应带 from=2016-01-01 请求并渲染返回的全部数据', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const urls = [];
      await page.route('**/api/market/kline-stock/**', (route) => {
        const url = route.request().url();
        const isIndex = /sh000001|sh000510|sz399|sh000688/.test(url);
        if (!isIndex) urls.push(url);
        // 模拟 2016 至今的数据量（约 2600 根）
        const body = BacktestPage.buildKline(isIndex ? 250 : 2600, isIndex ? 3000 : 24, isIndex ? '上证指数' : '测试标的');
        body.adjust = 'qfq';
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });

      await page.selectOption('#btYears', 'from2016');
      await bt.loadData();

      const hit = urls.find((u) => u.includes('from=2016-01-01'));
      expect(hit, '主图请求应携带 from=2016-01-01').toBeTruthy();
      expect(hit, 'from 模式 count 应为安全上限 3500').toMatch(/count=3500/);

      // 图表应渲染全部 2600 根（窗口模式以日期为准，不按根数裁剪）
      const got = await page.evaluate(() => (window.BT_klineData && window.BT_klineData.dates || []).length);
      expect(got, '应渲染返回的全部根数').toBe(2600);

      // 存档应记录所选年数选项
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('bt_state_form') || '{}'));
      expect(saved.years, '年数选择应写入存档').toBe('from2016');
    });
  });

  test.describe('标的搜索', () => {
    test('输入中文名称应弹出候选，可点选填入带前缀代码', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const input = page.locator('#btSymbol');
      await input.fill('');
      await input.type('银行', { delay: 20 });

      await page.waitForSelector('#btSymbolList .bt-symbol-item', { timeout: 15000 });
      const items = page.locator('#btSymbolList .bt-symbol-item');
      expect(await items.count()).toBeGreaterThan(0);

      await items.first().click();
      await page.waitForTimeout(500);

      const val = await input.inputValue();
      expect(val, '应填入 sh/sz + 6 位代码').toMatch(/^(sh|sz)\d{6}$/);
      await expect(page.locator('#btSymbolList')).toBeHidden();
    });

    test('输入纯数字回车应自动补交易所前缀', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const input = page.locator('#btSymbol');
      await input.fill('000001');
      await page.waitForTimeout(400);
      await input.press('Enter');
      await page.waitForTimeout(800);

      const val = await input.inputValue();
      expect(val, '000001 应补为 sz000001').toBe('sz000001');
    });

    test('后端搜索接口应支持名称、纯数字，并拒绝未登录访问', async ({ page }) => {
      const { token } = await enterBacktestWithAuth(page);
      const headers = { Authorization: 'Bearer ' + token };

      // 名称（带鉴权头；裸 request fixture 没有 token，会 401）
      const byName = await page.request.get('/api/market/search?q=' + encodeURIComponent('浦发银行'), { headers });
      expect(byName.ok(), '带 token 搜索应成功').toBeTruthy();
      const nameBody = await byName.json();
      expect(Array.isArray(nameBody.results)).toBe(true);

      // 纯数字代码
      const byCode = await page.request.get('/api/market/search?q=600000', { headers });
      expect(byCode.ok()).toBeTruthy();

      // 归一化接口
      const norm = await page.request.get('/api/market/normalize-symbol?symbol=600000', { headers });
      expect(norm.ok()).toBeTruthy();
      expect((await norm.json()).symbol).toBe('sh600000');
      const norm2 = await page.request.get('/api/market/normalize-symbol?symbol=000001', { headers });
      expect((await norm2.json()).symbol).toBe('sz000001');

      // 未鉴权：全新 context（不带 cookie/token）应被拒
      const anon = await page.context().browser().newContext();
      const denied = await anon.request.get('/api/market/search?q=test');
      expect([401, 403], '未登录访问搜索应被拒绝').toContain(denied.status());
      await anon.close();
    });

    test('搜索接口失败时应静默降级，不阻断手动输入', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.route('**/api/market/search**', (route) => route.fulfill({ status: 500, body: '{}' }));
      const input = page.locator('#btSymbol');
      await input.fill('');
      await input.type('茅台', { delay: 20 });
      await page.waitForTimeout(1500);

      await expect(page.locator('#btSymbolList')).toBeHidden();
      expect(errors, '搜索失败不应抛出页面错误').toEqual([]);
    });
  });
});
