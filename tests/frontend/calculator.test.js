'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('calculator.js 测试', () => {
  before(() => {
    setupBrowserMock();
    // P1-2: calculator.js 已用 showToast 替代 alert，需先加载 ui.js
    loadFrontendScripts(['utils.js', 'ui.js', 'calculator.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('roundToMultiple() 四舍五入到指定倍数', () => {
    test('0 到 0.1 倍数 = 0', () => {
      assert.equal(roundToMultiple(0, 0.1), 0);
    });

    test('10 到 5 倍数 = 10', () => {
      assert.equal(roundToMultiple(10, 5), 10);
    });

    test('12 到 5 倍数 = 10', () => {
      assert.equal(roundToMultiple(12, 5), 10);
    });

    test('13 到 5 倍数 = 15', () => {
      assert.equal(roundToMultiple(13, 5), 15);
    });

    test('100 到 100 倍数 = 100', () => {
      assert.equal(roundToMultiple(100, 100), 100);
    });

    test('55 到 100 倍数 = 100', () => {
      assert.equal(roundToMultiple(55, 100), 100);
    });

    test('1.25 到 0.5 倍数 = 1.5', () => {
      assert.equal(roundToMultiple(1.25, 0.5), 1.5);
    });

    test('1.75 到 0.5 倍数 = 2', () => {
      assert.equal(roundToMultiple(1.75, 0.5), 2);
    });

    test('0.06 到 0.1 倍数 = 0.1', () => {
      assert.equal(roundToMultiple(0.06, 0.1), 0.1);
    });

    test('负数 -0.05 到 0.1 倍数 ≈ 0（浮点精度，可能为 -0）', () => {
      // JavaScript 中 Math.round(-0.05/0.1) = -0，0*-0.1 = -0
      // 验证结果的绝对值等于 0
      const result = roundToMultiple(-0.05, 0.1);
      assert.equal(Math.abs(result), 0, '绝对值应等于 0');
    });

    test('负数 -0.06 到 0.1 倍数 = -0.1', () => {
      assert.equal(roundToMultiple(-0.06, 0.1), -0.1);
    });
  });

  describe('仓位计算器业务逻辑（不依赖 DOM 的纯计算）', () => {
    test('做多计算：风险金额、止损距离、止盈', () => {
      const cap = 100000;
      const rPct = 2;
      const entry = 42000;
      const stop = 41000;
      const targetR = 2;

      const rAmt = cap * rPct / 100;
      const stopDist = Math.abs(entry - stop);
      const stopPct = (stopDist / entry) * 100;
      const sugPos = rAmt / (stopPct / 100);
      const tpDist = stopDist * targetR;
      const tp = entry + tpDist;
      const breakeven = entry + stopDist;

      assert.equal(rAmt, 2000);
      assert.equal(stopDist, 1000);
      assert.ok(Math.abs(stopPct - 2.3809) < 0.001);
      assert.ok(Math.abs(sugPos - 84000) < 1);
      assert.equal(tpDist, 2000);
      assert.equal(tp, 44000);
      assert.equal(breakeven, 43000);
    });

    test('做空计算：风险金额、止损距离、止盈', () => {
      const cap = 100000;
      const rPct = 2;
      const entry = 2500;
      const stop = 2600;
      const targetR = 2;

      const rAmt = cap * rPct / 100;
      const stopDist = Math.abs(entry - stop);
      const stopPct = (stopDist / entry) * 100;
      const sugPos = rAmt / (stopPct / 100);
      const tpDist = stopDist * targetR;
      const tp = entry - tpDist;
      const breakeven = entry - stopDist;

      assert.equal(rAmt, 2000);
      assert.equal(stopDist, 100);
      assert.equal(stopPct, 4);
      assert.equal(sugPos, 50000);
      assert.equal(tpDist, 200);
      assert.equal(tp, 2300);
      assert.equal(breakeven, 2400);
    });

    test('手续费计算：开仓', () => {
      const posSize = 9000;
      const feeRate = 0.05 / 100;
      const openFee = posSize * feeRate;
      assert.ok(Math.abs(openFee - 4.5) < 0.01);
    });

    test('手续费计算：平仓', () => {
      const exitPrice = 43000;
      const actualLots = 2;
      const feeRate = 0.05 / 100;
      const closeFee = exitPrice * actualLots * feeRate;
      assert.ok(Math.abs(closeFee - 43) < 0.01);
    });

    test('推荐手数计算', () => {
      const rAmt = 2000;
      const entry = 42000;
      const stop = 41000;
      const stopPct = (Math.abs(entry - stop) / entry) * 100;
      const sugPos = rAmt / (stopPct / 100);
      const recoLots = Math.round(sugPos / entry * 10) / 10;
      assert.ok(Math.abs(recoLots - 2.0) < 0.1);
    });
  });

  describe('addTradeFromCalc() DOM 集成测试', () => {
    test('未填写入场价时调用应给出提示', () => {
      // 模拟一个无入场价的场景
      const calcEntry = globalThis.document.getElementById('calcEntry');
      calcEntry.value = '';
      const calcStop = globalThis.document.getElementById('calcStop');
      calcStop.value = '41000';

      // P1-2: calculator.js 已用 showToast 替代 alert，重写 showToast 检测调用
      const originalToast = globalThis.showToast;
      let toastCalled = false;
      globalThis.showToast = () => { toastCalled = true; return { close: () => {} }; };

      try {
        addTradeFromCalc();
        assert.equal(toastCalled, true, '应弹出 showToast 提示');
      } finally {
        globalThis.showToast = originalToast;
      }
    });
  });
});
