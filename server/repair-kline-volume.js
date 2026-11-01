#!/usr/bin/env node
/**
 * 修复 stock_kline 的成交量数据（旧口径：整数万手 + volume 列全空）
 *
 * 背景（2026-10-24 发现）：
 *   库里 725 万行里有 684 万行（94%）的 amount 是**整数**，volume 是 NULL。
 *   这是早期版本的写入口径造成的：
 *     - `volumes` 用 Math.round(手/10000) 压成整数万手 → 小盘股 1.2 万手变 1、
 *       0.4 万手变 0，连续多天完全相同，看着像坏数据
 *     - `_bulkInsert` 当时把 volume 列写死 null（注释："上游 amount 已够用"）
 *   现版本已经是「万手保留 2 位小数 + volumesRaw 原始手数」，
 *   但**库里的旧行不会自己变**（append 只追加新日期，不更新旧行）。
 *   本脚本就是把这些旧行整只重写一遍。
 *
 * ★ 为什么要 force:true：
 *   getKLineSnapshotForSymbol 默认会命中本地库直接返回（正是要修的那份），
 *   `noCache` 只跳内存缓存、不跳本地库。只有 force 才真正回源。
 *   force 时 meta 为 null → 落库走 replaceKLine（先删后插），旧行被整体替换。
 *
 * ★ 停牌日会被顺手清掉：
 *   旧数据里 8 万行 amount=0（停牌/无成交被写成了 0）。腾讯不返回停牌日，
 *   replaceKLine 先 DELETE 再 INSERT，这些脏行自然消失。
 *
 * 用法：
 *   node server/repair-kline-volume.js                 # 修复池内所有待修标的
 *   node server/repair-kline-volume.js --limit 30      # 只跑前 30 只（试跑）
 *   node server/repair-kline-volume.js --dry           # 只看要修多少只
 *   node server/repair-kline-volume.js --concurrency 4 --gap 60
 *   node server/repair-kline-volume.js --symbols sz300404,sh600519
 *   node server/repair-kline-volume.js --all           # 不限标的池（连池外一起修）
 *
 * 断点续跑：每次都重新查库，volume 已经完整（NULL 率 < 1%）的标的自动跳过，
 * 中断后重跑同一条命令即可继续。
 */
'use strict';

const sqlite3 = require('sqlite3');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.db');
const market = require('./market-quote');

// ---------------- 参数 ----------------
function parseArgs(argv) {
  const o = { limit: 0, concurrency: 3, gapMs: 120, dry: false, all: false, symbols: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--limit') o.limit = Math.max(0, Number(next()) || 0);
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === '--gap') o.gapMs = Math.max(0, Number(next()) || 0);
    else if (a === '--dry') o.dry = true;
    else if (a === '--all') o.all = true;
    else if (a === '--symbols') o.symbols = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return o;
}

const ARGS = parseArgs(process.argv);

// ---------------- 数据库（只读连接，写由 market-quote 负责） ----------------
function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, (e) => e ? reject(e) : resolve(db));
  });
}
function all(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params || [], (e, rows) => e ? reject(e) : resolve(rows || []));
  });
}
function close(db) {
  return new Promise((resolve) => db.close(() => resolve()));
}

// 打"已修复"标记需要写权限，而扫描用只读连接（避免误伤）。
// ★ 为什么要标记列而不是每次统计 volume IS NULL：
//   stock_kline 的 volume 没有索引，`WHERE volume IS NULL GROUP BY symbol`
//   要全表扫 725 万行，实测 **59 秒**（比真正干活还久），每次重跑都白等。
//   标记列在 stock_meta（3500 行小表）上，查询是 O(1)，断点续跑也靠它。
function openRwDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (e) => e ? reject(e) : resolve(db));
  });
}
function run(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params || [], function (e) { e ? reject(e) : resolve(this); });
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 修复标记（stock_meta.vol_fixed）----
let _rw = null;
async function markFixed(symbol) {
  try {
    if (!_rw) {
      _rw = await openRwDb();
      _rw.configure('busyTimeout', 8000);   // 主站在写库时别直接 SQLITE_BUSY
    }
    await run(_rw, 'UPDATE stock_meta SET vol_fixed = 1 WHERE symbol = ?', [symbol]);
  } catch (e) {
    console.warn('[修复] 标记失败 ' + symbol + ': ' + e.message);
  }
}

async function ensureFlagColumn() {
  const db = await openRwDb();
  try {
    // 已存在会抛 "duplicate column name"，忽略即可
    await run(db, 'ALTER TABLE stock_meta ADD COLUMN vol_fixed INTEGER DEFAULT 0').catch(function () {});
  } finally {
    await close(db);
  }
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

// ---------------- 主流程 ----------------
(async function main() {
  await ensureFlagColumn();
  const db = await openDb();
  let rows;
  try {
    // 待修名单 = stock_meta.vol_fixed 还没置 1 的（见 openRwDb 上的注释）
    const cols = await all(db, 'PRAGMA table_info(stock_meta)');
    const hasFlag = cols.some(c => c.name === 'vol_fixed');
    const flagCond = hasFlag ? 'COALESCE(m.vol_fixed, 0) = 0' : '1=1';
    if (ARGS.symbols) {
      const ph = ARGS.symbols.map(() => '?').join(',');
      rows = await all(db, `
        SELECT s.symbol, m.name, 0 AS rank, COALESCE(m.bar_count, 0) AS n
        FROM (SELECT symbol FROM stock_meta WHERE symbol IN (${ph})) s
        LEFT JOIN stock_meta m ON m.symbol = s.symbol
        WHERE ${flagCond}`, ARGS.symbols);
    } else if (ARGS.all) {
      rows = await all(db, `
        SELECT m.symbol, m.name, 0 AS rank, COALESCE(m.bar_count, 0) AS n
        FROM stock_meta m
        WHERE ${flagCond} AND COALESCE(m.bar_count, 0) > 0`);
    } else {
      // 默认：标的池内的（回测用的就是这批）
      rows = await all(db, `
        SELECT u.symbol, u.name, u.rank, COALESCE(m.bar_count, 0) AS n
        FROM bt_universe u
        JOIN stock_meta m ON m.symbol = u.symbol
        WHERE ${flagCond}
        ORDER BY u.rank ASC`);
    }
  } finally {
    await close(db);
  }

  const todo = rows.filter(r => r.n > 0);
  console.log('[修复] 名单 ' + rows.length + ' 只：待修 ' + todo.length + ' 只（vol_fixed 未置位）');

  if (!todo.length) { console.log('[修复] 没有需要修复的标的'); process.exit(0); }

  const batch = ARGS.limit > 0 ? todo.slice(0, ARGS.limit) : todo;
  console.log('[修复] 本次处理 ' + batch.length + ' 只，并发 ' + ARGS.concurrency +
    '，间隔 ' + ARGS.gapMs + 'ms' + (ARGS.dry ? '（dry-run）' : ''));

  if (ARGS.dry) {
    batch.slice(0, 15).forEach((x, i) => console.log('   ' + (i + 1) + '. ' + x.symbol + ' ' +
      (x.name || '') + '  ' + x.n + ' 根'));
    if (batch.length > 15) console.log('   ... 还有 ' + (batch.length - 15) + ' 只');
    process.exit(0);
  }

  const t0 = Date.now();
  let done = 0, failed = 0, okBars = 0;
  const fails = [];
  const queue = batch.slice();

  async function worker(id) {
    while (queue.length) {
      const it = queue.shift();
      if (!it) break;
      const t = Date.now();
      try {
        const r = await market.getKLineSnapshotForSymbol(it.symbol, 3500, {
          adjust: 'auto',            // 沿用自动择优（前复权有瑕疵的会降到后复权，与建库口径一致）
          startDate: '2016-01-04',
          noCache: true,
          force: true,               // ★ 必须 force，否则命中本地库直接返回旧数据
        });
        done++;
        okBars += (r && r.count) || 0;
        markFixed(it.symbol);   // 置 vol_fixed=1，重跑时自动跳过
        console.log('[' + done + '/' + batch.length + '] ✓ ' + it.symbol + ' ' + (it.name || '') +
          '  ' + (r && r.count) + ' 根  ' + (Date.now() - t) + 'ms');
      } catch (e) {
        failed++;
        fails.push({ symbol: it.symbol, name: it.name, error: e.message });
        console.log('[' + done + '/' + batch.length + '] ✗ ' + it.symbol + ' ' + (it.name || '') +
          '  ' + e.message);
      }
      const spent = Date.now() - t;
      await sleep(Math.max(0, ARGS.gapMs));
    }
  }

  await Promise.all(Array.from({ length: ARGS.concurrency }, (_, i) => worker(i)));

  console.log('\n[修复] 完成：成功 ' + done + ' 只 / 失败 ' + failed + ' 只，共写入 ' +
    okBars + ' 根，耗时 ' + fmtDur(Date.now() - t0));
  if (_rw) { await close(_rw); _rw = null; }
  if (fails.length) {
    console.log('[修复] 失败清单（可重跑同一命令继续）：');
    fails.slice(0, 20).forEach(f => console.log('   ' + f.symbol + ' ' + f.name + '  ' + f.error));
  }
  process.exit(failed > 0 ? 2 : 0);
})().catch(e => {
  console.error('[修复] 失败：' + (e && e.message));
  process.exit(1);
});
