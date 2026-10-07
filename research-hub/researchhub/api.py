"""REST API 路由。"""

from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Query, Request, Response
from fastapi.responses import PlainTextResponse

from . import ai, autofetch, backfill, db, extract, feeds

router = APIRouter(prefix="/api")

EDITABLE = {
    "title", "org", "authors", "industry", "rating", "target_price", "stock_code",
    "report_date", "summary", "risks", "starred", "read_status", "content",
    "key_points", "key_data", "tags",
}
JSON_FIELDS = {"key_points", "key_data", "tags"}
SORTS = {
    "created_desc": "datetime(created_at) DESC, id DESC",
    "created_asc": "datetime(created_at) ASC, id ASC",
    "date_desc": "CASE WHEN report_date='' THEN 1 ELSE 0 END, report_date DESC, id DESC",
    "title": "title ASC",
    "words_desc": "word_count DESC",
}

MAX_UPLOAD = 60 * 1024 * 1024  # 60MB


# ------------------------------------------------------------------ 序列化

def row_to_report(row) -> dict:
    item = dict(row)
    for field in JSON_FIELDS:
        item[field] = db.json_load(item.get(field), [])
    item["starred"] = bool(item.get("starred"))
    return item


def fetch_report(rid: int) -> dict:
    row = db.connect().execute("SELECT * FROM reports WHERE id=?", (rid,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="研报不存在")
    return row_to_report(row)


def _plain_excerpt(content: str, limit: int = 180) -> str:
    """卡片摘要：跳过自动写入的元信息头，并去掉 Markdown 标记。"""
    text = content or ""
    lines = text.splitlines()
    for index, line in enumerate(lines[:24]):
        if line.strip() in ("---", "***", "___"):
            text = "\n".join(lines[index + 1:])
            break
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*`>|_]", "", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _split_terms(value: str) -> list[str]:
    return [t for t in re.split(r"[\s,，]+", (value or "").strip()) if t]


# ------------------------------------------------------------------ 列表 / 详情

@router.get("/reports")
def list_reports(
    q: str = "",
    industry: str = "",
    org: str = "",
    rating: str = "",
    tag: str = "",
    status: str = "",
    source_type: str = "",
    starred: str = "",
    sort: str = "created_desc",
    limit: int = Query(500, ge=1, le=2000),
    offset: int = Query(0, ge=0),
) -> dict:
    where: list[str] = []
    params: list = []

    for term in _split_terms(q):
        where.append(
            "(title LIKE ? OR org LIKE ? OR authors LIKE ? OR industry LIKE ? "
            "OR rating LIKE ? OR summary LIKE ? OR tags LIKE ? OR content LIKE ?)"
        )
        params.extend([f"%{term}%"] * 8)

    if industry:
        where.append("industry LIKE ?")
        params.append(f"%{industry}%")
    if org:
        where.append("org = ?")
        params.append(org)
    if rating:
        where.append("rating = ?")
        params.append(rating)
    if tag:
        where.append("tags LIKE ?")
        params.append(f'%"{tag}"%')
    if status:
        where.append("read_status = ?")
        params.append(status)
    if source_type:
        where.append("source_type = ?")
        params.append(source_type)
    if starred in ("1", "true", "yes"):
        where.append("starred = 1")

    clause = f"WHERE {' AND '.join(where)}" if where else ""
    order = SORTS.get(sort, SORTS["created_desc"])
    conn = db.connect()
    total = conn.execute(f"SELECT COUNT(*) AS c FROM reports {clause}", params).fetchone()["c"]
    rows = conn.execute(
        f"SELECT * FROM reports {clause} ORDER BY {order} LIMIT ? OFFSET ?",
        [*params, limit, offset],
    ).fetchall()

    items = []
    for row in rows:
        item = row_to_report(row)
        item["excerpt"] = _plain_excerpt(item.get("content") or "")
        item["summary"] = item.get("summary") or ""
        item["content"] = ""  # 列表不返回全文，减小体积
        items.append(item)
    return {"total": total, "items": items}


@router.get("/reports/{rid}")
def get_report(rid: int) -> dict:
    report = fetch_report(rid)
    conn = db.connect()
    highlights = conn.execute(
        "SELECT * FROM highlights WHERE report_id=? ORDER BY id", (rid,)
    ).fetchall()
    notes = conn.execute(
        "SELECT * FROM notes WHERE report_id=? ORDER BY id DESC", (rid,)
    ).fetchall()
    report["highlights"] = [dict(h) for h in highlights]
    report["notes"] = [dict(n) for n in notes]
    return report


@router.post("/reports", status_code=201)
def create_report(payload: dict = Body(...)) -> dict:
    content = extract.normalize_pasted(str(payload.get("content") or ""))
    title = str(payload.get("title") or "").strip()
    if not content and not title:
        raise HTTPException(status_code=400, detail="标题和正文至少填一个")

    meta = extract.build_meta(content, title)
    source_type = str(payload.get("source_type") or "text")
    values = {
        "title": title or meta["title"],
        "org": str(payload.get("org") or meta["org"]),
        "authors": str(payload.get("authors") or meta["authors"]),
        "industry": str(payload.get("industry") or meta["industry"]),
        "rating": str(payload.get("rating") or meta["rating"]),
        "target_price": str(payload.get("target_price") or meta["target_price"]),
        "stock_code": str(payload.get("stock_code") or meta["stock_code"]),
        "report_date": str(payload.get("report_date") or meta["report_date"]),
        "source_type": source_type,
        "source_file": str(payload.get("source_file") or ""),
        "page_count": int(payload.get("page_count") or 0),
        "word_count": meta["word_count"],
        "content": content,
        "summary": str(payload.get("summary") or ""),
        "tags": db.json_dump(db.split_csv(payload.get("tags"))),
        "starred": 1 if payload.get("starred") else 0,
        "read_status": str(payload.get("read_status") or "unread"),
        "created_at": db.now(),
        "updated_at": db.now(),
    }
    conn = db.connect()
    columns = ", ".join(values)
    marks = ", ".join("?" for _ in values)
    cursor = conn.execute(
        f"INSERT INTO reports ({columns}) VALUES ({marks})", list(values.values())
    )
    conn.commit()
    return fetch_report(cursor.lastrowid)


@router.post("/reports/upload", status_code=201)
async def upload_report(request: Request, filename: str = Query("upload.pdf")) -> dict:
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="文件超过 60MB 限制")

    safe_name = re.sub(r"[^\w\u4e00-\u9fa5.\-() ]+", "_", Path(filename).name) or "upload.pdf"
    saved = db.FILE_DIR / f"{db.now().replace(':', '').replace(' ', '_')}_{safe_name}"
    saved.write_bytes(raw)

    lower = safe_name.lower()
    page_count, note = 0, ""
    if lower.endswith(".pdf"):
        content, page_count, note = extract.extract_pdf(raw)
    elif lower.endswith((".txt", ".md", ".markdown")):
        content = raw.decode("utf-8", errors="ignore")
    else:
        content, note = "", "仅支持 PDF / TXT / Markdown，其他格式请粘贴正文。"

    content = extract.normalize_pasted(content)
    meta = extract.build_meta(content, safe_name)
    values = {
        "title": meta["title"],
        "org": meta["org"],
        "authors": meta["authors"],
        "industry": meta["industry"],
        "rating": meta["rating"],
        "target_price": meta["target_price"],
        "stock_code": meta["stock_code"],
        "report_date": meta["report_date"],
        "source_type": "pdf" if lower.endswith(".pdf") else "file",
        "source_file": safe_name,
        "page_count": page_count,
        "word_count": meta["word_count"],
        "content": content,
        "tags": "[]",
        "created_at": db.now(),
        "updated_at": db.now(),
    }
    conn = db.connect()
    cursor = conn.execute(
        f"INSERT INTO reports ({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
        list(values.values()),
    )
    conn.commit()
    report = fetch_report(cursor.lastrowid)
    report["import_note"] = note
    return report


@router.patch("/reports/{rid}")
def update_report(rid: int, payload: dict = Body(...)) -> dict:
    fetch_report(rid)
    updates, params = [], []
    for key, value in payload.items():
        if key not in EDITABLE:
            continue
        if key in JSON_FIELDS:
            value = db.json_dump(db.split_csv(value) if not isinstance(value, list) else value)
        elif key == "starred":
            value = 1 if value else 0
        elif key == "content":
            value = extract.normalize_pasted(str(value))
            params_word = len(re.sub(r"\s+", "", value))
            updates.append("word_count = ?")
            params.append(params_word)
        else:
            value = "" if value is None else str(value)
        updates.append(f"{key} = ?")
        params.append(value)

    if not updates:
        raise HTTPException(status_code=400, detail="没有可更新的字段")
    updates.append("updated_at = ?")
    params.append(db.now())
    params.append(rid)
    conn = db.connect()
    conn.execute(f"UPDATE reports SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    return fetch_report(rid)


@router.delete("/reports/{rid}")
def delete_report(rid: int) -> dict:
    fetch_report(rid)
    conn = db.connect()
    conn.execute("DELETE FROM highlights WHERE report_id=?", (rid,))
    conn.execute("DELETE FROM notes WHERE report_id=?", (rid,))
    conn.execute("DELETE FROM reports WHERE id=?", (rid,))
    conn.commit()
    return {"ok": True, "deleted": rid}


# ------------------------------------------------------------------ 批量删除

FETCHED_TYPES = ("feed", "auto", "backfill")


def _batch_where(filt: dict) -> tuple[list[str], list]:
    """把批量删除的筛选条件翻译成 SQL。只认白名单字段，不做字符串拼接注入。"""
    where: list[str] = []
    params: list = []

    status = str(filt.get("read_status") or "").strip()
    if status in ("read", "unread", "reading"):
        where.append("read_status = ?")
        params.append(status)

    scope = str(filt.get("scope") or "").strip()
    if scope == "fetched":
        where.append("source_type IN ('feed', 'auto', 'backfill')")
    elif scope == "manual":
        where.append("source_type NOT IN ('feed', 'auto', 'backfill')")
    elif scope in FETCHED_TYPES:
        where.append("source_type = ?")
        params.append(scope)

    before = str(filt.get("before") or "").strip()
    if before:
        # 按报告日期时跳过空日期，避免把没填日期的条目误删
        field = "created_at" if str(filt.get("date_field")) == "created_at" else "report_date"
        where.append(f"{field} != '' AND {field} < ?")
        params.append(before)

    return where, params


def _batch_scope_sql(filt: dict, include_starred: bool) -> tuple[str, list]:
    where, params = _batch_where(filt)
    if not where:
        raise HTTPException(status_code=400, detail="请至少指定一个删除条件（时间或阅读状态）")
    if not include_starred:
        where.append("starred = 0")     # 星标默认受保护
    return " AND ".join(where), params


def _batch_breakdown(conn, clause: str, params: list) -> dict:
    def group(field: str) -> list:
        return [dict(row) for row in conn.execute(
            f"SELECT {field} AS name, COUNT(*) AS count FROM reports WHERE {clause} "
            f"GROUP BY {field} ORDER BY count DESC", params)]

    return {
        "by_source": group("source_type"),
        "by_status": group("read_status"),
    }


@router.post("/reports/batch-delete")
def batch_delete(payload: dict = Body(...)) -> dict:
    """按条件批量删除。preview=True 时只统计不删除，方便前端先让用户确认。"""
    filt = payload.get("filter") or {}
    include_starred = bool(payload.get("include_starred", False))
    preview = bool(payload.get("preview", True))
    clause, params = _batch_scope_sql(filt, include_starred)
    conn = db.connect()

    ids = [row["id"] for row in conn.execute(f"SELECT id FROM reports WHERE {clause}", params)]
    breakdown = _batch_breakdown(conn, clause, params)
    # 附上几条样例，让用户在删之前能看清到底会删掉什么
    samples = [dict(row) for row in conn.execute(
        f"SELECT id, title, org, report_date FROM reports WHERE {clause} "
        f"ORDER BY COALESCE(NULLIF(report_date, ''), '1970-01-01') DESC, id DESC LIMIT 6", params)]

    if preview:
        return {"preview": True, "count": len(ids), "deleted": 0,
                "samples": samples, "breakdown": breakdown}

    if ids:
        marks = ",".join("?" for _ in ids)
        conn.execute(f"DELETE FROM highlights WHERE report_id IN ({marks})", ids)
        conn.execute(f"DELETE FROM notes WHERE report_id IN ({marks})", ids)
        conn.execute(f"DELETE FROM reports WHERE id IN ({marks})", ids)
        conn.commit()
    return {"preview": False, "count": len(ids), "deleted": len(ids),
            "samples": samples, "breakdown": breakdown}


@router.post("/reports/batch-read")
def batch_mark_read(payload: dict = Body(...)) -> dict:
    """顺手配套：把筛选出的研报批量标记为已读，方便「读完再按已读清理」。"""
    filt = payload.get("filter") or {}
    target = str(payload.get("read_status") or "read")
    if target not in ("read", "unread", "reading"):
        raise HTTPException(status_code=400, detail="阅读状态取值不合法")
    clause, params = _batch_scope_sql(filt, bool(payload.get("include_starred", True)))
    conn = db.connect()
    cursor = conn.execute(
        f"UPDATE reports SET read_status = ?, updated_at = ? WHERE {clause}",
        [target, db.now(), *params],
    )
    conn.commit()
    return {"ok": True, "updated": cursor.rowcount, "read_status": target}


# ------------------------------------------------------------------ AI

@router.post("/reports/{rid}/summarize")
def summarize_report(rid: int, payload: dict = Body(default={})) -> dict:
    report = fetch_report(rid)
    settings = db.get_settings()
    if payload.get("settings"):
        settings = {**settings, **payload["settings"]}
    try:
        result = ai.summarize(report["title"], report["content"], settings)
    except ai.AIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    fields = {
        "summary": result["summary"],
        "key_points": db.json_dump(result["key_points"]),
        "key_data": db.json_dump(result["key_data"]),
        "risks": result["risks"],
        "ai_model": settings.get("ai_model", ""),
        "ai_updated_at": db.now(),
        "updated_at": db.now(),
    }
    if result["rating"]:
        fields["rating"] = result["rating"]
    if result["target_price"]:
        fields["target_price"] = result["target_price"]

    tags = list(report["tags"])
    for tag in result["tags"]:
        if tag and tag not in tags:
            tags.append(tag)
    fields["tags"] = db.json_dump(tags[:12])

    conn = db.connect()
    conn.execute(
        f"UPDATE reports SET {', '.join(f'{k} = ?' for k in fields)} WHERE id = ?",
        [*fields.values(), rid],
    )
    conn.commit()
    updated = fetch_report(rid)
    updated["ai_extra"] = {
        "sentiment": result["sentiment"],
        "confidence": result["confidence"],
    }
    return updated


@router.post("/reports/{rid}/ask")
def ask_report(rid: int, payload: dict = Body(...)) -> dict:
    question = str(payload.get("question") or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="请输入问题")
    report = fetch_report(rid)
    try:
        answer = ai.ask(report["title"], report["content"], question, db.get_settings())
    except ai.AIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"question": question, "answer": answer, "at": db.now()}


# ------------------------------------------------------------------ 高亮 / 笔记

@router.get("/reports/{rid}/highlights")
def list_highlights(rid: int) -> list[dict]:
    rows = db.connect().execute(
        "SELECT * FROM highlights WHERE report_id=? ORDER BY id", (rid,)
    ).fetchall()
    return [dict(r) for r in rows]


@router.post("/reports/{rid}/highlights", status_code=201)
def create_highlight(rid: int, payload: dict = Body(...)) -> dict:
    fetch_report(rid)
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="高亮内容为空")
    conn = db.connect()
    cursor = conn.execute(
        "INSERT INTO highlights(report_id, text, color, note, anchor, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (
            rid,
            text[:4000],
            str(payload.get("color") or "yellow"),
            str(payload.get("note") or ""),
            str(payload.get("anchor") or ""),
            db.now(),
        ),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM highlights WHERE id=?", (cursor.lastrowid,)).fetchone()
    return dict(row)


@router.patch("/highlights/{hid}")
def update_highlight(hid: int, payload: dict = Body(...)) -> dict:
    conn = db.connect()
    row = conn.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="高亮不存在")
    fields, params = [], []
    for key in ("color", "note"):
        if key in payload:
            fields.append(f"{key} = ?")
            params.append(str(payload[key] or ""))
    if fields:
        params.append(hid)
        conn.execute(f"UPDATE highlights SET {', '.join(fields)} WHERE id = ?", params)
        conn.commit()
    row = conn.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone()
    return dict(row)


@router.delete("/highlights/{hid}")
def delete_highlight(hid: int) -> dict:
    conn = db.connect()
    conn.execute("DELETE FROM highlights WHERE id=?", (hid,))
    conn.commit()
    return {"ok": True}


@router.post("/reports/{rid}/notes", status_code=201)
def create_note(rid: int, payload: dict = Body(...)) -> dict:
    fetch_report(rid)
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="笔记内容为空")
    conn = db.connect()
    cursor = conn.execute(
        "INSERT INTO notes(report_id, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (rid, content, db.now(), db.now()),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (cursor.lastrowid,)).fetchone()
    return dict(row)


@router.patch("/notes/{nid}")
def update_note(nid: int, payload: dict = Body(...)) -> dict:
    conn = db.connect()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="笔记不存在")
    content = str(payload.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="笔记内容为空")
    conn.execute(
        "UPDATE notes SET content=?, updated_at=? WHERE id=?", (content, db.now(), nid)
    )
    conn.commit()
    row = conn.execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    return dict(row)


@router.delete("/notes/{nid}")
def delete_note(nid: int) -> dict:
    conn = db.connect()
    conn.execute("DELETE FROM notes WHERE id=?", (nid,))
    conn.commit()
    return {"ok": True}


# ------------------------------------------------------------------ 统计 / 筛选面

@router.get("/stats")
def stats() -> dict:
    conn = db.connect()
    total = conn.execute("SELECT COUNT(*) c FROM reports").fetchone()["c"]
    words = conn.execute("SELECT COALESCE(SUM(word_count),0) w FROM reports").fetchone()["w"]
    star = conn.execute("SELECT COUNT(*) c FROM reports WHERE starred=1").fetchone()["c"]
    status = {
        r["read_status"]: r["c"]
        for r in conn.execute(
            "SELECT read_status, COUNT(*) c FROM reports GROUP BY read_status"
        )
    }
    notes = conn.execute("SELECT COUNT(*) c FROM notes").fetchone()["c"]
    highlights = conn.execute("SELECT COUNT(*) c FROM highlights").fetchone()["c"]
    ai_done = conn.execute(
        "SELECT COUNT(*) c FROM reports WHERE summary != '' OR key_points != '[]'"
    ).fetchone()["c"]

    def group(field: str, limit: int = 12) -> list[dict]:
        rows = conn.execute(
            f"SELECT {field} AS name, COUNT(*) AS count FROM reports "
            f"WHERE {field} != '' GROUP BY {field} ORDER BY count DESC, name LIMIT ?",
            (limit,),
        ).fetchall()
        return [{"name": r["name"], "count": r["count"]} for r in rows]

    tag_counter: dict[str, int] = {}
    for row in conn.execute("SELECT tags FROM reports"):
        for tag in db.json_load(row["tags"], []):
            tag_counter[tag] = tag_counter.get(tag, 0) + 1
    tags = sorted(tag_counter.items(), key=lambda kv: (-kv[1], kv[0]))[:30]

    recent = conn.execute(
        "SELECT id, title, org, report_date, created_at FROM reports "
        "ORDER BY datetime(created_at) DESC LIMIT 6"
    ).fetchall()
    by_month = conn.execute(
        "SELECT substr(created_at,1,7) AS month, COUNT(*) AS count FROM reports "
        "GROUP BY month ORDER BY month DESC LIMIT 12"
    ).fetchall()

    return {
        "total": total,
        "words": words,
        "starred": star,
        "status": {
            "unread": status.get("unread", 0),
            "reading": status.get("reading", 0),
            "read": status.get("read", 0),
        },
        "notes": notes,
        "highlights": highlights,
        "ai_ready": ai_done,
        "industries": group("industry"),
        "orgs": group("org"),
        "ratings": group("rating"),
        "tags": [{"name": k, "count": v} for k, v in tags],
        "recent": [dict(r) for r in recent],
        "by_month": [dict(r) for r in reversed(by_month)],
    }


@router.get("/facets")
def facets() -> dict:
    conn = db.connect()

    def distinct(field: str) -> list[str]:
        rows = conn.execute(
            f"SELECT DISTINCT {field} AS v FROM reports WHERE {field} != '' ORDER BY v"
        ).fetchall()
        out: list[str] = []
        for row in rows:
            for part in re.split(r"[、,，;；/]", row["v"]):
                part = part.strip()
                if part and part not in out:
                    out.append(part)
        return out

    tags: list[str] = []
    for row in conn.execute("SELECT DISTINCT tags FROM reports WHERE tags != '[]'"):
        for tag in db.json_load(row["tags"], []):
            if tag not in tags:
                tags.append(tag)
    tags.sort()
    return {
        "industries": distinct("industry"),
        "orgs": distinct("org"),
        "ratings": distinct("rating"),
        "authors": distinct("authors"),
        "tags": tags,
    }


# ------------------------------------------------------------------ 设置

def _mask(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:4]}{'•' * 8}{key[-4:]}"


@router.get("/settings")
def read_settings() -> dict:
    settings = db.get_settings()
    return {
        "ai_base_url": settings.get("ai_base_url", ""),
        "ai_model": settings.get("ai_model", ""),
        "ai_temperature": settings.get("ai_temperature", "0.3"),
        "ai_language": settings.get("ai_language", "zh"),
        "ai_api_key_masked": _mask(settings.get("ai_api_key", "")),
        "ai_configured": bool(settings.get("ai_api_key")),
    }


@router.put("/settings")
def write_settings(payload: dict = Body(...)) -> dict:
    values = {}
    for key in ("ai_base_url", "ai_model", "ai_temperature", "ai_language"):
        if key in payload and payload[key] is not None:
            values[key] = str(payload[key]).strip()
    key_input = str(payload.get("ai_api_key") or "").strip()
    if key_input and "•" not in key_input:
        values["ai_api_key"] = key_input
    if payload.get("clear_api_key"):
        values["ai_api_key"] = ""
    db.set_settings(values)
    return read_settings()


@router.post("/settings/test")
def test_settings(payload: dict = Body(default={})) -> dict:
    settings = db.get_settings()
    override = payload.get("settings") or {}
    settings = {**settings, **override}
    key_input = str(settings.get("ai_api_key") or "")
    if "•" in key_input:  # 前端回传的是掩码，用已保存的 key
        settings["ai_api_key"] = db.get_settings().get("ai_api_key", "")
    try:
        return ai.test_connection(settings)
    except ai.AIError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ------------------------------------------------------------------ 研报抓取

FEED_FIELDS = (
    "id", "kind", "title", "org", "authors", "rating", "industry",
    "stock_name", "stock_code", "date", "pages", "type_label",
)


def _sanitize_feed_item(raw: dict) -> dict:
    """只接受白名单字段，并且强制用服务端重建原文链接，避免被塞入任意外链。"""
    item: dict = {}
    source = str(raw.get("source") or "eastmoney")
    item["source"] = source if source in feeds.SOURCE_BY_KEY else "eastmoney"
    for key in FEED_FIELDS:
        value = raw.get(key)
        if key == "pages":
            try:
                item[key] = int(value or 0)
            except (TypeError, ValueError):
                item[key] = 0
        else:
            item[key] = re.sub(r"\s+", " ", str(value or "")).strip()[:300]
    item["url"] = feeds.detail_url(item["source"], item["id"], item.get("kind", ""))
    return item


@router.get("/feeds/sources")
def feed_sources(refresh: int = 0) -> dict:
    try:
        return feeds.sources_payload(force=bool(refresh))
    except feeds.FeedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/feeds/search")
def feed_search(
    source: str = "eastmoney",
    type: str = "stock",
    org_code: str = "",
    stock_code: str = "",
    days: int = Query(30, ge=1, le=3650),
    begin: str = "",
    end: str = "",
    keyword: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=5, le=50),
) -> dict:
    if source not in feeds.SOURCE_BY_KEY:
        raise HTTPException(status_code=400, detail=f"暂不支持的来源：{source}")
    valid_types = {t["key"] for t in feeds.SOURCE_BY_KEY[source]["types"]}
    if type not in valid_types:
        raise HTTPException(status_code=400, detail=f"「{feeds.SOURCE_BY_KEY[source]['label']}」不支持该研报类型")
    if not begin and not end:
        end = date.today().isoformat()
        begin = (date.today() - timedelta(days=days)).isoformat()
    try:
        result = feeds.search(
            source=source, type_key=type, org_code=org_code, stock_code=stock_code,
            begin=begin, end=end, keyword=keyword, page=page, page_size=page_size,
        )
    except feeds.FeedError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    codes = [item["id"] for item in result["items"] if item["id"]]
    imported: set[str] = set()
    if codes:
        marks = ",".join("?" for _ in codes)
        rows = db.connect().execute(
            f"SELECT source_file FROM reports WHERE source_file IN ({marks})", codes
        ).fetchall()
        imported = {row["source_file"] for row in rows}
    for item in result["items"]:
        item["imported"] = item["id"] in imported

    result["begin"] = begin
    result["end"] = end
    result["max_import"] = feeds.MAX_ITEMS_PER_IMPORT
    return result


@router.post("/feeds/import")
def feed_import(payload: dict = Body(...)) -> dict:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(status_code=400, detail="请先选择要导入的研报")
    if len(raw_items) > feeds.MAX_ITEMS_PER_IMPORT:
        raise HTTPException(
            status_code=400,
            detail=f"一次最多导入 {feeds.MAX_ITEMS_PER_IMPORT} 篇，请分批操作",
        )
    source = str(payload.get("source") or "eastmoney")
    if source not in feeds.SOURCE_BY_KEY:
        raise HTTPException(status_code=400, detail="暂不支持的来源")

    with_content = bool(payload.get("fetch_content", True))
    conn = db.connect()
    created: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []

    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            failed.append({"title": "", "reason": "数据格式不正确"})
            continue
        item = _sanitize_feed_item(raw)
        if not item["id"] or not item["title"]:
            failed.append({"title": item["title"], "reason": "缺少研报编号或标题"})
            continue

        existing = conn.execute(
            "SELECT id FROM reports WHERE source_file = ? AND source_type IN ('feed', 'auto', 'backfill')",
            (item["id"],),
        ).fetchone()
        if existing:
            skipped.append({"title": item["title"], "reason": "已在库中", "report_id": existing["id"]})
            continue

        content, url, note = "", item["url"], ""
        if with_content:
            if index:
                feeds.polite_sleep()
            try:
                fetched = feeds.fetch_content(item)
                content, url = fetched["content"], fetched["url"]
                if not content:
                    note = "来源页面未提供公开正文，已只保存元数据"
            except feeds.FeedError as exc:
                note = f"正文抓取失败：{exc}"

        markdown = feeds.build_markdown(item, content)
        tags = [item["type_label"]] if item["type_label"] else []
        values = {
            "title": item["title"] or "未命名研报",
            "org": item["org"],
            "authors": item["authors"],
            "industry": item["industry"],
            "rating": item["rating"],
            "target_price": "",
            "stock_code": item["stock_code"],
            "report_date": item["date"],
            "source_type": "feed",
            "source_file": item["id"],
            "source_url": url,
            "page_count": item["pages"],
            "word_count": len(re.sub(r"\s+", "", markdown)),
            "content": markdown,
            "summary": feeds.make_summary(content) or note,
            "key_points": "[]",
            "key_data": "[]",
            "risks": "",
            "ai_model": "",
            "ai_updated_at": "",
            "tags": db.json_dump(tags),
            "starred": 0,
            "read_status": "unread",
            "created_at": db.now(),
            "updated_at": db.now(),
        }
        cursor = conn.execute(
            f"INSERT INTO reports ({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
            list(values.values()),
        )
        conn.commit()
        created.append({
            "id": cursor.lastrowid,
            "title": item["title"],
            "org": item["org"],
            "has_content": bool(content),
            "note": note,
        })

    return {
        "created": created,
        "skipped": skipped,
        "failed": failed,
        "with_content": sum(1 for c in created if c["has_content"]),
        "notes": [c["note"] for c in created if c["note"]],
    }


# ------------------------------------------------------------------ 订阅式自动抓取

@router.get("/subscriptions")
def subscription_list() -> dict:
    return {"items": autofetch.list_subscriptions(), "status": autofetch.status()}


@router.post("/subscriptions", status_code=201)
def subscription_create(payload: dict = Body(...)) -> dict:
    try:
        return autofetch.create_subscription(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/subscriptions/{sid}")
def subscription_update(sid: int, payload: dict = Body(...)) -> dict:
    try:
        updated = autofetch.update_subscription(sid, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if updated is None:
        raise HTTPException(status_code=404, detail="订阅不存在")
    return updated


@router.delete("/subscriptions/{sid}")
def subscription_delete(sid: int) -> dict:
    if not autofetch.delete_subscription(sid):
        raise HTTPException(status_code=404, detail="订阅不存在")
    return {"ok": True, "deleted": sid}


@router.post("/subscriptions/{sid}/run")
def subscription_run(sid: int) -> dict:
    outcome = autofetch.run_now(sid, trigger="manual")
    if outcome.get("busy"):
        raise HTTPException(status_code=409, detail=outcome["message"])
    if not outcome["results"]:
        raise HTTPException(status_code=404, detail=outcome.get("message") or "订阅不存在")
    return outcome


@router.get("/autofetch/status")
def autofetch_status(logs: int = Query(20, ge=0, le=100)) -> dict:
    return {
        "status": autofetch.status(),
        "logs": autofetch.recent_logs(logs) if logs else [],
        "subscriptions": autofetch.list_subscriptions(),
    }


@router.put("/autofetch/settings")
def autofetch_settings(payload: dict = Body(...)) -> dict:
    values = {}
    just_enabled = False
    if "enabled" in payload:
        enabled = "1" if payload["enabled"] in (True, 1, "1", "true", "on", "yes") else "0"
        values["autofetch_enabled"] = enabled
        just_enabled = enabled == "1" and db.get_settings().get("autofetch_enabled") != "1"
    if "daily_limit" in payload:
        try:
            limit = max(1, min(int(payload["daily_limit"]), 500))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="每日上限需要是数字") from None
        values["autofetch_daily_limit"] = str(limit)
    if values:
        db.set_settings(values)
    seed = ""
    if just_enabled:
        # 打开开关就立刻跑一轮，让用户马上看到效果（后台线程，不阻塞请求）
        import threading

        threading.Thread(target=autofetch.run_now, kwargs={"trigger": "manual"}, daemon=True).start()
        seed = "已开启，正在立即抓取一轮…"
    return {"status": autofetch.status(), "message": seed}


@router.post("/autofetch/run")
def autofetch_run(force: int = 0) -> dict:
    outcome = autofetch.run_now(trigger="manual", force=bool(force))
    if outcome.get("busy"):
        raise HTTPException(status_code=409, detail=outcome["message"])
    return outcome


# ------------------------------------------------------------------ 批量回填

@router.get("/themes")
def theme_list() -> dict:
    return {
        "themes": backfill.THEMES,
        "sources": [
            {"key": s["key"], "label": s["label"], "types": s["types"]}
            for s in feeds.SOURCES
        ],
    }


@router.post("/backfill/start")
def backfill_start(payload: dict = Body(...)) -> dict:
    try:
        return backfill.start(payload)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/content/missing")
def reports_missing_content(source: str = "") -> dict:
    """有多少抓取进来的研报还没拿到正文（供「一键补全」提示用）。"""
    sources = [source] if source in feeds.SOURCE_BY_KEY else None
    return backfill.count_missing(sources)


@router.post("/content/fill")
def reports_fill_content(payload: dict = Body(default={})) -> dict:
    """只补正文：把库里缺正文的条目重试一遍，不重新扫描列表。"""
    try:
        return backfill.start_fill(payload or {})
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/backfill/status")
def backfill_status() -> dict:
    return backfill.status()


@router.post("/backfill/stop")
def backfill_stop() -> dict:
    return backfill.stop()


# ------------------------------------------------------------------ 导出

def report_to_markdown(report: dict) -> str:
    meta_bits = [
        ("机构", report.get("org")),
        ("分析师", report.get("authors")),
        ("行业", report.get("industry")),
        ("评级", report.get("rating")),
        ("目标价", report.get("target_price")),
        ("股票代码", report.get("stock_code")),
        ("报告日期", report.get("report_date")),
        ("标签", "、".join(report.get("tags") or [])),
        ("原文", report.get("source_file")),
        ("原文链接", report.get("source_url")),
    ]
    lines = [f"# {report.get('title') or '未命名研报'}", ""]
    lines += [f"- **{k}**：{v}" for k, v in meta_bits if v]
    lines.append("")
    if report.get("summary"):
        lines += ["## 一句话摘要", "", report["summary"], ""]
    if report.get("key_points"):
        lines += ["## 核心观点", ""]
        lines += [f"{i}. {p}" for i, p in enumerate(report["key_points"], 1)]
        lines.append("")
    if report.get("key_data"):
        lines += ["## 关键数据", ""]
        lines += [f"- {d}" for d in report["key_data"]]
        lines.append("")
    if report.get("risks"):
        lines += ["## 风险提示", "", report["risks"], ""]
    if report.get("highlights"):
        lines += ["## 高亮摘录", ""]
        lines += [
            f"> {h['text']}" + (f"\n>\n> 批注：{h['note']}" if h.get("note") else "")
            for h in report["highlights"]
        ]
        lines.append("")
    if report.get("notes"):
        lines += ["## 我的笔记", ""]
        lines += [f"- {n['content']}" for n in report["notes"]]
        lines.append("")
    lines += ["---", "", "## 正文", "", report.get("content") or "_（无正文）_", ""]
    return "\n".join(lines)


@router.get("/reports/{rid}/export")
def export_report(rid: int, format: str = Query("md")) -> Response:
    report = get_report(rid)
    if format == "json":
        return Response(
            json.dumps(report, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="report-{rid}.json"'},
        )
    markdown = report_to_markdown(report)
    filename = re.sub(r"[/\\\r\n\"]", "_", report["title"] or f"report-{rid}")[:60] or f"report-{rid}"
    return PlainTextResponse(
        markdown,
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"report-{rid}.md\"; "
                f"filename*=UTF-8''{quote(filename)}.md"
            )
        },
    )


@router.get("/export")
def export_all(format: str = Query("md")) -> Response:
    conn = db.connect()
    rows = conn.execute("SELECT * FROM reports ORDER BY id").fetchall()
    reports = []
    for row in rows:
        item = row_to_report(row)
        item["highlights"] = [
            dict(h)
            for h in conn.execute(
                "SELECT * FROM highlights WHERE report_id=? ORDER BY id", (row["id"],)
            )
        ]
        item["notes"] = [
            dict(n)
            for n in conn.execute(
                "SELECT * FROM notes WHERE report_id=? ORDER BY id", (row["id"],)
            )
        ]
        reports.append(item)

    stamp = db.now().replace(":", "").replace(" ", "-")
    if format == "json":
        payload = {"exported_at": db.now(), "count": len(reports), "reports": reports}
        return Response(
            json.dumps(payload, ensure_ascii=False, indent=2),
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="research-hub-{stamp}.json"'
            },
        )
    chunks = [
        "# 研报整理导出",
        "",
        f"- 导出时间：{db.now()}",
        f"- 研报数量：{len(reports)}",
        "",
        "---",
        "",
    ]
    for report in reports:
        chunks.append(report_to_markdown(report))
        chunks.append("\n---\n")
    return PlainTextResponse(
        "\n".join(chunks),
        media_type="text/markdown; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''research-hub-{stamp}.md"
            )
        },
    )
