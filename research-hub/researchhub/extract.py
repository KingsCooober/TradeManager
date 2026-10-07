"""PDF / 纯文本解析：抽取正文并启发式识别研报元数据。"""

from __future__ import annotations

import re
from pathlib import Path

# ------------------------------------------------------------------ PDF

def extract_pdf(raw: bytes) -> tuple[str, int, str]:
    """返回 (正文文本, 页数, 提示信息)。"""
    try:
        import io

        from pypdf import PdfReader
    except ImportError:  # pragma: no cover
        return "", 0, "未安装 pypdf，无法解析 PDF。请运行：pip3 install pypdf"

    try:
        reader = PdfReader(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        return "", 0, f"PDF 打开失败：{exc}"

    pages: list[str] = []
    for index, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001
            text = ""
        if text.strip():
            pages.append(f"\n\n<!-- page {index + 1} -->\n\n{text.strip()}")

    body = "\n".join(pages).strip()
    note = ""
    if not body:
        note = "该 PDF 未提取到文本（可能是扫描件/图片版），可改用 OCR 或直接粘贴正文。"
    return body, len(reader.pages), note


# ------------------------------------------------------------------ 元数据识别

BROKERS = [
    "中信证券", "中金公司", "华泰证券", "国泰君安", "招商证券", "广发证券", "海通证券",
    "中信建投", "申万宏源", "兴业证券", "东方证券", "光大证券", "浙商证券", "天风证券",
    "长江证券", "国信证券", "国金证券", "方正证券", "东吴证券", "华创证券", "开源证券",
    "民生证券", "华西证券", "国投证券", "中泰证券", "太平洋证券", "信达证券", "国海证券",
    "西部证券", "财通证券", "华安证券", "平安证券", "东方财富证券", "国盛证券", "德邦证券",
    "银河证券", "中银证券", "华宝证券", "兴业研究", "瑞银证券", "摩根士丹利", "高盛",
    "花旗", "野村", "麦格理", "汇丰", "中金", "申万", "国泰海通",
]

RATINGS = [
    "强烈推荐", "买入", "增持", "推荐", "跑赢行业", "优于大市", "强于大市", "审慎增持",
    "中性", "持有", "同步大市", "观望", "减持", "卖出", "回避", "跑输行业",
]

INDUSTRY_HINTS = [
    "半导体", "电子", "计算机", "通信", "传媒", "医药生物", "医药", "食品饮料", "白酒",
    "家用电器", "汽车", "电力设备", "新能源", "光伏", "风电", "储能", "锂电", "有色金属",
    "煤炭", "石油石化", "化工", "基础化工", "钢铁", "建筑材料", "建筑装饰", "房地产",
    "银行", "非银金融", "证券", "保险", "农林牧渔", "商贸零售", "社会服务", "纺织服装",
    "轻工制造", "国防军工", "机械设备", "交通运输", "公用事业", "环保", "美容护理",
    "人工智能", "机器人", "人形机器人", "消费电子", "军工", "券商", "黄金", "智能驾驶",
    "自动驾驶", "汽车零部件", "创新药", "医疗器械", "CXO", "数据要素", "信创", "算力",
    "固态电池", "低空经济", "半导体设备", "食品", "家电", "机械", "化工", "建材",
]

STOCK_CODE_RE = re.compile(r"(?<!\d)(\d{6}\.(?:SH|SZ|BJ)|\d{6})(?!\d)")
DATE_PATTERNS = [
    re.compile(r"(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})"),
    re.compile(r"(20\d{2})[-/年](\d{1,2})月?"),
]
TARGET_PRICE_RE = re.compile(
    r"目标价(?:格)?[^\d]{0,8}(\d+(?:\.\d+)?)"
    r"|target\s*price[^\d]{0,12}(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
PAGE_MARK_RE = re.compile(r"<!--\s*page\s*\d+\s*-->", re.IGNORECASE)
RATING_LINE_RE = re.compile(r"(?:投资评级|评级|维持|首次覆盖|给予)[：: ]{0,3}([^\n，,。；;]{1,12})")


def _clean_title(line: str) -> str:
    line = re.sub(r"\s+", " ", line).strip(" 　|·-—")
    line = re.sub(r"^#{1,6}\s*", "", line)          # Markdown 标题
    line = re.sub(r"^[>*+\-]\s+", "", line)         # 列表 / 引用符号
    line = re.sub(r"^\*\*(.+?)\*\*$", r"\1", line)  # 整行加粗
    line = re.sub(r"^[证券研究分析报告\s|]+", "", line)
    return line.strip()


META_LINE_RE = re.compile(
    r"^(分析师|研究员|作者|执业|证书编号|电话|邮箱|日期|时间|评级|目标价|股票代码|证券代码|"
    r"投资要点|核心观点|风险提示|免责|请务必|本报告|相关研究|评级说明|投资建议|事件|投资案件|"
    r"内容目录|目录|正文|摘要|abstract|disclaimer)\b|^[：:、,，。]+$",
    re.IGNORECASE,
)


def guess_title(text: str, filename: str = "") -> str:
    """优先取正文首个 Markdown 标题，其次首个像标题的行，最后退回文件名。"""
    head = PAGE_MARK_RE.sub("", text).lstrip("﻿ \n\t")
    fallback = ""
    for line in head.splitlines()[:40]:
        if not line.strip():
            continue
        is_heading = bool(re.match(r"^\s*#{1,3}\s+\S", line))
        candidate = _clean_title(line)
        if not candidate:
            continue
        if not fallback and len(candidate) >= 2:
            fallback = candidate
        if not (2 <= len(candidate) <= 60):
            continue
        if META_LINE_RE.search(candidate) or STOCK_CODE_RE.fullmatch(candidate):
            continue
        if is_heading:
            return candidate
        if 6 <= len(candidate) <= 60:
            return candidate
    if fallback:
        return fallback
    return Path(filename).stem if filename else "未命名研报"


def guess_org(text: str, filename: str = "") -> str:
    haystack = f"{filename}\n{text[:3000]}"
    for broker in BROKERS:
        if broker in haystack:
            return broker
    return ""


def guess_rating(text: str, filename: str = "") -> str:
    haystack = f"{filename}\n{text[:4000]}"
    match = RATING_LINE_RE.search(haystack)
    if match:
        for rating in RATINGS:
            if rating in match.group(1):
                return rating
    head = haystack[:2000]
    for rating in RATINGS:
        if rating in head:
            return rating
    return ""


def guess_date(text: str, filename: str = "") -> str:
    haystack = f"{filename}\n{text[:1500]}"
    for pattern in DATE_PATTERNS:
        match = pattern.search(haystack)
        if not match:
            continue
        groups = [g for g in match.groups() if g]
        if len(groups) >= 3:
            return f"{int(groups[0]):04d}-{int(groups[1]):02d}-{int(groups[2]):02d}"
        if len(groups) == 2:
            return f"{int(groups[0]):04d}-{int(groups[1]):02d}-01"
    return ""


def guess_industries(text: str, filename: str = "", limit: int = 3) -> list[str]:
    haystack = f"{filename}\n{text[:4000]}"
    found: list[tuple[int, str]] = []
    for industry in INDUSTRY_HINTS:
        pos = haystack.find(industry)
        if pos >= 0:
            found.append((pos, industry))
    found.sort()
    out: list[str] = []
    for _, industry in found:
        if industry not in out:
            out.append(industry)
        if len(out) >= limit:
            break
    return out


def guess_stock_code(text: str, filename: str = "") -> str:
    haystack = f"{filename}\n{text[:3000]}"
    match = STOCK_CODE_RE.search(haystack)
    return match.group(1) if match else ""


def guess_authors(text: str, limit: int = 3) -> str:
    """研报首页常见 '分析师：张三 李四' 或 'S123456789 王五'。"""
    head = text[:2500]
    names: list[str] = []
    for match in re.finditer(r"(?:分析师|研究员|作者)[：:\s]*([^\n]{2,40})", head):
        chunk = match.group(1)
        chunk = re.split(r"(?:执业|证书|S\d{9}|电话|邮箱|日期)", chunk)[0]
        for name in re.split(r"[\s,、，/]+", chunk):
            name = name.strip(" 　*")
            if 2 <= len(name) <= 4 and re.fullmatch(r"[\u4e00-\u9fa5·]{2,4}", name):
                if name not in names:
                    names.append(name)
    for match in re.finditer(r"\bS\d{9}\s*([\u4e00-\u9fa5·]{2,4})", head):
        if match.group(1) not in names:
            names.append(match.group(1))
    return "、".join(names[:limit])


def guess_target_price(text: str) -> str:
    match = TARGET_PRICE_RE.search(text[:6000])
    if not match:
        return ""
    return next((g for g in match.groups() if g), "")


def build_meta(text: str, filename: str = "") -> dict:
    return {
        "title": guess_title(text, filename),
        "org": guess_org(text, filename),
        "authors": guess_authors(text),
        "industry": "、".join(guess_industries(text, filename)),
        "rating": guess_rating(text, filename),
        "target_price": guess_target_price(text),
        "stock_code": guess_stock_code(text, filename),
        "report_date": guess_date(text, filename),
        "word_count": len(re.sub(r"\s+", "", text)),
    }


# ------------------------------------------------------------------ 纯文本

def normalize_pasted(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def looks_like_markdown(text: str) -> bool:
    return bool(re.search(r"^#{1,6}\s+\S", text, flags=re.MULTILINE))
