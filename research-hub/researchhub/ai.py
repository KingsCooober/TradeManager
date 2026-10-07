"""大模型能力：摘要、要点提取、问答。兼容 OpenAI Chat Completions 协议。"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

TIMEOUT = httpx.Timeout(180.0, connect=20.0)

SUMMARIZE_PROMPT = """你是一名资深卖方研究助理，负责把研报提炼成可复用的信息卡。
请阅读下面的研报正文，输出**严格的 JSON**（不要 markdown 代码块，不要任何解释文字），字段如下：

{
  "summary": "用 2-4 句话概括这篇研报的核心结论（不超过 200 字）",
  "key_points": ["3-6 条核心观点，每条一句话，尽量带逻辑链"],
  "key_data": ["3-6 条关键数据/预测，保留数字、单位、年份，例如 2025E 归母净利润 120.5 亿元，同比 +18%"],
  "risks": "风险提示，2-3 条，用分号分隔",
  "tags": ["3-6 个主题标签，2-6 字，例如 国产替代、AI算力、提价逻辑"],
  "rating": "研报给出的投资评级，若正文没有则填空字符串",
  "target_price": "目标价，只保留数字，没有则填空字符串",
  "sentiment": "看多 / 中性 / 看空 三选一",
  "confidence": "高 / 中 / 低，表示你对提取结果的把握"
}

要求：
1. 只依据正文内容，禁止编造数字；正文没写的信息就留空。
2. key_data 必须包含具体数字，不要出现“增长显著”这类空话。
3. 如果正文明显不是研报，summary 里直接说明文档类型。
"""

ASK_PROMPT = """你是研报阅读助手。请只依据下面的研报正文回答用户问题。
- 如果正文没有相关信息，明确说“研报中未提及”，不要编造。
- 回答用中文，先给结论，再列依据；涉及数字时原样引用。
- 控制在 400 字以内。

【研报正文】
{body}
"""


class AIError(RuntimeError):
    pass


def _settings(settings: dict) -> tuple[str, str, str, float]:
    base = (settings.get("ai_base_url") or "").strip().rstrip("/")
    key = (settings.get("ai_api_key") or "").strip()
    model = (settings.get("ai_model") or "").strip()
    try:
        temperature = float(settings.get("ai_temperature") or 0.3)
    except ValueError:
        temperature = 0.3
    if not base:
        raise AIError("未配置 API Base URL，请到「设置」里填写。")
    if not key:
        raise AIError("未配置 API Key，请到「设置」里填写。")
    if not model:
        raise AIError("未配置模型名称，请到「设置」里填写。")
    return base, key, model, temperature


def chat(messages: list[dict], settings: dict, *, json_mode: bool = False,
         max_tokens: int = 2200) -> str:
    base, key, model, temperature = _settings(settings)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    url = f"{base}/chat/completions"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            response = client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        if json_mode:  # 部分兼容网关不支持 response_format，降级重试
            payload.pop("response_format", None)
            try:
                with httpx.Client(timeout=TIMEOUT) as client:
                    response = client.post(url, headers=headers, json=payload)
            except httpx.HTTPError as exc2:  # noqa: BLE001
                raise AIError(f"调用模型失败：{exc2}") from exc2
        else:
            raise AIError(f"调用模型失败：{exc}") from exc

    if response.status_code >= 400:
        detail = response.text[:400]
        raise AIError(f"模型接口返回 {response.status_code}：{detail}")

    try:
        data = response.json()
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, ValueError) as exc:
        raise AIError(f"无法解析模型返回：{response.text[:300]}") from exc


def _body_excerpt(content: str, head: int = 9000, tail: int = 2500) -> str:
    text = content or ""
    if len(text) <= head + tail:
        return text
    return f"{text[:head]}\n\n……（中间省略）……\n\n{text[-tail:]}"


def _parse_json(raw: str) -> dict:
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    try:
        return json.loads(text)
    except ValueError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except ValueError:
            pass
    raise AIError(f"模型未返回合法 JSON：{raw[:200]}")


def _as_list(value, limit: int = 8) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = re.split(r"[\n；;]+", value)
        items = [p.strip(" -•\t") for p in parts]
    elif isinstance(value, list):
        items = []
        for item in value:
            if isinstance(item, dict):
                item = "；".join(f"{k}：{v}" for k, v in item.items())
            items.append(str(item).strip(" -•\t"))
    else:
        items = [str(value)]
    out, seen = [], set()
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out[:limit]


def summarize(title: str, content: str, settings: dict) -> dict:
    if not (content or "").strip():
        raise AIError("这篇研报没有正文，无法生成摘要。")
    messages = [
        {"role": "system", "content": SUMMARIZE_PROMPT},
        {
            "role": "user",
            "content": f"研报标题：{title or '未命名'}\n\n研报正文：\n{_body_excerpt(content)}",
        },
    ]
    raw = chat(messages, settings, json_mode=True, max_tokens=2000)
    data = _parse_json(raw)
    result = {
        "summary": str(data.get("summary") or "").strip(),
        "key_points": _as_list(data.get("key_points")),
        "key_data": _as_list(data.get("key_data")),
        "risks": str(data.get("risks") or "").strip(),
        "tags": _as_list(data.get("tags"), limit=8),
        "rating": str(data.get("rating") or "").strip(),
        "target_price": str(data.get("target_price") or "").strip(),
        "sentiment": str(data.get("sentiment") or "").strip(),
        "confidence": str(data.get("confidence") or "").strip(),
    }
    if not result["summary"] and not result["key_points"]:
        raise AIError("模型返回内容为空，请检查模型名称或稍后重试。")
    return result


def ask(title: str, content: str, question: str, settings: dict) -> str:
    if not (content or "").strip():
        raise AIError("这篇研报没有正文，无法问答。")
    messages = [
        {"role": "system", "content": ASK_PROMPT.format(body=_body_excerpt(content))},
        {"role": "user", "content": f"研报标题：{title}\n\n我的问题：{question}"},
    ]
    return chat(messages, settings, max_tokens=1200).strip()


def test_connection(settings: dict) -> dict:
    base, key, model, _ = _settings(settings)
    messages = [{"role": "user", "content": "只回复两个字：正常"}]
    reply = chat(messages, settings, max_tokens=16)
    return {"ok": True, "model": model, "base_url": base, "reply": reply.strip()[:50]}
