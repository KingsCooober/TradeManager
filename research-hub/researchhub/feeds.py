"""公开研报抓取。

设计边界（重要）：
- 只访问**无需登录、无需付费**的公开页面；
- 不绕过、不破解任何验证码 / 反爬挑战 / 付费墙；
- 抓到的正文版权归原券商所有，仅供个人研究使用，请勿二次分发；
- 请求之间加入间隔，避免给来源站点造成压力。

接入的来源：
- eastmoney：东方财富研报中心，结构化接口，元数据最全（评级 / 行业 / 分析师 / 页数），
  机构下拉来自来源公开列表；支持个股 / 行业 / 策略 / 宏观 / 券商晨会。
- sina：新浪财经研究报告，HTML 列表，覆盖头部券商（中信建投、华泰、中金、国泰海通等），
  支持最新 / 行业 / 策略 / 宏观，以及按机构全称检索。
"""

from __future__ import annotations

import html
import json
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)

REQUEST_GAP = 0.5            # 通用请求间隔（秒）
SINA_GAP = 1.6               # 新浪对突发频率敏感，间隔放宽，避免被限流返回空列表
SINA_BACKOFF = (2.5, 8.0)    # 命中限流后的退避梯度（秒）
MAX_ITEMS_PER_IMPORT = 20

EM_API = "https://reportapi.eastmoney.com"
EM_HOME = "https://data.eastmoney.com/report/"
SINA_LIST = "https://vip.stock.finance.sina.com.cn/q/go.php/vReport_List/kind/"
SINA_HOME = SINA_LIST + "lastest/index.phtml"
SINA_ORG_JS = "http://finance.sina.com.cn/stock/reaserchyjbg/report/report_orgname_juyuan.js"

EM_TYPES = [
    {"key": "stock", "label": "个股研报"},
    {"key": "industry", "label": "行业研报"},
    {"key": "strategy", "label": "策略报告"},
    {"key": "macro", "label": "宏观研究"},
    {"key": "broker", "label": "券商晨会"},
]
EM_QTYPE = {"stock": 0, "industry": 1, "strategy": 2, "macro": 3, "broker": 4}

SINA_TYPES = [
    {"key": "latest", "label": "最新研报"},
    {"key": "industry", "label": "行业研报"},
    {"key": "strategy", "label": "策略报告"},
    {"key": "macro", "label": "宏观研究"},
]
# 注意：站点自身的路径拼写是 lastest（原文如此），不是 latest
SINA_PATH = {"latest": "lastest", "industry": "industry", "strategy": "strategy", "macro": "macro"}
# 按天检索页里的"报告类型"列
SINA_COLUMN_TYPE = {
    "公司": "个股研报", "行业": "行业研报", "策略": "策略报告", "宏观": "宏观研究",
    "债券": "债券研究", "基金": "基金研究", "创业板": "创业板", "晨会": "券商晨会",
    "期货": "期货研究", "外汇": "外汇研究", "金融工程": "金融工程", "港股": "港股研究",
    "美股": "美股研究", "其他": "研报",
}
SINA_KIND_LABEL = {
    "latest": "最新研报", "lastest": "最新研报", "industry": "行业研报",
    "strategy": "策略报告", "macro": "宏观研究", "search": "机构检索",
}

SOURCES = [
    {
        "key": "eastmoney",
        "label": "东方财富 · 研报中心",
        "home": EM_HOME,
        "note": "结构化公开接口，元数据最全（评级 / 行业 / 分析师 / 页数），正文来自公开正文页。",
        "coverage": "机构下拉为来源公开列表（含中小券商、外资券商与研究机构）；头部券商研报在此接口下多为付费内容，不在抓取范围内，可用新浪来源补充。",
        "org_filter": "code",
        "types": EM_TYPES,
    },
    {
        "key": "sina",
        "label": "新浪财经 · 研究报告",
        "home": SINA_HOME,
        "note": "覆盖头部券商（中信建投、华泰证券、中金公司、国泰海通等）的公开研报列表与正文页。",
        "coverage": "支持按机构全称检索；该站点偶发返回空列表，本工具会自动重试一次。",
        "org_filter": "name",
        "types": SINA_TYPES,
    },
]
SOURCE_BY_KEY = {s["key"]: s for s in SOURCES}
DISCLAIMER = (
    "仅抓取无需登录、无需付费的公开页面内容，不绕过任何验证码、反爬机制或付费墙；"
    "正文版权归原券商所有，仅供个人研究使用，请勿二次分发。"
)


class FeedError(RuntimeError):
    """抓取失败（网络、来源改版、解析不到内容等）。"""


# ------------------------------------------------------------------ HTTP

def _headers(referer: str = EM_HOME) -> dict:
    return {
        "User-Agent": UA,
        "Referer": referer,
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
    }


def _fetch(url: str, timeout: float = 25.0, encodings=("utf-8", "gb18030"), referer: str = EM_HOME) -> str:
    request = urllib.request.Request(url, headers=_headers(referer))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            charset = response.headers.get_content_charset()
    except urllib.error.HTTPError as exc:
        raise FeedError(f"来源返回 HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise FeedError(f"无法连接来源站点：{exc.reason}") from exc
    except TimeoutError as exc:
        raise FeedError("访问来源站点超时") from exc

    for encoding in ([charset] if charset else []) + list(encodings):
        if not encoding:
            continue
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="ignore")


def _fetch_json(url: str, timeout: float = 25.0, referer: str = EM_HOME) -> dict:
    text = _fetch(url, timeout, referer=referer)
    try:
        return json.loads(text)
    except ValueError as exc:
        raise FeedError("来源返回的不是合法 JSON（接口可能已改版）") from exc


def _fetch_with_retry(fetch, *, attempts: int = 2, gap: float = 0.9):
    """部分来源（新浪）会偶发返回空列表，这里做一次重试。"""
    last = None
    for index in range(attempts):
        try:
            result = fetch()
        except FeedError as exc:
            last = exc
            result = None
        if result:
            return result
        if index < attempts - 1:
            time.sleep(gap)
    if last is not None:
        raise last
    return None


# ------------------------------------------------------------------ 机构列表

_org_cache: dict[str, dict] = {}
_org_lock = threading.Lock()
ORG_TTL = 12 * 3600


def list_orgs(source: str = "eastmoney", force: bool = False) -> list[dict]:
    if source not in SOURCE_BY_KEY:
        raise FeedError(f"暂不支持的来源：{source}")
    with _org_lock:
        cached = _org_cache.get(source) or {}
        if cached.get("data") and not force and time.time() - cached.get("at", 0) < ORG_TTL:
            return cached["data"]
        orgs = _list_orgs_eastmoney() if source == "eastmoney" else _list_orgs_sina()
        _org_cache[source] = {"at": time.time(), "data": orgs}
        return orgs


def _list_orgs_eastmoney() -> list[dict]:
    payload = _fetch_json(f"{EM_API}/report/org")
    orgs = []
    for row in payload.get("data") or []:
        code = str(row.get("orgCode") or "")
        name = (row.get("orgSName") or row.get("orgName") or "").strip()
        if code and name:
            orgs.append({
                "code": code, "name": name,
                "full_name": (row.get("orgName") or "").strip(),
                "letter": (row.get("firstLetter") or "").strip().upper(),
            })
    orgs.sort(key=lambda o: (o["letter"], o["name"]))
    return orgs


def _short_org(full_name: str) -> str:
    """'中信建投证券股份有限公司' -> '中信建投证券'"""
    name = re.sub(r"股份(有限)?公司$|有限责任公司$|有限公司$|集团$", "", full_name).strip()
    return name or full_name


def _list_orgs_sina() -> list[dict]:
    text = _fetch(SINA_ORG_JS, referer=SINA_HOME)
    names = []
    for match in re.finditer(r'svalue\s*:\s*"([^"]+)"', text):
        full = html.unescape(match.group(1)).strip()
        if full and full not in names:
            names.append(full)
    orgs = [
        {
            "code": full,                     # 新浪按机构全称检索，code 就用全称
            "name": _short_org(full),
            "full_name": full,
            "letter": (_short_org(full)[:1] or "#").upper(),
        }
        for full in names
    ]
    orgs.sort(key=lambda o: (o["letter"], o["name"]))
    return orgs


# ------------------------------------------------------------------ 东方财富

def _em_detail_url(info_code: str, type_key: str) -> str:
    if not info_code:
        return EM_HOME
    if type_key == "stock":
        return f"https://data.eastmoney.com/report/info/{info_code}.html"
    return f"https://data.eastmoney.com/report/zw_industry.jshtml?infocode={info_code}"


def _em_normalize(row: dict, type_key: str) -> dict:
    """注意：接口返回的 reportType 并不等于查询用的 qType，类型一律以检索条件为准。"""
    info_code = str(row.get("infoCode") or "")
    rating = (row.get("emRatingName") or "").strip()
    if not rating:
        rating = re.sub(r"[（(].*?[)）]", "", (row.get("sRatingName") or "")).strip()
    authors = (row.get("researcher") or "").strip()
    if not authors:
        names = []
        for entry in row.get("author") or []:
            name = str(entry).split(".")[-1].strip()
            if name and name not in names:
                names.append(name)
        authors = "、".join(names)
    suffix = {"SHANGHAI": "SH", "SHENZHEN": "SZ", "BEIJING": "BJ"}.get((row.get("market") or "").upper(), "")
    stock_code = str(row.get("stockCode") or "")
    if stock_code and suffix and "." not in stock_code:
        stock_code = f"{stock_code}.{suffix}"
    return {
        "source": "eastmoney",
        "id": info_code,
        "kind": type_key,
        "title": html.unescape((row.get("title") or "").strip()),
        "org": (row.get("orgSName") or row.get("orgName") or "").strip(),
        "authors": authors,
        "rating": rating,
        "industry": (row.get("indvInduName") or row.get("industryName") or "").strip(),
        "stock_name": (row.get("stockName") or "").strip(),
        "stock_code": stock_code,
        "date": str(row.get("publishDate") or "")[:10],
        "pages": row.get("attachPages") or 0,
        "type_label": next((t["label"] for t in EM_TYPES if t["key"] == type_key), "研报"),
        "url": _em_detail_url(info_code, type_key),
    }


def _em_search(*, type_key, org_code, stock_code, begin, end, keyword, page, page_size) -> dict:
    if type_key not in EM_QTYPE:
        raise FeedError(f"不支持的研报类型：{type_key}")
    params = {
        "industryCode": "*", "industry": "*", "rating": "", "ratingChange": "",
        "beginTime": begin or "", "endTime": end or "", "pageNo": page, "pageSize": page_size,
        "fields": "", "qType": EM_QTYPE[type_key], "orgCode": org_code or "",
        "code": stock_code or "*", "rcode": "", "p": page, "pageNum": page, "pageNumber": page,
    }
    payload = _fetch_json(f"{EM_API}/report/list?{urllib.parse.urlencode(params)}")
    items = [_em_normalize(row, type_key) for row in payload.get("data") or []]

    keyword = (keyword or "").strip()
    if keyword:
        needles = [k for k in re.split(r"[\s,，]+", keyword) if k]

        def hit(item: dict) -> bool:
            blob = " ".join([item["title"], item["org"], item["industry"], item["stock_name"], item["authors"]])
            return all(n in blob for n in needles)

        items = [i for i in items if hit(i)]

    return {
        "total": int(payload.get("hits") or 0),
        "total_pages": int(payload.get("TotalPage") or 0),
        "items": items,
    }


_EM_BLOCK_TAGS = ("h1", "h2", "h3", "h4", "p", "table", "li")


def _table_to_markdown(table) -> str:
    rows = []
    for tr in table.find_all("tr"):
        cells = [re.sub(r"\s+", " ", td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
        if any(cells):
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head, *body = rows
    lines = ["| " + " | ".join(head) + " |", "| " + " | ".join(["---"] * width) + " |"]
    lines += ["| " + " | ".join(r) + " |" for r in body]
    return "\n".join(lines)


def _soup(page: str):
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover
        raise FeedError("缺少 beautifulsoup4，无法解析正文页。请运行：pip3 install beautifulsoup4") from exc
    return BeautifulSoup(page, "html.parser")


def _em_parse_page(page: str) -> str:
    soup = _soup(page)
    container = soup.find("div", class_="ctx-content") or soup.find(id="ctx-content")
    if container is None:
        return ""
    parts: list[str] = []
    seen: set[int] = set()
    for node in container.find_all(_EM_BLOCK_TAGS):
        if node.name == "table":
            if id(node) in seen:
                continue
            seen.add(id(node))
            block = _table_to_markdown(node)
            if block:
                parts.append(block)
            continue
        if node.find_parent("table") is not None:
            continue
        text = re.sub(r"[ \t\u00a0\u3000]+", " ", node.get_text(" ", strip=True)).strip()
        if not text:
            continue
        if node.name == "li":
            parts.append(f"- {text}")
        elif node.name in ("h1", "h2", "h3", "h4"):
            parts.append(f"### {text}")
        else:
            parts.append(text)
    deduped: list[str] = []
    for part in parts:
        if not deduped or deduped[-1] != part:
            deduped.append(part)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(deduped)).strip()


# ------------------------------------------------------------------ 新浪财经

SINA_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
SINA_LINK_RE = re.compile(r'href="([^"]*vReport_Show[^"]*)"[^>]*>(.*?)</a>', re.S)
SINA_KIND_RE = re.compile(r"kind/(\w+)/rptid/(\d+)/")


def _sina_normalize(row: dict) -> dict:
    kind = row.get("kind") or "latest"
    return {
        "source": "sina",
        "id": row["rptid"],
        "kind": kind,
        "title": row["title"],
        "org": _short_org(row.get("org") or ""),
        "authors": row.get("authors") or "",
        "rating": "",
        "industry": "",
        "stock_name": "",
        "stock_code": "",
        "date": row.get("date") or "",
        "pages": 0,
        "type_label": SINA_COLUMN_TYPE.get(row.get("rpt_type") or "", "") or SINA_KIND_LABEL.get(kind, "研报"),
        "url": _sina_detail_url(row["rptid"], kind),
    }


def _sina_detail_url(rptid: str, kind: str) -> str:
    kind = kind if kind and kind != "search" else "lastest"
    return f"https://stock.finance.sina.com.cn/stock/go.php/vReport_Show/kind/{kind}/rptid/{rptid}/index.phtml"


def _parse_sina_rows(page: str) -> list[dict]:
    rows: list[dict] = []
    for block in SINA_ROW_RE.findall(page):
        link = SINA_LINK_RE.search(block)
        if not link:
            continue
        match = SINA_KIND_RE.search(link.group(1))
        if not match:
            continue
        title_attr = re.search(r'title="([^"]*)"', block)
        title = html.unescape(title_attr.group(1)) if title_attr else re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", link.group(2))).strip()
        cells = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<td[^>]*>(.*?)</td>", block, re.S)]
        org = re.search(r'class="fname05"><span>([^<]+)</span>', block)
        auth = re.search(r'class="fname"><span>([^<]+)</span>', block)
        rows.append({
            "rptid": match.group(2),
            "kind": match.group(1),
            "title": html.unescape(title).strip(),
            "rpt_type": cells[2] if len(cells) > 2 else "",
            "date": cells[3] if len(cells) > 3 else "",
            "org": html.unescape(org.group(1)) if org else "",
            "authors": html.unescape(auth.group(1)) if auth else "",
        })
    # 去重（搜索页可能重复返回同一篇）
    seen, unique = set(), []
    for row in rows:
        if row["rptid"] in seen:
            continue
        seen.add(row["rptid"])
        unique.append(row)
    return unique


def _sina_page_url(kind: str, page: int, org_code: str = "") -> str:
    if org_code:
        quoted = urllib.parse.quote(org_code.encode("gb18030"))
        return f"{SINA_LIST}search/index.phtml?t1=1&orgname={quoted}&p={page}"
    return f"{SINA_LIST}{SINA_PATH.get(kind, kind)}/index.phtml?p={page}"


def _sina_search(*, type_key, org_code, begin, keyword, page, page_size) -> dict:
    if type_key not in {t["key"] for t in SINA_TYPES} and not org_code:
        raise FeedError(f"不支持的研报类型：{type_key}")

    collected: list[dict] = []
    max_pages = 3 if org_code else 2
    for page_no in range(1, max_pages + 1):
        url = _sina_page_url(type_key, page_no, org_code)
        rows, _ = _sina_fetch_rows(url)
        if not rows:
            break
        collected.extend(rows)
        oldest = min((r["date"] for r in rows if r.get("date")), default="")
        if begin and oldest and oldest < begin:
            break
        if page_no < max_pages:
            time.sleep(SINA_GAP)

    items = [_sina_normalize(row) for row in collected]
    if begin:
        items = [i for i in items if not i["date"] or i["date"] >= begin]
    keyword = (keyword or "").strip()
    if keyword:
        needles = [k for k in re.split(r"[\s,，]+", keyword) if k]
        items = [i for i in items if all(n in f"{i['title']} {i['org']} {i['authors']}" for n in needles)]

    total = len(items)
    start = (page - 1) * page_size
    return {
        "total": total,
        "total_pages": max(1, (total + page_size - 1) // page_size),
        "items": items[start:start + page_size],
    }


SINA_DAY_MAX_PAGES = 3      # 单日最多翻几页
SINA_DAY_GAP = 8.0          # 按天走：新浪限流是滑动窗口式的，间隔需要放宽
SINA_NO_DATA_MARK = "没有找到"   # 该页确实没数据（与"被限流返回空"区分开）


def _sina_fetch_rows(url: str) -> tuple[list[dict], bool]:
    """抓一页并判断状态。

    返回 (行, 是否确定没数据)。新浪被限流时同样返回 HTTP 200 的空页，
    但"确实没有数据"的页面里带「没有找到」标记 —— 靠这个区分，
    否则会对着空页反复重试，既慢又把自己送进限流。
    """
    for attempt in range(3):
        page_html = _fetch(url, referer=SINA_HOME)
        if not page_html:
            if attempt < 2:
                time.sleep(SINA_BACKOFF[attempt])
            continue
        rows = _parse_sina_rows(page_html)
        if rows:
            return rows, False
        if SINA_NO_DATA_MARK in page_html:
            return [], True          # 明确没数据，不该重试
        if attempt < 2:
            time.sleep(SINA_BACKOFF[attempt])
    return [], False


def _sina_day_search(*, begin: str, end: str, keyword: str, page: int, page_size: int) -> dict:
    """按天检索：一次请求覆盖当天全部报告类型，比按类型翻页省得多，也更不容易被限流。"""
    try:
        stop = date.fromisoformat(begin)
        cursor = date.fromisoformat(end)
    except ValueError as exc:
        raise FeedError("日期格式不正确，应为 YYYY-MM-DD") from exc

    collected: list[dict] = []
    days = 0
    while cursor >= stop and days < 400:
        days += 1
        day_text = cursor.isoformat()
        for page_no in range(1, SINA_DAY_MAX_PAGES + 1):
            url = f"{SINA_LIST}search/index.phtml?t1=6&pubdate={day_text}&p={page_no}"
            rows, definitely_empty = _sina_fetch_rows(url)
            if not rows:
                break                     # 没数据或被限流，都留给下一轮补
            collected.extend(rows)
            if definitely_empty or len(rows) < 40:
                break
            time.sleep(SINA_DAY_GAP)
        cursor -= timedelta(days=1)
        if cursor >= stop:
            time.sleep(SINA_DAY_GAP + random.uniform(0, 4))   # 加抖动，避免固定节奏被识别

    items = [_sina_normalize(row) for row in collected]
    keyword = (keyword or "").strip()
    if keyword:
        needles = [k for k in re.split(r"[\s,，]+", keyword) if k]
        items = [i for i in items if all(n in f"{i['title']} {i['org']} {i['authors']}" for n in needles)]
    # 深挖模式供批量回填使用，一次性把区间内命中的都交出去，不做分页切片
    return {"total": len(items), "total_pages": 1, "items": items}


def _sina_parse_page(page: str) -> str:
    soup = _soup(page)
    container = soup.find("div", class_="blk_container") or soup.find("div", class_="content")
    if container is None:
        return ""
    parts: list[str] = []
    for node in container.find_all(["p", "div", "h1", "h2", "h3", "h4"]):
        if node.find(["p", "div"]) is not None:      # 只取叶子块，避免重复
            continue
        text = re.sub(r"[ \t\u00a0\u3000]+", " ", node.get_text(" ", strip=True)).replace("\xa0", " ").strip()
        if not text:
            continue
        if node.name in ("h1", "h2", "h3", "h4"):
            parts.append(f"### {text}")
        else:
            parts.append(text)
    if not parts:
        text = re.sub(r"[ \t\u00a0\u3000]+", " ", container.get_text("\n", strip=True)).strip()
        return re.sub(r"\n{3,}", "\n\n", text)
    deduped: list[str] = []
    for part in parts:
        if not deduped or deduped[-1] != part:
            deduped.append(part)
    return re.sub(r"\n{3,}", "\n\n", "\n\n".join(deduped)).strip()


# ------------------------------------------------------------------ 对外接口

def detail_url(source: str, item_id: str, kind: str = "") -> str:
    if source == "sina":
        return _sina_detail_url(item_id, kind)
    return _em_detail_url(item_id, kind or "industry")


def search(
    *,
    source: str = "eastmoney",
    type_key: str = "stock",
    org_code: str = "",
    stock_code: str = "",
    begin: str = "",
    end: str = "",
    keyword: str = "",
    page: int = 1,
    page_size: int = 20,
    deep: bool = False,
) -> dict:
    """按条件检索公开研报（只读元数据，不落库）。"""
    if source not in SOURCE_BY_KEY:
        raise FeedError(f"暂不支持的来源：{source}")
    page = max(1, int(page or 1))
    page_size = max(5, min(int(page_size or 20), 50))

    if source == "sina":
        if deep and begin and end:
            result = _sina_day_search(begin=begin, end=end, keyword=keyword,
                                      page=page, page_size=page_size)
        else:
            result = _sina_search(type_key=type_key, org_code=org_code, begin=begin,
                                  keyword=keyword, page=page, page_size=page_size)
        result["type_label"] = SINA_KIND_LABEL.get(type_key, "研报")
    else:
        if type_key not in EM_QTYPE:
            raise FeedError(f"不支持的研报类型：{type_key}")
        result = _em_search(type_key=type_key, org_code=org_code, stock_code=stock_code,
                            begin=begin, end=end, keyword=keyword,
                            page=page, page_size=page_size)
        result["type_label"] = next((t["label"] for t in EM_TYPES if t["key"] == type_key), "研报")

    result.update({"source": source, "type": type_key, "page": page, "page_size": page_size})
    if source == "sina" and not result["items"]:
        result["warning"] = (
            "该来源返回了空列表。通常是短时间请求过多被限流（本工具已按 1.1 秒/次放慢），"
            "也可能确实是筛选条件过窄；建议等几秒重试，或把时间范围放宽、机构改为「全部机构」。"
        )
    return result


def fetch_content(item: dict) -> dict:
    """抓取单篇研报的公开正文。返回 {content, url, info_code}。"""
    source = item.get("source") or "eastmoney"
    item_id = str(item.get("id") or "").strip()
    kind = str(item.get("kind") or "")
    if not item_id:
        raise FeedError("缺少研报编号，无法定位正文页")
    url = detail_url(source, item_id, kind)
    if source == "sina":
        page = _fetch_with_retry(lambda: _fetch(url, referer=SINA_HOME))
        content = _sina_parse_page(page or "")
    else:
        page = _fetch(url)
        content = _em_parse_page(page)
    # reason: "" 表示正常；"empty" 表示页面打开成功但来源站确实没有文字正文
    return {"content": content, "url": url, "info_code": item_id,
            "reason": "" if content else "empty"}


def _em_pdf_url(url: str, info_code: str = "") -> str:
    """东方财富研报的原文 PDF 直链（该来源有稳定规律：H3_<infocode>_1.pdf）。"""
    if "eastmoney.com" not in (url or ""):
        return ""
    code = str(info_code or "").strip()
    if not code:
        m = (re.search(r"infocode=([A-Za-z0-9]+)", url or "")
             or re.search(r"/report/info/([A-Za-z0-9]+)\.html", url or ""))
        code = m.group(1) if m else ""
    if not code:
        return ""
    return f"https://pdf.dfcfw.com/pdf/H3_{code}_1.pdf"


def build_markdown(item: dict, content: str, reason: str = "") -> str:
    """把元信息 + 正文拼成一篇完整的 Markdown。"""
    url = (item.get("url") or "").strip()
    pdf_url = _em_pdf_url(url, item.get("id"))
    meta = [
        ("机构", item.get("org")),
        ("分析师", item.get("authors")),
        ("报告类型", item.get("type_label")),
        ("行业", item.get("industry")),
        ("标的", " ".join(x for x in [item.get("stock_name"), item.get("stock_code")] if x)),
        ("评级", item.get("rating")),
        ("发布日期", item.get("date")),
        ("原文页", f"[{url}]({url})" if url else ""),
    ]
    if pdf_url:
        meta.append(("原文 PDF", f"[{pdf_url}]({pdf_url})"))
    lines = [f"# {item.get('title') or '未命名研报'}", ""]
    lines += [f"- **{k}**：{v}" for k, v in meta if v]
    lines.append("")
    if content:
        lines += ["---", "", content.strip(), ""]
    elif reason == "empty":
        lines += [
            "> 📄 **这篇研报在来源站只有标题与摘要，没有公开的文字版全文。**",
            "> 元数据（机构 / 分析师 / 评级 / 日期）已完整保留，正文请点开原文页查看：",
            f"> [{item.get('url')}]({item.get('url')})",
            "",
        ]
    elif reason == "failed":
        lines += [
            "> ⚠️ **正文抓取失败**（网络波动或来源限流）。",
            "> 可以到「研报抓取 → 补全缺失正文」一键重试：",
            f"> [{item.get('url')}]({item.get('url')})",
            "",
        ]
    else:
        lines += [
            "> ⏳ 这篇研报还没有抓取正文。",
            "> 到「研报抓取 → 补全缺失正文」可以一键补充。",
            f"> [{item.get('url')}]({item.get('url')})",
            "",
        ]
    lines += ["---", "", "*本内容由程序自动抓取自公开页面，版权归原券商所有，仅供个人研究使用。*"]
    return "\n".join(lines)


def make_summary(content: str, limit: int = 150) -> str:
    """从抓到的正文里取一段干净的摘要（去掉 Markdown 标记与多余空白）。"""
    text = re.sub(r"<[^>]+>", " ", content or "")
    text = re.sub(r"^\s*#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"[*`>|_]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    return text[:limit] + ("…" if len(text) > limit else "")


def polite_sleep(seconds: float = REQUEST_GAP) -> None:
    time.sleep(seconds)


def sources_payload(force: bool = False) -> dict:
    """给前端的来源元数据，附带各来源的机构列表。"""
    payload = []
    errors = []
    for source in SOURCES:
        entry = {**source, "orgs": []}
        try:
            entry["orgs"] = list_orgs(source["key"], force=force)
        except FeedError as exc:
            errors.append(f"{source['label']}：{exc}")
        payload.append(entry)
    return {
        "sources": payload,
        "error": "；".join(errors),
        "max_import": MAX_ITEMS_PER_IMPORT,
        "disclaimer": DISCLAIMER,
    }
