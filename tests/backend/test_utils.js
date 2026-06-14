/**
 * TradeManager 前端 utils.js 单元测试（Node.js 测试运行器）
 *
 * 通过浏览器环境模拟加载 public/js/utils.js，测试其中的纯函数。
 * roundToMultiple 等其他纯函数在 calculator.test.js / sync.test.js 中覆盖。
 */

'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('utils.js 纯函数', () => {
  before(() => {
    setupBrowserMock();
    loadFrontendScripts(['utils.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('formatNumber()', () => {
    test('正常数字', () => {
      assert.equal(formatNumber(1234.5), '1,234.50');
      assert.equal(formatNumber(0), '0.00');
      assert.equal(formatNumber(-999.1), '-999.10');
      assert.equal(formatNumber(1000000), '1,000,000.00');
      assert.equal(formatNumber(3.14159), '3.14');
    });

    test('空值返回 -', () => {
      assert.equal(formatNumber(NaN), '-');
      assert.equal(formatNumber(null), '-');
      assert.equal(formatNumber(undefined), '-');
    });
  });

  describe('CNY()', () => {
    test('正常金额带 ￥ 后缀', () => {
      assert.equal(CNY(1234.5), '1,234.50 ￥');
      assert.equal(CNY(0), '0.00 ￥');
      assert.equal(CNY(-500), '-500.00 ￥');
      assert.equal(CNY(100000), '100,000.00 ￥');
      assert.equal(CNY(1.5), '1.50 ￥');
    });

    test('空值返回 -', () => {
      assert.equal(CNY(NaN), '-');
      assert.equal(CNY(null), '-');
      assert.equal(CNY(undefined), '-');
    });
  });

  describe('CNYW()', () => {
    test('万元单位', () => {
      assert.equal(CNYW(0), '0');
      assert.equal(CNYW(100000), '10.0万');
      assert.equal(CNYW(150000), '15.0万');
      assert.equal(CNYW(5000), '0.50万');
      assert.equal(CNYW(100), '0.01万');
    });

    test('亿元单位', () => {
      assert.equal(CNYW(100000000), '1.00亿');
      assert.equal(CNYW(1000000000), '10.00亿');
    });

    test('负数', () => {
      assert.equal(CNYW(-100000), '-10.0万');
    });

    test('空值返回 -', () => {
      assert.equal(CNYW(NaN), '-');
      assert.equal(CNYW(null), '-');
    });
  });

  describe('fmtR()', () => {
    test('正/负/零 R 值', () => {
      assert.equal(fmtR(0), '+0.00R');
      assert.equal(fmtR(1.5), '+1.50R');
      assert.equal(fmtR(-2.3), '-2.30R');
      assert.equal(fmtR(10), '+10.00R');
      assert.equal(fmtR(0.01), '+0.01R');
    });

    test('空值返回 -', () => {
      assert.equal(fmtR(NaN), '-');
      assert.equal(fmtR(null), '-');
    });
  });

  describe('esc()', () => {
    test('HTML 特殊字符转义', () => {
      assert.equal(esc('hello'), 'hello');
      assert.equal(esc('<div>'), '&lt;div&gt;');
      assert.equal(esc('a&b'), 'a&amp;b');
      assert.equal(esc('"test"'), '&quot;test&quot;');
      assert.equal(
        esc('<script>alert("xss")</script>'),
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
      );
      assert.equal(esc(''), '');
      assert.equal(esc(123), '123');
    });
  });

  describe('sqesc()', () => {
    test('单引号转义', () => {
      assert.equal(sqesc('hello'), "'hello'");
      assert.equal(sqesc("it's"), "'it\\'s'");
      assert.equal(sqesc("a'b'c"), "'a\\'b\\'c'");
      assert.equal(sqesc(''), "''");
    });
  });

  describe('getDaysInMonth()', () => {
    test('各月天数', () => {
      assert.equal(getDaysInMonth(2024, 1), 31);
      assert.equal(getDaysInMonth(2024, 3), 31);
      assert.equal(getDaysInMonth(2024, 4), 30);
      assert.equal(getDaysInMonth(2024, 6), 30);
      assert.equal(getDaysInMonth(2024, 12), 31);
    });

    test('闰年判断', () => {
      assert.equal(getDaysInMonth(2024, 2), 29);
      assert.equal(getDaysInMonth(2023, 2), 28);
      assert.equal(getDaysInMonth(2000, 2), 29);
      assert.equal(getDaysInMonth(1900, 2), 28);
    });
  });
});

describe('业务计算逻辑（仓位/手续费）', () => {
  test('做多仓位计算', () => {
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

  test('做空仓位计算', () => {
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

  test('手续费计算', () => {
    const posSize = 9000;
    const feeRate = 0.05 / 100;
    const openFee = posSize * feeRate;
    assert.ok(Math.abs(openFee - 4.5) < 0.01);

    const exitPrice = 43000;
    const actualLots = 2;
    const closeFee = exitPrice * actualLots * feeRate;
    assert.ok(Math.abs(closeFee - 43) < 0.01);
  });
});
