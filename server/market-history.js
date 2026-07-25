// 市场数据历史快照
// 每天第一次成功拉到行情时，自动把当天数据写入 SQLite 的 market_history 表
// 字段：
//   date            - YYYY-MM-DD（主键，UNIQUE）
//   rzye            - 融资余额（元）
//   rzrqye          - 两融余额（元）
//   margin_change_pct - 融资余额环比（%）
//   amount_sh_yi    - 沪市成交额（亿元）
//   amount_sz_yi    - 深市成交额（亿元）
//   amount_total_yi - 沪深两市总成交额（亿元）
//   zt_count        - 涨停家数
//   dt_count        - 跌停家数
//   zt_dt_diff      - 涨跌停差
//   up_count        - 上涨家数
//   down_count      - 下跌家数
//   flat_count      - 平盘家数
//   sample_size     - 样本数（拉到的股票总数）
//   north_net_yi    - 北向资金净流入（亿元）
//   fetched_at      - 拉取时间
//   source          - 数据源标识

const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data.db');
let _db = null;
function getDB() {
  if (!_db) _db = new sqlite3.Database(DB_PATH);
  return _db;
}

// 计算「最近的交易日」：周六回退到周五，周日回退到周五，其他日期保持当天
// 用于在非交易日拉取数据时，把记录写到上一个交易日，避免「周六记录里其实是周五数据」的歧义
function getLastTradingDate() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
  if (day === 0) now.setDate(now.getDate() - 2); // 周日 → 上周五
  else if (day === 6) now.setDate(now.getDate() - 1); // 周六 → 上周五
  return now.toISOString().slice(0, 10);
}

// 规范化日期为 YYYY-MM-DD（兼容 "2026-07-23 00:00:00" 这种带时间的格式）
function normalizeDate(s) {
  if (!s) return '';
  return String(s).slice(0, 10);
}

// 初始化表
function initHistoryTable() {
  const db = getDB();
  db.run(`CREATE TABLE IF NOT EXISTS market_history (
    date TEXT PRIMARY KEY,
    rzye REAL DEFAULT 0,
    rzrqye REAL DEFAULT 0,
    margin_change_pct REAL DEFAULT 0,
    amount_sh_yi REAL DEFAULT 0,
    amount_sz_yi REAL DEFAULT 0,
    amount_total_yi REAL DEFAULT 0,
    zt_count INTEGER DEFAULT 0,
    dt_count INTEGER DEFAULT 0,
    zt_dt_diff INTEGER DEFAULT 0,
    up_count INTEGER DEFAULT 0,
    down_count INTEGER DEFAULT 0,
    flat_count INTEGER DEFAULT 0,
    sample_size INTEGER DEFAULT 0,
    north_net_yi REAL DEFAULT 0,
    fetched_at TEXT,
    source TEXT
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_market_history_date ON market_history(date DESC)');
}
initHistoryTable();

// 记录今日资金面（fund 字段被更新，其他字段保留）
// 用「最近交易日」作记录主键（周六/日调用时回退到周五），保证图表最右端的日期是真实交易日
function recordFundSnapshot(fund) {
  const today = getLastTradingDate();
  const db = getDB();

  const f = fund || {};
  const m = f.margin || {};
  const a = f.amount || {};
  const n = f.north || {};

  return new Promise(function(resolve) {
    db.run(`INSERT INTO market_history
      (date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi, north_net_yi, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        rzye=excluded.rzye,
        rzrqye=excluded.rzrqye,
        margin_change_pct=excluded.margin_change_pct,
        amount_sh_yi=excluded.amount_sh_yi,
        amount_sz_yi=excluded.amount_sz_yi,
        amount_total_yi=excluded.amount_total_yi,
        north_net_yi=excluded.north_net_yi,
        fetched_at=excluded.fetched_at`,
      [today, m.rzye || 0, m.rzrqye || 0, m.changePct || 0,
       a.shYi || 0, a.szYi || 0, a.totalYi || 0,
       (n.netInflow || 0) / 1e8,
       new Date().toISOString(), 'eastmoney+sina'],
      function(err) {
        if (err) console.warn('[market-history] fund 记录失败:', err.message);
        else console.log('[market-history] fund 已记录 ' + today);
        resolve();
      });
  });
}

// 记录今日情绪面（sentiment 字段被更新，其他字段保留）
function recordSentimentSnapshot(sentiment) {
  const today = getLastTradingDate();  // 非交易日时写入上一交易日
  const db = getDB();

  const s = sentiment || {};
  const sm = s.merged || {};

  return new Promise(function(resolve) {
    db.run(`INSERT INTO market_history
      (date, zt_count, dt_count, zt_dt_diff, up_count, down_count, flat_count, sample_size, fetched_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        zt_count=excluded.zt_count,
        dt_count=excluded.dt_count,
        zt_dt_diff=excluded.zt_dt_diff,
        up_count=excluded.up_count,
        down_count=excluded.down_count,
        flat_count=excluded.flat_count,
        sample_size=excluded.sample_size,
        fetched_at=excluded.fetched_at`,
      [today, sm.zt || 0, sm.dt || 0, (sm.zt || 0) - (sm.dt || 0),
       sm.up || 0, sm.down || 0, sm.flat || 0, s.sampleSize || 0,
       new Date().toISOString(), 'eastmoney+sina'],
      function(err) {
        if (err) console.warn('[market-history] sentiment 记录失败:', err.message);
        else console.log('[market-history] sentiment 已记录 ' + today);
        resolve();
      });
  });
}

// 查询最近 N 天历史数据
// 入参：days - 天数（默认 30）
// 返回：[{ date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi,
//         zt_count, dt_count, zt_dt_diff, up_count, down_count, flat_count, sample_size, north_net_yi }, ...] 按 date ASC
function getHistory(days) {
  days = days || 30;
  const db = getDB();
  return new Promise(function(resolve, reject) {
    db.all('SELECT * FROM market_history ORDER BY date DESC LIMIT ?', [days], function(err, rows) {
      if (err) return reject(err);
      // 反转成 ASC
      resolve((rows || []).reverse());
    });
  });
}

// 查询某日数据
function getHistoryByDate(date) {
  const db = getDB();
  return new Promise(function(resolve, reject) {
    db.get('SELECT * FROM market_history WHERE date = ?', [date], function(err, row) {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

module.exports = { recordFundSnapshot, recordSentimentSnapshot, getHistory, getHistoryByDate, initHistoryTable };
