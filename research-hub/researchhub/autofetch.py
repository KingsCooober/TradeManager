"""自动抓取：按订阅规则定时拉取公开研报。

一个后台线程周期性检查「到点」的订阅，抓新内容入库；所有抓取都复用 feeds 里的
限流与解析逻辑，只访问公开页面，不绕过任何验证码 / 反爬 / 付费墙。

安全阀：
- 总开关默认关闭，不会在用户不知情时联网；
- 单次每条订阅最多 max_per_run 篇；
- 全库每日自动入库上限 autofetch_daily_limit，触顶后当天不再抓；
- 全局同一时刻只跑一个抓取任务，避免并发打爆来源站点。
"""

from __future__ import annotations

import threading
import time
from datetime import date, datetime, timedelta

from . import db, feeds

POLL_SECONDS = 20          # 调度线程轮询间隔
START_DELAY = 8            # 启动后先等一会再跑第一轮
LOG_KEEP = 300             # 日志保留条数

state = {
    "running": False,
    "current": "",
    "last_tick": "",
    "last_run_at": "",
    "last_error": "",
}
_run_lock = threading.Lock()
_stop = threading.Event()
_thread: threading.Thread | None = None


# ------------------------------------------------------------------ 订阅 CRUD

SUB_FIELDS = ("name", "source", "type", "org_code", "org_name", "keyword",
              "fetch_content", "max_per_run", "interval_minutes", "lookback_days", "enabled")
INT_FIELDS = ("fetch_content", "max_per_run", "interval_minutes", "lookback_days", "enabled")
BOUNDS = {
    "max_per_run": (1, feeds.MAX_ITEMS_PER_IMPORT),
    "interval_minutes": (5, 10080),
    "lookback_days": (1, 365),
}


def _row_to_sub(row) -> dict:
    item = dict(row)
    for key in INT_FIELDS:
        item[key] = int(item.get(key) or 0)
    item["enabled"] = bool(item["enabled"])
    item["fetch_content"] = bool(item["fetch_content"])
    return item


def list_subscriptions() -> list[dict]:
    rows = db.connect().execute(
        "SELECT * FROM subscriptions ORDER BY enabled DESC, id ASC"
    ).fetchall()
    return [_row_to_sub(r) for r in rows]


def get_subscription(sid: int) -> dict | None:
    row = db.connect().execute("SELECT * FROM subscriptions WHERE id=?", (sid,)).fetchone()
    return _row_to_sub(row) if row else None


def _clean_payload(payload: dict, *, partial: bool = False) -> dict:
    values: dict = {}
    for key in SUB_FIELDS:
        if key not in payload:
            continue
        value = payload[key]
        if key in INT_FIELDS:
            if key == "enabled":
                value = 1 if value in (True, 1, "1", "true", "on", "yes") else 0
            elif key == "fetch_content":
                value = 1 if value in (True, 1, "1", "true", "on", "yes") else 0
            else:
                try:
                    value = int(value)
                except (TypeError, ValueError):
                    continue
                low, high = BOUNDS.get(key, (0, 10 ** 6))
                value = max(low, min(high, value))
        else:
            value = str(value or "").strip()[:200]
        values[key] = value
    if not partial and not values.get("name"):
        source_label = feeds.SOURCE_BY_KEY.get(values.get("source", ""), {}).get("label", "研报")
        values["name"] = f"{source_label} · {values.get('type', '')}".strip(" ·") or "未命名订阅"
    return values


def create_subscription(payload: dict) -> dict:
    values = _clean_payload(payload)
    values.setdefault("source", "eastmoney")
    values.setdefault("type", "stock")
    if values["source"] not in feeds.SOURCE_BY_KEY:
        raise ValueError(f"暂不支持的来源：{values['source']}")
    valid_types = {t["key"] for t in feeds.SOURCE_BY_KEY[values["source"]]["types"]}
    if values["type"] not in valid_types:
        raise ValueError("该来源不支持这个研报类型")
    columns = list(values) + ["created_at"]
    params = list(values.values()) + [db.now()]
    conn = db.connect()
    cursor = conn.execute(
        f"INSERT INTO subscriptions ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        params,
    )
    conn.commit()
    return get_subscription(cursor.lastrowid)


def update_subscription(sid: int, payload: dict) -> dict | None:
    if get_subscription(sid) is None:
        return None
    values = _clean_payload(payload, partial=True)
    if "source" in values or "type" in values:
        current = get_subscription(sid)
        source = values.get("source", current["source"])
        type_key = values.get("type", current["type"])
        if source not in feeds.SOURCE_BY_KEY:
            raise ValueError(f"暂不支持的来源：{source}")
        if type_key not in {t["key"] for t in feeds.SOURCE_BY_KEY[source]["types"]}:
            raise ValueError("该来源不支持这个研报类型")
    if values:
        conn = db.connect()
        conn.execute(
            f"UPDATE subscriptions SET {', '.join(f'{k} = ?' for k in values)} WHERE id = ?",
            [*values.values(), sid],
        )
        conn.commit()
    return get_subscription(sid)


def delete_subscription(sid: int) -> bool:
    conn = db.connect()
    cursor = conn.execute("DELETE FROM subscriptions WHERE id=?", (sid,))
    conn.commit()
    return cursor.rowcount > 0


# ------------------------------------------------------------------ 调度

def due_subscriptions() -> list[dict]:
    rows = db.connect().execute(
        "SELECT * FROM subscriptions WHERE enabled = 1 AND ("
        "  last_run_at IS NULL OR last_run_at = '' OR "
        "  datetime(last_run_at, '+' || CAST(interval_minutes AS TEXT) || ' minutes') "
        "    <= datetime('now', 'localtime')"
        ") ORDER BY COALESCE(NULLIF(last_run_at, ''), '1970-01-01 00:00:00') ASC"
    ).fetchall()
    return [_row_to_sub(r) for r in rows]


def next_run_at() -> str:
    rows = db.connect().execute(
        "SELECT last_run_at, interval_minutes FROM subscriptions WHERE enabled = 1"
    ).fetchall()
    if not rows:
        return ""
    moments = []
    now = datetime.now()
    for row in rows:
        try:
            base = datetime.strptime(row["last_run_at"], "%Y-%m-%d %H:%M:%S") if row["last_run_at"] else now
        except ValueError:
            base = now
        moments.append(base + timedelta(minutes=int(row["interval_minutes"] or 60)))
    nxt = min(moments)
    return nxt.strftime("%Y-%m-%d %H:%M:%S") if nxt > now else db.now()


def _setting_int(key: str, default: int) -> int:
    try:
        return int(db.get_settings().get(key) or default)
    except (TypeError, ValueError):
        return default


def daily_created() -> int:
    today = date.today().isoformat()
    row = db.connect().execute(
        "SELECT COUNT(*) AS c FROM reports WHERE source_type = 'auto' AND substr(created_at, 1, 10) = ?",
        (today,),
    ).fetchone()
    return row["c"]


def recent_logs(limit: int = 20) -> list[dict]:
    rows = db.connect().execute(
        "SELECT * FROM autofetch_logs ORDER BY id DESC LIMIT ?", (max(1, min(limit, 100)),)
    ).fetchall()
    return [dict(r) for r in rows]


def _log(entry: dict) -> None:
    conn = db.connect()
    columns = list(entry)
    conn.execute(
        f"INSERT INTO autofetch_logs ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        list(entry.values()),
    )
    conn.execute(
        "DELETE FROM autofetch_logs WHERE id NOT IN "
        "(SELECT id FROM autofetch_logs ORDER BY id DESC LIMIT ?)", (LOG_KEEP,)
    )
    conn.commit()


# ------------------------------------------------------------------ 执行

def run_subscription(sub: dict, trigger: str = "auto", daily_remaining: int | None = None) -> dict:
    """执行一条订阅：抓新内容入库。返回本次结果（同时写日志）。"""
    started = db.now()
    conn = db.connect()
    found = created = skipped = failed = 0
    message = ""
    status = "ok"
    created_ids: list[int] = []

    if daily_remaining is None:
        daily_remaining = _setting_int("autofetch_daily_limit", 30) - daily_created()
    if daily_remaining <= 0:
        result = {"status": "skipped", "found": 0, "created": 0, "skipped": 0, "failed": 0,
                  "message": "已达今日自动入库上限，明天再继续"}
        _log({"sub_id": sub["id"], "sub_name": sub["name"], "trigger": trigger,
              "started_at": started, "finished_at": db.now(), **result})
        _touch_sub(sub["id"], result)
        return result

    try:
        begin = (date.today() - timedelta(days=int(sub["lookback_days"] or 7))).isoformat()
        outcome = feeds.search(
            source=sub["source"], type_key=sub["type"], org_code=sub["org_code"],
            begin=begin, end=date.today().isoformat(), keyword=sub["keyword"],
            page=1, page_size=20,
        )
        items = outcome.get("items") or []
        if outcome.get("warning"):
            message = outcome["warning"]
            status = "partial"
        found = len(items)

        fresh = []
        for item in items:
            exists = conn.execute(
                "SELECT 1 FROM reports WHERE source_file = ? AND source_type IN ('feed', 'auto', 'backfill')",
                (item["id"],),
            ).fetchone()
            if exists:
                skipped += 1
            else:
                fresh.append(item)

        limit = min(int(sub["max_per_run"] or 5), daily_remaining)
        for index, item in enumerate(fresh[:limit]):
            content, url, note = "", item["url"], ""
            if sub["fetch_content"]:
                if index:
                    feeds.polite_sleep(feeds.SINA_GAP if sub["source"] == "sina" else feeds.REQUEST_GAP)
                try:
                    fetched = feeds.fetch_content(item)
                    content, url = fetched["content"], fetched["url"]
                    if not content:
                        note = "来源页面未提供公开正文"
                except feeds.FeedError as exc:
                    failed += 1
                    note = f"正文抓取失败：{exc}"
            markdown = feeds.build_markdown(item, content)
            tags = [t for t in [item.get("type_label"), "自动抓取"] if t]
            values = {
                "title": item["title"] or "未命名研报",
                "org": item["org"], "authors": item["authors"], "industry": item["industry"],
                "rating": item["rating"], "target_price": "", "stock_code": item["stock_code"],
                "report_date": item["date"], "source_type": "auto", "source_file": item["id"],
                "source_url": url, "page_count": item.get("pages") or 0,
                "word_count": len(markdown.replace(" ", "").replace("\n", "")),
                "content": markdown,
                "summary": feeds.make_summary(content) or note,
                "key_points": "[]", "key_data": "[]",
                "risks": "", "ai_model": "", "ai_updated_at": "",
                "tags": db.json_dump(tags), "starred": 0, "read_status": "unread",
                "created_at": db.now(), "updated_at": db.now(),
            }
            cursor = conn.execute(
                f"INSERT INTO reports ({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
                list(values.values()),
            )
            conn.commit()
            created += 1
            created_ids.append(cursor.lastrowid)
            if note:
                message = (message + "；" if message else "") + note

        remaining = limit - len(fresh[:limit])
        if remaining > 0 and fresh:
            message = (message + "；" if message else "") + f"还有 {remaining} 篇留到下次"

    except feeds.FeedError as exc:
        status, message = "error", str(exc)
    except Exception as exc:  # noqa: BLE001 — 调度线程不能让单条订阅的异常炸掉整个循环
        status, message = "error", f"{type(exc).__name__}: {exc}"

    result = {"status": status, "found": found, "created": created, "skipped": skipped,
              "failed": failed, "message": message[:500], "report_ids": created_ids}
    _log({"sub_id": sub["id"], "sub_name": sub["name"], "trigger": trigger,
          "started_at": started, "finished_at": db.now(),
          "status": status, "found": found, "created": created,
          "skipped": skipped, "failed": failed, "message": result["message"]})
    _touch_sub(sub["id"], result)
    return result


def _touch_sub(sid: int, result: dict) -> None:
    conn = db.connect()
    conn.execute(
        "UPDATE subscriptions SET last_run_at = ?, last_status = ?, last_message = ?, "
        "last_created = ?, total_created = total_created + ? WHERE id = ?",
        (db.now(), result["status"], result.get("message", "")[:500],
         result.get("created", 0), result.get("created", 0), sid),
    )
    conn.commit()


def run_now(sub_id: int | None = None, trigger: str = "manual", force: bool = False) -> dict:
    """立即执行。force=True 时无视时间表，跑所有启用的订阅；否则只跑到点的。"""
    if not _run_lock.acquire(blocking=False):
        return {"busy": True, "message": "已有抓取任务在运行，请稍候", "results": []}

    state["running"] = True
    state["last_run_at"] = db.now()
    results = []
    try:
        if sub_id is not None:
            sub = get_subscription(sub_id)
            if sub is None:
                return {"busy": False, "message": "订阅不存在", "results": []}
            subs = [sub]
        elif force:
            subs = [s for s in list_subscriptions() if s["enabled"]]
        else:
            subs = due_subscriptions()
        remaining = _setting_int("autofetch_daily_limit", 30) - daily_created()
        for sub in subs:
            state["current"] = sub["name"]
            try:
                results.append({"id": sub["id"], "name": sub["name"],
                                **run_subscription(sub, trigger=trigger, daily_remaining=remaining)})
            except Exception as exc:  # noqa: BLE001
                state["last_error"] = str(exc)
                results.append({"id": sub["id"], "name": sub["name"], "status": "error",
                                "created": 0, "message": f"{type(exc).__name__}: {exc}"})
            remaining = _setting_int("autofetch_daily_limit", 30) - daily_created()
            if remaining <= 0:
                break
        return {"busy": False, "results": results,
                "created": sum(r.get("created", 0) for r in results),
                "message": "" if results else (
                    "没有启用的订阅" if force else "没有到点的订阅（可点「立即抓取」强制跑一轮）")}
    finally:
        state["current"] = ""
        state["running"] = False
        _run_lock.release()


def tick() -> None:
    state["last_tick"] = db.now()
    if db.get_settings().get("autofetch_enabled") != "1":
        return
    from . import backfill
    if backfill.JOB.get("running"):
        return          # 批量回填进行中，先让路，避免同时打来源站点
    due = due_subscriptions()
    if not due:
        return
    outcome = run_now(trigger="auto")
    if outcome.get("busy"):
        return
    created = outcome.get("created", 0)
    if created:
        state["last_error"] = ""
        print(f"  [自动抓取] 新增 {created} 篇研报")


# ------------------------------------------------------------------ 线程

def _loop() -> None:
    _stop.wait(START_DELAY)
    while not _stop.is_set():
        try:
            tick()
        except Exception as exc:  # noqa: BLE001
            state["last_error"] = f"{type(exc).__name__}: {exc}"
        _stop.wait(POLL_SECONDS)


def start() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="autofetch", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()


def status() -> dict:
    settings = db.get_settings()
    subs = list_subscriptions()
    limit = _setting_int("autofetch_daily_limit", 30)
    used = daily_created()
    return {
        "enabled": settings.get("autofetch_enabled") == "1",
        "daily_limit": limit,
        "today_created": used,
        "next_run_at": next_run_at() if settings.get("autofetch_enabled") == "1" else "",
        "running": state["running"],
        "current": state["current"],
        "last_tick": state["last_tick"],
        "last_run_at": state["last_run_at"],
        "last_error": state["last_error"],
        "subscription_count": len(subs),
        "enabled_count": sum(1 for s in subs if s["enabled"]),
        "total_auto_reports": db.connect().execute(
            "SELECT COUNT(*) AS c FROM reports WHERE source_type = 'auto'"
        ).fetchone()["c"],
    }
