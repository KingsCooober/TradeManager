// 个股 K 线本地库（按需惰性同步）
//
// 背景与目标：
//   回测页每次都从上游拉 K 线，虽然单次约 200ms，但叠加"切换标的/改年数"
//   以及上游限流抖动，体验不稳定。这里把 K 线落到本地 SQLite，
//   命中即毫秒级返回；只有"库里没有 / 数据过期"时才回源上游。
//
// 设计取舍（按用户选择"按需惰性同步"，不做后台定时任务）：
//   - 用户加载某标的时才检查该标的的数据新鲜度并补齐，上游压力最小
//   - 首次访问某标的 = 拉满历史入库；之后再访问基本直接命中
//   - ★ 前复权陷阱：本项目的 K 线是前复权（qfq），除权除息后**历史全部价格
//     都会重算**。所以"只补最近几根"会造成新旧数据口径不一致（接缝处假跳空）。
//     因此这里用"尾部比对"检测复权基准是否变化：
//       库里最后 N 根 与 上游最新 N 根 若**重叠日期价格不一致** → 判定发生过除权
//       → 整只重拉覆盖，而不是增量追加。
//
// 表结构：
//   stock_kline(symbol, date, open, close, low, high, volume, amount)
//     主键 (symbol, date) —— 天然去重，重复写入用 INSERT OR REPLACE
//   stock_meta(symbol, name, last_sync, last_full_sync, bar_count, first_date, last_date)
//     记录每只标的的同步元信息，用于判断是否需要回源

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data.db');
let _db = null;
function getDB() {
  if (!_db) {
    _db = new sqlite3.Database(DB_PATH);
    // 与主服务共用 data.db：WAL + busy_timeout 避免并发写 SQLITE_BUSY
    _db.run('PRAGMA journal_mode = WAL');
    _db.run('PRAGMA busy_timeout = 5000');
  }
  return _db;
}

// ---------- Promise 包装（sqlite3 是回调风格，这里统一成 async） ----------
function dbRun(sql, params) {
  return new Promise(function (resolve, reject) {
    getDB().run(sql, params || [], function (err) {
      if (err) reject(err); else resolve(this);
    });
  });
}
function dbAll(sql, params) {
  return new Promise(function (resolve, reject) {
    getDB().all(sql, params || [], function (err, rows) {
      if (err) reject(err); else resolve(rows || []);
    });
  });
}
function dbGet(sql, params) {
  return new Promise(function (resolve, reject) {
    getDB().get(sql, params || [], function (err, row) {
      if (err) reject(err); else resolve(row || null);
    });
  });
}

// ---------- 建表 ----------
// ★ 与 market-history.js 同样的坑：建表与建索引必须串行，
//   否则全新数据库首次启动时索引语句会早于建表执行，报 no such table。
let _initPromise = null;
function initStore() {
  if (_initPromise) return _initPromise;
  _initPromise = (async function () {
    await dbRun(`CREATE TABLE IF NOT EXISTS stock_kline (
      symbol TEXT NOT NULL,
      date   TEXT NOT NULL,
      open   REAL,
      close  REAL,
      low    REAL,
      high   REAL,
      volume REAL,
      amount REAL,
      PRIMARY KEY (symbol, date)
    )`);
    // 按 (symbol, date DESC) 建索引：查询"某标的最近 N 根"是最热路径
    await dbRun('CREATE INDEX IF NOT EXISTS idx_stock_kline_symbol_date ON stock_kline(symbol, date DESC)');

    await dbRun(`CREATE TABLE IF NOT EXISTS stock_meta (
      symbol         TEXT PRIMARY KEY,
      name           TEXT,
      mcap_yi        REAL DEFAULT 0,
      bar_count      INTEGER DEFAULT 0,
      first_date     TEXT,
      last_date      TEXT,
      last_sync      TEXT,
      last_full_sync TEXT
    )`);
    return true;
  })().catch(function (e) {
    console.error('[kline-store] 建表失败:', e.message);
    _initPromise = null;   // 允许下次重试
    throw e;
  });
  return _initPromise;
}

// ---------- 查询 ----------

/**
 * 读取某标的最近 count 根 K 线（升序返回，与上游接口结构一致）
 * @returns {Promise<{dates,ohlc,volumes,meta}|null>} 无数据返回 null
 */
async function loadKLine(symbol, count) {
  await initStore();
  const rows = await dbAll(
    'SELECT date, open, close, low, high, volume FROM stock_kline WHERE symbol = ? ORDER BY date DESC LIMIT ?',
    [symbol, count]
  );
  if (!rows.length) return null;
  // DESC 取回后反转成升序
  rows.reverse();
  return {
    dates:   rows.map(r => r.date),
    ohlc:    rows.map(r => [r.open, r.close, r.low, r.high]),
    volumes: rows.map(r => Math.round(r.amount || 0)),
  };
}

/** 读元信息 */
async function getMeta(symbol) {
  await initStore();
  return await dbGet('SELECT * FROM stock_meta WHERE symbol = ?', [symbol]);
}

/** 库里某标的的总根数 */
async function countBars(symbol) {
  await initStore();
  const r = await dbGet('SELECT COUNT(*) AS n FROM stock_kline WHERE symbol = ?', [symbol]);
  return (r && r.n) || 0;
}

// ---------- 写入 ----------

/**
 * 覆盖写入某标的的完整 K 线序列（先删后插，保证不留旧数据）
 * 用于"首次入库"和"检测到除权后整只重拉"。
 */
async function replaceKLine(symbol, data, meta) {
  await initStore();
  const dates = (data && data.dates) || [];
  const ohlc  = (data && data.ohlc) || [];
  const vols  = (data && data.volumes) || [];
  if (!dates.length) return { inserted: 0 };

  await dbRun('BEGIN');
  try {
    await dbRun('DELETE FROM stock_kline WHERE symbol = ?', [symbol]);
    await _bulkInsert(symbol, dates, ohlc, vols);
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch (e2) {}
    throw e;
  }

  await _upsertMeta(symbol, {
    name: (meta && meta.name) || null,
    bar_count: dates.length,
    first_date: dates[0],
    last_date: dates[dates.length - 1],
    last_sync: new Date().toISOString(),
    last_full_sync: new Date().toISOString(),
  });
  return { inserted: dates.length };
}

/**
 * 增量追加（只写库中尚不存在的日期）
 * 注意：调用方必须先用 detectAdjustChange() 确认复权基准未变，
 *       否则前复权价格会与旧数据不一致。
 */
async function appendKLine(symbol, data, meta) {
  await initStore();
  const dates = (data && data.dates) || [];
  const ohlc  = (data && data.ohlc) || [];
  const vols  = (data && data.volumes) || [];
  if (!dates.length) return { inserted: 0 };

  const lastRow = await dbGet('SELECT MAX(date) AS d FROM stock_kline WHERE symbol = ?', [symbol]);
  const lastDate = lastRow && lastRow.d;
  // 只保留比库里最新日期更新的部分
  const idx = lastDate ? dates.findIndex(d => d > lastDate) : 0;
  const nDates = idx >= 0 ? dates.slice(idx) : [];
  if (!nDates.length) return { inserted: 0 };
  const nOhlc = ohlc.slice(idx);
  const nVols = vols.slice(idx);

  await dbRun('BEGIN');
  try {
    await _bulkInsert(symbol, nDates, nOhlc, nVols);
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch (e2) {}
    throw e;
  }

  const st = await dbGet(
    'SELECT COUNT(*) AS n, MIN(date) AS f, MAX(date) AS l FROM stock_kline WHERE symbol = ?', [symbol]);
  await _upsertMeta(symbol, {
    name: (meta && meta.name) || null,
    bar_count: (st && st.n) || 0,
    first_date: (st && st.f) || null,
    last_date: (st && st.l) || null,
    last_sync: new Date().toISOString(),
  });
  return { inserted: nDates.length };
}

/** 内部：批量插入（单条 SQL 多 VALUES，比逐条快一个数量级） */
async function _bulkInsert(symbol, dates, ohlc, vols) {
  const CHUNK = 200;   // 分批，避免 SQL 语句过长
  for (let i = 0; i < dates.length; i += CHUNK) {
    const vals = [];
    const params = [];
    const end = Math.min(i + CHUNK, dates.length);
    for (let k = i; k < end; k++) {
      const o = ohlc[k] || [];
      vals.push('(?,?,?,?,?,?,?,?)');
      params.push(symbol, dates[k],
        o[0] != null ? o[0] : null,   // open
        o[1] != null ? o[1] : null,   // close
        o[2] != null ? o[2] : null,   // low
        o[3] != null ? o[3] : null,   // high
        null,                          // volume（上游 amount 已够用，volume 字段留空）
        vols[k] != null ? vols[k] : 0  // amount
      );
    }
    await dbRun(
      'INSERT OR REPLACE INTO stock_kline (symbol,date,open,close,low,high,volume,amount) VALUES ' + vals.join(','),
      params
    );
  }
}

/** 内部：写元信息（存在则更新，不存在则插入） */
async function _upsertMeta(symbol, f) {
  const exist = await getMeta(symbol);
  if (exist) {
    const sets = [];
    const params = [];
    ['name', 'bar_count', 'first_date', 'last_date', 'last_sync', 'last_full_sync'].forEach(function (k) {
      if (f[k] !== undefined) { sets.push(k + ' = ?'); params.push(f[k]); }
    });
    if (!sets.length) return;
    params.push(symbol);
    await dbRun('UPDATE stock_meta SET ' + sets.join(', ') + ' WHERE symbol = ?', params);
  } else {
    await dbRun(
      'INSERT INTO stock_meta (symbol,name,mcap_yi,bar_count,first_date,last_date,last_sync,last_full_sync) VALUES (?,?,?,?,?,?,?,?)',
      [symbol, f.name || null, f.mcap_yi || 0, f.bar_count || 0,
       f.first_date || null, f.last_date || null,
       f.last_sync || null, f.last_full_sync || null]
    );
  }
}

/** 更新市值（由市值名单刷新脚本调用） */
async function upsertMetaBatch(list) {
  await initStore();
  await dbRun('BEGIN');
  try {
    for (const it of list) {
      await dbRun(
        `INSERT INTO stock_meta (symbol,name,mcap_yi) VALUES (?,?,?)
         ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, mcap_yi = excluded.mcap_yi`,
        [it.symbol, it.name || null, it.mcap_yi || 0]
      );
    }
    await dbRun('COMMIT');
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch (e2) {}
    throw e;
  }
  return list.length;
}

// ---------- 新鲜度判断 ----------

/**
 * 判断库里的数据是否"够新"
 * 规则：last_date 距今不超过 maxStaleDays 个自然日（默认 4 天，覆盖周末+节假日）
 *      —— 超过就说明可能漏了交易日，需要回源补。
 */
function isFresh(meta, maxStaleDays) {
  if (!meta || !meta.last_date) return false;
  const days = maxStaleDays == null ? 4 : maxStaleDays;
  const last = new Date(meta.last_date + 'T00:00:00Z');
  if (isNaN(last.getTime())) return false;
  const diff = (Date.now() - last.getTime()) / 86400000;
  return diff <= days;
}

/**
 * 用"尾部比对"检测前复权基准是否变化（即是否发生过除权除息）
 *
 * 原理：前复权下，除权会让**历史价格整体重算**。
 *   取库里最后 overlap 根，与上游返回的同名日期价格比对：
 *   若有重叠日期价格差异超过阈值 → 说明复权基准变了 → 必须整只重拉。
 *
 * @returns {boolean} true = 检测到复权变化，需要全量重拉
 */
async function detectAdjustChange(symbol, upstream, overlap) {
  const n = overlap == null ? 20 : overlap;
  const dates = (upstream && upstream.dates) || [];
  const ohlc  = (upstream && upstream.ohlc) || [];
  if (dates.length < 2) return false;

  const upMap = new Map();
  for (let i = 0; i < dates.length; i++) upMap.set(dates[i], ohlc[i]);

  const rows = await dbAll(
    'SELECT date, open, close, low, high FROM stock_kline WHERE symbol = ? ORDER BY date DESC LIMIT ?',
    [symbol, n]
  );
  if (!rows.length) return false;

  const EPS = 0.005;   // 相对误差阈值 0.5%：容忍上游四舍五入，但能抓住真实除权
  let compared = 0;
  for (const r of rows) {
    const u = upMap.get(r.date);
    if (!u) continue;              // 上游没这根（可能停牌）→ 跳过
    compared++;
    const pairs = [[r.open, u[0]], [r.close, u[1]], [r.low, u[2]], [r.high, u[3]]];
    for (const [a, b] of pairs) {
      if (a == null || b == null) continue;
      const base = Math.max(Math.abs(a), Math.abs(b));
      if (base < 1e-6) continue;
      if (Math.abs(a - b) / base > EPS) return true;   // 发现不一致 → 复权基准变了
    }
  }
  // 一根都没比对上（数据完全不重叠）→ 保守认为需要重拉
  if (compared === 0) return true;
  return false;
}

// ---------- 统计（给运维/脚本用） ----------
async function getStats() {
  await initStore();
  const k = await dbGet('SELECT COUNT(*) AS bars, COUNT(DISTINCT symbol) AS symbols FROM stock_kline');
  const m = await dbGet('SELECT COUNT(*) AS metas FROM stock_meta');
  return {
    bars: (k && k.bars) || 0,
    symbols: (k && k.symbols) || 0,
    metas: (m && m.metas) || 0,
  };
}

module.exports = {
  initStore,
  loadKLine,
  getMeta,
  countBars,
  replaceKLine,
  appendKLine,
  upsertMetaBatch,
  isFresh,
  detectAdjustChange,
  getStats,
  _internal: { dbRun, dbAll, dbGet },   // 供脚本复用
};
