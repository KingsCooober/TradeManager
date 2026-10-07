'use strict';

const https = require('https');

const API_BASE = 'https://aihot.news/api/v1';
const CACHE_MAX_ENTRIES = 64;
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

function trimCache() {
  // 保留过期缓存中的 ETag / Last-Modified，下一次请求可条件重验证。
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

async function getCachedJson(url) {
  trimCache();
  const now = Date.now();
  const previous = cache.get(url);
  if (previous && previous.pending) return previous.pending;
  if (previous && previous.data && previous.expiresAt > now) return previous.data;

  const pending = requestJson(url, previous).then((result) => {
    if (result.ttl > 0) {
      cache.set(url, {
        data: result.data,
        etag: result.etag,
        lastModified: result.lastModified,
        expiresAt: Date.now() + result.ttl,
        pending: null
      });
    } else {
      cache.delete(url);
    }
    return result.data;
  }).catch((error) => {
    cache.delete(url);
    throw error;
  });

  cache.set(url, { pending, expiresAt: 0 });
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
}

module.exports = { mount, getCachedJson, cacheTtl };
