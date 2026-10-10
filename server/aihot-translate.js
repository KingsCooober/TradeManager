'use strict';

// AIHOT 英文正文翻译：段落级中英对照。
// 引擎策略（智能降级）：
//   1) 复用「研报库」里已配置的大模型（OpenAI 兼容协议，默认 DeepSeek）——质量最好；
//   2) 未配置 API Key 时，自动降级到 MyMemory 免费翻译接口，保证零配置可用。
// 译文按段落文本缓存，重复展开同一篇文章不会重复计费。

const http = require('http');
const https = require('https');
const path = require('path');
const sqlite3 = require('sqlite3');

// 研报库的设置库（与 research-hub 共用同一份 AI 配置，用户只需填一次）
const SETTINGS_DB = path.join(__dirname, '..', 'research-hub', 'data', 'research.db');
const SETTINGS_TTL_MS = 60 * 1000;

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

const LLM_TIMEOUT_MS = 90 * 1000;
const LLM_BATCH_CHARS = 6000;
// 单批段落数：实测模型在 12 段时偶尔会漏段/合并（格式走样），6 段稳定得多；
// 万一仍失败，safeBatch 会继续拆半兜底。
const LLM_BATCH_MAX = 6;
// 批次之间并发请求，抵消批变小带来的延迟（顺序仍然按结果回填，不受影响）
const LLM_CONCURRENCY = 3;
const MYMEMORY_TIMEOUT_MS = 15 * 1000;
const MYMEMORY_MAX_CHARS = 480;
const MYMEMORY_GAP_MS = 250;

const MAX_BLOCKS = 40;
const MAX_TEXT_CHARS = 4000;
const MAX_TOTAL_CHARS = 60000;
// 划词翻译：单词、短语、短句都翻，不受 needsTranslation 的「够长才翻」限制
const QUICK_MAX_CHARS = 600;

const cache = new Map();
let settingsCache = { at: 0, value: null };

function trimCache() {
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 配置读取

function loadAiSettings() {
  return new Promise((resolve) => {
    let db;
    try {
      db = new sqlite3.Database(SETTINGS_DB, sqlite3.OPEN_READONLY, (err) => {
        if (err) return resolve({});
        db.all('SELECT key, value FROM settings', (queryErr, rows) => {
          db.close();
          if (queryErr || !rows) return resolve({});
          const map = {};
          for (const row of rows) map[row.key] = row.value;
          resolve(map);
        });
      });
    } catch (e) {
      resolve({});
    }
  });
}

async function getAiSettings() {
  const now = Date.now();
  if (settingsCache.value && now - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const value = await loadAiSettings();
  settingsCache = { at: now, value };
  return value;
}

async function resolveEngine() {
  const settings = await getAiSettings();
  const base = String(settings.ai_base_url || '').trim().replace(/\/+$/, '');
  const key = String(settings.ai_api_key || '').trim();
  const model = String(settings.ai_model || '').trim();
  if (base && key && model) return { name: 'llm', base, key, model };
  return { name: 'mymemory' };
}

// ---------------------------------------------------------------- 是否需翻译

// 只翻英文段落：拉丁字母够多、且明显多于汉字
function needsTranslation(text) {
  const value = String(text || '');
  if (value.length < 2) return false;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  return latin >= 12 && latin > cjk * 2;
}

// ---------------------------------------------------------------- LLM 引擎

// 分隔符格式：模型直接在译文里写引号也不会破坏结构（JSON 会被未转义的引号截断，
// 这是实测踩过的坑），比「输出 JSON 数组」稳得多。
const SEGMENT_MARKER = '<<<SEG>>>';

function buildPrompt(count) {
  return [
    '你是专业译者。用户会提供一个 JSON 数组，数组中的每一项是一段英文。',
    '请把每一段翻译成简体中文，并严格按以下格式输出：',
    '1. 依次输出 ' + count + ' 段译文，每段译文独占一行；',
    '2. 段与段之间再单独用一行 ' + SEGMENT_MARKER + ' 分隔；',
    '3. 第 1 段译文之前、最后一段译文之后都不要出现 ' + SEGMENT_MARKER + '；',
    '4. 不要输出序号、原文、解释说明，也不要使用 markdown 代码块；',
    '5. 每段译文内部不要换行；译文里的引号照常书写，不需要转义；',
    '6. 专有名词、公司名、模型名、数字、代码片段、URL 保持原样；',
    '7. 译文通顺准确，符合中文表达习惯，适合中文读者阅读理解。'
  ].join('\n');
}

function postJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = lib.request(url, {
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }, headers),
      timeout: timeoutMs
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 0) >= 400) {
          return reject(new Error('模型接口返回 HTTP ' + response.statusCode + '：' + data.slice(0, 200)));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('模型返回内容无法解析。'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('模型请求超时。')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

// 去掉 markdown 代码块围栏
function stripFence(raw) {
  return String(raw == null ? '' : raw)
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
}

// 解析一：严格 JSON 数组（模型偶尔无视格式要求，仍然返回 JSON）
function parseJsonArray(text) {
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return direct;
  } catch (e) { /* 继续尝试截取 */ }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const sliced = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(sliced)) return sliced;
    } catch (e) { /* 放弃 */ }
  }
  return null;
}

// 解析二：宽容行解析 —— 译文里出现未转义的引号时，JSON 会整体解析失败，
// 但模型通常仍是「一行一段、外层带引号」，逐行收集即可救回来。
function parseLooseArray(text, expected) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const body = text.slice(start + 1, end);
  const items = [];
  let buffer = null;
  for (const line of body.split(/\r?\n/)) {
    const piece = buffer === null ? line : buffer + '\n' + line;
    const trimmed = piece.trim();
    if (!trimmed) { buffer = null; continue; }
    if (trimmed.charAt(0) === '"' && /"\s*,?$/.test(trimmed)) {
      let inner = trimmed.replace(/,\s*$/, '');
      if (inner.length >= 2 && inner.charAt(0) === '"' && inner.charAt(inner.length - 1) === '"') {
        inner = inner.slice(1, -1);
      }
      items.push(inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
      buffer = null;
    } else {
      buffer = piece;
    }
  }
  if (buffer !== null && buffer.trim()) {
    let inner = buffer.trim().replace(/,\s*$/, '');
    if (inner.length >= 2 && inner.charAt(0) === '"' && inner.charAt(inner.length - 1) === '"') {
      inner = inner.slice(1, -1);
    }
    items.push(inner.replace(/\\"/g, '"'));
  }
  if (items.length === expected) return items;
  // 兜底：整段挤在一行时，按 `", "` 边界切分
  const inline = body.trim().replace(/^\[/, '').replace(/\]$/, '');
  const pieces = inline.split(/"\s*,\s*"/);
  if (pieces.length === expected) {
    return pieces.map((piece) => {
      let inner = piece.trim();
      if (inner.charAt(0) === '"') inner = inner.slice(1);
      if (inner.charAt(inner.length - 1) === '"') inner = inner.slice(0, -1);
      return inner.replace(/\\"/g, '"');
    });
  }
  return null;
}

// 单行清洗：去掉序号、外层引号
function cleanLine(line) {
  let value = String(line).trim().replace(/^\d+[.、)]\s*/, '').trim();
  if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
    value = value.slice(1, -1).trim();
  }
  return value;
}

// 解析三：分隔符切分（完全不受引号与转义影响）
function parseSegments(text, expected) {
  const parts = text
    .split(/[ \t]*<{2,4}\s*SEG\s*>{2,4}[ \t]*/i)
    .map(cleanLine)
    .filter((part) => part.length > 0);
  if (parts.length === expected) return parts;
  return null;
}

// 解析四：逐行切分 —— 实测模型经常无视分隔符，直接「一行一段」输出，
// 此时行结构仍然是对的，按行收集即可。
function parseLines(text, expected) {
  const lines = text.split(/\r?\n/).map(cleanLine).filter((line) => line.length > 0);
  if (lines.length === expected) return lines;
  return null;
}

function parseTranslations(raw, expected) {
  const text = stripFence(raw);
  if (!text) return null;
  const json = parseJsonArray(text);
  if (json && json.length === expected) return json.map((item) => String(item == null ? '' : item));
  const segments = parseSegments(text, expected);
  if (segments) return segments;
  const lines = parseLines(text, expected);
  if (lines) return lines;
  const loose = parseLooseArray(text, expected);
  if (loose) return loose;
  // 单段翻译：模型没有加任何包装时，整段内容就是译文
  if (expected === 1 && text.charAt(0) !== '[' && !/<<<\s*SEG/i.test(text)) {
    return [text.replace(/\s*\n\s*/g, '')];
  }
  return null;
}

async function llmBatch(texts, engine) {
  const startedAt = Date.now();
  const data = await postJson(engine.base + '/chat/completions', { Authorization: 'Bearer ' + engine.key }, {
    model: engine.model,
    messages: [
      { role: 'system', content: buildPrompt(texts.length) },
      { role: 'user', content: JSON.stringify(texts) }
    ],
    temperature: 0.2,
    stream: false
  }, LLM_TIMEOUT_MS);

  const choice = data && data.choices && data.choices[0];
  const raw = choice && choice.message && choice.message.content;
  if (!raw) throw new Error('模型未返回翻译内容。');
  const list = parseTranslations(raw, texts.length);
  if (!list) {
    console.error('[aihot] 无法解析的模型返回（期望 ' + texts.length + ' 段）：\n' + String(raw).slice(0, 800));
    throw new Error('模型返回格式无法解析（期望 ' + texts.length + ' 段）。');
  }
  console.log('[aihot] 批次 ' + texts.length + ' 段翻译完成，耗时 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
  return list.map((item) => String(item == null ? '' : item).trim());
}

// 一批失败时递归拆半重试：模型对长批次更容易漏段/串行，拆小后成功率大幅提升。
// 拆到单段仍失败就放弃这一段（返回空串），不让整篇翻译因为一段而全废。
async function safeBatch(texts, engine) {
  try {
    return { list: await llmBatch(texts, engine), failed: 0, lastError: '' };
  } catch (error) {
    if (texts.length > 1) {
      console.error('[aihot] ' + texts.length + ' 段批次解析失败（' + error.message + '），拆半重试。');
      const mid = Math.ceil(texts.length / 2);
      const left = await safeBatch(texts.slice(0, mid), engine);
      const right = await safeBatch(texts.slice(mid), engine);
      return {
        list: left.list.concat(right.list),
        failed: left.failed + right.failed,
        lastError: right.lastError || left.lastError
      };
    }
    console.error('[aihot] 段落翻译失败：' + error.message + ' | 原文：' + String(texts[0] || '').slice(0, 60));
    return { list: [''], failed: 1, lastError: error.message };
  }
}

async function translateWithLlm(texts, engine) {
  // 先按体积/段数切批
  const batches = [];
  let current = [];
  let size = 0;
  for (const text of texts) {
    if (current.length && (size + text.length > LLM_BATCH_CHARS || current.length >= LLM_BATCH_MAX)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += text.length;
  }
  if (current.length) batches.push(current);

  // 并发跑批次（游标分配，结果按原下标回填，段落顺序不会乱）
  const results = new Array(batches.length);
  let cursor = 0;
  const workers = new Array(Math.min(LLM_CONCURRENCY, batches.length)).fill(0).map(async () => {
    for (let index = cursor++; index < batches.length; index = cursor++) {
      results[index] = await safeBatch(batches[index], engine);
    }
  });
  await Promise.all(workers);

  const out = [];
  let failed = 0;
  let lastError = '';
  for (const result of results) {
    out.push.apply(out, result.list);
    failed += result.failed;
    if (result.lastError) lastError = result.lastError;
  }
  return { list: out, failed, lastError };
}

// ---------------------------------------------------------------- 免费引擎

function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'TradeManager AIHOT reader' },
      timeout: timeoutMs
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 0) >= 400) {
          return reject(new Error('免费翻译服务返回 HTTP ' + response.statusCode + '。'));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('免费翻译服务返回内容无法解析。'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('免费翻译请求超时。')));
    request.on('error', reject);
  });
}

// MyMemory 单次查询长度有限，长段落按句子切开再拼接
function splitForFreeEngine(text) {
  if (text.length <= MYMEMORY_MAX_CHARS) return [text];
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current + ' ' + sentence).length > MYMEMORY_MAX_CHARS) {
      chunks.push(current);
      current = '';
    }
    if (sentence.length > MYMEMORY_MAX_CHARS) {
      for (let i = 0; i < sentence.length; i += MYMEMORY_MAX_CHARS) {
        chunks.push(sentence.slice(i, i + MYMEMORY_MAX_CHARS));
      }
      continue;
    }
    current = current ? current + ' ' + sentence : sentence;
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}

async function translateWithFreeEngine(texts) {
  const out = [];
  for (const text of texts) {
    const parts = [];
    for (const chunk of splitForFreeEngine(text)) {
      const url = 'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(chunk);
      const data = await getJson(url, MYMEMORY_TIMEOUT_MS);
      const translated = data && data.responseData && data.responseData.translatedText;
      if (!translated) throw new Error('免费翻译服务未返回结果（可能已达每日额度）。');
      parts.push(String(translated));
      await delay(MYMEMORY_GAP_MS);
    }
    out.push(parts.join(''));
  }
  return out;
}

// ---------------------------------------------------------------- 划词翻译

// 方向自动判定：汉字多于拉丁字母 → 中译英，否则英译中
function detectDirection(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return cjk > latin ? 'zh2en' : 'en2zh';
}

// 去掉模型可能加的外层包装：代码围栏、成对引号
function stripWrapping(raw) {
  let value = String(raw == null ? '' : raw).trim();
  value = value.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    const pairs = [['"', '"'], ['“', '”'], ['「', '」'], ['『', '』'], ["'", "'"]];
    for (const pair of pairs) {
      if (first === pair[0] && last === pair[1]) {
        value = value.slice(1, -1).trim();
        break;
      }
    }
  }
  return value;
}

async function quickTranslateWithLlm(text, engine, direction) {
  const target = direction === 'zh2en' ? '英文' : '简体中文';
  const system = [
    '你是专业译者。请把用户提供的文本翻译成' + target + '。',
    '要求：',
    '1. 只输出译文本身，不要原文、不要解释、不要用引号包裹、不要 markdown 代码块；',
    '2. 专有名词、公司名、模型名、数字、代码片段、URL 保持原样；',
    '3. 若输入是单词或短语，给出最常见、最自然的译法；',
    '4. 译文通顺，符合目标语言的表达习惯。'
  ].join('\n');

  const data = await postJson(engine.base + '/chat/completions', { Authorization: 'Bearer ' + engine.key }, {
    model: engine.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text }
    ],
    temperature: 0.2,
    stream: false
  }, LLM_TIMEOUT_MS);

  const choice = data && data.choices && data.choices[0];
  const raw = choice && choice.message && choice.message.content;
  if (!raw) throw new Error('模型未返回翻译内容。');
  const value = stripWrapping(raw);
  if (!value) throw new Error('模型返回了空译文。');
  return value;
}

async function quickTranslateWithFreeEngine(text, direction) {
  const pair = direction === 'zh2en' ? 'zh-CN|en' : 'en|zh-CN';
  const parts = [];
  for (const chunk of splitForFreeEngine(text)) {
    const url = 'https://api.mymemory.translated.net/get?langpair=' + pair + '&q=' + encodeURIComponent(chunk);
    const data = await getJson(url, MYMEMORY_TIMEOUT_MS);
    const translated = data && data.responseData && data.responseData.translatedText;
    if (!translated) throw new Error('免费翻译服务未返回结果（可能已达每日额度）。');
    parts.push(String(translated));
    await delay(MYMEMORY_GAP_MS);
  }
  return parts.join('');
}

// 划词翻译主流程：单词 / 短语 / 短句都能翻
async function translateOne(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) throw new Error('没有可翻译的内容。');
  const clipped = value.slice(0, QUICK_MAX_CHARS);
  const direction = detectDirection(clipped);
  const engine = await resolveEngine();
  const key = 'quick\u0000' + direction + '\u0000' + engine.name + '\u0000' + clipped;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    return { translation: hit.text, engine: engine.name, direction: direction, cached: true };
  }

  const translation = engine.name === 'llm'
    ? await quickTranslateWithLlm(clipped, engine, direction)
    : await quickTranslateWithFreeEngine(clipped, direction);

  if (translation) {
    cache.delete(key);
    cache.set(key, { text: translation, expiresAt: Date.now() + CACHE_TTL_MS });
    trimCache();
  }
  return { translation: translation, engine: engine.name, direction: direction, cached: false };
}

// ---------------------------------------------------------------- 对外主流程

async function translateTexts(texts) {
  const engine = await resolveEngine();
  const translations = new Array(texts.length).fill('');
  const pendingIndex = [];
  const pendingTexts = [];
  const now = Date.now();

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!needsTranslation(text)) continue;
    const key = engine.name + '\u0000' + text;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      cache.delete(key);
      cache.set(key, hit);
      translations[i] = hit.text;
      continue;
    }
    pendingIndex.push(i);
    pendingTexts.push(text);
  }

  if (!pendingTexts.length) return { engine: engine.name, translations, cached: true, failed: 0, total: 0 };

  const result = engine.name === 'llm'
    ? await translateWithLlm(pendingTexts, engine)
    : { list: await translateWithFreeEngine(pendingTexts), failed: 0, lastError: '' };
  const translated = result.list;

  // 全部段落都失败（多半是 Key / base_url 配错），直接抛错让用户看到原因，
  // 而不是静默返回一篇没有译文的结果。
  if (result.failed >= pendingTexts.length) {
    throw new Error(result.lastError || '模型调用失败，请检查「设置」中的 AI 配置。');
  }

  for (let j = 0; j < pendingIndex.length; j++) {
    const index = pendingIndex[j];
    translations[index] = translated[j] || '';
    if (!translations[index]) continue; // 失败的段落不写缓存，方便下次重试
    const key = engine.name + '\u0000' + pendingTexts[j];
    cache.delete(key);
    cache.set(key, { text: translations[index], expiresAt: Date.now() + CACHE_TTL_MS });
  }
  trimCache();

  return { engine: engine.name, translations, cached: false, failed: result.failed, total: pendingTexts.length };
}

function mount(app, auth) {
  app.post('/api/aihot/translate', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    let texts = Array.isArray(body.texts) ? body.texts : [];
    if (!texts.length) return res.status(400).json({ error: '没有需要翻译的内容。' });

    if (texts.length > MAX_BLOCKS) texts = texts.slice(0, MAX_BLOCKS);
    let total = 0;
    texts = texts.map((text) => {
      const value = String(text == null ? '' : text).slice(0, MAX_TEXT_CHARS);
      total += value.length;
      return value;
    });
    if (total > MAX_TOTAL_CHARS) return res.status(413).json({ error: '本次翻译内容过长，请分段翻译。' });

    try {
      const result = await translateTexts(texts);
      res.set('Cache-Control', 'private, no-store');
      res.json(result);
    } catch (error) {
      console.error('[aihot] 翻译失败:', error.message);
      res.status(502).json({ error: '翻译失败：' + (error.message || '请稍后重试。') });
    }
  });

  // 划词翻译：单条文本（单词/短语/短句都行），方向自动判定
  app.post('/api/aihot/quick-translate', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    const text = String(body.text == null ? '' : body.text);
    if (!text.trim()) return res.status(400).json({ error: '没有可翻译的内容。' });
    if (text.length > QUICK_MAX_CHARS * 4) return res.status(413).json({ error: '选中的内容过长，请缩短后再试。' });

    try {
      const result = await translateOne(text);
      res.set('Cache-Control', 'private, no-store');
      res.json(result);
    } catch (error) {
      console.error('[aihot] 划词翻译失败:', error.message);
      res.status(502).json({ error: '翻译失败：' + (error.message || '请稍后重试。') });
    }
  });
}

module.exports = { mount, translateTexts, translateOne, needsTranslation, resolveEngine, getAiSettings };
