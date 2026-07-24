'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('updateAll 拆分（refresh* 系列）— P2-2', () => {
  before(() => {
    setupBrowserMock();
  });

  beforeEach(() => {
    if (globalThis.localStorage) globalThis.localStorage.clear();
    // main.js 顶层调用 window.addEventListener，browser-mock 不支持，注入空函数
    globalThis.window.addEventListener = globalThis.window.addEventListener || function() {};
    // 加载依赖链：utils → storage（提供 getCurrentCapital 等 getter）→ main
    loadFrontendScripts(['utils.js', 'storage.js', 'main.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('refresh* 函数已暴露', () => {
    test('refreshStats 是函数', () => {
      assert.strictEqual(typeof refreshStats, 'function');
    });

    test('refreshTable 是函数', () => {
      assert.strictEqual(typeof refreshTable, 'function');
    });

    test('refreshCharts 是函数', () => {
      assert.strictEqual(typeof refreshCharts, 'function');
    });

    test('refreshDashboard 是函数', () => {
      assert.strictEqual(typeof refreshDashboard, 'function');
    });

    test('refreshCalculator 是函数', () => {
      assert.strictEqual(typeof refreshCalculator, 'function');
    });

    test('updateAll 仍为函数（兼容入口）', () => {
      assert.strictEqual(typeof updateAll, 'function');
    });
  });

  describe('refreshStats()', () => {
    test('DOM 元素缺失时不抛错', () => {
      // 浏览器 mock 中没有 currentCapital 等元素
      assert.doesNotThrow(function() { refreshStats(); });
    });

    test('存在 currentCapital 元素时正确写入格式化资金', () => {
      var el = document.getElementById('currentCapital');
      // getCurrentCapital 默认应返回 initCapital + totalDeposit - totalWithdraw
      // 注入已知值：init=100000, deposit=0, withdraw=0 → cap=100000
      globalThis.initCapital = 100000;
      globalThis.deposits = [];
      globalThis.withdrawals = [];
      globalThis.trades = [];
      refreshStats();
      var text = el.textContent || el._textContent;
      assert.ok(text, '应写入文本');
      assert.ok(/100,?000/.test(text), '应包含资金金额 100000');
    });

    test('totalPnl 元素存在时写入盈亏与颜色类', () => {
      var el = document.getElementById('totalPnl');
      globalThis.initCapital = 100000;
      globalThis.deposits = [];
      globalThis.withdrawals = [];
      globalThis.trades = [];
      refreshStats();
      var cls = el.className || '';
      assert.ok(cls.indexOf('val') !== -1, 'className 应含 val');
    });

    test('交易亏损时 totalPnl 文本带负号前缀', () => {
      var el = document.getElementById('totalPnl');
      // 构造一笔亏损交易，pnl=-100
      globalThis.initCapital = 100000;
      globalThis.deposits = [];
      globalThis.withdrawals = [];
      globalThis.trades = [{ id: 't1', pnl: -100 }];
      refreshStats();
      var text = el.textContent || el._textContent || '';
      assert.ok(text.indexOf('-') === 0, '亏损时 pnl 文本应以 - 开头，实际：' + text);
    });
  });

  describe('updateAll() 兼容入口', () => {
    test('调用不抛错（即使大多数 refresh 子函数找不到 DOM 元素）', () => {
      assert.doesNotThrow(function() { updateAll(); });
    });

    test('调用顺序：saveAccountParams → refreshStats → refreshDashboard → refreshCalculator → refreshTable → refreshCharts', () => {
      var calls = [];
      globalThis.saveAccountParams = function() { calls.push('saveAccountParams'); };
      // 替换各 refresh，记录调用顺序
      var origStats = refreshStats;
      var origDash = refreshDashboard;
      var origCalc = refreshCalculator;
      var origTable = refreshTable;
      var origCharts = refreshCharts;
      globalThis.refreshStats = function() { calls.push('refreshStats'); };
      globalThis.refreshDashboard = function() { calls.push('refreshDashboard'); };
      globalThis.refreshCalculator = function() { calls.push('refreshCalculator'); };
      globalThis.refreshTable = function() { calls.push('refreshTable'); };
      globalThis.refreshCharts = function() { calls.push('refreshCharts'); };
      try {
        updateAll();
      } finally {
        globalThis.refreshStats = origStats;
        globalThis.refreshDashboard = origDash;
        globalThis.refreshCalculator = origCalc;
        globalThis.refreshTable = origTable;
        globalThis.refreshCharts = origCharts;
      }
      assert.deepStrictEqual(calls, [
        'saveAccountParams',
        'refreshStats',
        'refreshDashboard',
        'refreshCalculator',
        'refreshTable',
        'refreshCharts'
      ]);
    });
  });

  describe('refresh* 互不依赖（局部刷新可单独调用）', () => {
    test('单独调用 refreshStats 不会触发 refreshCharts', () => {
      var chartsCalled = false;
      var orig = globalThis.refreshCharts;
      globalThis.refreshCharts = function() { chartsCalled = true; };
      try {
        refreshStats();
        assert.strictEqual(chartsCalled, false, 'refreshStats 不应触发 refreshCharts');
      } finally {
        globalThis.refreshCharts = orig;
      }
    });

    test('单独调用 refreshTable 不会触发 refreshStats', () => {
      var statsCalled = false;
      var orig = globalThis.refreshStats;
      globalThis.refreshStats = function() { statsCalled = true; };
      try {
        refreshTable();
        assert.strictEqual(statsCalled, false, 'refreshTable 不应触发 refreshStats');
      } finally {
        globalThis.refreshStats = orig;
      }
    });
  });
});
