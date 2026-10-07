#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 Baostock 重算「指定交易日」的全市场涨跌家数 / 涨跌停家数。

背景：新浪/东财的涨跌家数接口只有当日实时数据，历史某天缺失时无法直接补。
      Baostock 覆盖 1990-至今全部 A 股日 K，可离线重算任意历史交易日。

用法：
  python3 bs-activity.py 2026-08-31            # 全量统计
  python3 bs-activity.py 2026-09-01 --limit 300  # 只跑前 300 只（快速验证脚本逻辑）

输出：stdout 最后一行是 JSON 结果（便于 shell 解析），进度信息走 stderr。

关键实现细节（踩过的坑）：
  1) 涨跌幅必须用 Baostock 官方的 pctChg 字段，不要用 (close/preclose-1) 自己算 ——
     preclose 对停牌/新股经常返回空或 0，自算会得到 +100% 的假涨停。
  2) 必须过滤 tradestatus != '1'（停牌）和空 pctChg 的记录。
  3) 涨停阈值按板块区分：主板 10% / 创业板·科创板 20% / ST 5%，
     留 0.3% 容差（价格四舍五入导致实际涨停幅度可能是 9.90%~10.05%）。
"""
import sys
import json
import baostock as bs


def is_a_stock(code):
    """只统计 A 股：沪主板(60/688)、深主板(00)、创业板(30)。排除 BJ、指数、基金、债券。"""
    if code.startswith('sh.6'):
        return True      # 沪市 60 主板 + 688 科创板
    if code.startswith('sz.00'):
        return True      # 深主板
    if code.startswith('sz.30'):
        return True      # 创业板
    return False


def limit_pct(code, is_st):
    if code.startswith('sz.30') or code.startswith('sh.688'):
        return 20.0
    if is_st == '1':
        return 5.0
    return 10.0


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if not args:
        print('用法: python3 bs-activity.py YYYY-MM-DD [--limit N]', file=sys.stderr)
        sys.exit(1)
    date = args[0]
    limit_n = 0
    if '--limit' in sys.argv:
        limit_n = int(sys.argv[sys.argv.index('--limit') + 1])

    lg = bs.login()
    if lg.error_code != '0':
        print('登录失败: ' + lg.error_msg, file=sys.stderr)
        sys.exit(1)

    rs = bs.query_all_stock(day=date)
    all_stocks = []
    while (rs.error_code == '0') and rs.next():
        all_stocks.append(rs.get_row_data())
    print('[%s] query_all_stock 返回 %d 条' % (date, len(all_stocks)), file=sys.stderr)
    if not all_stocks:
        print('❌ 该日期无股票列表（非交易日？）', file=sys.stderr)
        bs.logout()
        sys.exit(2)

    targets = [s for s in all_stocks if is_a_stock(s[0])]
    print('[%s] A 股目标 %d 只' % (date, len(targets)), file=sys.stderr)
    if limit_n:
        targets = targets[:limit_n]
        print('[调试模式] 只处理前 %d 只' % limit_n, file=sys.stderr)

    up = down = flat = 0
    zt = dt = 0
    skipped = 0
    halted = 0
    total = len(targets)

    for i, item in enumerate(targets):
        code = item[0]
        krs = bs.query_history_k_data_plus(
            code,
            'date,code,close,preclose,pctChg,isST,tradestatus',
            start_date=date, end_date=date,
            frequency='d', adjustflag='3'
        )
        rows = []
        while (krs.error_code == '0') and krs.next():
            rows.append(krs.get_row_data())
        if not rows:
            skipped += 1
            continue
        r = rows[0]
        # 停牌：tradestatus != '1'（1 = 正常交易）
        if len(r) > 6 and r[6] != '1':
            halted += 1
            continue
        try:
            pct = float(r[4])
        except (TypeError, ValueError, IndexError):
            skipped += 1
            continue

        if pct > 0:
            up += 1
        elif pct < 0:
            down += 1
        else:
            flat += 1

        th = limit_pct(code, r[5] if len(r) > 5 else '0') - 0.3
        if pct >= th:
            zt += 1
        elif pct <= -th:
            dt += 1

        if (i + 1) % 500 == 0:
            print('  进度 %d/%d  涨%d 跌%d 涨停%d 跌停%d' % (i + 1, total, up, down, zt, dt), file=sys.stderr)

    bs.logout()
    result = {
        'date': date,
        'up_count': up,
        'down_count': down,
        'flat_count': flat,
        'zt_count': zt,
        'dt_count': dt,
        'zt_dt_diff': zt - dt,
        'sample_size': up + down + flat,
        'skipped': skipped,
        'halted': halted,
        'source': 'baostock-recalc'
    }
    print(json.dumps(result, ensure_ascii=False))   # stdout 最后一行 = JSON


if __name__ == '__main__':
    main()
