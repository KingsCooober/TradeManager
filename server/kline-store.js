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
      last_full_sync TEXT,
      adjust         TEXT DEFAULT 'qfq'
    )`);

    // ★ 迁移：老库的 stock_meta 没有 adjust 列。
    //   记录该标的实际使用的复权口径（'qfq' 前复权 / 'hfq' 后复权），
    //   否则下次读取时无法判断库里存的是哪一种，可能把 qfq 数据当成 hfq 用。
    const cols = await dbAll("PRAGMA table_info(stock_meta)");
    if (!cols.some(c => c.name === 'adjust')) {
      await dbRun("ALTER TABLE stock_meta ADD COLUMN adjust TEXT DEFAULT 'qfq'");
    }
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
async function loadKLine(symbol, count, fromDate) {
  await initStore();
  let rows;
  if (fromDate) {
    // 日期窗口模式：返回 fromDate（含）之后的全部行，不按根数截断
    rows = await dbAll(
      'SELECT date, open, close, low, high, volume, amount FROM stock_kline WHERE symbol = ? AND date >= ? ORDER BY date ASC',
      [symbol, fromDate]
    );
  } else {
    rows = await dbAll(
      'SELECT date, open, close, low, high, volume, amount FROM stock_kline WHERE symbol = ? ORDER BY date DESC LIMIT ?',
      [symbol, count]
    );
    // DESC 取回后反转成升序
    rows.reverse();
  }
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

// ---------- 事务串行化 ----------
//
// ★ 为什么需要这个：
//   sqlite3 的 Database 是**单连接**的，BEGIN/COMMIT 作用在这一个连接上。
//   批量预热脚本用 worker pool 并发拉取（4 个 worker），多个写入事务会交叠，
//   后到的 BEGIN 撞上前一个还没 COMMIT 的事务，直接报
//   `SQLITE_ERROR: cannot start a transaction within a transaction`，
//   结果是**数据拉回来了却没写进库**（错误被上层 catch 成 warn 吞掉，很难发现）。
//   实测 --limit 5 时 5 只里有 2 只写入失败。
//
//   解决办法：把所有写了 BEGIN/COMMIT 的写入操作串成队列，同一时刻只有一个事务在跑。
//   事务内部仍是多条语句、一次提交，因此并不牺牲批量写入的性能。
//   （注意：sqlite3 是串行化的单连接，排队不会造成死锁。）
let _txChain = Promise.resolve();
function withTransaction(fn) {
  const run = _txChain.then(fn, fn);   // 前一个事务无论成败都继续排队
  // 让链条本身永不 reject，避免一次失败卡死后续所有写入
  _txChain = run.then(function () {}, function () {});
  return run;
}

async function _runInTransaction(body) {
  await dbRun('BEGIN IMMEDIATE');
  try {
    const out = await body();
    await dbRun('COMMIT');
    return out;
  } catch (e) {
    try { await dbRun('ROLLBACK'); } catch (e2) {}
    throw e;
  }
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

  await withTransaction(async function () {
    await _runInTransaction(async function () {
      await dbRun('DELETE FROM stock_kline WHERE symbol = ?', [symbol]);
      await _bulkInsert(symbol, dates, ohlc, vols);
    });
  });

  await _upsertMeta(symbol, {
    name: (meta && meta.name) || null,
    bar_count: dates.length,
    first_date: dates[0],
    last_date: dates[dates.length - 1],
    last_sync: new Date().toISOString(),
    last_full_sync: new Date().toISOString(),
    adjust: (meta && meta.adjust) || 'qfq',
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

  await withTransaction(async function () {
    await _runInTransaction(async function () {
      await _bulkInsert(symbol, nDates, nOhlc, nVols);
    });
  });

  const st = await dbGet(
    'SELECT COUNT(*) AS n, MIN(date) AS f, MAX(date) AS l FROM stock_kline WHERE symbol = ?', [symbol]);
  await _upsertMeta(symbol, {
    name: (meta && meta.name) || null,
    bar_count: (st && st.n) || 0,
    first_date: (st && st.f) || null,
    last_date: (st && st.l) || null,
    last_sync: new Date().toISOString(),
    adjust: (meta && meta.adjust) || undefined,
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
    ['name', 'bar_count', 'first_date', 'last_date', 'last_sync', 'last_full_sync', 'adjust'].forEach(function (k) {
      if (f[k] !== undefined) { sets.push(k + ' = ?'); params.push(f[k]); }
    });
    if (!sets.length) return;
    params.push(symbol);
    await dbRun('UPDATE stock_meta SET ' + sets.join(', ') + ' WHERE symbol = ?', params);
  } else {
    await dbRun(
      'INSERT INTO stock_meta (symbol,name,mcap_yi,bar_count,first_date,last_date,last_sync,last_full_sync,adjust) VALUES (?,?,?,?,?,?,?,?,?)',
      [symbol, f.name || null, f.mcap_yi || 0, f.bar_count || 0,
       f.first_date || null, f.last_date || null,
       f.last_sync || null, f.last_full_sync || null,
       f.adjust || 'qfq']
    );
  }
}

/** 更新市值（由市值名单刷新脚本调用） */
async function upsertMetaBatch(list) {
  await initStore();
  await withTransaction(async function () {
    await _runInTransaction(async function () {
      for (const it of list) {
        await dbRun(
          `INSERT INTO stock_meta (symbol,name,mcap_yi) VALUES (?,?,?)
           ON CONFLICT(symbol) DO UPDATE SET name = excluded.name, mcap_yi = excluded.mcap_yi`,
          [it.symbol, it.name || null, it.mcap_yi || 0]
        );
      }
    });
  });
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
 * 今天是否有行情（周一~周五，不含节假日判断——节假日多拉一次增量可忽略）。
 * 用途：交易日当天，库内 last_date 停在上一交易日时，isFresh 仍会放行命中，
 * 导致标的比实时回源的指数少最新一根（两图日期错位一天）。
 * 交易日当天要求 last_date ≥ 今天（昨天收盘后同步过也算新鲜，因为数据一样）。
 */
function isTradingDayToday() {
  const d = new Date().getDay();
  return d >= 1 && d <= 5;
}

/**
 * 库内数据是否「跟上今天」：非交易日（周末）只看 isFresh；
 * 交易日当天要求 last_date 是今天或昨天之后的交易日（含昨晚收盘后同步）。
 * 简化：交易日当天，last_date < 今天的 都视为可能缺最新一根 → 不算最新。
 * （返回 false 只意味着走回源增量补根，append 每天补 1 根代价极小）
 */
function isUpToDate(meta) {
  if (!isFresh(meta)) return false;
  if (!isTradingDayToday()) return true;
  const today = new Date();
  const t = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' +
    String(today.getDate()).padStart(2, '0');
  return meta.last_date >= t;
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

/** 名单中的候选标的（按市值降序），供批量预热脚本调用 */
async function getWarmupCandidates(minMcapYi, limit) {
  await initStore();
  const threshold = minMcapYi == null ? 50 : Number(minMcapYi);
  const lim = limit == null ? 0 : Number(limit);
  const sql = `SELECT symbol, name, mcap_yi, bar_count, first_date, last_date, last_sync
               FROM stock_meta
               WHERE mcap_yi > ?
               ORDER BY mcap_yi DESC` + (lim > 0 ? ' LIMIT ?' : '');
  return await dbAll(sql, lim > 0 ? [threshold, lim] : [threshold]);
}

/**
 * 判断本地库该标的是否覆盖了目标历史窗口。
 * 对老股票要求至少 targetBars 根；上市较晚的股票以首根上市日期判断，
 * 如果已有数据覆盖从上市以来且 last_date 新鲜，就不重复拉。
 */
function isCoverageEnough(meta, targetBars, maxStaleDays) {
  if (!meta || !meta.bar_count || !meta.last_date || !meta.first_date) return false;
  if (!isFresh(meta, maxStaleDays)) return false;
  if (meta.bar_count >= targetBars) return true;
  // 若少于目标根数，判断是否是新股（首根数据已接近上市日期而非中途缺历史）。
  // 保守规则：小于 targetBars 且首日不晚于最近 10 年窗口 + 1 年余量，
  // 仍视作历史不完整，需要尝试重新拉（源会返回上市后的全部数据）。
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 11);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return meta.first_date > cutoffStr;
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
  getWarmupCandidates,
  isFresh,
  isUpToDate,
  isCoverageEnough,
  detectAdjustChange,
  getStats,
  _internal: { dbRun, dbAll, dbGet },   // 供脚本复用
};
