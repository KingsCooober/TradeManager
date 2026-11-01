'use strict';

// 一次性迁移：把研报库 research-hub/data/research.db 的 settings 表里的
// AI 配置，搬到 server/ai-config.json（见 ai-config.js）。
//
//   node migrate-ai-config.js            # 目标已存在则跳过
//   node migrate-ai-config.js --force    # 覆盖目标
//
// 幂等：读不到旧库 / 旧库没有配置时静默跳过，不报错、不写空文件。

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const aiConfig = require('./ai-config');

const LEGACY_DB = path.join(__dirname, '..', 'research-hub', 'data', 'research.db');
const FORCE = process.argv.includes('--force');

const KEYS = ['ai_base_url', 'ai_model', 'ai_api_key', 'ai_temperature', 'ai_language'];

function readLegacy() {
  return new Promise((resolve) => {
    if (!fs.existsSync(LEGACY_DB)) return resolve(null);
    let db;
    try {
      db = new sqlite3.Database(LEGACY_DB, sqlite3.OPEN_READONLY, (err) => {
        if (err) return resolve(null);
        db.all('SELECT key, value FROM settings', (queryErr, rows) => {
          db.close();
          if (queryErr || !rows || !rows.length) return resolve(null);
          const map = {};
          for (const row of rows) map[row.key] = row.value;
          resolve(map);
        });
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function main() {
  const exists = fs.existsSync(aiConfig.CONFIG_PATH);
  if (exists && !FORCE) {
    console.log('[迁移] 目标已存在，跳过：' + aiConfig.CONFIG_PATH);
    console.log('        如需覆盖请加 --force');
    return;
  }

  const legacy = await readLegacy();
  if (!legacy) {
    console.log('[迁移] 旧库不存在或没有配置，跳过。');
    return;
  }

  const patch = {};
  for (const key of KEYS) {
    if (legacy[key] !== undefined && String(legacy[key]).trim() !== '') patch[key] = legacy[key];
  }
  if (!Object.keys(patch).length) {
    console.log('[迁移] 旧库里没有可迁移的 AI 配置，跳过。');
    return;
  }

  const saved = aiConfig.update(patch);
  const view = aiConfig.publicView();
  console.log('[迁移] 已写入 ' + aiConfig.CONFIG_PATH);
  console.log('        base_url = ' + (saved.ai_base_url || '(空)'));
  console.log('        model    = ' + (saved.ai_model || '(空)'));
  console.log('        api_key  = ' + (view.ai_api_key_masked || '(空)'));
  console.log('        configured = ' + view.ai_configured);
}

main().catch((error) => {
  console.error('[迁移] 失败：' + (error && error.message));
  process.exitCode = 1;
});
