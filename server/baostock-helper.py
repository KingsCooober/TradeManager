#!/usr/bin/env python3
# Baostock 数据拉取 helper
# 入参：code start_date end_date frequency adjustflag
# 输出：stdout 只输出一行 JSON 数组 [{date, open, high, low, close, volume, amount}]
#       baostock 自带的 login/logout 等日志全部走 stderr

import sys
import json
import baostock as bs


def main():
    if len(sys.argv) < 6:
        sys.stderr.write('usage: baostock-helper.py <code> <start> <end> <freq> <adj>\n')
        sys.exit(1)

    code = sys.argv[1]
    start_date = sys.argv[2]
    end_date = sys.argv[3]
    frequency = sys.argv[4]
    adjustflag = sys.argv[5]

    # 关键：把 baostock 的 stdout 临时重定向到 stderr
    # 让 baostock 内部的 print("login success!") 等不污染 stdout
    saved_stdout = sys.stdout
    sys.stdout = sys.stderr

    try:
        lg = bs.login()
        if lg.error_code != '0':
            sys.stdout = saved_stdout
            print(json.dumps({"error": "login failed: " + lg.error_msg}))
            sys.exit(2)

        rs = bs.query_history_k_data_plus(
            code,
            'date,open,high,low,close,volume,amount',
            start_date,
            end_date,
            frequency,
            adjustflag
        )
        rows = []
        while rs.error_code == '0' and rs.next():
            r = rs.get_row_data()
            rows.append({
                'date':   r[0],
                'open':   r[1],
                'high':   r[2],
                'low':    r[3],
                'close':  r[4],
                'volume': r[5],
                'amount': r[6]
            })
        if rs.error_code != '0':
            sys.stdout = saved_stdout
            print(json.dumps({"error": "query error: " + rs.error_msg}))
            sys.exit(3)

        bs.logout()
    finally:
        # 还原 stdout
        sys.stdout = saved_stdout

    # stdout 只输出一行 JSON
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == '__main__':
    main()
