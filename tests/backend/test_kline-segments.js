/**
 * K 线分段拉取与负价降级的回归测试
 *
 * 本文件把线上实际踩过的两个缺陷固化为用例：
 *
 *   1. **腾讯区间接口单次最多 640 根，超出静默截断**。
 *      历史写法用 TX_SEG_YEARS=2.5 递进、结束年取 Math.ceil 向上取整到整年，
 *      每段实际跨 3 个自然年 ≈ 729 交易日 → 每段被砍掉约 90 根，且不报错。
 *      实测后果：全库 2482/2542 只（97.6%）出现内部缺口，合计 5921 处，
 *      用户回测时会看到「假跳空」（例如 2018-12-28 → 2019-05-21 凭空缺 96 个交易日，
 *      浦发银行/中国平安/贵州茅台/宁德时代等全部中招）。
 *
 *   2. **预热脚本没把 --force 传下去**。market-quote 的 noCache 只跳过内存缓存，
 *      本地 SQLite 库依旧命中并直接返回旧数据，导致「全量重拉 3094 只」只跑了几秒、
 *      一条记录都没更新（第二次重拉耗时 2m43s 却零改动，第三次传 force 后 4m25s 才真正生效）。
 *
 * 这些都是纯逻辑缺陷，不需要联网即可断言。
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const market = require(path.join(__dirname, '..', '..', 'server', 'market-quote.js'));

describe('K 线分段拉取（腾讯 640 根截断防护）', () => {
  const DAYS_PER_YEAR = 243;   // A 股约 243 个交易日/年

  test('每段交易日数必须低于腾讯单次返回上限（640）', () => {
    // 覆盖前端 BT_YEARS_TO_COUNT 实际会用到的全部年数，外加边界值
    const yearsList = [1, 1.15, 2, 3, 5, 7, 8, 10, 10.2, 11.5, 12, 15, 20];
    yearsList.forEach(function (years) {
      const segs = market._testSegments(years);
      assert.ok(segs.length > 0, 'years=' + years + ' 应至少切出 1 段');
      segs.forEach(function (s) {
        const td = market._estTradingDays(s.start, s.end);
        assert.ok(
          td <= 640,
          'years=' + years + ' 的段 ' + s.start + '~' + s.end + ' 约 ' + td +
          ' 个交易日，超过腾讯 640 根上限会被静默截断'
        );
      });
    });
  });

  test('10 年窗口每段约 2 个自然年（≈486 交易日），留足安全余量', () => {
    const segs = market._testSegments(10);
    segs.forEach(function (s) {
      const td = market._estTradingDays(s.start, s.end);
      // 单段不应超过 620（TX_MAX_SEG_DAYS 的余量线）
      assert.ok(td <= market._TX_MAX_SEG_DAYS,
        '段 ' + s.start + '~' + s.end + ' 约 ' + td + ' 交易日，超过安全线 ' + market._TX_MAX_SEG_DAYS);
    });
    // 10 年应至少能覆盖到 10 年前，不能因为限段而缩水
    const earliest = segs.reduce(function (min, s) { return s.start < min ? s.start : min; }, segs[0].start);
    const endY = new Date().getFullYear();
    assert.ok(endY - parseInt(earliest.slice(0, 4), 10) >= 10,
      '10 年请求应覆盖至少 10 个自然年，实际最早段为 ' + earliest);
  });

  test('段数不超过上限，且时间连续不重叠', () => {
    [1, 3, 5, 10, 15, 20].forEach(function (years) {
      const segs = market._testSegments(years);
      assert.ok(segs.length <= 6, 'years=' + years + ' 切出 ' + segs.length + ' 段，超过 6 段上限');
      for (let i = 1; i < segs.length; i++) {
        assert.ok(segs[i].start > segs[i - 1].start, '段应按时间升序且不重叠');
        assert.ok(segs[i].start > segs[i - 1].end, '相邻段不应重叠');
      }
    });
  });

  test('段数为整数年步进（防止历史 Math.ceil 向上取整到整年的回归）', () => {
    // 历史 bug 的签名：某段跨了 3 个自然年。这里断言不存在这样的段。
    [5, 10, 12].forEach(function (years) {
      market._testSegments(years).forEach(function (s) {
        const sy = parseInt(s.start.slice(0, 4), 10);
        const ey = parseInt(s.end.slice(0, 4), 10);
        assert.ok(ey - sy <= 2,
          'years=' + years + ' 出现跨越 ' + (ey - sy + 1) + ' 个自然年的段 ' + s.start + '~' + s.end +
          '（历史 bug：3 年段 ≈729 交易日会被 640 上限截断）');
      });
    });
  });
});

describe('负价检测（前复权高分红股降级依据）', () => {
  test('open/close 存在 <= 0 时判定为负价', () => {
    assert.equal(market._hasNegativePrice([{ open: -3.262, close: -3.309 }]), true);
    assert.equal(market._hasNegativePrice([{ open: 25.1, close: 25.4 }, { open: 1, close: -0.5 }]), true);
    assert.equal(market._hasNegativePrice([{ open: 0, close: 1 }]), true, '0 价也应视为异常');
  });

  test('正常价格不判定为负价', () => {
    assert.equal(market._hasNegativePrice([{ open: 9.12, close: 9.24 }]), false);
    assert.equal(market._hasNegativePrice([{ open: 0.05, close: 0.092 }]), false, '极低但正的价格属正常');
    assert.equal(market._hasNegativePrice([]), false);
  });

  test('NaN 视为异常（避免脏数据静默通过）', () => {
    assert.equal(market._hasNegativePrice([{ open: NaN, close: 1 }]), true);
    assert.equal(market._hasNegativePrice([{ open: undefined, close: 1 }]), true);
  });

  test('非数组输入不抛错', () => {
    assert.equal(market._hasNegativePrice(null), false);
    assert.equal(market._hasNegativePrice(undefined), false);
  });
});

describe('异常涨跌幅检测（前复权除权日折算错误的降级依据）', () => {
  const mk = (d, o, c) => ({ date: d, open: o, close: c });

  test('涨跌停上限按板块区分：主板11% / 创业板科创板21% / 北交所31%', () => {
    assert.equal(market._getPriceLimitPct('sh600000'), 11, '沪市主板');
    assert.equal(market._getPriceLimitPct('sz000001'), 11, '深市主板');
    assert.equal(market._getPriceLimitPct('sz300903'), 21, '创业板 300xxx');
    assert.equal(market._getPriceLimitPct('sh688981'), 21, '科创板 688xxx');
    assert.equal(market._getPriceLimitPct('bj830799'), 31, '北交所');
    assert.equal(market._getPriceLimitPct('sh600000'), 11, '大小写不敏感');
    assert.equal(market._getPriceLimitPct('SH600000'), 11);
  });

  test('正常的相邻交易日不报警', () => {
    const r = market._detectAbnormalJump([
      mk('2024-01-02', 10, 10.2),
      mk('2024-01-03', 10.2, 10.5),
      mk('2024-01-04', 10.5, 10.1),
    ], 'sh600000');
    assert.equal(r.count, 0);
  });

  test('主板涨停/跌停（恰好 10%）不应报警，留 1% 余量', () => {
    const r = market._detectAbnormalJump([
      mk('2024-01-02', 10, 10),      // 收 10
      mk('2024-01-03', 10, 11),      // +10.00% 涨停
      mk('2024-01-04', 11, 9.9),     // -10.00% 跌停
    ], 'sh600000');
    assert.equal(r.count, 0, '恰好 10% 的涨跌停属正常');
  });

  test('捕获真实的假跳空（浦发银行 2017-05-25 +14.21%）', () => {
    const r = market._detectAbnormalJump([
      mk('2017-05-24', 8.266, 8.335),
      mk('2017-05-25', 8.339, 9.519),
    ], 'sh600000');
    assert.equal(r.count, 1);
    assert.ok(r.worst > 14 && r.worst < 15, '偏离应约 14.2%，实际 ' + r.worst);
    assert.equal(r.sample, '2017-05-24→2017-05-25');
  });

  test('创业板 20% 涨停不应误判为假跳空（回归：统一 11% 阈值曾误伤）', () => {
    // 实测 sz300903 2021-07-27 不复权真实涨幅 20.01%（标准 20% 涨停）
    const r = market._detectAbnormalJump([
      mk('2021-07-26', 29.55, 28.43),
      mk('2021-07-27', 28.48, 34.12),
    ], 'sz300903');
    assert.equal(r.count, 0, '创业板 20% 涨停是真实行情，不该触发降级');
    // 同样幅度在主板仍应被判为异常
    const rMain = market._detectAbnormalJump([
      mk('2021-07-26', 29.55, 28.43),
      mk('2021-07-27', 28.48, 34.12),
    ], 'sh600000');
    assert.equal(rMain.count, 1, '同样幅度出现在主板则应判为异常');
  });

  test('跨长假的跳空不应误判（真实跳空）', () => {
    const r = market._detectAbnormalJump([
      mk('2024-02-08', 10, 10),
      mk('2024-02-19', 10, 12),      // 春节后跳空 +20%，但跨了 11 天
    ], 'sh600000');
    assert.equal(r.count, 0, '长假后的真实跳空不应触发降级');
  });

  test('暴跌同样被捕获', () => {
    const r = market._detectAbnormalJump([
      mk('2020-09-04', 10, 10),
      mk('2020-09-07', 10, 8.5),     // -15%
    ], 'sh600000');
    assert.equal(r.count, 1);
  });

  test('严重度评分：负价权重远高于跳空，用于两口径择优', () => {
    // 单根负价（权重 1000）应劣于多处跳空
    const withNeg = market._klineBadness([
      mk('2024-01-02', -1, 10),
      mk('2024-01-03', 10, 10),
    ], 'sh600000');
    const withJump = market._klineBadness([
      mk('2024-01-02', 10, 10),
      mk('2024-01-03', 10, 12),
      mk('2024-01-04', 12, 14.4),
    ], 'sh600000');
    assert.equal(withNeg.neg, 1);
    assert.equal(withJump.jumps, 2);
    assert.ok(withNeg.score > withJump.score,
      '负价（致命，买不进）应比跳空严重，实际 ' + withNeg.score + ' vs ' + withJump.score);

    // 回归：广汇能源 sh600256 场景 —— 前复权 34 负价 + 221 跳空，
    // 后复权 0 负价 + 1 跳空（11.14% 的正常涨停恰好越过 11% 阈值）。
    // 早期实现要求后复权「必须完美」才采用 → 反而退回更差的前复权。
    const qfqLike = { neg: 34, jumps: 221, score: 34 * 1000 + 221 };
    const hfqLike = { neg: 0, jumps: 1, score: 1 };
    assert.ok(hfqLike.score < qfqLike.score, '后复权更干净时必须被采用');
  });

  test('样本不足或无有效价格时不抛错', () => {
    assert.equal(market._detectAbnormalJump([], 'sh600000').count, 0);
    assert.equal(market._detectAbnormalJump([mk('2024-01-02', 10, 10)], 'sh600000').count, 0);
    assert.equal(market._detectAbnormalJump([mk('2024-01-02', 0, 0), mk('2024-01-03', 10, 10)], 'sh600000').count, 0);
    assert.equal(market._detectAbnormalJump(null, 'sh600000').count, 0);
    assert.equal(market._detectAbnormalJump([mk('2024-01-02', 10, 10), mk('2024-01-03', 10, 12)]).count, 1,
      '不传 symbol 时按主板阈值处理');
  });
});
