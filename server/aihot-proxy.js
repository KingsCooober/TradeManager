'use strict';

const https = require('https');
const article = require('./aihot-article');
const translate = require('./aihot-translate');
const tts = require('./aihot-tts');

const API_BASE = 'https://aihot.news/api/v1';
const CACHE_MAX_ENTRIES = 64;
// 缓存总字节上限：只限条数时，64 条 × 单条最大 2MB 会让内存无界增长
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
// 上游未声明 max-age / s-maxage 时的兜底 TTL（此前该常量缺失，会直接抛 ReferenceError）
const CACHE_MIN_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 12 * 1000;
const cache = new Map();

function cacheTtl(headers) {
  const value = String(headers['cache-control'] || '');
  if (/\bno-store\b/i.test(value)) return 0;
  const shared = value.match(/(?:^|,)\s*s-maxage=(\d+)/i);
  const regular = value.match(/(?:^|,)\s*max-age=(\d+)/i);
  const seconds = Number((shared || regular || [])[1]);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return CACHE_MIN_MS;
}

function requestJson(url, previous) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'TradeManager AIHOT internal reader'
    };
    if (previous && previous.etag) headers['If-None-Match'] = previous.etag;
    if (previous && previous.lastModified) headers['If-Modified-Since'] = previous.lastModified;

    const request = https.get(url, { headers, timeout: REQUEST_TIMEOUT_MS }, (response) => {
      const status = response.statusCode || 0;
      if (status === 304 && previous) {
        response.resume();
        return resolve({
          data: previous.data,
          bytes: previous.bytes || 0,
          etag: response.headers.etag || previous.etag,
          lastModified: response.headers['last-modified'] || previous.lastModified,
          ttl: cacheTtl(response.headers)
        });
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error(`AIHOT API returned HTTP ${status}`));
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) request.destroy(new Error('AIHOT response exceeded 2 MB'));
      });
      response.on('end', () => {
        try {
          resolve({
            data: JSON.parse(body),
            bytes: Buffer.byteLength(body),
            etag: response.headers.etag || '',
            lastModified: response.headers['last-modified'] || '',
            ttl: cacheTtl(response.headers)
          });
        } catch (error) {
          reject(new Error(`AIHOT API returned invalid JSON: ${error.message}`));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('AIHOT API request timed out')));
    request.on('error', reject);
  });
}

function cacheBytes() {
  let total = 0;
  for (const entry of cache.values()) {
    if (entry && entry.bytes) total += entry.bytes;
  }
  return total;
}

// 写入缓存统一走这里：先删后写，让该 key 移动到 Map 末尾，实现真正的 LRU 顺序
// （直接 cache.set 已存在的 key 不会改变迭代顺序，旧实现因此退化成 FIFO）
function setCache(url, entry) {
  cache.delete(url);
  cache.set(url, entry);
}

function trimCache() {
  // 保留过期缓存中的 ETag / Last-Modified，下一次请求可条件重验证。
  // 从 Map 头部（最久未使用）淘汰，直到同时满足条数与总字节双上限；
  // size > 1 保证至少保留最新一条，避免单条超限时被清空。
  while (cache.size > CACHE_MAX_ENTRIES || (cache.size > 1 && cacheBytes() > CACHE_MAX_BYTES)) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function getCachedJson(url) {
  trimCache();
  const now = Date.now();
  const previous = cache.get(url);
  if (previous && previous.pending) return previous.pending;
  if (previous && previous.data && previous.expiresAt > now) {
    setCache(url, previous); // 命中即刷新 LRU 位置，避免热点条目被提前淘汰
    return previous.data;
  }

  const pending = requestJson(url, previous).then((result) => {
    if (result.ttl > 0) {
      setCache(url, {
        data: result.data,
        bytes: result.bytes || 0,
        etag: result.etag,
        lastModified: result.lastModified,
        expiresAt: Date.now() + result.ttl,
        pending: null
      });
    } else {
      cache.delete(url);
    }
    trimCache();
    return result.data;
  }).catch((error) => {
    // 失败时保留旧数据与校验头，便于下次条件重验证，而不是把缓存整个丢掉
    if (previous && previous.data) {
      setCache(url, {
        data: previous.data,
        bytes: previous.bytes || 0,
        etag: previous.etag,
        lastModified: previous.lastModified,
        expiresAt: 0,
        pending: null
      });
    } else {
      cache.delete(url);
    }
    throw error;
  });

  // 占位条目沿用旧条目的 data / etag，请求进行中也不会丢失条件重验证能力
  setCache(url, {
    data: previous && previous.data,
    bytes: (previous && previous.bytes) || 0,
    etag: previous && previous.etag,
    lastModified: previous && previous.lastModified,
    expiresAt: 0,
    pending
  });
  return pending;
}

function replyError(res, error) {
  console.error('[aihot] 上游请求失败:', error.message);
  res.status(502).json({ error: 'AIHOT 暂时无法同步，请稍后重试。' });
}

function mount(app, auth) {
  app.get('/api/aihot/items', auth.authMiddleware, async (req, res) => {
    const mode = req.query.mode === 'all' ? 'all' : 'selected';
    const windowSize = req.query.window === '7d' ? '7d' : '24h';
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    if (cursor.length > 2048) return res.status(400).json({ error: '分页游标无效。' });

    const query = new URLSearchParams({ mode, window: windowSize, by: 'timeline', limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const url = `${API_BASE}/items?${query.toString()}`;
    try {
      const data = await getCachedJson(url);
      res.set('Cache-Control', 'private, no-store');
      res.json(data);
    } catch (error) {
      replyError(res, error);
    }
  });

  app.get('/api/aihot/hot-topics', auth.authMiddleware, async (req, res) => {
    try {
      const data = await getCachedJson(`${API_BASE}/hot-topics`);
      res.set('Cache-Control', 'private, no-store');
      res.json(data);
    } catch (error) {
      replyError(res, error);
    }
  });

  app.get('/api/aihot/daily', auth.authMiddleware, async (req, res) => {
    try {
      const data = await getCachedJson(`${API_BASE}/dailies/latest`);
      res.set('Cache-Control', 'private, no-store');
      res.json(data);
    } catch (error) {
      replyError(res, error);
    }
  });

  // 原文正文：AIHOT 官方接口只给标题与摘要，正文需抓取原文页面（部分来源不可达）
  article.mount(app, auth);

  // 英文正文段落级翻译：有 API Key 走大模型，否则降级免费接口
  translate.mount(app, auth);

  // 朗读（TTS）：走 MiMo 的 /chat/completions + audio 字段
  tts.mount(app, auth);
}

module.exports = { mount, getCachedJson, cacheTtl };
