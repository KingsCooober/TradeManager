#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""研报库全文检索 —— easy-stock AI 的 MCP 工具。

背景：研报库（research-hub）原本是一个独立的 FastAPI + 前端工作台，
沉淀了 500+ 篇机构研报（含正文）。2026-10-20 起它的界面下线，
只保留「后台自动抓取 + 全文库」两个职责，通过本 MCP 服务把检索能力
交给 easy-stock 的 AI 助手使用。

设计要点：
- 直接读 SQLite（只读 URI），不依赖研报库的 Python 服务是否在跑；
- 只读，不改任何数据；
- 返回纯文本（markdown），控制 token 消耗：检索只给摘要，正文按需分页取。

启动（由 easy-stock 的 Hermes 运行时以 stdio 方式拉起）：
    /var/www/trademanager/hermes-runtime/venv/bin/python /var/www/trademanager/server/research-mcp.py
"""

import os
import sqlite3
import sys
from typing import Optional

from mcp.server.mcpserver import MCPServer

DEFAULT_DB = "/var/www/trademanager/research-hub/data/research.db"
DB_PATH = os.environ.get("RESEARCH_DB_PATH", DEFAULT_DB)

# 用户持仓库：用来判断「这篇研报是不是讲我手上的票」
TRADE_DB = os.environ.get("TRADE_DB_PATH", "/var/www/trademanager/server/data.db")

# 关注范围配置（行业白名单 + 手工补充的标的）
SCOPE_PATH = os.environ.get(
    "RESEARCH_SCOPE_PATH", "/var/www/trademanager/server/research-scope.json"
)

MAX_LIMIT = 30
SNIPPET_CHARS = 220
MAX_CONTENT_CHARS = 8000
MAX_MUST_READ = 5

server = MCPServer(
    name="research-hub",
    version="1.1.0",
    instructions=(
        "本机研报库全文检索。用户问及券商研报、行业深度、机构观点、评级与目标价、"
        "或需要「最近某方向有哪些研报」时使用。数据为本地沉淀的机构研报（含正文），"
        "检索范围覆盖标题、机构、行业、摘要与正文。"
        "用户问「今天有什么必读的研报」「有什么值得看」「扫一下最近的研报」时，"
        "优先调用 get_must_read —— 它会过滤掉周报/月报/宏观等噪音，只返回信号级研报。"
    ),
)


def _connect():
    """只读连接；库不存在时抛 FileNotFoundError。"""
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"研报库不存在：{DB_PATH}")
    return sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    return text[:limit] + "…"


@server.tool(
    name="search_reports",
    description=(
        "按关键词检索本机研报库（标题/机构/行业/摘要/正文全文匹配），返回最相关的研报列表。"
        "适合回答「最近关于 XX 的研报怎么说」「有没有关于 XX 行业的深度报告」。"
        "只返回摘要级信息；需要原文时再用 get_report 按 id 取正文。"
    ),
)
def search_reports(query: str, limit: int = 8, industry: Optional[str] = None) -> str:
    query = (query or "").strip()
    if not query and not industry:
        return "请提供检索关键词（query）或行业（industry）。"
    try:
        limit = max(1, min(int(limit or 8), MAX_LIMIT))
    except Exception:
        limit = 8

    like = f"%{query}%"
    where = []
    params: list = []
    if query:
        where.append(
            "(title LIKE ? OR org LIKE ? OR authors LIKE ? OR industry LIKE ?"
            " OR rating LIKE ? OR summary LIKE ? OR tags LIKE ? OR content LIKE ?)"
        )
        params.extend([like] * 8)
    if industry:
        where.append("industry LIKE ?")
        params.append(f"%{industry}%")

    sql = (
        "SELECT id, title, org, report_date, rating, target_price, industry, summary"
        " FROM reports WHERE " + " AND ".join(where) +
        " ORDER BY report_date DESC, id DESC LIMIT ?"
    )
    params.append(limit)

    try:
        conn = _connect()
        try:
            rows = conn.execute(sql, params).fetchall()
        finally:
            conn.close()
    except FileNotFoundError as error:
        return str(error)
    except sqlite3.Error as error:
        return f"研报库查询失败：{error}"

    if not rows:
        return f"研报库里没有匹配「{query or industry}」的内容。"

    lines = [f"共命中 {len(rows)} 篇（按报告日期倒序，最多 {limit} 篇）："]
    for rid, title, org, date, rating, target, ind, summary in rows:
        head = f"- [id={rid}] {date or ''} {org or ''}｜{title or ''}"
        extras = []
        if rating:
            extras.append(f"评级 {rating}")
        if target:
            extras.append(f"目标价 {target}")
        if ind:
            extras.append(f"行业 {ind}")
        if extras:
            head += "（" + "，".join(extras) + "）"
        lines.append(head)
        snippet = _clip(summary, SNIPPET_CHARS)
        if snippet:
            lines.append(f"  摘要：{snippet}")
    lines.append("需要原文请调用 get_report(report_id)。")
    return "\n".join(lines)


@server.tool(
    name="get_report",
    description=(
        "取一篇研报的正文（按 id），支持分页读取长文。"
        "id 来自 search_reports 的返回结果。"
    ),
)
def get_report(report_id: int, offset: int = 0, max_chars: int = 4000) -> str:
    try:
        report_id = int(report_id)
        offset = max(0, int(offset or 0))
        max_chars = max(500, min(int(max_chars or 4000), MAX_CONTENT_CHARS))
    except Exception:
        return "参数不合法：report_id 必须是整数。"

    try:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT title, org, report_date, rating, target_price, industry,"
                " summary, content FROM reports WHERE id = ?",
                (report_id,),
            ).fetchone()
        finally:
            conn.close()
    except FileNotFoundError as error:
        return str(error)
    except sqlite3.Error as error:
        return f"研报库查询失败：{error}"

    if not row:
        return f"没有 id={report_id} 的研报。"

    title, org, date, rating, target, ind, summary, content = row
    body = content or summary or ""
    total = len(body)
    chunk = body[offset:offset + max_chars]

    header = [f"# {title}", f"机构：{org or '未知'}｜日期：{date or '未知'}"]
    meta = []
    if rating:
        meta.append(f"评级 {rating}")
    if target:
        meta.append(f"目标价 {target}")
    if ind:
        meta.append(f"行业 {ind}")
    if meta:
        header.append("｜".join(meta))
    header.append(f"（正文共 {total} 字，本次返回第 {offset}–{offset + len(chunk)} 字）")

    parts = ["\n".join(header)]
    if not body:
        parts.append("（这篇没有正文，仅有摘要）")
        if summary:
            parts.append(summary)
        return "\n\n".join(parts)

    parts.append(chunk)
    if offset + len(chunk) < total:
        parts.append(f"（还有 {total - offset - len(chunk)} 字，可调大 offset 继续读）")
    return "\n\n".join(parts)


# ---------------------------------------------------------------- 必读筛选
#
# 背景：订阅每 5 分钟抓一次，稳定 20 篇/天，13 天堆了 582 篇。
# 用户的原话是「太多了，看不过来」—— 所以需要的不是列表，是**替他筛完**。
# 规则很直接：
#   1) 只留关注范围内（行业白名单 ∪ 持仓/近期交易过的标的）
#   2) 剔掉周报 / 月报 / 晨报 / 宏观利率 / 理财这类「必然存在、信息量极低」的品种
#   3) 只留带信号的：首次覆盖、深度、重大事项、评级或目标价上调、超预期、涨价、中标…
#   4) 按信号强度排序，只返回 1~3 条
# 目标是「要么 0 条（今天真没有），要么 3 条以内，每条一句话说清为什么值得看」。

DEFAULT_SCOPE = {
    "industries": [
        "通信设备", "半导体", "元件", "光学光电子", "电子化学品Ⅱ", "消费电子",
        "通用设备", "专用设备", "工业金属", "化学制药", "生物制品"
    ],
    "extra_stocks": [],
    "min_score": 5,
    "recent_days": 3
}

# (关键词, 权重, 展示用的理由)
SIGNALS = [
    ("首次覆盖", 6, "首次覆盖"),
    ("首次给予", 6, "首次覆盖"),
    ("首次推荐", 5, "首次推荐"),
    ("深度报告", 5, "深度报告"),
    ("深度研究", 5, "深度研究"),
    ("重大事项", 5, "重大事项"),
    ("重大合同", 5, "重大合同"),
    ("上调", 4, "评级/预期上调"),
    ("调高", 4, "评级/预期上调"),
    ("超预期", 4, "业绩超预期"),
    ("涨价", 4, "涨价"),
    ("提价", 4, "提价"),
    ("获批", 4, "获批"),
    ("量产", 3, "量产落地"),
    ("中标", 3, "中标"),
    ("订单", 3, "订单"),
    ("扩产", 3, "扩产"),
    ("突破", 3, "技术突破"),
    ("拐点", 3, "拐点"),
    ("供需", 2, "供需变化"),
    # 21财经·脱水研报这类「精选摘要」来源常用这些表述，不给权重就永远进不了必读
    ("创历史新高", 4, "业绩创新高"),
    ("机构调研", 3, "机构调研"),
    ("大模型", 2, "大模型落地"),
]

# 命中即降权/排除：这类研报每天都有，全是背景噪音
NOISE = ["周报", "月报", "晨报", "早报", "日报", "晨会", "数据点评", "利率债",
         "理财", "策略报告", "基金研究", "信用债", "可转债", "打新"]


def _load_scope() -> dict:
    import json
    scope = dict(DEFAULT_SCOPE)
    try:
        with open(SCOPE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
        for key in ("industries", "extra_stocks", "min_score", "recent_days"):
            if key in data:
                scope[key] = data[key]
    except Exception:
        pass
    return scope


def _plausible_stock(name: str) -> bool:
    """过滤掉交易库里的测试数据/噪声（TEST、2312、12 这类）。

    真实标的要么是 6 位代码（600176 / 000933.SZ），要么是含两个以上汉字的名称。
    不滤的话，「12」会命中摘要里的「10月12日」，把无关研报判成「涉及持仓」。
    """
    import re
    text = (name or "").strip()
    if not text:
        return False
    if re.fullmatch(r"\d{6}", text) or re.fullmatch(r"\d{6}\.(SH|SZ|BJ)", text.upper()):
        return True
    return len(re.findall(r"[\u4e00-\u9fa5]", text)) >= 2


def _recent_stocks(days: int = 365, cap: int = 60) -> list:
    """从交易记录里取最近交易过的标的（当作持仓/自选）。"""
    if not os.path.exists(TRADE_DB):
        return []
    try:
        conn = sqlite3.connect(f"file:{TRADE_DB}?mode=ro", uri=True, timeout=3)
        try:
            rows = conn.execute(
                "SELECT DISTINCT symbol FROM trades WHERE symbol <> '' "
                "AND open_date >= date('now', ?) LIMIT ?",
                (f"-{days} day", cap * 3),
            ).fetchall()
        finally:
            conn.close()
        names = [str(r[0]).strip() for r in rows if r[0]]
        return [name for name in names if _plausible_stock(name)][:cap]
    except sqlite3.Error:
        return []


@server.tool(
    name="get_must_read",
    description=(
        "【默认首选】返回「真正值得看」的研报，最多 3 条。"
        "用户问「今天有什么必读」「有什么值得看的研报」「扫一下最近的研报」「太多了看不过来」时调用。"
        "已内置过滤：只看用户关注行业与持仓相关标的，剔除周报/月报/宏观等噪音，"
        "只保留首次覆盖、深度、重大事项、上调、超预期、涨价、中标等信号级研报。"
        "返回条目少是正常现象——没有信号时会明确说没有。"
    ),
)
def get_must_read(days: int = 0, limit: int = 3) -> str:
    scope = _load_scope()
    try:
        days = int(days or 0) or int(scope.get("recent_days", 3))
        limit = max(1, min(int(limit or 3), MAX_MUST_READ))
        min_score = float(scope.get("min_score", 5))
    except Exception:
        days, limit, min_score = 3, 3, 5.0

    industries = [str(x).strip() for x in scope.get("industries") or [] if str(x).strip()]
    stocks = list(dict.fromkeys(
        _recent_stocks() + [str(x).strip() for x in scope.get("extra_stocks") or []]
    ))

    where = ["created_at >= date('now', ?)"]
    params: list = [f"-{days} day"]
    cond = []
    if industries:
        cond.append("(" + " OR ".join(["industry LIKE ?"] * len(industries)) + ")")
        params.extend([f"%{x}%" for x in industries])
    # 来源不标注行业的情况（例如 21财经·脱水研报，industry 字段为空）不能因为
    # 「不在白名单」就被整条丢掉 —— 否则只订阅这类来源时，必读会永远是空的。
    cond.append("(industry = '' OR industry IS NULL)")
    if stocks:
        # 个股研报的标题往往只有「业绩环比高增，Q3 超预期」这种概括，公司名在摘要开头
        # （形如「中国巨石(600176) …」），所以 title 和 summary 都要匹配。
        cond.append("(" + " OR ".join(["title LIKE ? OR summary LIKE ?"] * len(stocks)) + ")")
        for name in stocks:
            params.extend([f"%{name}%", f"%{name}%"])
    if not cond:
        cond.append("1=1")
    where.append("(" + " OR ".join(cond) + ")")

    sql = (
        "SELECT id, title, org, report_date, rating, target_price, industry, summary, content"
        " FROM reports WHERE " + " AND ".join(where) +
        " ORDER BY report_date DESC, id DESC LIMIT 400"
    )

    try:
        conn = _connect()
        try:
            rows = conn.execute(sql, params).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM reports WHERE created_at >= date('now', ?)",
                (f"-{days} day",),
            ).fetchone()[0]
        finally:
            conn.close()
    except FileNotFoundError as error:
        return str(error)
    except sqlite3.Error as error:
        return f"研报库查询失败：{error}"

    scored = []
    for rid, title, org, date, rating, target, ind, summary, content in rows:
        title_text = title or ""
        noise = next((n for n in NOISE if n in title_text), None)
        hits = []
        score = 0.0
        for kw, weight, label in SIGNALS:
            if kw in title_text or kw in (summary or ""):
                score += weight
                if label not in hits:
                    hits.append(label)
        if noise and score < 8:
            continue  # 周报 + 没有强信号 → 直接丢
        if any(s in title_text or s in (summary or "") for s in stocks):
            score += 6
            hits.append("涉及你的持仓/自选")
        if ind and any(i in ind for i in industries):
            score += 2
        if len(content or "") > 3000:
            score += 1
        if score < min_score:
            continue
        scored.append((score, rid, title, org, date, rating, target, ind, summary, hits))

    scored.sort(key=lambda x: (-x[0], x[4] or ""))
    picked = scored[:limit]

    if not picked:
        return (
            f"近 {days} 天共入库 {total} 篇，**没有达到必读标准的研报**。\n"
            "（周报、月报、宏观利率类已按规则剔除；如需按主题翻，用 search_reports。）"
        )

    lines = [f"近 {days} 天共入库 {total} 篇，按你的关注范围与信号强度筛出 {len(picked)} 条必读："]
    for score, rid, title, org, date, rating, target, ind, summary, hits in picked:
        reason = "、".join(dict.fromkeys(hits)) if hits else "综合信息量"
        meta = [x for x in [
            f"评级 {rating}" if rating else "",
            f"目标价 {target}" if target else "",
            f"行业 {ind}" if ind else "",
        ] if x]
        lines.append("")
        lines.append(f"### {title}")
        lines.append(f"[id={rid}] {date or ''} · {org or '未知机构'}" + (" · " + " · ".join(meta) if meta else ""))
        lines.append(f"**为什么值得看**：{reason}")
        gist = _clip(summary, 260)
        if gist:
            lines.append(f"**一句话结论**：{gist}")
        lines.append(f"（要原文调 get_report(report_id={rid})）")
    return "\n".join(lines)


def main() -> None:
    try:
        server.run()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
