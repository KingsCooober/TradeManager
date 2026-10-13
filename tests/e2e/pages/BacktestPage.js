// tests/e2e/pages/BacktestPage.js
// 回测练习页（backtest.html）页面对象
//
// 设计说明：
//  - 图表用 ECharts 渲染在 canvas 上，无法用 DOM 断言图形，
//    因此通过页面暴露的全局对象（BT_chart / BT_klineData / BT_visibleBars 等）
//    读取真实渲染状态，而不是只截图。
//  - 网络层用 route 拦截行情接口，注入确定性数据，
//    避免测试依赖外部行情源（东财/腾讯）而变得不稳定。
const path = require('path');

class BacktestPage {
  constructor(page) {
    this.page = page;
  }

  // ---------- 导航 ----------

  async goto() {
    await this.page.goto('/backtest.html');
    // 等回测模块就绪（BT_init 完成后这些全局量可用）
    await this.page.waitForFunction(
      () => typeof window.BT_loadData === 'function' && typeof window.BT_chart !== 'undefined',
      null, { timeout: 15000 }
    );
    await this.page.waitForTimeout(300);
  }

  // ---------- 数据注入 ----------

  /**
   * 拦截行情接口，返回确定性 K 线数据。
   * @param {object} opts
   *   - count: 根数（默认 250）
   *   - symbolName: 标的名称（默认 '浦发银行'）
   *   - indexName: 指数名称（默认 '上证指数'）
   */
  async mockMarketData(opts = {}) {
    const count = opts.count || 250;
    const symbolName = opts.symbolName || '浦发银行';
    const indexName = opts.indexName || '上证指数';

    await this.page.route('**/api/market/kline-stock/**', (route) => {
      const url = route.request().url();
      const isIndex = /sh000001|sh000510|sz399|sh000688/.test(url);
      const base = isIndex ? 3000 : 24;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BacktestPage.buildKline(count, base, isIndex ? indexName : symbolName)),
      });
    });
    // 其余鉴权类接口给空成功，避免 401 噪声干扰。
    // ⚠ 注意：必须放行 /api/market/search（标的搜索）走真实服务端，
    //    否则兜底会把搜索结果也替换成 {}，导致下拉永远"没有匹配的标的"。
    await this.page.route('**/api/**', (route) => {
      const url = route.request().url();
      if (/kline-stock|market\/search|normalize-symbol/.test(url)) return route.fallback();
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
  }

  /** 生成结构合法的 K 线数据：[open, close, low, high] */
  static buildKline(count, base, name) {
    const dates = [], ohlc = [], volumes = [], macd = { dif: [], dea: [], macd: [] };
    let px = base;
    for (let i = 0; i < count; i++) {
      const c = base + Math.sin(i / 30) * base * 0.15;
      const o = px;
      ohlc.push([
        +o.toFixed(2), +c.toFixed(2),
        +(Math.min(o, c) - base * 0.005).toFixed(2),
        +(Math.max(o, c) + base * 0.005).toFixed(2),
      ]);
      px = c;
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
      volumes.push(Math.round(100000 + Math.abs(c - o) * 500000));
      macd.dif.push(0.1); macd.dea.push(0.08); macd.macd.push(0.04);
    }
    return { dates, ohlc, volumes, macd, count, name };
  }

  /** 触发主图加载（该页不会自动加载主图，需点「加载 K 线」或调用 BT_loadData） */
  async loadData({ viaButton = false } = {}) {
    if (viaButton) {
      await this.page.click('#btnLoad');
    } else {
      await this.page.evaluate(() => window.BT_loadData());
    }
    await this.page.waitForFunction(
      () => window.BT_klineData && window.BT_klineData.dates && window.BT_klineData.dates.length > 0,
      null, { timeout: 15000 }
    );
    await this.page.waitForTimeout(500);
  }

  // ---------- 状态读取 ----------

  /** 主图 dataZoom 窗口（百分比） */
  async mainZoom() {
    return this.page.evaluate(() => {
      const dz = window.BT_chart.getOption().dataZoom[1];
      return { start: +dz.start.toFixed(2), end: +dz.end.toFixed(2) };
    });
  }

  /**
   * 当前可见窗口（数据索引，**闭区间** [start, end]，两端都可见）
   * 断言"窗口是否滚动"要用这个，不是百分比（百分比有换算误差）。
   * ★ ECharts dataZoom 的 end 是 inclusive，所以这里 end 也是"最右一根的索引"。
   */
  async windowState() {
    return this.page.evaluate(() => ({
      start: window.BT_winStartIdx,
      end: window.BT_winEndIdx,
    }));
  }

  /** 光标是否在当前窗口内（闭区间） */
  async isCursorInWindow() {
    return this.page.evaluate(() => {
      const w = window.BT_getWindowRange();
      return window.BT_currentIdx >= w.start && window.BT_currentIdx <= w.end;
    });
  }

  /** 给定窗口与光标索引，判断光标是否落在窗口内（闭区间，纯函数便于断言） */
  windowContains(win, cursor) {
    return cursor >= win.start && cursor <= win.end;
  }

  /**
   * 把光标移动到窗口边缘并返回 { cursor, win }
   * @param {'left'|'right'} side
   */
  async setCursorToEdge(side) {
    return this.page.evaluate((s) => {
      const w = window.BT_getWindowRange();
      const idx = s === 'left' ? w.start : w.end;   // 闭区间：end 即最右一根
      window.BT_setCursor(idx);
      const nw = window.BT_getWindowRange();
      return { cursor: window.BT_currentIdx, win: { start: nw.start, end: nw.end } };
    }, side);
  }

  /**
   * 把光标移动到窗口正中，返回 { cursor, win }
   * 用于"窗口不应滚动"用例的前置准备
   */
  async setCursorToWindowCenter() {
    return this.page.evaluate(() => {
      const w = window.BT_getWindowRange();
      const mid = Math.floor((w.start + w.end) / 2);
      window.BT_setCursor(mid);
      const nw = window.BT_getWindowRange();
      return { cursor: window.BT_currentIdx, win: { start: nw.start, end: nw.end } };
    });
  }

  /**
   * 把窗口挪到中段（模拟用户拖动过 slider，使"最右侧不是最后一根"）
   * @param {number} startIdx 目标窗口左端索引
   */
  async setWindowStart(startIdx) {
    return this.page.evaluate((s) => {
      window.BT_winStartIdx = s;
      window.BT_applyWindow();
      const w = window.BT_getWindowRange();
      return { start: w.start, end: w.end };
    }, startIdx);
  }

  /** 指数图 dataZoom 窗口 */
  async indexZoom() {
    return this.page.evaluate(() => {
      if (!window.BT_indexChart) return null;
      const dz = window.BT_indexChart.getOption().dataZoom[1];
      return { start: +dz.start.toFixed(2), end: +dz.end.toFixed(2) };
    });
  }

  /** 光标相关状态 */
  async cursorState() {
    return this.page.evaluate(() => ({
      cursor: window.BT_currentIdx,
      date: (document.getElementById('curDate') || {}).textContent,
      idxDate: (document.getElementById('idxDate') || {}).textContent,
      ma5: (document.getElementById('curMaP_0') || {}).textContent,
      open: (document.getElementById('curOpen') || {}).textContent,
      close: (document.getElementById('curClose') || {}).textContent,
      high: (document.getElementById('curHigh') || {}).textContent,
      low: (document.getElementById('curLow') || {}).textContent,
    }));
  }

  /** 图表 option 摘要（grid / series / yAxis） */
  async chartSummary() {
    return this.page.evaluate(() => {
      const mainOpt = window.BT_chart.getOption();
      const idxOpt = window.BT_indexChart ? window.BT_indexChart.getOption() : null;
      return {
        mainGrid: mainOpt.grid.map((g) => ({ top: g.top, height: g.height })),
        idxGrid: idxOpt ? idxOpt.grid.map((g) => ({ top: g.top, height: g.height })) : null,
        mainSeries: (mainOpt.series || []).map((s) => s.name),
        idxSeries: idxOpt ? (idxOpt.series || []).map((s) => s.name) : null,
        mainPriceAxisShow: !(mainOpt.yAxis[0].axisLabel && mainOpt.yAxis[0].axisLabel.show === false),
        mainVolAxisShow: mainOpt.yAxis[1].axisLabel ? mainOpt.yAxis[1].axisLabel.show : null,
        idxVolAxisShow: idxOpt ? (idxOpt.yAxis[1].axisLabel ? idxOpt.yAxis[1].axisLabel.show : null) : null,
        mainKlineOk: (() => {
          const k = (mainOpt.series || []).find((s) => s.name === 'K线');
          return !!(k && Array.isArray(k.data) && Array.isArray(k.data[0]) && k.data[0].length === 4);
        })(),
        idxKlineOk: (() => {
          if (!idxOpt) return null;
          const k = (idxOpt.series || []).find((s) => s.name === 'K线');
          return !!(k && Array.isArray(k.data) && Array.isArray(k.data[0]) && k.data[0].length === 4);
        })(),
      };
    });
  }

  /** 可见根数配置 */
  async visibleBarsState() {
    return this.page.evaluate(() => ({
      bars: window.BT_visibleBars,
      selectValue: (document.getElementById('btVisibleBars') || {}).value,
      options: Array.from(document.querySelectorAll('#btVisibleBars option')).map((o) => o.value),
      defaultBars: window.BT_DEFAULT_VISIBLE_BARS,
      allowed: window.BT_ALLOWED_VISIBLE_BARS,
    }));
  }

  /** MA 配置与图上实际线色 */
  async maState() {
    return this.page.evaluate(() => {
      const opt = window.BT_chart.getOption();
      const maSeries = (opt.series || []).filter((s) => /^MA\d+$/.test(s.name));
      return {
        periods: window.BT_maPeriods,
        palette: window.BT_maColors(),
        series: maSeries.map((s) => ({ name: s.name, color: s.lineStyle && s.lineStyle.color })),
        inputs: ['ma1', 'ma2', 'ma3', 'ma4'].map((id) => {
          const el = document.getElementById(id);
          return el ? el.value : null;
        }),
        hasMa4Input: !!document.getElementById('ma4'),
      };
    });
  }

  /** 右侧指标卡布局 */
  async statsLayout() {
    return this.page.evaluate(() => {
      const stats = document.getElementById('btStats');
      const right = document.querySelector('.bt-main-right');
      const left = document.querySelector('.bt-main-left');
      const cards = Array.from(document.querySelectorAll('.bt-stats-side .bt-stat'));
      const cs = getComputedStyle(stats);
      const rR = right.getBoundingClientRect();
      const lR = left.getBoundingClientRect();
      const lastR = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null;
      return {
        inRightColumn: !!(right && right.contains(stats)),
        columns: cs.gridTemplateColumns.trim().split(/\s+/).length,
        cardCount: cards.length,
        cardHeights: cards.map((c) => Math.round(c.getBoundingClientRect().height)),
        rightWidth: Math.round(rR.width),
        leftWidth: Math.round(lR.width),
        bottomGap: lastR ? Math.round(rR.bottom - lastR.bottom) : null,
        topAligned: Math.abs(lR.top - rR.top) < 2,
        bottomAligned: Math.abs(lR.bottom - rR.bottom) < 2,
      };
    });
  }

  /** 交易底栏布局 */
  async tradebarLayout() {
    return this.page.evaluate(() => {
      const R = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect() : null;
      };
      const tb = R('.bt-tradebar');
      const row = R('.bt-tradebar-row');
      const tip = R('.bt-tip-inline');
      const pos = R('.bt-group-pos');
      const nav = R('.bt-btn-group-nav');
      const trade = R('.bt-btn-group-trade');
      return {
        singleRow: tb && row ? Math.abs(tb.height - row.height) <= 24 : null,
        tipRight: tip ? Math.round(tip.right) : null,
        posLeft: pos ? Math.round(pos.left) : null,
        navLeft: nav ? Math.round(nav.left) : null,
        tradeRight: trade ? Math.round(trade.right) : null,
        tbRight: tb ? Math.round(tb.right) : null,
        gapRight: tb && trade ? Math.round(tb.right - trade.right) : null,
        posBeforeNav: pos && nav ? pos.left < nav.left : null,
      };
    });
  }

  // ---------- 交互 ----------

  async clickPrevBar(times = 1) {
    for (let i = 0; i < times; i++) {
      await this.page.click('#btnPrevBar', { force: true, noWaitAfter: true });
    }
    await this.page.waitForTimeout(times > 1 ? times * 250 : 350);
  }

  async clickNextBar(times = 1) {
    for (let i = 0; i < times; i++) {
      await this.page.click('#btnNextBar', { force: true, noWaitAfter: true });
    }
    await this.page.waitForTimeout(times > 1 ? times * 250 : 350);
  }

  /** 设置主题（走真实路径：storage 事件触发 BT_applyTheme） */
  async setTheme(theme) {
    await this.page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('app_theme', t);
      window.dispatchEvent(new StorageEvent('storage', { key: 'app_theme', newValue: t }));
    }, theme);
    await this.page.waitForTimeout(700);
  }
}

module.exports = BacktestPage;
