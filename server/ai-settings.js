'use strict';

// 全局「AI 大模型」配置的读写接口（带登录鉴权）。
//
// 2026-10-20 改造：配置不再转发给研报库（127.0.0.1:8765 / research.db），
// 而是落在 server/ai-config.json（见 ai-config.js）。
// 这样研报库可以被降级/移除，主站的 AI 设置、AIHOT 翻译、TTS 都不受影响。
//
// 一性次迁移旧配置：node migrate-ai-config.js

const http = require('http');
const https = require('https');
const { URL } = require('url');

const aiConfig = require('./ai-config');

const TEST_TIMEOUT_MS = 60 * 1000;

// 只把前端需要的字段吐出去，密钥永远不返回明文
function pickSettings(view) {
  const source = view || {};
  return {
    ai_base_url: source.ai_base_url || '',
    ai_model: source.ai_model || '',
    ai_configured: !!source.ai_configured,
    ai_api_key_masked: source.ai_api_key_masked || ''
  };
}

/**
 * 用「库里已保存的」地址与密钥发一次最小请求。
 * ★ 安全：绝不接受请求体里的 base_url / api_key，
 *   否则这个接口能被当成跳板，把真实密钥发往攻击者控制的服务器。
 */
function probeModel(model) {
  return new Promise((resolve, reject) => {
    const current = aiConfig.load();
    const base = String(current.ai_base_url || '').trim().replace(/\/+$/, '');
    const key = String(current.ai_api_key || '').trim();
    const useModel = String(model || current.ai_model || '').trim();
    if (!base) return reject(new Error('还没有配置接口地址（Base URL）'));
    if (!key) return reject(new Error('还没有配置 API Key'));
    if (!useModel) return reject(new Error('还没有配置模型名称'));

    let target;
    try {
      target = new URL(base + '/chat/completions');
    } catch (e) {
      return reject(new Error('接口地址不是合法 URL：' + base));
    }

    const payload = Buffer.from(JSON.stringify({
      model: useModel,
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      max_tokens: 16,
      stream: false
    }), 'utf8');

    const transport = target.protocol === 'https:' ? https : http;
    const started = Date.now();
    const request = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + key
      },
      timeout: TEST_TIMEOUT_MS
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status >= 400) {
          // 只透出状态码与截断后的正文，避免把密钥或内部细节外泄
          const detail = String(raw || '').slice(0, 300);
          return reject(new Error('模型返回 HTTP ' + status + (detail ? '：' + detail : '')));
        }
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        const choice = parsed && parsed.choices && parsed.choices[0];
        const text = (choice && (choice.message && choice.message.content)) || '';
        resolve({
          ok: true,
          model: useModel,
          latency_ms: Date.now() - started,
          reply: String(text).trim().slice(0, 120)
        });
      });
    });

    request.on('timeout', () => request.destroy(new Error('模型响应超时')));
    request.on('error', (error) => reject(new Error(error.message || '连接模型服务失败')));
    request.write(payload);
    request.end();
  });
}

function mount(app, auth) {
  app.get('/api/ai/settings', auth.authMiddleware, (req, res) => {
    res.json(pickSettings(aiConfig.publicView()));
  });

  app.put('/api/ai/settings', auth.authMiddleware, (req, res) => {
    const body = req.body || {};
    const payload = {};
    if (typeof body.ai_base_url === 'string') payload.ai_base_url = body.ai_base_url.trim();
    if (typeof body.ai_model === 'string') payload.ai_model = body.ai_model.trim();
    // 掩码回传（含 •）表示「不修改」，这里直接忽略
    if (typeof body.ai_api_key === 'string' && body.ai_api_key.trim() && body.ai_api_key.indexOf('•') < 0) {
      payload.ai_api_key = body.ai_api_key.trim();
    }
    if (body.clear_api_key === true) payload.clear_api_key = true;

    try {
      aiConfig.update(payload);
      res.json(pickSettings(aiConfig.publicView()));
    } catch (error) {
      res.status(500).json({ error: '保存 AI 配置失败：' + ((error && error.message) || error) });
    }
  });

  app.post('/api/ai/settings/test', auth.authMiddleware, async (req, res) => {
    const body = req.body || {};
    const model = typeof body.ai_model === 'string' ? body.ai_model.trim() : '';
    try {
      const result = await probeModel(model);
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: (error && error.message) || '模型连接测试失败' });
    }
  });
}

module.exports = { mount, probeModel };
