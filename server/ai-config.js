'use strict';

// 全站「AI 大模型」配置的唯一存储点。
//
// 历史包袱：这份配置原本放在研报库 research-hub/data/research.db 的 settings 表里，
// 结果主站的 AI 设置页、AIHOT 翻译、AIHOT 朗读（TTS）全被一个独立子项目绑住 ——
// 想删研报库就得先拆这个耦合。现在落点改为 server/ai-config.json（0600 权限）。
//
// 迁移不在这里做：一次性脚本见 server/migrate-ai-config.js。
// 本模块只负责「读写一个 JSON + 掩码」，不依赖 sqlite、不依赖任何子项目。

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.AI_CONFIG_PATH
  || path.join(__dirname, 'ai-config.json');

const DEFAULTS = {
  ai_base_url: '',
  ai_model: '',
  ai_api_key: '',
  ai_temperature: 0.3,
  ai_language: 'zh'
};

// 只允许这几个键落盘，避免前端塞进来乱七八糟的字段
const ALLOWED = Object.keys(DEFAULTS);

let cache = { mtime: -1, value: null };

function emptyValue() {
  return Object.assign({}, DEFAULTS);
}

function normalize(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const out = emptyValue();
  for (const key of ALLOWED) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (key === 'ai_temperature') {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = Math.min(2, Math.max(0, num));
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

function writeToDisk(value) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  } catch (e) { /* 目录已存在 */ }
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (e) { /* Windows 忽略 */ }
  cache = { mtime: fs.statSync(CONFIG_PATH).mtimeMs, value: value };
  return value;
}

/** 读当前配置（永不抛错）。文件不存在时返回默认空配置，不落盘。 */
function load() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cache.value && stat.mtimeMs === cache.mtime) return cache.value;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    cache = { mtime: stat.mtimeMs, value: normalize(parsed) };
    return cache.value;
  } catch (e) {
    return cache.value || emptyValue();
  }
}

/** 部分更新；只接受白名单字段。返回更新后的完整配置。 */
function update(patch) {
  const current = load();
  const next = Object.assign({}, current);
  const source = patch && typeof patch === 'object' ? patch : {};
  for (const key of ALLOWED) {
    if (source[key] === undefined) continue;
    if (key === 'ai_temperature') {
      const num = Number(source[key]);
      if (Number.isFinite(num)) next[key] = Math.min(2, Math.max(0, num));
      continue;
    }
    next[key] = String(source[key]).trim();
  }
  if (source.clear_api_key === true) next.ai_api_key = '';
  return writeToDisk(next);
}

function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

/** 前端可见的视图：密钥只给掩码。字段名沿用旧研报库的约定，前端无需改动。 */
function publicView() {
  const value = load();
  return {
    ai_base_url: value.ai_base_url,
    ai_model: value.ai_model,
    ai_configured: !!(value.ai_api_key && value.ai_base_url && value.ai_model),
    ai_api_key_masked: maskKey(value.ai_api_key),
    ai_temperature: value.ai_temperature,
    ai_language: value.ai_language
  };
}

module.exports = {
  CONFIG_PATH,
  load,
  update,
  publicView,
  maskKey,
  allowedKeys: ALLOWED
};
