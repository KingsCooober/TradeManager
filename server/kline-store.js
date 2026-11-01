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
    // ★ qfq_bad：该标的的**前复权**数据被判定为不可用（有负价或假跳空），
    //   库内实际存的是后复权。
    //   为什么要单列标记：前端默认请求 qfq，若只靠 adjust 列判断"口径不匹配"，
    //   这类标的每次访问都会回源重拉（实测 550~1900ms），预灌的库等于白建。
    //   有了这个标记，qfq 请求可以直接命中库内 hfq 数据并如实告知前端"实际用的是后复权"。
    if (!cols.some(c => c.name === 'qfq_bad')) {
      await dbRun("ALTER TABLE stock_meta ADD COLUMN qfq_bad INTEGER DEFAULT 0");
      // 存量回填：本次迁移前落库的 hfq 都是 auto 择优的结果（即 qfq 有瑕疵）
      await dbRun("UPDATE stock_meta SET qfq_bad = 1 WHERE adjust = 'hfq'");
    }
    // 一致性：qfq_bad 只在"库内是 hfq"时有意义。
    // 数据源重新拉取后 qfq 可能恢复正常（本次就出现过：工行整只覆盖成 qfq 后标记还留着 1），
    // 这种矛盾状态会让 qfqFallback 判断混乱 —— 每次启动清一次，幂等且开销可忽略。
    await dbRun("UPDATE stock_meta SET qfq_bad = 0 WHERE adjust <> 'hfq' AND qfq_bad <> 0");

    // ★ 回测标的池（2026-10 新增）：
    //   按**建池当时的**总市值排名固定下来的前 N 只 A 股。
    //   为什么不直接用 stock_meta.mcap_yi 排序？
    //     1) 市值每次刷新都在变，名单跟着抖，"前 3500 只"不是一个稳定集合，
    //        今天灌满的数据明天可能就有一批掉出名单、白白占几个 GB；
    //     2) 预热脚本要能断点续跑，名单必须可枚举、可比较进度；
    //     3) 随机按钮要的是"这个池子里的票"，而不是"此刻市值最大的票"。
    //   所以单独一张表，只在显式重建（build-universe.js）时整体替换。
    await dbRun(`CREATE TABLE IF NOT EXISTS bt_universe (
      symbol      TEXT PRIMARY KEY,
      rank        INTEGER NOT NULL,     -- 建池时的市值排名（1 = 最大）
      name        TEXT,
      mcap_yi     REAL DEFAULT 0,       -- 建池时的总市值（亿元）
      built_at    TEXT,                 -- 本次建池时间（ISO）
      drawn_count INTEGER DEFAULT 0,    -- ★ 已练次数（练习轮次标记）
      drawn_at    TEXT                  -- ★ 最近一次真正开局的时间（ISO）
    )`);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_bt_universe_rank ON bt_universe(rank)');
    // ★ 迁移：老库的 bt_universe 没有 drawn_count/drawn_at。
    //   语义见 randomUniverseSymbol 的注释：drawn_count 是"这只标的被练过几次"，
    //   随机抽取永远优先挑 drawn_count 最小的那一档，
    //   于是整个池子会被一轮一轮地过完，而不是反复抽到同一批。
    const ucols = await dbAll('PRAGMA table_info(bt_universe)');
    if (!ucols.some(c => c.name === 'drawn_count')) {
      await dbRun('ALTER TABLE bt_universe ADD COLUMN drawn_count INTEGER DEFAULT 0');
      await dbRun('UPDATE bt_universe SET drawn_count = 0');
    }
    if (!ucols.some(c => c.name === 'drawn_at')) {
      await dbRun('ALTER TABLE bt_universe ADD COLUMN drawn_at TEXT');
    }
    await dbRun('CREATE INDEX IF NOT EXISTS idx_bt_universe_drawn ON bt_universe(drawn_count)');
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
    // ★ 成交量：volumes / volumesRaw 都返回「手」（实际手数，整数），与 market-quote
    //   buildKLineSnapshot 的出口口径完全一致。「万手」这个单位已经从数据层彻底移除 ——
    //   只要数据层还给万手，展示层迟早会再掉一次精度（先 2 位小数再 toFixed(0)）。
    //   库内 volume 列是手（真值）；早期落库的行 volume 是 NULL，
    //   用 amount（万手）× 10000 兜底还原成手。
    volumes:    rows.map(_rowVolumeHand),
    volumesRaw: rows.map(_rowVolumeHand),
  };
}

/** 单行成交量 → 手（整数）。兼容 volume 为 NULL 的老数据。 */
function _rowVolumeHand(r) {
  if (r.volume != null && Number(r.volume) > 0) return Math.round(Number(r.volume));
  if (r.amount != null && Number(r.amount) > 0) return Math.round(Number(r.amount) * 10000);
  return 0;
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
  const volsRaw = (data && data.volumesRaw) || [];   // 成交量原始值（手），用于落 volume 字段
  if (!dates.length) return { inserted: 0 };

  await withTransaction(async function () {
    await _runInTransaction(async function () {
      await dbRun('DELETE FROM stock_kline WHERE symbol = ?', [symbol]);
      await _bulkInsert(symbol, dates, ohlc, vols, volsRaw);
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
  const volsRaw = (data && data.volumesRaw) || [];   // 成交量原始值（手），用于落 volume 字段
  if (!dates.length) return { inserted: 0 };

  const lastRow = await dbGet('SELECT MAX(date) AS d FROM stock_kline WHERE symbol = ?', [symbol]);
  const lastDate = lastRow && lastRow.d;
  // 只保留比库里最新日期更新的部分
  const idx = lastDate ? dates.findIndex(d => d > lastDate) : 0;
  const nDates = idx >= 0 ? dates.slice(idx) : [];
  if (!nDates.length) return { inserted: 0 };
  const nOhlc = ohlc.slice(idx);
  const nVols = vols.slice(idx);
  const nVolsRaw = volsRaw.slice(idx);

  await withTransaction(async function () {
    await _runInTransaction(async function () {
      await _bulkInsert(symbol, nDates, nOhlc, nVols, nVolsRaw);
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
async function _bulkInsert(symbol, dates, ohlc, vols, volsRaw) {
  const CHUNK = 200;   // 分批，避免 SQL 语句过长
  for (let i = 0; i < dates.length; i += CHUNK) {
    const vals = [];
    const params = [];
    const end = Math.min(i + CHUNK, dates.length);
    for (let k = i; k < end; k++) {
      const o = ohlc[k] || [];
      // ★ 上游（buildKLineSnapshot）现在给的 vols / volsRaw **都是「手」**。
      //   库内两列的分工：
      //     volume = 实际手数（整数，唯一真值，前端与统计都用它）
      //     amount = 手数 / 10000（万手，2 位小数）—— 仅为了兼容历史 SQL 与 repair 脚本的
      //              阈值判断（amount > 100000 之类），列名是历史遗留，其实不是成交额
      //   早先两列一个是万手一个是手，调用方经常拿错，这里显式派生一次，不再靠上游传两个单位。
      const vHand = (volsRaw && Number(volsRaw[k]) > 0)
        ? Math.round(Number(volsRaw[k]))
        : (vols[k] != null ? Math.round(Number(vols[k]) || 0) : 0);
      vals.push('(?,?,?,?,?,?,?,?)');
      params.push(symbol, dates[k],
        o[0] != null ? o[0] : null,   // open
        o[1] != null ? o[1] : null,   // close
        o[2] != null ? o[2] : null,   // low
        o[3] != null ? o[3] : null,   // high
        vHand > 0 ? vHand : null,                 // volume（手）
        vHand > 0 ? Math.round(vHand / 100) / 100 : 0   // amount（万手，兼容列）
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
    ['name', 'bar_count', 'first_date', 'last_date', 'last_sync', 'last_full_sync', 'adjust', 'qfq_bad'].forEach(function (k) {
      if (f[k] !== undefined) { sets.push(k + ' = ?'); params.push(f[k]); }
    });
    if (!sets.length) return;
    params.push(symbol);
    await dbRun('UPDATE stock_meta SET ' + sets.join(', ') + ' WHERE symbol = ?', params);
  } else {
    await dbRun(
      'INSERT INTO stock_meta (symbol,name,mcap_yi,bar_count,first_date,last_date,last_sync,last_full_sync,adjust,qfq_bad) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [symbol, f.name || null, f.mcap_yi || 0, f.bar_count || 0,
       f.first_date || null, f.last_date || null,
       f.last_sync || null, f.last_full_sync || null,
       f.adjust || 'qfq', f.qfq_bad ? 1 : 0]
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

// ---------- 回测标的池（bt_universe） ----------

/**
 * 整体替换标的池（先清空再写入，单事务）。
 * @param {Array<{symbol,rank,name,mcap_yi}>} list
 * @returns {Promise<number>} 写入条数
 */
async function saveUniverse(list) {
  await initStore();
  if (!Array.isArray(list) || !list.length) throw new Error('标的池为空，拒绝覆盖');
  const builtAt = new Date().toISOString();
  // ★ 重建池子必须保住"已练次数"标记。
  //   saveUniverse 是 DELETE + INSERT，如果不显式抢救，
  //   每次重跑 build-universe.js 都会把练习进度清零、
  //   已经练过的票全部重新回到"未练"档 —— 用户会以为标记功能坏了。
  const prev = await dbAll(
    'SELECT symbol, drawn_count, drawn_at FROM bt_universe WHERE COALESCE(drawn_count,0) > 0');
  const keep = new Map();
  prev.forEach(function (r) { keep.set(r.symbol, r); });
  await withTransaction(async function () {
    await _runInTransaction(async function () {
      await dbRun('DELETE FROM bt_universe');
      // 逐条 INSERT：3500 条在单事务内约 100~200ms，不必拼多值语句
      for (const it of list) {
        await dbRun(
          'INSERT OR REPLACE INTO bt_universe (symbol, rank, name, mcap_yi, built_at, drawn_count, drawn_at) VALUES (?,?,?,?,?,?,?)',
          [it.symbol, it.rank || 0, it.name || null, it.mcap_yi || 0, builtAt,
           it.drawn_count || 0, it.drawn_at || null]
        );
      }
      // 池子里仍在的标的，把旧标记回填进去
      // （只遍历 keep：掉出名单的标的自然就丢掉标记了，不必逐条试）
      let restored = 0;
      for (const [sym, old] of keep) {
        const r = await dbRun('UPDATE bt_universe SET drawn_count = ?, drawn_at = ? WHERE symbol = ?',
          [old.drawn_count || 0, old.drawn_at || null, sym]);
        if (r && r.changes) restored++;
      }
      if (restored) console.log('[kline-store] 重建标的池时保留了 ' + restored + ' 只的练习标记');
    });
  });
  return list.length;
}

/**
 * 按排名取池子（LEFT JOIN stock_meta 带出入库状态，供预热脚本判断跳过）
 * @param {number} limit 0/空 = 全部
 */
async function getUniverse(limit) {
  await initStore();
  const lim = limit == null ? 0 : Number(limit);
  const sql = `SELECT u.symbol, u.rank, u.name, u.mcap_yi,
                      COALESCE(u.drawn_count,0) AS drawn_count, u.drawn_at,
                      m.bar_count, m.first_date, m.last_date, m.adjust,
                      m.last_sync, m.last_full_sync
               FROM bt_universe u
               LEFT JOIN stock_meta m ON m.symbol = u.symbol
               ORDER BY u.rank ASC` + (lim > 0 ? ' LIMIT ?' : '');
  return await dbAll(sql, lim > 0 ? [lim] : []);
}

/**
 * 从池子里随机抽一只。
 *
 * ★ 为什么要 minBars 而不是纯 RANDOM()：
 *   池子按市值排名，里面既有茅台这种 2600 根的老股，也有上个月刚上市的
 *   大盘新股（只有 20 根）。抽到新股回测页直接报"数据不够"，
 *   随机按钮就成了"随机报错"。
 *   所以先只在「已入库且根数够」的子集里抽；子集为空才放宽到全池子。
 *
 * ★ 为什么还要「数据新鲜」这一条（maxStaleDays）：
 *   池子里有停牌股/退市整理股（last_date 停在几个月前）。抽到它们时，
 *   上游根本拉不到新数据，同步补数会一路重试到超时（实测 8s+），
 *   表现就是"点了随机按钮，转圈十秒没反应"。
 *   随机练习本来就不该拿停牌股练 —— 直接排除，比"抽到了再去补"体验好得多。
 *   （手动输入代码的场景不受影响，那条路走 kline-stock 的惰性同步）
 *
 * @param {object} o
 * @param {string[]} o.exclude 排除的 symbol（避免连点两次抽到同一只）
 * @param {number} o.minBars   最少根数（默认 0 = 不限）
 * @param {number} o.maxStaleDays 数据最旧容忍天数（默认 4，覆盖周末）
 * @returns {Promise<object|null>}
 */
async function randomUniverseSymbol(o) {
  await initStore();
  o = o || {};
  const exclude = Array.isArray(o.exclude)
    ? o.exclude.map(s => String(s).toLowerCase()).filter(s => /^(sh|sz|bj)\d{6}$/.test(s)).slice(0, 50)
    : [];
  const minBars = Math.max(0, Number(o.minBars) || 0);
  const staleDays = (o.maxStaleDays == null) ? 4 : Math.max(0, Number(o.maxStaleDays));
  const exSql = exclude.length ? ' AND u.symbol NOT IN (' + exclude.map(() => '?').join(',') + ')' : '';
  // 新鲜度条件写成 SQL 片段，三轮逐级放宽
  const freshSql = staleDays > 0
    ? " AND m.last_date >= date('now','localtime','-" + staleDays + " day')"
    : '';
  const base = `SELECT u.symbol, u.rank, u.name, u.mcap_yi,
                       COALESCE(m.bar_count,0) AS bar_count, m.first_date, m.last_date, m.adjust,
                       COALESCE(u.drawn_count,0) AS drawn_count, u.drawn_at
                FROM bt_universe u
                LEFT JOIN stock_meta m ON m.symbol = u.symbol
                WHERE 1=1` + exSql;

  // ★ ORDER BY 的顺序就是"练习轮次"的全部实现：
  //   drawn_count 升序 → 永远先抽没练过的（=0），0 档抽空了自然落到 1 档，
  //   1 档抽空落到 2 档……「所有标的都被标记才允许重复」不需要额外判断。
  //   RANDOM() 作为第二排序键：同一档内部仍是随机的。
  //   注意不能在 SQL 里先 ORDER BY RANDOM() 再挑，那样会退化成纯随机。
  const orderSql = ' ORDER BY COALESCE(u.drawn_count,0) ASC, RANDOM() LIMIT 1';

  // 第一轮：根数够 + 数据新鲜
  if (minBars > 0 || freshSql) {
    let row = await dbGet(base + ' AND COALESCE(m.bar_count,0) >= ?' + freshSql + orderSql,
      exclude.concat([minBars]));
    if (row) return row;
  }
  // 第二轮：放宽根数，仍要求新鲜（新股/短历史也可以练短局）
  if (freshSql) {
    const row2 = await dbGet(base + freshSql + ' AND COALESCE(m.bar_count,0) > 0' + orderSql, exclude);
    if (row2) return row2;
  }
  // 第三轮：彻底放宽（池子刚建、还没灌数据时就是这种状态）
  const row3 = await dbGet(base + orderSql, exclude);
  return row3 || null;
}

/**
 * 给一只标的打"已练"标记（drawn_count + 1）。
 *
 * ★ drawn_count 的语义不是"练了几次"，而是"这只票被练到了第几轮"。
 *   所以只有处在**最低档**的标的才允许 +1：
 *
 *     min = 池内最小 drawn_count
 *     若 该标的 drawn_count <= min  →  +1
 *     否则不动（它已经领先于当前轮次了）
 *
 *   这条规则顺带解决了两件事：
 *   ① 页面刷新 / 反复加载同一只票不会把它的标记顶到天上
 *      （第一次 0→1，第二次因为 1 > min 0 就不再加）；
 *   ② 「所有标的都被标记才允许重复」自动成立 ——
 *      只要池里还有 0 档的票，min 就是 0，1 档的票怎么练都不涨。
 *
 * ★ 什么时候调用：
 *   在**前端真正开局成功之后**调（K 线加载完成），不是抽中那一刻。
 *   抽中但加载失败（停牌/接口抖动）不该消耗掉这只票 ——
 *   否则池子里的票会被"抽掉"却没真正练过。
 *
 * @param {string} symbol
 * @returns {Promise<{symbol:string, drawnCount:number, bumped:boolean}|null>}
 */
async function markUniverseDrawn(symbol) {
  await initStore();
  const sym = String(symbol || '').trim().toLowerCase();
  if (!/^(sh|sz|bj)\d{6}$/.test(sym)) return null;
  const row = await dbGet(
    `SELECT COALESCE(drawn_count,0) AS c,
            (SELECT MIN(COALESCE(drawn_count,0)) FROM bt_universe) AS m
     FROM bt_universe WHERE symbol = ?`, [sym]);
  if (!row) return null;                       // 不在池内（手动输入的池外标的）
  const cur = row.c || 0;
  const min = row.m || 0;
  if (cur > min) {
    // 已经领先当前轮次 → 只刷新时间，不涨次数
    await dbRun('UPDATE bt_universe SET drawn_at = ? WHERE symbol = ?', [new Date().toISOString(), sym]);
    return { symbol: sym, drawnCount: cur, bumped: false };
  }
  await dbRun(
    'UPDATE bt_universe SET drawn_count = COALESCE(drawn_count,0) + 1, drawn_at = ? WHERE symbol = ?',
    [new Date().toISOString(), sym]);
  return { symbol: sym, drawnCount: cur + 1, bumped: true };
}

/**
 * 批量回填"已练"标记（把历史回测记录里出现过的标的补上标记）。
 *
 * ★ 回填只保证"至少 1"（历史记录分不清当时是第几轮），
 *   用 MAX(drawn_count,1) 而不是累加 —— 累加会让一只练过 5 次的票
 *   直接跳到第 6 档，把整个池子的轮次顺序打乱。
 *
 * @param {string[]} symbols
 * @returns {Promise<{scanned:number, marked:number}>}
 */
async function markUniverseDrawnBatch(symbols) {
  await initStore();
  const list = (Array.isArray(symbols) ? symbols : [])
    .map(s => String(s || '').trim().toLowerCase())
    .filter(s => /^(sh|sz|bj)\d{6}$/.test(s));
  if (!list.length) return { scanned: 0, marked: 0 };
  const uniq = Array.from(new Set(list));
  let marked = 0;
  const now = new Date().toISOString();
  for (const sym of uniq) {
    const r = await dbRun(
      'UPDATE bt_universe SET drawn_count = MAX(COALESCE(drawn_count,0), 1), drawn_at = COALESCE(drawn_at, ?) WHERE symbol = ?',
      [now, sym]);
    if (r && r.changes) marked++;
  }
  return { scanned: uniq.length, marked: marked };
}

/**
 * 池子覆盖率统计（给运维/前端展示用）
 */
async function getUniverseStats() {
  await initStore();
  const u = await dbGet(`SELECT COUNT(*) AS total, MIN(rank) AS min_rank, MAX(rank) AS max_rank,
                                MAX(built_at) AS built_at,
                                SUM(CASE WHEN COALESCE(drawn_count,0) > 0 THEN 1 ELSE 0 END) AS drawn,
                                MAX(COALESCE(drawn_count,0)) AS max_drawn,
                                MIN(COALESCE(drawn_count,0)) AS min_drawn,
                                SUM(COALESCE(drawn_count,0)) AS drawn_total,
                                (SELECT COUNT(*) FROM bt_universe b
                                  WHERE COALESCE(b.drawn_count,0) =
                                        (SELECT MIN(COALESCE(drawn_count,0)) FROM bt_universe)) AS remaining
                         FROM bt_universe`);
  if (!u || !u.total) {
    return { total: 0, loaded: 0, full: 0, fresh: 0, builtAt: null, latestDate: null, bars: 0,
             drawn: 0, untouched: 0, drawnTotal: 0, round: 1, remaining: 0 };
  }
  // ★ "完整"的口径不能只看 bar_count >= 2500：
  //   2016 之后上市的股票（如宁德时代 2018-06 上市只有 2029 根）永远达不到 2500，
  //   会被误判成"没灌满"，进度条永远到不了 100%。
  //   正确口径 = 覆盖窗口起点(2016-01-04) 且最新日期新鲜；
  //   或 上市晚于窗口起点、但根数与该股上市以来应有的交易日数相当（0.6 倍宽松阈值，
  //   容忍长期停牌股）。julianday 差值 × 0.6 ≈ 每年 219 根，正常股 243 根/年必然通过。
  const c = await dbGet(`
    SELECT SUM(CASE WHEN COALESCE(m.bar_count,0) > 0    THEN 1 ELSE 0 END) AS loaded,
           SUM(CASE WHEN COALESCE(m.bar_count,0) >= 150 THEN 1 ELSE 0 END) AS usable,
           SUM(COALESCE(m.bar_count,0)) AS bars,
           SUM(CASE WHEN m.first_date IS NOT NULL
                     AND m.last_date >= date('now','localtime','-4 day')
                     AND (m.first_date <= '2016-01-04'
                          OR m.bar_count >= (julianday('now','localtime') - julianday(m.first_date)) * 0.6)
               THEN 1 ELSE 0 END) AS full
    FROM bt_universe u LEFT JOIN stock_meta m ON m.symbol = u.symbol`);
  // 池内最新数据日期：拿 stock_kline 里池内标的的最大日期
  const d = await dbGet(`
    SELECT MAX(k.date) AS latest
    FROM stock_kline k
    WHERE k.symbol IN (SELECT symbol FROM bt_universe)`);
  return {
    total: u.total || 0,
    loaded: (c && c.loaded) || 0,
    full: (c && c.full) || 0,        // 覆盖 2016-01-04 且最新（含 2016 后上市但上市起完整）
    usable: (c && c.usable) || 0,    // ≥150 根，够开一局
    bars: (c && c.bars) || 0,
    builtAt: u.built_at || null,
    latestDate: (d && d.latest) || null,
    // ---- 练习轮次（drawn_count 标记）----
    drawn: (u && u.drawn) || 0,               // 池内已被练过的只数
    untouched: ((u && u.total) || 0) - ((u && u.drawn) || 0),  // 还没练过的只数
    drawnTotal: (u && u.drawn_total) || 0,    // 累计练习次数
    // ★ 「当前第几轮」要用 MIN 而不是 MAX：
    //   MIN = 池子里练得最少的那一档，也就是**正在抽的那一轮**。
    //   用 MAX 会错得离谱 —— 刚开始练了 20 只（都是 1）时，max=1 会显示"第 2 轮"，
    //   实际才第 1 轮（还有 3480 只没练过）。
    round: ((u && u.min_drawn) || 0) + 1,
    remaining: (u && u.remaining) || 0,       // 当前这一轮还剩多少只没练过
  };
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
  saveUniverse,
  getUniverse,
  randomUniverseSymbol,
  markUniverseDrawn,
  markUniverseDrawnBatch,
  getUniverseStats,
  isFresh,
  isUpToDate,
  isCoverageEnough,
  detectAdjustChange,
  getStats,
  _internal: { dbRun, dbAll, dbGet },   // 供脚本复用
};
