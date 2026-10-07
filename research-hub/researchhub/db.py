"""SQLite 数据层：连接、建表、设置读写与通用工具。"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
FILE_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "research.db"

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL DEFAULT '',
    org           TEXT DEFAULT '',
    authors       TEXT DEFAULT '',
    industry      TEXT DEFAULT '',
    rating        TEXT DEFAULT '',
    target_price  TEXT DEFAULT '',
    stock_code    TEXT DEFAULT '',
    report_date   TEXT DEFAULT '',
    source_type   TEXT DEFAULT 'text',
    source_file   TEXT DEFAULT '',
    source_url    TEXT DEFAULT '',
    page_count    INTEGER DEFAULT 0,
    word_count    INTEGER DEFAULT 0,
    content       TEXT DEFAULT '',
    summary       TEXT DEFAULT '',
    key_points    TEXT DEFAULT '[]',
    key_data      TEXT DEFAULT '[]',
    risks         TEXT DEFAULT '',
    ai_model      TEXT DEFAULT '',
    ai_updated_at TEXT DEFAULT '',
    tags          TEXT DEFAULT '[]',
    starred       INTEGER DEFAULT 0,
    read_status   TEXT DEFAULT 'unread',
    created_at    TEXT DEFAULT '',
    updated_at    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS highlights (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    text       TEXT NOT NULL,
    color      TEXT DEFAULT 'yellow',
    note       TEXT DEFAULT '',
    anchor     TEXT DEFAULT '',
    created_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT DEFAULT '',
    source           TEXT DEFAULT 'eastmoney',
    type             TEXT DEFAULT 'stock',
    org_code         TEXT DEFAULT '',
    org_name         TEXT DEFAULT '',
    keyword          TEXT DEFAULT '',
    fetch_content    INTEGER DEFAULT 1,
    max_per_run      INTEGER DEFAULT 5,
    interval_minutes INTEGER DEFAULT 60,
    lookback_days    INTEGER DEFAULT 7,
    enabled          INTEGER DEFAULT 1,
    last_run_at      TEXT DEFAULT '',
    last_status      TEXT DEFAULT '',
    last_message     TEXT DEFAULT '',
    last_created     INTEGER DEFAULT 0,
    total_created    INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS autofetch_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sub_id      INTEGER DEFAULT 0,
    sub_name    TEXT DEFAULT '',
    trigger     TEXT DEFAULT 'auto',
    started_at  TEXT DEFAULT '',
    finished_at TEXT DEFAULT '',
    status      TEXT DEFAULT '',
    found       INTEGER DEFAULT 0,
    created     INTEGER DEFAULT 0,
    skipped     INTEGER DEFAULT 0,
    failed      INTEGER DEFAULT 0,
    message     TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_highlights_report ON highlights(report_id);
CREATE INDEX IF NOT EXISTS idx_notes_report ON notes(report_id);
CREATE INDEX IF NOT EXISTS idx_logs_started ON autofetch_logs(started_at DESC);
"""

# 这三类都是"从外部抓取进来的"，去重时按来源编号统一处理
FEED_SOURCE_TYPES = ("feed", "auto", "backfill")

DEFAULT_SETTINGS = {
    "ai_base_url": "https://api.deepseek.com/v1",
    "ai_api_key": "",
    "ai_model": "deepseek-chat",
    "ai_temperature": "0.3",
    "ai_language": "zh",
    "autofetch_enabled": "0",
    "autofetch_daily_limit": "30",
}

# 首次启动写入的示例订阅（总开关默认关闭，不会自动联网抓取）
DEFAULT_SUBSCRIPTIONS = [
    {
        "name": "头部券商 · 最新研报",
        "source": "sina",
        "type": "latest",
        "org_name": "全部机构",
        "interval_minutes": 60,
        "max_per_run": 5,
        "lookback_days": 7,
        "fetch_content": 1,
    },
    {
        "name": "行业研报 · 东方财富",
        "source": "eastmoney",
        "type": "industry",
        "org_name": "全部机构",
        "interval_minutes": 120,
        "max_per_run": 5,
        "lookback_days": 7,
        "fetch_content": 1,
    },
]


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def connect() -> sqlite3.Connection:
    """每个线程一条连接（FastAPI 线程池下安全）。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """轻量迁移：给老库补上后来新增的列。"""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(reports)")}
    for column, ddl in (
        ("source_url", "ALTER TABLE reports ADD COLUMN source_url TEXT DEFAULT ''"),
    ):
        if column not in existing:
            conn.execute(ddl)


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    FILE_DIR.mkdir(parents=True, exist_ok=True)
    conn = connect()
    conn.executescript(SCHEMA)
    _ensure_columns(conn)
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (key, value))
    if not conn.execute("SELECT COUNT(*) AS c FROM subscriptions").fetchone()["c"]:
        for sub in DEFAULT_SUBSCRIPTIONS:
            columns = ["name", "source", "type", "org_code", "org_name", "keyword", "fetch_content",
                       "max_per_run", "interval_minutes", "lookback_days", "enabled", "created_at"]
            values = [sub.get("name", ""), sub.get("source", "eastmoney"), sub.get("type", "stock"),
                      sub.get("org_code", ""), sub.get("org_name", ""), sub.get("keyword", ""),
                      int(sub.get("fetch_content", 1)), int(sub.get("max_per_run", 5)),
                      int(sub.get("interval_minutes", 60)), int(sub.get("lookback_days", 7)), 1, now()]
            conn.execute(
                f"INSERT INTO subscriptions ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
                values,
            )
    conn.commit()


# ---------------------------------------------------------------- settings

def get_settings() -> dict:
    rows = connect().execute("SELECT key, value FROM settings").fetchall()
    data = dict(DEFAULT_SETTINGS)
    data.update({r["key"]: r["value"] for r in rows})
    return data


def set_settings(values: dict) -> dict:
    conn = connect()
    for key, value in values.items():
        if value is None:
            continue
        conn.execute(
            "INSERT INTO settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
    conn.commit()
    return get_settings()


# ---------------------------------------------------------------- helpers

def json_load(value, fallback):
    if value in (None, ""):
        return fallback
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def json_dump(value) -> str:
    return json.dumps(value, ensure_ascii=False)


def split_csv(value) -> list[str]:
    """把 'a, b；c' 这类输入拆成去重列表。"""
    if value is None:
        return []
    if isinstance(value, list):
        items = value
    else:
        text = str(value).replace("；", ",").replace("、", ",").replace("，", ",")
        items = text.split(",")
    out, seen = [], set()
    for item in items:
        item = str(item).strip()
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out
