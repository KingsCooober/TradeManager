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

      const before = { ...(await bt.cursorState()), zoom: await bt.mainZoom() };

      await bt.clickPrevBar();
      const afterPrev = { ...(await bt.cursorState()), zoom: await bt.mainZoom() };

      // 光标必须后退一格
      expect(afterPrev.cursor).toBe(before.cursor - 1);
      // 关键断言：窗口必须跟着滚动（这正是当时失效的点：光标动了、窗口不动）
      expect(afterPrev.zoom.start, '窗口左边界应随光标左移').toBeLessThan(before.zoom.start);
      // 面板与指数图同步
      expect(afterPrev.date).not.toBe(before.date);
      expect(afterPrev.idxDate).toBe(afterPrev.date);

      await bt.clickNextBar();
      const afterNext = { ...(await bt.cursorState()), zoom: await bt.mainZoom() };
      expect(afterNext.cursor).toBe(before.cursor);
      expect(Math.abs(afterNext.zoom.start - before.zoom.start)).toBeLessThan(0.6);
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
      await page.evaluate(() => window.BT_setCursor(0, 'pinRight'));
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

      const before = { ...(await bt.cursorState()), zoom: await bt.mainZoom() };
      await bt.clickPrevBar();
      const after = { ...(await bt.cursorState()), zoom: await bt.mainZoom() };
      expect(after.cursor).toBe(before.cursor - 1);
      expect(after.zoom.start).toBeLessThan(before.zoom.start);
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

      expect(mainH).toBe(idxH);
      expect(s.mainGrid[0].height).toBe(300);
      expect(s.mainGrid[1].height).toBe(60);
      expect(s.idxGrid[0].height).toBe(300);
      expect(s.idxGrid[1].height).toBe(60);
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

    test('交易底栏应为单行，仓位与按钮靠右且顺序正确', async ({ page }) => {
      const { bt } = await enterBacktestWithAuth(page);
      const tb = await bt.tradebarLayout();

      expect(tb.singleRow, '底栏应为单行').toBe(true);
      expect(tb.posBeforeNav, '仓位应在按钮左侧').toBe(true);
      expect(tb.gapRight, '买卖按钮应贴右').toBeLessThan(30);
      expect(tb.tipRight).toBeLessThan(tb.posLeft);
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

      // 移出图表 → 隐藏
      await page.mouse.move(box.x - 200, box.y - 200);
      await page.waitForTimeout(500);
      expect((await layerInfo('btChart')).drawn, '移出后应隐藏').toBe(0);

      // 指数图同样生效
      const idxBox = await page.locator('#btChartIndex').boundingBox();
      await page.mouse.move(idxBox.x + idxBox.width * 0.4, idxBox.y + idxBox.height * 0.3);
      await page.waitForTimeout(500);
      expect((await layerInfo('btChartIndex')).drawn, '指数图 hover 也应显示').toBeGreaterThan(200);
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
  });

  // ============================================================
  // 9. 标的搜索（名称 / 纯数字 / 下拉选择）
  // ============================================================
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
