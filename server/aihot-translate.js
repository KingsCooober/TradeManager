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
const LLM_BATCH_MAX = 20;
const MYMEMORY_TIMEOUT_MS = 15 * 1000;
const MYMEMORY_MAX_CHARS = 480;
const MYMEMORY_GAP_MS = 250;

const MAX_BLOCKS = 40;
const MAX_TEXT_CHARS = 4000;
const MAX_TOTAL_CHARS = 60000;

const cache = new Map();
let settingsCache = { at: 0, value: null };

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

const TRANSLATE_PROMPT = [
  '你是专业译者，请把用户提供的 JSON 数组中的每一段英文翻译成简体中文。',
  '要求：',
  '1. 逐段翻译，输出严格的 JSON 数组，元素个数与顺序必须与输入完全一致；',
  '2. 只输出 JSON 数组本身，不要 markdown 代码块，不要任何解释文字；',
  '3. 专有名词、公司名、模型名、数字、代码片段、URL 保持原样；',
  '4. 译文通顺准确，符合中文表达习惯，适合中文读者阅读理解。'
].join('\n');

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

function parseJsonArray(raw) {
  let text = String(raw == null ? '' : raw).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
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

async function llmBatch(texts, engine) {
  const data = await postJson(engine.base + '/chat/completions', { Authorization: 'Bearer ' + engine.key }, {
    model: engine.model,
    messages: [
      { role: 'system', content: TRANSLATE_PROMPT },
      { role: 'user', content: JSON.stringify(texts) }
    ],
    temperature: 0.2,
    stream: false
  }, LLM_TIMEOUT_MS);

  const choice = data && data.choices && data.choices[0];
  const raw = choice && choice.message && choice.message.content;
  if (!raw) throw new Error('模型未返回翻译内容。');
  const list = parseJsonArray(raw);
  if (!list || list.length !== texts.length) throw new Error('模型返回的段落数与原文不一致，请重试。');
  return list.map((item) => String(item == null ? '' : item).trim());
}

async function translateWithLlm(texts, engine) {
  const out = [];
  let batch = [];
  let size = 0;
  for (const text of texts) {
    if (batch.length && (size + text.length > LLM_BATCH_CHARS || batch.length >= LLM_BATCH_MAX)) {
      out.push.apply(out, await llmBatch(batch, engine));
      batch = [];
      size = 0;
    }
    batch.push(text);
    size += text.length;
  }
  if (batch.length) out.push.apply(out, await llmBatch(batch, engine));
  return out;
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

  if (!pendingTexts.length) return { engine: engine.name, translations, cached: true };

  const translated = engine.name === 'llm'
    ? await translateWithLlm(pendingTexts, engine)
    : await translateWithFreeEngine(pendingTexts);

  for (let j = 0; j < pendingIndex.length; j++) {
    const index = pendingIndex[j];
    translations[index] = translated[j] || '';
    const key = engine.name + '\u0000' + pendingTexts[j];
    cache.delete(key);
    cache.set(key, { text: translations[index], expiresAt: Date.now() + CACHE_TTL_MS });
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }

  return { engine: engine.name, translations, cached: false };
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
      res.status(502).json({ error: error.message || '翻译失败，请稍后重试。' });
    }
  });
}

module.exports = { mount, translateTexts, needsTranslation, resolveEngine };
