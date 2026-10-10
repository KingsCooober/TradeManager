'use strict';

// AIHOT 朗读（TTS）：调用小米 MiMo 的 mimo-v2.5-tts。
//
// ⚠️ 关键差异：MiMo 的语音合成**不是** OpenAI 的 /v1/audio/speech（实测该路径 404），
// 而是走 /v1/chat/completions —— 用一条 role=assistant 的消息指定要朗读的文本，
// 音频以 base64 放在 choices[0].message.audio.data 里。
// 官方文档：https://mimo.mi.com/docs/zh-CN/api/audio/tts
//
// 音频按 (音色 + 文本) 缓存在内存里，重复朗读同一段不重复计费。

const http = require('http');
const https = require('https');
const { getAiSettings } = require('./aihot-translate');

const DEFAULT_MODEL = 'mimo-v2.5-tts';
const MAX_TEXT_CHARS = 800;
const TTS_TIMEOUT_MS = 90 * 1000;

// mimo-v2.5-tts 的预置音色（官方可选值）
const VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
const VOICE_EN_DEFAULT = 'Chloe';
const VOICE_ZH_DEFAULT = '茉莉';

const CACHE_MAX_ENTRIES = 300;
const CACHE_MAX_BYTES = 24 * 1024 * 1024;

const cache = new Map();
let cacheBytes = 0;

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
          return reject(new Error('语音接口返回 HTTP ' + response.statusCode + '：' + data.slice(0, 200)));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('语音接口返回内容无法解析。'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('语音合成超时。')));
    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

// 判断偏中文还是偏英文，用于自动挑音色
function detectLang(text) {
  const value = String(text || '');
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return cjk > latin ? 'zh' : 'en';
}

function pickVoice(requested, lang) {
  const wanted = String(requested || '').trim();
  if (wanted && VOICES.indexOf(wanted) >= 0) return wanted;
  return lang === 'zh' ? VOICE_ZH_DEFAULT : VOICE_EN_DEFAULT;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  cache.delete(key);
  cache.set(key, hit); // LRU：先删后写
  return hit.data;
}

function cacheSet(key, data) {
  const bytes = data.length;
  if (bytes > CACHE_MAX_BYTES) return;
  const old = cache.get(key);
  if (old) cacheBytes -= old.bytes;
  cache.delete(key);
  cache.set(key, { data, bytes });
  cacheBytes += bytes;
  while (cache.size > CACHE_MAX_ENTRIES || cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= dropped ? dropped.bytes : 0;
  }
}

async function synthesize(text, voice) {
  const settings = await getAiSettings();
  const base = String(settings.ai_base_url || '').trim().replace(/\/+$/, '');
  const key = String(settings.ai_api_key || '').trim();
  if (!base || !key) throw new Error('尚未配置大模型 API Key，无法朗读。');
  const model = String(settings.ai_tts_model || '').trim() || DEFAULT_MODEL;

  const data = await postJson(base + '/chat/completions', { Authorization: 'Bearer ' + key }, {
    model: model,
    messages: [{ role: 'assistant', content: text }],
    audio: { format: 'mp3', voice: voice }
  }, TTS_TIMEOUT_MS);

  const choice = data && data.choices && data.choices[0];
  const audio = choice && choice.message && choice.message.audio;
  if (!audio || !audio.data) throw new Error('语音接口未返回音频。');
  return String(audio.data);
}

// 对外主流程：命中缓存直接返回，否则合成并写缓存
async function speak(text, options) {
  const value = String(text == null ? '' : text).trim();
  if (!value) throw new Error('没有可朗读的内容。');
  const clipped = value.slice(0, MAX_TEXT_CHARS);
  const lang = options && options.lang ? options.lang : detectLang(clipped);
  const voice = pickVoice(options && options.voice, lang);

  const cacheKey = voice + '\u0000' + clipped;
  const cached = cacheGet(cacheKey);
  if (cached) return { audio: cached, format: 'mp3', voice: voice, lang: lang, cached: true };

  const audio = await synthesize(clipped, voice);
  cacheSet(cacheKey, audio);
  return { audio: audio, format: 'mp3', voice: voice, lang: lang, cached: false };
}

function mount(app, auth) {
  app.post('/api/aihot/tts', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    const text = String(body.text == null ? '' : body.text);
    if (!text.trim()) return res.status(400).json({ error: '没有可朗读的内容。' });
    if (text.length > MAX_TEXT_CHARS * 4) return res.status(413).json({ error: '内容过长，请分段朗读。' });

    try {
      const result = await speak(text, { voice: body.voice, lang: body.lang });
      res.set('Cache-Control', 'private, no-store');
      res.json(result);
    } catch (error) {
      console.error('[aihot] 语音合成失败:', error.message);
      res.status(502).json({ error: error.message || '语音合成失败。' });
    }
  });
}

module.exports = { mount, speak, detectLang, VOICES, VOICE_EN_DEFAULT, VOICE_ZH_DEFAULT, MAX_TEXT_CHARS };
