// tests/e2e/pages/ChartPanel.js
// 图表（持仓分布 + 收益曲线）
const { expect } = require('@playwright/test');
const BasePage = require('./BasePage');

class ChartPanel extends BasePage {
  constructor(page) {
    super(page);
  }

  get selectors() {
    return {
      // 持仓分布
      positionPieCard: '.chart-card:has(h2:has-text("持仓分布"))',
      positionPie: '#positionPie',
      pieLegend: '#pieLegend',

      // 收益曲线
      equityCard: '.chart-card:has(h2:has-text("收益曲线"))',
      equityCurve: '#equityCurve',
      maxDrawdownPct: '#maxDrawdownPct',
      maxDrawdownAmt: '#maxDrawdownAmt',
      peakCapital: '#peakCapital',
      valleyCapital: '#valleyCapital',

      // 收益曲线详情弹窗
      equityModal: '#equityModal',
      equityModalChart: '#equityModalChart',
      equityTimeRange: '#equityTimeRange',
      equityInitCapital: '#equityInitCapital',
      equityCurrentCapital: '#equityCurrentCapital',
      equityTotalPnl: '#equityTotalPnl',
      equityTotalReturn: '#equityTotalReturn',
      equityMaxDrawdown: '#equityMaxDrawdown',
      equityPeakCapital: '#equityPeakCapital',
      equityTotalTrades: '#equityTotalTrades',
      equityWinRate: '#equityWinRate',
    };
  }

  /**
   * 验证图表已渲染（canvas 有内容）
   */
  async isPieChartRendered() {
    return this.page.evaluate(() => {
      const canvas = document.getElementById('positionPie');
      if (!canvas) return false;
      // 简单判断：canvas 存在且 width/height > 0
      return canvas.width > 0 && canvas.height > 0;
    });
  }

  async isEquityChartRendered() {
    return this.page.evaluate(() => {
      const canvas = document.getElementById('equityCurve');
      if (!canvas) return false;
      return canvas.width > 0 && canvas.height > 0;
    });
  }

  /**
   * 获取图例内容
   */
  async getLegendItems() {
    return this.page.evaluate(() => {
      const legend = document.getElementById('pieLegend');
      if (!legend) return [];
      return Array.from(legend.children).map((el) => el.textContent.trim());
    });
  }

  /**
   * 获取最大回撤
   */
  async getMaxDrawdown() {
    return {
      pct: (await this.page.textContent(this.selectors.maxDrawdownPct)).trim(),
      amt: (await this.page.textContent(this.selectors.maxDrawdownAmt)).trim(),
    };
  }

  /**
   * 获取峰值资金
   */
  async getPeakCapital() {
    return (await this.page.textContent(this.selectors.peakCapital)).trim();
  }

  /**
   * 获取谷值资金
   */
  async getValleyCapital() {
    return (await this.page.textContent(this.selectors.valleyCapital)).trim();
  }
}

module.exports = ChartPanel;
