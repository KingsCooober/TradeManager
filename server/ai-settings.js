'use strict';

// 全局「AI 大模型」配置的读写接口（带登录鉴权）。
// 配置本体存放在研报库的 settings 表里（与研报摘要、AIHOT 翻译共用同一份配置），
// 这里转发到本机研报服务，避免前端直接使用无鉴权的 /research/* 通道。

const http = require('http');

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = parseInt(process.env.RESEARCH_PORT, 10) || 8765;
const READ_TIMEOUT_MS = 15 * 1000;
const TEST_TIMEOUT_MS = 60 * 1000;

function callUpstream(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    const request = http.request({
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: method,
      path: path,
      headers: headers,
      timeout: timeoutMs
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        const status = response.statusCode || 0;
        if (status >= 400) {
          const detail = (parsed && (parsed.detail || parsed.error)) || ('研报服务返回 HTTP ' + status);
          return reject(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)));
        }
        resolve(parsed);
      });
    });

    request.on('timeout', () => request.destroy(new Error('研报服务响应超时。')));
    request.on('error', (error) => {
      if (error && error.message === '研报服务响应超时。') return reject(error);
      reject(new Error('研报服务未运行，暂时无法读写 AI 配置。'));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

// 只把前端需要的字段吐出去，密钥永远不返回明文
function pickSettings(data) {
  const source = data || {};
  return {
    ai_base_url: source.ai_base_url || '',
    ai_model: source.ai_model || '',
    ai_configured: !!source.ai_configured,
    ai_api_key_masked: source.ai_api_key_masked || ''
  };
}

function mount(app, auth) {
  app.get('/api/ai/settings', auth.authMiddleware, async (req, res) => {
    try {
      res.json(pickSettings(await callUpstream('GET', '/api/settings', null, READ_TIMEOUT_MS)));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.put('/api/ai/settings', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    const payload = {};
    if (typeof body.ai_base_url === 'string') payload.ai_base_url = body.ai_base_url.trim();
    if (typeof body.ai_model === 'string') payload.ai_model = body.ai_model.trim();
    // 掩码回传（含 •）时上游会忽略，这里也不下发
    if (typeof body.ai_api_key === 'string' && body.ai_api_key.trim() && body.ai_api_key.indexOf('•') < 0) {
      payload.ai_api_key = body.ai_api_key.trim();
    }
    if (body.clear_api_key === true) payload.clear_api_key = true;

    try {
      res.json(pickSettings(await callUpstream('PUT', '/api/settings', payload, READ_TIMEOUT_MS)));
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.post('/api/ai/settings/test', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    const settings = {};
    if (typeof body.ai_base_url === 'string' && body.ai_base_url.trim()) settings.ai_base_url = body.ai_base_url.trim();
    if (typeof body.ai_model === 'string' && body.ai_model.trim()) settings.ai_model = body.ai_model.trim();
    if (typeof body.ai_api_key === 'string' && body.ai_api_key.trim() && body.ai_api_key.indexOf('•') < 0) {
      settings.ai_api_key = body.ai_api_key.trim();
    }

    try {
      const result = await callUpstream('POST', '/api/settings/test', { settings: settings }, TEST_TIMEOUT_MS);
      res.json(result || { ok: true });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });
}

module.exports = { mount, callUpstream };
