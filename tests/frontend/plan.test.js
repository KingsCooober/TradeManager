'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('plan.js 测试', () => {
  before(() => {
    setupBrowserMock();
    loadFrontendScripts(['utils.js', 'plan.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('常量定义', () => {
    test('PLAN_STATUS 应包含 5 个状态', () => {
      assert.deepEqual(Object.keys(PlanModule.PLAN_STATUS).sort(),
        ['cancelled', 'completed', 'confirmed', 'draft', 'executed']);
    });

    test('EXEC_STATUS 应包含 4 个执行状态', () => {
      assert.deepEqual(Object.keys(PlanModule.EXEC_STATUS).sort(),
        ['cancelled', 'full', 'not_executed', 'partial']);
    });

    test('DIRECTION 应包含 4 个方向', () => {
      assert.deepEqual(Object.keys(PlanModule.DIRECTION).sort(),
        ['buy', 'long', 'sell', 'short']);
    });

    test('MARKETS 应至少 4 个市场', () => {
      assert.ok(PlanModule.MARKETS.length >= 4);
      assert.ok(PlanModule.MARKETS.includes('股票'));
      assert.ok(PlanModule.MARKETS.includes('期货'));
    });
  });

  describe('工具函数', () => {
    test('genId 应生成唯一 ID', () => {
      var id1 = PlanModule.genId('test');
      var id2 = PlanModule.genId('test');
      assert.notEqual(id1, id2);
      assert.ok(id1.indexOf('test_') === 0);
    });

    test('todayISO 应返回 YYYY-MM-DD 格式', () => {
      var t = PlanModule.todayISO();
      assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('tomorrowISO 应比 todayISO 大一天', () => {
      var t = new Date(PlanModule.todayISO());
      var tm = new Date(PlanModule.tomorrowISO());
      var diff = (tm - t) / (24 * 60 * 60 * 1000);
      assert.equal(Math.round(diff), 1);
    });
  });

  describe('calcRR() 风险收益比计算', () => {
    test('做多：入场 100，止盈 120，止损 90 → R/R = 2.00', () => {
      var rr = PlanModule.calcRR(100, 120, 90, 'long');
      assert.equal(rr.ratio, 2.0);
      assert.equal(rr.reward, 20);
      assert.equal(rr.risk, 10);
      assert.equal(rr.valid, true);
    });

    test('做空：入场 100，止盈 80，止损 110 → R/R = 2.00', () => {
      var rr = PlanModule.calcRR(100, 80, 110, 'short');
      assert.equal(rr.ratio, 2.0);
    });

    test('缺少参数应返回 null', () => {
      assert.equal(PlanModule.calcRR(null, 120, 90, 'long'), null);
      assert.equal(PlanModule.calcRR(100, null, 90, 'long'), null);
      assert.equal(PlanModule.calcRR(100, 120, null, 'long'), null);
    });

    test('止损设置无效（风险<=0）应返回 valid=false', () => {
      var rr = PlanModule.calcRR(100, 120, 100, 'long');
      assert.equal(rr.valid, false);
      assert.equal(rr.ratio, null);
    });

    test('字符串数字应正确解析', () => {
      var rr = PlanModule.calcRR('100', '120', '90', 'long');
      assert.equal(rr.ratio, 2.0);
    });

    test('formatRR 应输出 "1 : 2.00"', () => {
      var rr = PlanModule.calcRR(100, 120, 90, 'long');
      assert.equal(PlanModule.formatRR(rr), '1 : 2.00');
    });

    test('formatRR(null) 应返回 "-"', () => {
      assert.equal(PlanModule.formatRR(null), '-');
    });
  });

  describe('calcPnL() 实际盈亏计算', () => {
    test('做多：入场 100，出场 110，数量 10 → 100', () => {
      var pnl = PlanModule.calcPnL('long', 100, 110, 10);
      assert.equal(pnl, 100);
    });

    test('做空：入场 100，出场 90，数量 10 → 100', () => {
      var pnl = PlanModule.calcPnL('short', 100, 90, 10);
      assert.equal(pnl, 100);
    });

    test('做多亏损：入场 100，出场 95，数量 10 → -50', () => {
      var pnl = PlanModule.calcPnL('long', 100, 95, 10);
      assert.equal(pnl, -50);
    });

    test('应扣除手续费', () => {
      var pnl = PlanModule.calcPnL('long', 100, 110, 10, 5);
      assert.equal(pnl, 95);
    });

    test('缺少必要参数应返回 null', () => {
      assert.equal(PlanModule.calcPnL('long', null, 110, 10), null);
      assert.equal(PlanModule.calcPnL('long', 100, null, 10), null);
      assert.equal(PlanModule.calcPnL('long', 100, 110, null), null);
    });

    test('NaN 输入应返回 null', () => {
      assert.equal(PlanModule.calcPnL('long', 'abc', 110, 10), null);
    });
  });

  describe('工厂函数', () => {
    test('createEmptyPlan 应返回包含必要字段的对象', () => {
      var p = PlanModule.createEmptyPlan();
      assert.ok(p.id);
      assert.match(p.id, /^plan_/);
      assert.equal(p.status, 'draft');
      assert.ok(Array.isArray(p.items));
      assert.equal(p.items.length, 0);
      assert.ok(p.date);
      assert.ok(p.createdAt);
      assert.ok(p.updatedAt);
    });

    test('createEmptyItem 应返回默认未执行状态', () => {
      var it = PlanModule.createEmptyItem();
      assert.ok(it.id);
      assert.match(it.id, /^item_/);
      assert.equal(it.direction, 'long');
      assert.equal(it.executionStatus, 'not_executed');
      assert.equal(it.fee, 0);
    });
  });

  describe('summarizePlan() 统计', () => {
    test('空计划应返回 0 计数', () => {
      var p = PlanModule.createEmptyPlan();
      var s = PlanModule.summarizePlan(p);
      assert.equal(s.itemCount, 0);
      assert.equal(s.executedCount, 0);
      assert.equal(s.totalActualPnl, 0);
    });

    test('应正确计算各执行状态数量', () => {
      var p = PlanModule.createEmptyPlan();
      p.items.push(Object.assign(PlanModule.createEmptyItem(), { executionStatus: 'full' }));
      p.items.push(Object.assign(PlanModule.createEmptyItem(), { executionStatus: 'full' }));
      p.items.push(Object.assign(PlanModule.createEmptyItem(), { executionStatus: 'partial' }));
      p.items.push(Object.assign(PlanModule.createEmptyItem(), { executionStatus: 'cancelled' }));
      p.items.push(Object.assign(PlanModule.createEmptyItem(), { executionStatus: 'not_executed' }));
      var s = PlanModule.summarizePlan(p);
      assert.equal(s.itemCount, 5);
      assert.equal(s.fullExecuted, 2);
      assert.equal(s.partialExecuted, 1);
      assert.equal(s.cancelled, 1);
      assert.equal(s.notExecuted, 1);
      assert.equal(s.executedCount, 3);
    });

    test('应正确计算计划风险 = |入场 - 止损| × 数量', () => {
      var p = PlanModule.createEmptyPlan();
      var it = PlanModule.createEmptyItem();
      it.entryPriceMin = 100;
      it.stopLossPrice = 90;
      it.quantity = 10;
      p.items.push(it);
      var s = PlanModule.summarizePlan(p);
      assert.equal(s.totalPlannedRisk, 100);
    });

    test('应正确累加实际盈亏', () => {
      var p = PlanModule.createEmptyPlan();
      var it1 = PlanModule.createEmptyItem();
      it1.direction = 'long';
      it1.actualEntryPrice = 100;
      it1.actualExitPrice = 110;
      it1.quantity = 1;
      var it2 = PlanModule.createEmptyItem();
      it2.direction = 'short';
      it2.actualEntryPrice = 100;
      it2.actualExitPrice = 90;
      it2.quantity = 1;
      p.items.push(it1, it2);
      var s = PlanModule.summarizePlan(p);
      assert.equal(s.totalActualPnl, 20);
    });

    test('应正确计算平均 R/R', () => {
      var p = PlanModule.createEmptyPlan();
      var it1 = PlanModule.createEmptyItem();
      it1.direction = 'long';
      it1.entryPriceMin = 100;
      it1.targetPrice = 120;
      it1.stopLossPrice = 90;
      var it2 = PlanModule.createEmptyItem();
      it2.direction = 'long';
      it2.entryPriceMin = 100;
      it2.targetPrice = 130;
      it2.stopLossPrice = 90;
      p.items.push(it1, it2);
      var s = PlanModule.summarizePlan(p);
      assert.equal(s.rrCount, 2);
      assert.equal(s.avgRR, 2.5);
    });
  });
});
