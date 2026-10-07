"""批量回填：按主题 / 行业关键词，把指定时间范围内的公开研报成批导入。

两条流水线：
1. 扫描阶段——逐页翻来源列表，命中主题关键词的先建条目（只存元数据，很快）；
2. 补正文阶段——再回头给这批新条目逐篇抓公开正文（慢，但可中断、可续跑）。

去重口径与自动抓取一致（按来源研报编号），所以任务中断后再跑只会补差集。
"""

from __future__ import annotations

import re
import threading
import time
from datetime import date, timedelta

from . import db, feeds

MAX_PAGES_PER_COMBO = 60      # 每个（来源,类型）组合最多翻多少页
MAX_CREATE_PER_JOB = 4000     # 单次任务最多入库多少篇，防止手滑
LOG_KEEP = 60

# ------------------------------------------------------------------ 主题包

THEMES = [
    {
        "key": "15th5",
        "name": "十五五规划方向",
        "note": "科技自立自强、新质生产力、未来产业、绿色低碳等规划重点方向",
        "keywords": [
            "半导体", "集成电路", "芯片", "晶圆", "光刻", "封测", "EDA", "存储芯片",
            "人工智能", "AI", "算力", "大模型", "智能体", "具身智能", "人形机器人", "机器人",
            "工业母机", "数控机床", "高端装备", "精密仪器", "科学仪器", "智能制造",
            "信创", "基础软件", "操作系统", "工业软件", "数据库", "网络安全",
            "新材料", "先进材料", "碳纤维", "稀土", "超导", "石墨烯",
            "创新药", "生物制造", "合成生物", "医疗器械", "基因", "细胞治疗", "脑机接口",
            "光伏", "风电", "储能", "氢能", "核电", "核聚变", "特高压", "智能电网", "固态电池",
            "新能源汽车", "智能驾驶", "自动驾驶", "车规", "汽车零部件",
            "商业航天", "卫星互联网", "低空经济", "无人机", "eVTOL",
            "深海科技", "海洋经济", "海工装备", "船舶",
            "量子", "6G", "光通信", "卫星通信",
            "军工", "国防", "航空发动机",
            "数据要素", "数字经济", "东数西算", "智算",
            "种业", "转基因",
            "碳中和", "节能环保", "循环经济",
        ],
    },
    {
        "key": "tech",
        "name": "科技自立自强",
        "note": "卡脖子环节与国产替代",
        "keywords": ["半导体", "集成电路", "芯片", "光刻", "EDA", "工业母机", "数控机床",
                     "信创", "基础软件", "操作系统", "工业软件", "科学仪器", "高端装备",
                     "国产替代", "自主可控", "新材料", "量子", "6G"],
    },
    {
        "key": "newenergy",
        "name": "新能源与绿色低碳",
        "note": "能源转型、储能与电网",
        "keywords": ["光伏", "风电", "储能", "氢能", "核电", "核聚变", "特高压", "智能电网",
                     "固态电池", "锂电", "钠电", "碳中和", "节能环保", "循环经济", "新能源汽车"],
    },
    {
        "key": "future",
        "name": "未来产业",
        "note": "商业航天、低空经济、深海科技、脑机接口等",
        "keywords": ["商业航天", "卫星互联网", "低空经济", "无人机", "eVTOL", "深海科技",
                     "海洋经济", "海工装备", "量子", "脑机接口", "具身智能", "人形机器人", "合成生物"],
    },
]
THEME_BY_KEY = {t["key"]: t for t in THEMES}


def resolve_keywords(payload: dict) -> list[str]:
    """关键词来源：显式传入 > 主题包 > 空。"""
    raw = payload.get("keywords")
    if isinstance(raw, str) and raw.strip():
        parts = re.split(r"[\s,，、;；\n]+", raw)
    elif isinstance(raw, list) and raw:
        parts = [str(x) for x in raw]
    else:
        theme = THEME_BY_KEY.get(str(payload.get("theme") or ""))
        parts = list(theme["keywords"]) if theme else []
    out, seen = [], set()
    for part in parts:
        part = part.strip()
        if part and part.lower() not in seen:
            seen.add(part.lower())
            out.append(part)
    return out[:200]


_ASCII_RE = re.compile(r"^[A-Za-z0-9+.\-]+$")


def compile_matcher(keywords: list[str]):
    patterns = []
    for keyword in keywords:
        if _ASCII_RE.match(keyword):
            patterns.append(re.compile(rf"(?<![A-Za-z0-9]){re.escape(keyword)}(?![A-Za-z0-9])", re.I))
        else:
            patterns.append(re.compile(re.escape(keyword), re.I))
    return patterns


def match_item(item: dict, patterns: list[re.Pattern]) -> str:
    """命中则返回命中的关键词，否则返回空串。"""
    haystack = f"{item.get('title') or ''} {item.get('industry') or ''} {item.get('stock_name') or ''}"
    for pattern in patterns:
        found = pattern.search(haystack)
        if found:
            return found.group(0)
    return ""


# ------------------------------------------------------------------ 任务

JOB: dict = {}
_job_lock = threading.Lock()
_stop_flag = threading.Event()
_thread: threading.Thread | None = None


def _empty_job(params: dict) -> dict:
    return {
        "running": False, "phase": "idle", "cancel": False,
        "started_at": "", "finished_at": "",
        "params": params,
        "scanned": 0, "matched": 0, "created": 0, "skipped": 0, "failed": 0,
        "content_total": 0, "content_done": 0, "content_failed": 0,
        "combo_index": 0, "combo_total": 0, "current": "",
        "progress": 0, "message": "", "log": [],
    }


def _log(job: dict, text: str) -> None:
    job["log"].append(f"{db.now()[11:]}  {text}")
    del job["log"][:-LOG_KEEP]


def status() -> dict:
    with _job_lock:
        snapshot = dict(JOB) if JOB else _empty_job({})
    snapshot.pop("pending", None)
    return snapshot


def stop() -> dict:
    _stop_flag.set()
    with _job_lock:
        if JOB:
            JOB["cancel"] = True
            JOB["message"] = "正在停止…"
    return status()


def _combos(params: dict) -> list[tuple[str, str]]:
    """展开待扫描的（来源, 类型）组合。

    新浪用「按天检索」深挖，一次请求就覆盖当天所有类型，所以四个类型合并成一次，
    避免同样的日期被翻四遍、把来源刷到限流。
    """
    source_keys = params.get("sources") or ["eastmoney", "sina"]
    type_keys = params.get("types") or []
    combos: list[tuple[str, str]] = []
    for source in source_keys:
        meta = feeds.SOURCE_BY_KEY.get(source)
        if not meta:
            continue
        valid = [t["key"] for t in meta["types"]]
        picked = [t for t in type_keys if t in valid] or valid
        if source == "sina":
            if picked:
                combos.append((source, "latest"))     # 按天检索已覆盖全部类型
            continue
        for type_key in picked:
            combos.append((source, type_key))
    return combos


def start(payload: dict) -> dict:
    global _thread
    if _thread and _thread.is_alive():
        raise RuntimeError("已有回填任务在运行")
    keywords = resolve_keywords(payload)
    if not keywords:
        raise RuntimeError("请至少选择一个主题，或填写行业 / 主题关键词")

    try:
        days = max(1, min(int(payload.get("days") or 30), 730))
    except (TypeError, ValueError):
        days = 30
    # 显式起止日期优先：长任务可以拆成几段跑，中断后从断点续，不必重走已完成的日期
    begin_date = str(payload.get("begin") or "").strip()
    end_date = str(payload.get("end") or "").strip()
    try:
        if begin_date and end_date:
            b, e = date.fromisoformat(begin_date), date.fromisoformat(end_date)
            if b > e:
                b, e = e, b
            days = (e - b).days + 1
            begin_date, end_date = b.isoformat(), e.isoformat()
        else:
            begin_date = end_date = ""
    except ValueError:
        begin_date = end_date = ""
    params = {
        "sources": [s for s in (payload.get("sources") or ["eastmoney", "sina"])
                    if s in feeds.SOURCE_BY_KEY] or ["eastmoney", "sina"],
        "types": [str(t) for t in (payload.get("types") or [])],
        "days": days,
        "keywords": keywords,
        "theme": str(payload.get("theme") or ""),
        "fetch_content": bool(payload.get("fetch_content", True)),
        "max_items": max(1, min(int(payload.get("max_items") or MAX_CREATE_PER_JOB), MAX_CREATE_PER_JOB)),
        "begin_date": begin_date,
        "end_date": end_date,
    }
    global JOB
    with _job_lock:
        JOB = _empty_job(params)
        job = JOB
        job.update({
            "running": True, "phase": "scan", "started_at": db.now(),
            "combo_total": len(_combos(params)),
            "end_date": end_date or date.today().isoformat(),
            "begin_date": begin_date or (date.today() - timedelta(days=days)).isoformat(),
        })
        _log(job, f"开始回填：{job['begin_date']} ~ {job['end_date']}，"
                  f"{len(params['keywords'])} 个关键词，{job['combo_total']} 个来源×类型组合")
    _stop_flag.clear()
    _thread = threading.Thread(target=_run, args=(job,), name="backfill", daemon=True)
    _thread.start()
    return status()


def start_fill(payload: dict) -> dict:
    """只补正文：把库里所有缺正文的抓取条目重试一遍，不重新扫描列表。"""
    global _thread
    if _thread and _thread.is_alive():
        raise RuntimeError("已有任务在运行")
    sources = [s for s in (payload.get("sources") or list(feeds.SOURCE_BY_KEY.keys()))
               if s in feeds.SOURCE_BY_KEY] or list(feeds.SOURCE_BY_KEY.keys())
    missing = count_missing(sources)
    if not missing["retryable"]:
        raise RuntimeError(
            "没有可重试的缺正文研报"
            + (f"（另有 {missing['no_body']} 篇来源站本身就没有文字正文）" if missing["no_body"] else ""))

    params = {
        "sources": sources, "types": [], "days": 30, "keywords": [],
        "theme": "", "fetch_content": True, "mode": "fill",
        "max_items": MAX_CREATE_PER_JOB, "begin_date": "", "end_date": "",
    }
    global JOB
    with _job_lock:
        JOB = _empty_job(params)
        job = JOB
        job.update({
            "running": True, "phase": "content", "started_at": db.now(),
            "combo_total": 0, "content_total": missing["retryable"],
            "end_date": date.today().isoformat(),
            "begin_date": (date.today() - timedelta(days=30)).isoformat(),
        })
        _log(job, f"开始补正文：可重试 {missing['retryable']} 篇"
                  + (f"（另有 {missing['no_body']} 篇来源站无正文，跳过）" if missing["no_body"] else ""))
    _stop_flag.clear()
    _thread = threading.Thread(target=_run, args=(job,), name="backfill-fill", daemon=True)
    _thread.start()
    return status()


def _set(job: dict, **fields) -> None:
    with _job_lock:
        job.update(fields)


def _bump(job: dict, field: str, delta: int = 1) -> None:
    with _job_lock:
        job[field] = job.get(field, 0) + delta


def _should_stop(job: dict) -> bool:
    return _stop_flag.is_set() or job.get("cancel")


def _run(job: dict) -> None:
    fill_only = job["params"].get("mode") == "fill"
    patterns = compile_matcher(job["params"]["keywords"])
    today = date.today()
    begin = job["params"].get("begin_date") or (today - timedelta(days=job["params"]["days"])).isoformat()
    end = job["params"].get("end_date") or today.isoformat()
    pending: list[tuple[str, str]] = []          # (source, report_id)

    try:
        combos = [] if fill_only else _combos(job["params"])
        if fill_only:
            _log(job, "[补正文] 跳过扫描，直接重试库里缺正文的条目")
        for index, (source, type_key) in enumerate(combos):
            if _should_stop(job):
                break
            _set(job, combo_index=index + 1, current=f"{feeds.SOURCE_BY_KEY[source]['label']} · {type_key}")
            _log(job, f"[扫描] {job['current']}")
            try:
                _scan_combo(job, source, type_key, begin, end, patterns, pending)
            except feeds.FeedError as exc:
                _log(job, f"  ⚠ {job['current']} 抓取失败：{exc}")
                _bump(job, "failed")
            if source == "sina":
                time.sleep(4.0)      # 换下一个组合前先冷一冷，避免被新浪限流
            _set(job, progress=int((index + 1) / max(len(combos), 1) * 50))

        # ---- 补正文阶段：本轮新入库的 + 库内历史遗留没正文的
        pending += _stale_without_content(job["params"]["sources"], existing_ids=set(pending))
        if job["params"]["fetch_content"] and pending and not _should_stop(job):
            _set(job, phase="content", content_total=len(pending), message="")
            _log(job, f"[补正文] 共 {len(pending)} 篇待抓")
            base = 0 if fill_only else 50          # 只补正文时全程都为补正文阶段
            span = 100 if fill_only else 50
            for idx, (source, info_id) in enumerate(pending, 1):
                if _should_stop(job):
                    break
                _fetch_one_content(job, source, info_id)
                _set(job, content_done=idx, progress=base + int(idx / len(pending) * span),
                     current=f"补正文 {idx}/{len(pending)}")
                if idx % 10 == 0:
                    _log(job, f"  正文进度 {idx}/{len(pending)}")

        stopped = _should_stop(job)
        _set(job, running=False, phase="cancelled" if stopped else "done",
             finished_at=db.now(), current="",
             progress=100 if not stopped else job.get("progress", 0),
             message=("已手动停止，已入库的内容保留；再跑一次会接着补" if stopped else "全部完成"))
        if fill_only:
            _log(job, ("已停止。" if stopped else "完成。") +
                 f" 重试 {job.get('content_total', 0)} 篇 / 成功 {job.get('content_done', 0)} / "
                 f"仍失败 {job.get('content_failed', 0)}")
        else:
            _log(job, ("已停止。" if stopped else "完成。") +
                 f" 扫描 {job['scanned']} 篇 / 命中 {job['matched']} / 入库 {job['created']} / "
                 f"跳过 {job['skipped']} / 正文 {job.get('content_done', 0)}")
    except Exception as exc:  # noqa: BLE001
        _set(job, running=False, phase="error", finished_at=db.now(),
             message=f"{type(exc).__name__}: {exc}")
        _log(job, f"✗ 任务异常：{type(exc).__name__}: {exc}")


# 来源站确实没有文字正文的标记 —— 这类重试也没用，不再反复抓
NO_BODY_MARK = "没有公开的文字版全文"

# 各来源在 source_url 上的域名特征（用于按来源筛选 / 反查来源）
SOURCE_DOMAIN = {"sina": "sina.com.cn", "eastmoney": "eastmoney.com", "sfconnect": "sfconnect.cn"}


def _source_of(url: str) -> str:
    url = url or ""
    for key, domain in SOURCE_DOMAIN.items():
        if domain in url:
            return key
    return "eastmoney"


def _domain_clause(sources: list[str]) -> str:
    parts = []
    for source in sources:
        domain = SOURCE_DOMAIN.get(source)
        if domain:
            parts.append(f"source_url LIKE '%{domain}%'")
    return " OR ".join(parts)


def _retryable_where() -> str:
    """可重试的缺正文条件：没正文，且不是「来源本来就没有正文」那一类。"""
    return ("source_type IN ('feed', 'auto', 'backfill') AND word_count = 0 "
            f"AND content NOT LIKE '%{NO_BODY_MARK}%'")


def count_missing(sources: list[str] | None = None) -> dict:
    """统计缺正文情况：总数 / 可重试 / 来源本来就没有正文。"""
    sources = sources or list(feeds.SOURCE_BY_KEY.keys())
    domain = _domain_clause(sources)
    if not domain:
        return {"count": 0, "retryable": 0, "no_body": 0, "by_source": []}
    conn = db.connect()
    total = conn.execute(
        f"SELECT COUNT(*) n FROM reports WHERE source_type IN ('feed','auto','backfill') "
        f"AND word_count = 0 AND ({domain})").fetchone()["n"]
    no_body = conn.execute(
        f"SELECT COUNT(*) n FROM reports WHERE source_type IN ('feed','auto','backfill') "
        f"AND word_count = 0 AND content LIKE ? AND ({domain})",
        (f"%{NO_BODY_MARK}%",)).fetchone()["n"]
    by_source = []
    for source in sources:
        like = f"%{SOURCE_DOMAIN.get(source, 'eastmoney.com')}%"
        n = conn.execute(
            f"SELECT COUNT(*) n FROM reports WHERE {_retryable_where()} AND source_url LIKE ?",
            (like,)).fetchone()["n"]
        if n:
            by_source.append({"name": source, "count": n})
    return {"count": total, "retryable": total - no_body, "no_body": no_body, "by_source": by_source}


def _stale_without_content(sources: list[str], existing_ids: set) -> list[tuple[str, str]]:
    """找出还可重试的缺正文条目，让补正文阶段可以跨任务续跑。"""
    domain = _domain_clause(sources)
    if not domain:
        return []
    rows = db.connect().execute(
        f"SELECT id, source_url FROM reports WHERE {_retryable_where()} AND ({domain}) "
        f"ORDER BY id DESC LIMIT 4000").fetchall()
    out = []
    for row in rows:
        if str(row["id"]) in existing_ids:
            continue
        source = _source_of(row["source_url"])
        out.append((source, str(row["id"])))
    return out


def _scan_combo(job, source: str, type_key: str, begin: str, end: str,
                patterns, pending: list) -> None:
    params = job["params"]
    page_size = 50 if source == "eastmoney" else 40
    # 新浪按天深挖一次拿完；脱水研报靠翻页积累，跟东财一样多翻几页
    max_pages = MAX_PAGES_PER_COMBO if source in ("eastmoney", "sfconnect") else 1
    conn = db.connect()
    for page in range(1, max_pages + 1):
        if _should_stop(job):
            return
        outcome = feeds.search(source=source, type_key=type_key, begin=begin, end=end,
                               page=page, page_size=page_size,
                               deep=(source == "sina"))
        items = outcome.get("items") or []
        if not items:
            if outcome.get("warning"):
                _log(job, f"  ⚠ {outcome['warning'][:60]}")
            return

        _bump(job, "scanned", len(items))
        hit_this_page = 0
        for item in items:
            keyword = match_item(item, patterns)
            if not keyword:
                continue
            hit_this_page += 1
            _bump(job, "matched")
            if job["created"] >= params["max_items"]:
                _log(job, f"  ⚠ 已达单次入库上限 {params['max_items']} 篇，停止扫描")
                _set(job, cancel=True)
                return
            exists = conn.execute(
                "SELECT id FROM reports WHERE source_file = ? AND source_type IN ('feed', 'auto', 'backfill')",
                (item["id"],),
            ).fetchone()
            if exists:
                _bump(job, "skipped")
                continue
            try:
                report_id = _insert_meta(conn, item)
            except Exception as exc:  # noqa: BLE001
                _bump(job, "failed")
                _log(job, f"  ✗ 写入失败：{item.get('title', '')[:24]}（{exc}）")
                continue
            _bump(job, "created")
            pending.append((source, str(report_id)))

        # 该页最早日期已经超出区间，说明翻完了
        oldest = min((i["date"] for i in items if i.get("date")), default="")
        if oldest and oldest < begin:
            return
        if page >= (outcome.get("total_pages") or MAX_PAGES_PER_COMBO):
            return
        time.sleep(feeds.SINA_GAP * 1.5 if source == "sina" else feeds.REQUEST_GAP)


def _insert_meta(conn, item: dict) -> int:
    """只写元数据，正文占位，等补正文阶段再填。"""
    placeholder = feeds.build_markdown(item, "")
    values = {
        "title": item["title"] or "未命名研报",
        "org": item["org"], "authors": item["authors"], "industry": item["industry"],
        "rating": item["rating"], "target_price": "", "stock_code": item["stock_code"],
        "report_date": item["date"], "source_type": "backfill", "source_file": item["id"],
        "source_url": item["url"], "page_count": item.get("pages") or 0,
        "word_count": 0, "content": placeholder, "summary": item.get("summary") or "",
        "key_points": "[]", "key_data": "[]", "risks": "",
        "ai_model": "", "ai_updated_at": "",
        "tags": db.json_dump([t for t in [item.get("type_label"), "批量回填"] if t]),
        "starred": 0, "read_status": "unread",
        "created_at": db.now(), "updated_at": db.now(),
    }
    cursor = conn.execute(
        f"INSERT INTO reports ({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
        list(values.values()),
    )
    conn.commit()
    return cursor.lastrowid


def _fetch_one_content(job: dict, source: str, report_id: str) -> None:
    conn = db.connect()
    row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
    if row is None:
        return
    item = {
        "source": source, "id": row["source_file"], "kind": "",
        "title": row["title"], "url": row["source_url"],
        "org": row["org"], "date": row["report_date"], "type_label": "",
    }
    if source == "sfconnect":
        item["kind"] = ""
    elif source == "sina":
        match = re.search(r"/kind/(\w+)/rptid/", row["source_url"] or "")
        item["kind"] = match.group(1) if match else "lastest"
    else:
        item["kind"] = "stock" if "/report/info/" in (row["source_url"] or "") else "industry"
    content = ""
    reason = "failed"
    for attempt in range(2):          # 偶发的限流/超时会返回空，隔一下重试一次
        try:
            fetched = feeds.fetch_content(item)
            item.update({k: v for k, v in (fetched.get("extra") or {}).items() if v})
            content = fetched.get("content") or ""
            if content:
                reason = ""
                break
            reason = fetched.get("reason") or "empty"
        except feeds.FeedError:
            reason = "failed"
        if attempt == 0:
            time.sleep(1.5)
    try:
        if not content:
            # 把"来源本来就没正文"和"抓取失败"分别写清楚，方便用户判断要不要重试
            note_md = feeds.build_markdown(item, "", reason)
            conn.execute("UPDATE reports SET content = ?, word_count = 0, updated_at = ? WHERE id = ?",
                         (note_md, db.now(), report_id))
            conn.commit()
            _bump(job, "content_failed")
            return
        markdown = feeds.build_markdown(item, content)
        conn.execute(
            "UPDATE reports SET content = ?, summary = ?, word_count = ?, updated_at = ? WHERE id = ?",
            (markdown, feeds.make_summary(content), len(re.sub(r"\s+", "", markdown)),
             db.now(), report_id),
        )
        conn.commit()
        time.sleep(feeds.SINA_GAP if source == "sina" else feeds.REQUEST_GAP)
    except feeds.FeedError:
        _bump(job, "content_failed")
    except Exception:  # noqa: BLE001
        _bump(job, "content_failed")
