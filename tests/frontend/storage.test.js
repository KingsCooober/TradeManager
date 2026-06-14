'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('storage.js 测试', () => {
  before(() => {
    setupBrowserMock();
  });

  beforeEach(() => {
    // 每个测试用例前清空 localStorage 并重置全局状态
    if (globalThis.localStorage) {
      globalThis.localStorage.clear();
    }
    // 加载 storage.js（重新执行以重置模块级变量）
    loadFrontendScripts(['utils.js', 'storage.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('markTradeDirty()', () => {
    test('标记数字 ID 为脏', () => {
      const id = 123;
      markTradeDirty(id);
      assert.equal(dirtyTradeIds[String(id)], true);
    });

    test('标记字符串 ID 为脏', () => {
      const id = 'abc-def';
      markTradeDirty(id);
      assert.equal(dirtyTradeIds[id], true);
    });

    test('不同 ID 独立标记', () => {
      markTradeDirty('id1');
      markTradeDirty('id2');
      assert.equal(dirtyTradeIds['id1'], true);
      assert.equal(dirtyTradeIds['id2'], true);
    });

    test('重复标记同一 ID 不影响', () => {
      markTradeDirty('same-id');
      markTradeDirty('same-id');
      assert.equal(dirtyTradeIds['same-id'], true);
    });
  });

  describe('markTradeDeleted()', () => {
    test('将 ID 加入待删除列表', () => {
      markTradeDeleted('delete-me');
      assert.ok(pendingDeletedTradeIds.includes('delete-me'));
    });

    test('从 dirtyTradeIds 移除', () => {
      markTradeDirty('will-be-deleted');
      assert.equal(dirtyTradeIds['will-be-deleted'], true);
      markTradeDeleted('will-be-deleted');
      assert.equal(dirtyTradeIds['will-be-deleted'], undefined);
    });

    test('多个 ID 都加入待删除列表', () => {
      markTradeDeleted('a');
      markTradeDeleted('b');
      markTradeDeleted('c');
      assert.equal(pendingDeletedTradeIds.length, 3);
      assert.ok(pendingDeletedTradeIds.includes('a'));
      assert.ok(pendingDeletedTradeIds.includes('b'));
      assert.ok(pendingDeletedTradeIds.includes('c'));
    });
  });

  describe('clearDirtyTracking()', () => {
    test('清空 dirtyTradeIds 和 pendingDeletedTradeIds', () => {
      markTradeDirty('id1');
      markTradeDeleted('id2');
      assert.equal(Object.keys(dirtyTradeIds).length, 1);
      assert.equal(pendingDeletedTradeIds.length, 1);

      clearDirtyTracking();

      assert.equal(Object.keys(dirtyTradeIds).length, 0);
      assert.equal(pendingDeletedTradeIds.length, 0);
    });
  });

  describe('计算函数', () => {
    test('getTotalDeposit() 求和', () => {
      deposits = [
        { amount: 1000 },
        { amount: 2000 },
        { amount: 5000 }
      ];
      assert.equal(getTotalDeposit(), 8000);
    });

    test('getTotalDeposit() 空数组返回 0', () => {
      deposits = [];
      assert.equal(getTotalDeposit(), 0);
    });

    test('getTotalWithdraw() 求和', () => {
      withdrawals = [
        { amount: 500 },
        { amount: 1500 }
      ];
      assert.equal(getTotalWithdraw(), 2000);
    });

    test('getTotalWithdraw() 空数组返回 0', () => {
      withdrawals = [];
      assert.equal(getTotalWithdraw(), 0);
    });

    test('getTotalTradePnl() 只累计已平仓的盈利', () => {
      trades = [
        { status: 'open', pnl: 1000 },
        { status: 'win', pnl: 500 },
        { status: 'loss', pnl: -200 },
        { status: 'win', pnl: '' },
        { status: 'win', pnl: 300 }
      ];
      // 1000 (open) + 500 (win) + -200 (loss) + 0 (空字符串) + 300 (win) = 1600
      assert.equal(getTotalTradePnl(), 600);
    });

    test('getTotalTradePnl() 空 trades 返回 0', () => {
      trades = [];
      assert.equal(getTotalTradePnl(), 0);
    });

    test('getInitCapital() 读取 DOM 值', () => {
      const input = globalThis.document.getElementById('initCapital');
      input.value = '250000';
      assert.equal(getInitCapital(), 250000);
    });

    test('getInitCapital() 非法值返回 100000', () => {
      const input = globalThis.document.getElementById('initCapital');
      input.value = '';
      assert.equal(getInitCapital(), 100000);
    });

    test('getRiskPct() 读取 DOM 值', () => {
      const input = globalThis.document.getElementById('riskPct');
      input.value = '3.5';
      assert.equal(getRiskPct(), 3.5);
    });

    test('getRiskPct() 非法值返回 2', () => {
      const input = globalThis.document.getElementById('riskPct');
      input.value = '';
      assert.equal(getRiskPct(), 2);
    });

    test('getMaxRisk() 读取 DOM 值', () => {
      const input = globalThis.document.getElementById('maxRisk');
      input.value = '5';
      assert.equal(getMaxRisk(), 5);
    });

    test('getFeeRate() 读取 DOM 值', () => {
      const input = globalThis.document.getElementById('feeRate');
      input.value = '0.15';
      assert.equal(getFeeRate(), 0.15);
    });
  });

  describe('getCurrentCapital() 当前资金计算', () => {
    test('初始资金 + 入金 - 出金 + 交易盈亏', () => {
      const initInput = globalThis.document.getElementById('initCapital');
      initInput.value = '100000';
      deposits = [{ amount: 20000 }];
      withdrawals = [{ amount: 5000 }];
      trades = [
        { status: 'win', pnl: 1000 },
        { status: 'open', pnl: 500 }, // 不计入
        { status: 'loss', pnl: -300 }
      ];
      // 100000 + 20000 - 5000 + (1000 + 0 + -300) = 115700
      assert.equal(getCurrentCapital(), 115700);
    });

    test('无交易时 = 初始资金 + 入金 - 出金', () => {
      const initInput = globalThis.document.getElementById('initCapital');
      initInput.value = '100000';
      deposits = [{ amount: 10000 }];
      withdrawals = [];
      trades = [];
      assert.equal(getCurrentCapital(), 110000);
    });
  });

  describe('getUsedRisk() 已使用风险', () => {
    test('只计算持仓中的交易', () => {
      const entry = 100;
      const stop = 95;
      const posSize = 5000;
      // 已使用 = posSize * |entry-stop| / entry = 5000 * 5/100 = 250
      trades = [
        { status: 'open', entry, stop, posSize },
        { status: 'win', entry, stop, posSize }, // 已平仓不计入
        { status: 'open', entry: 200, stop: 190, posSize: 10000 } // = 10000 * 10/200 = 500
      ];
      assert.equal(getUsedRisk(), 750);
    });

    test('空 trades 返回 0', () => {
      trades = [];
      assert.equal(getUsedRisk(), 0);
    });

    test('缺少必要字段的交易被跳过', () => {
      trades = [
        { status: 'open' },
        { status: 'open', entry: 100 }, // 缺少 stop, posSize
        { status: 'open', entry: 100, stop: 95, posSize: 0 } // posSize 为 0
      ];
      assert.equal(getUsedRisk(), 0);
    });
  });
});
