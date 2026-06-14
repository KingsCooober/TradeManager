'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { setupBrowserMock, teardownBrowserMock, loadFrontendScripts } = require('../helpers/browser-mock');

describe('utils.js 纯函数测试', () => {
  before(() => {
    setupBrowserMock();
    loadFrontendScripts(['utils.js']);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('generateUUID()', () => {
    test('返回字符串且长度为 36 个字符', () => {
      const uuid = generateUUID();
      assert.equal(typeof uuid, 'string');
      assert.equal(uuid.length, 36);
    });

    test('包含 4 个连字符', () => {
      const uuid = generateUUID();
      const hyphens = (uuid.match(/-/g) || []).length;
      assert.equal(hyphens, 4);
    });

    test('格式匹配 xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx', () => {
      const uuid = generateUUID();
      assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    test('连续调用生成不同的 UUID', () => {
      const uuids = new Set();
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID());
      }
      assert.equal(uuids.size, 100);
    });
  });

  describe('getToday()', () => {
    test('返回 YYYY-MM-DD 格式的字符串', () => {
      const today = getToday();
      assert.equal(typeof today, 'string');
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
    });

    test('日期等于当前日期', () => {
      const today = getToday();
      const expected = new Date().toISOString().slice(0, 10);
      assert.equal(today, expected);
    });
  });

  describe('formatNumber()', () => {
    test('正数格式化带千位分隔符', () => {
      assert.equal(formatNumber(1234.5), '1,234.50');
      assert.equal(formatNumber(1000000), '1,000,000.00');
    });

    test('零值', () => {
      assert.equal(formatNumber(0), '0.00');
    });

    test('负数', () => {
      assert.equal(formatNumber(-999.1), '-999.10');
    });

    test('保留两位小数', () => {
      assert.equal(formatNumber(3.14159), '3.14');
    });

    test('NaN 返回 -', () => {
      assert.equal(formatNumber(NaN), '-');
    });

    test('null 返回 -', () => {
      assert.equal(formatNumber(null), '-');
    });

    test('undefined 返回 -', () => {
      assert.equal(formatNumber(undefined), '-');
    });
  });

  describe('CNY()', () => {
    test('正常金额带 ￥ 后缀', () => {
      assert.equal(CNY(1234.5), '1,234.50 ￥');
      assert.equal(CNY(100000), '100,000.00 ￥');
    });

    test('零值', () => {
      assert.equal(CNY(0), '0.00 ￥');
    });

    test('负数', () => {
      assert.equal(CNY(-500), '-500.00 ￥');
    });

    test('null/undefined/NaN 返回 -', () => {
      assert.equal(CNY(null), '-');
      assert.equal(CNY(undefined), '-');
      assert.equal(CNY(NaN), '-');
    });
  });

  describe('CNYW() 万元/亿元格式化', () => {
    test('零显示 0', () => {
      assert.equal(CNYW(0), '0');
    });

    test('万元单位', () => {
      assert.equal(CNYW(100000), '10.0万');
      assert.equal(CNYW(150000), '15.0万');
    });

    test('千元', () => {
      assert.equal(CNYW(5000), '0.50万');
    });

    test('百元', () => {
      assert.equal(CNYW(100), '0.01万');
    });

    test('亿元单位', () => {
      assert.equal(CNYW(100000000), '1.00亿');
      assert.equal(CNYW(1000000000), '10.00亿');
    });

    test('负数', () => {
      assert.equal(CNYW(-100000), '-10.0万');
    });

    test('null/undefined/NaN 返回 -', () => {
      assert.equal(CNYW(null), '-');
      assert.equal(CNYW(undefined), '-');
      assert.equal(CNYW(NaN), '-');
    });
  });

  describe('fmtR() R值格式化', () => {
    test('正数带 + 号', () => {
      assert.equal(fmtR(1.5), '+1.50R');
      assert.equal(fmtR(10), '+10.00R');
    });

    test('零值', () => {
      assert.equal(fmtR(0), '+0.00R');
    });

    test('负数带 - 号', () => {
      assert.equal(fmtR(-2.3), '-2.30R');
    });

    test('小数值', () => {
      assert.equal(fmtR(0.01), '+0.01R');
    });

    test('null/NaN 返回 -', () => {
      assert.equal(fmtR(null), '-');
      assert.equal(fmtR(NaN), '-');
    });
  });

  describe('esc() HTML 转义', () => {
    test('普通字符串不变', () => {
      assert.equal(esc('hello'), 'hello');
    });

    test('尖括号转义', () => {
      assert.equal(esc('<div>'), '&lt;div&gt;');
    });

    test('和号转义', () => {
      assert.equal(esc('a&b'), 'a&amp;b');
    });

    test('双引号转义', () => {
      assert.equal(esc('"test"'), '&quot;test&quot;');
    });

    test('XSS 防护', () => {
      assert.equal(
        esc('<script>alert("xss")</script>'),
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
      );
    });

    test('空字符串', () => {
      assert.equal(esc(''), '');
    });

    test('数字自动转字符串', () => {
      assert.equal(esc(123), '123');
    });
  });

  describe('sqesc() 单引号转义', () => {
    test('普通字符串加引号', () => {
      assert.equal(sqesc('hello'), "'hello'");
    });

    test('单引号转义', () => {
      assert.equal(sqesc("it's"), "'it\\'s'");
    });

    test('多个单引号', () => {
      assert.equal(sqesc("a'b'c"), "'a\\'b\\'c'");
    });

    test('空字符串', () => {
      assert.equal(sqesc(''), "''");
    });
  });

  describe('getYearRange()', () => {
    test('返回 11 年（前后 5 年 + 当前）', () => {
      const years = getYearRange();
      assert.equal(years.length, 11);
    });

    test('包含当前年', () => {
      const years = getYearRange();
      const currentYear = new Date().getFullYear();
      assert.ok(years.includes(currentYear));
    });

    test('范围是前后各 5 年', () => {
      const years = getYearRange();
      const currentYear = new Date().getFullYear();
      assert.equal(Math.min(...years), currentYear - 5);
      assert.equal(Math.max(...years), currentYear + 5);
    });
  });

  describe('getDaysInMonth()', () => {
    test('1月 31天', () => {
      assert.equal(getDaysInMonth(2024, 1), 31);
    });

    test('闰年 2月 29天', () => {
      assert.equal(getDaysInMonth(2024, 2), 29);
    });

    test('非闰年 2月 28天', () => {
      assert.equal(getDaysInMonth(2023, 2), 28);
    });

    test('4月 30天', () => {
      assert.equal(getDaysInMonth(2024, 4), 30);
    });

    test('12月 31天', () => {
      assert.equal(getDaysInMonth(2024, 12), 31);
    });

    test('2000年 2月（世纪闰年）29天', () => {
      assert.equal(getDaysInMonth(2000, 2), 29);
    });

    test('1900年 2月（世纪非闰年）28天', () => {
      assert.equal(getDaysInMonth(1900, 2), 28);
    });
  });

  describe('calcTpDist() 目标距离计算', () => {
    test('正常计算', () => {
      const t = { entry: 100, target: 110 };
      assert.equal(calcTpDist(t), '10.00%');
    });

    test('缺少 entry 返回 -', () => {
      assert.equal(calcTpDist({ target: 110 }), '-');
    });

    test('缺少 target 返回 -', () => {
      assert.equal(calcTpDist({ entry: 100 }), '-');
    });

    test('空 entry 返回 -', () => {
      assert.equal(calcTpDist({ entry: '', target: 110 }), '-');
    });

    test('字符串数字能正确解析', () => {
      const t = { entry: '100', target: '105' };
      assert.equal(calcTpDist(t), '5.00%');
    });
  });

  describe('calcExitDist() 出场距离计算', () => {
    test('正收益带 +', () => {
      const t = { entry: 100, exit: 110 };
      assert.equal(calcExitDist(t), '+10.00%');
    });

    test('负收益带 -', () => {
      const t = { entry: 100, exit: 90 };
      assert.equal(calcExitDist(t), '-10.00%');
    });

    test('平局', () => {
      const t = { entry: 100, exit: 100 };
      assert.equal(calcExitDist(t), '+0.00%');
    });

    test('缺少 entry 返回 -', () => {
      assert.equal(calcExitDist({ exit: 110 }), '-');
    });

    test('缺少 exit 返回 -', () => {
      assert.equal(calcExitDist({ entry: 100 }), '-');
    });
  });
});
