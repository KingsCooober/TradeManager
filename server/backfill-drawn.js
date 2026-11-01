#!/usr/bin/env node
/**
 * 把「历史回测记录里出现过的标的」补上练习标记（bt_universe.drawn_count）。
 *
 * 背景：
 *   2026-10-23 给标的池加了练习轮次标记 —— 随机抽取永远优先挑 drawn_count
 *   最小的那一档，整池练过一遍才会重复抽到。但标记机制上线**之前**就已经
 *   练过一批票（DataStore 的 backtest_history 里有记录），如果不回填，
 *   这些票在池子里仍然是"未练"，会被优先抽到，等于做了无用功。
 *
 * 口径：
 *   - 只扫 backtest_history（真正的"回测过"），不看 backtest_trades / backtest_symbols
 *   - 同一个标的出现多次也只标记到 1（历史记录分不清当时是第几轮）
 *   - 不在标的池里的标的（当年手动输入的池外票）自动跳过
 *
 * 用法：
 *   node server/backfill-drawn.js            # 执行
 *   node server/backfill-drawn.js --dry      # 只看会标记多少只，不写库
 *   node server/backfill-drawn.js --all-users # 默认就扫全部用户，此参数仅为显式/可读
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_FILE = path.join(__dirname, 'data.db');
const klineStore = require('./kline-store');

const ARGS = { dry: process.argv.includes('--dry') };

function openDb() {
  return new Promise(function (resolve, reject) {
    const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, function (e) {
      if (e) reject(e); else resolve(db);
    });
  });
}

function all(db, sql, params) {
  return new Promise(function (resolve, reject) {
    db.all(sql, params || [], function (e, rows) { e ? reject(e) : resolve(rows || []); });
  });
}

function close(db) {
  return new Promise(function (resolve) { db.close(function () { resolve(); }); });
}

(async function main() {
  console.log('[回填] 扫描 backtest_history 里的标的…');
  const db = await openDb();
  let rows;
  try {
    rows = await all(db,
      "SELECT user_id, data_json FROM user_data WHERE collection = 'backtest_history'");
  } finally {
    await close(db);
  }
  console.log('[回填] 历史记录 ' + rows.length + ' 条');

  const symbols = [];
  let unparsable = 0;
  for (const r of rows) {
    let j = null;
    try { j = JSON.parse(r.data_json); } catch (e) { unparsable++; continue; }
    const s = j && j.symbol ? String(j.symbol).trim().toLowerCase() : '';
    if (/^(sh|sz|bj)\d{6}$/.test(s)) symbols.push(s);
  }
  const uniq = Array.from(new Set(symbols));
  console.log('[回填] 解析出标的 ' + uniq.length + ' 只（去重前 ' + symbols.length + ' 条'
    + (unparsable ? '，' + unparsable + ' 条 JSON 解析失败' : '') + '）');

  // 池内 / 池外分开统计，池外的是当年手动输入的票，跳过即可
  await klineStore.initStore();
  const statsBefore = await klineStore.getUniverseStats();
  console.log('[回填] 当前池子：' + statsBefore.total + ' 只，已标记 '
    + statsBefore.drawn + ' 只，未标记 ' + statsBefore.untouched + ' 只（第 '
    + statsBefore.round + ' 轮）');

  if (ARGS.dry) {
    console.log('[回填] dry-run，未写库。将尝试标记 ' + uniq.length + ' 只：');
    console.log('   ' + uniq.slice(0, 30).join(' ') + (uniq.length > 30 ? ' …' : ''));
    process.exit(0);
  }

  const r = await klineStore.markUniverseDrawnBatch(uniq);
  const after = await klineStore.getUniverseStats();
  console.log('[回填] 池内命中并标记 ' + r.marked + ' 只（扫描 ' + r.scanned + ' 只，'
    + (r.scanned - r.marked) + ' 只不在池内/已是标记状态）');
  console.log('[回填] 回填后：已标记 ' + after.drawn + ' 只，未标记 '
    + after.untouched + ' 只，累计练习 ' + after.drawnTotal + ' 次，第 '
    + after.round + ' 轮');
  process.exit(0);
})().catch(function (e) {
  console.error('[回填] 失败：' + (e && e.message));
  process.exit(1);
});
