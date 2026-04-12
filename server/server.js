const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../')));

// 数据库初始化
const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 交易记录表
  db.run(`CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    open_date TEXT,
    close_date TEXT,
    symbol TEXT,
    type TEXT,
    direction TEXT,
    entry_price REAL,
    stop_loss REAL,
    take_profit REAL,
    stop_distance_pct REAL,
    tp_distance_pct REAL,
    position_size REAL,
    actual_lots REAL,
    actual_amount REAL,
    r_amount REAL,
    close_price REAL,
    pnl_amount REAL,
    pnl_r REAL,
    hold_days INTEGER,
    status TEXT,
    notes TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // 入金记录表
  db.run(`CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // 出金记录表
  db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // 账户设置表
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    user_id TEXT PRIMARY KEY,
    init_capital REAL DEFAULT 100000,
    risk_pct REAL DEFAULT 1,
    max_risk REAL DEFAULT 1000,
    fee_rate REAL DEFAULT 0.03,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// ===== API 路由 =====

// 用户注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const userId = uuidv4();
  
  db.run(
    'INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
    [userId, username, password],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: '用户名已存在' });
        }
        return res.status(500).json({ error: err.message });
      }
      // 创建默认设置
      db.run('INSERT INTO settings (user_id) VALUES (?)', [userId]);
      res.json({ userId, username, message: '注册成功' });
    }
  );
});

// 用户登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: '用户名或密码错误' });
      res.json({ userId: row.id, username: row.username, message: '登录成功' });
    }
  );
});

// 获取用户所有数据
app.get('/api/sync/:userId', (req, res) => {
  const { userId } = req.params;
  const result = { trades: [], deposits: [], withdrawals: [], settings: null };
  
  db.get('SELECT * FROM settings WHERE user_id = ?', [userId], (err, settings) => {
    if (settings) result.settings = settings;
    
    db.all('SELECT * FROM trades WHERE user_id = ? ORDER BY open_date DESC', [userId], (err, trades) => {
      result.trades = trades || [];
      
      db.all('SELECT * FROM deposits WHERE user_id = ? ORDER BY date DESC', [userId], (err, deposits) => {
        result.deposits = deposits || [];
        
        db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY date DESC', [userId], (err, withdrawals) => {
          result.withdrawals = withdrawals || [];
          res.json(result);
        });
      });
    });
  });
});

// 同步数据（上传本地数据到服务器）
app.post('/api/sync/:userId', (req, res) => {
  const { userId } = req.params;
  const { trades, deposits, withdrawals, settings, deletedTradeIds, deletedDepositIds, deletedWithdrawalIds } = req.body;
  
  db.serialize(() => {
    // 更新设置
    if (settings) {
      db.run(
        `INSERT OR REPLACE INTO settings (user_id, init_capital, risk_pct, max_risk, fee_rate, updated_at) 
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [userId, settings.initCapital, settings.riskPct, settings.maxRisk, settings.feeRate]
      );
    }
    
    // 删除服务器上已被删除的交易记录
    if (deletedTradeIds && deletedTradeIds.length > 0) {
      const placeholders = deletedTradeIds.map(() => '?').join(',');
      db.run(`DELETE FROM trades WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...deletedTradeIds]);
    }
    
    // 更新交易记录
    if (trades && trades.length > 0) {
      const stmt = db.prepare(`INSERT OR REPLACE INTO trades (
        id, user_id, open_date, close_date, symbol, type, direction, entry_price, stop_loss,
        take_profit, stop_distance_pct, tp_distance_pct, position_size, actual_lots,
        actual_amount, r_amount, close_price, pnl_amount, pnl_r, hold_days, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      
      trades.forEach(trade => {
        stmt.run([
          trade.id || uuidv4(), userId, trade.openDate, trade.closeDate, trade.symbol,
          trade.type, trade.direction, trade.entryPrice, trade.stopLoss, trade.takeProfit,
          trade.stopDistancePct, trade.tpDistancePct, trade.positionSize, trade.actualLots,
          trade.actualAmount, trade.rAmount, trade.closePrice, trade.pnlAmount, trade.pnlR,
          trade.holdDays, trade.status, trade.notes
        ]);
      });
      stmt.finalize();
    }
    
    // 删除服务器上已被删除的入金记录
    if (deletedDepositIds && deletedDepositIds.length > 0) {
      const placeholders = deletedDepositIds.map(() => '?').join(',');
      db.run(`DELETE FROM deposits WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...deletedDepositIds]);
    }
    
    // 更新入金记录
    if (deposits && deposits.length > 0) {
      const stmt = db.prepare('INSERT OR REPLACE INTO deposits (id, user_id, amount, date) VALUES (?, ?, ?, ?)');
      deposits.forEach(d => {
        stmt.run([d.id || uuidv4(), userId, d.amount, d.date]);
      });
      stmt.finalize();
    }
    
    // 删除服务器上已被删除的出金记录
    if (deletedWithdrawalIds && deletedWithdrawalIds.length > 0) {
      const placeholders = deletedWithdrawalIds.map(() => '?').join(',');
      db.run(`DELETE FROM withdrawals WHERE user_id = ? AND id IN (${placeholders})`, [userId, ...deletedWithdrawalIds]);
    }
    
    // 更新出金记录
    if (withdrawals && withdrawals.length > 0) {
      const stmt = db.prepare('INSERT OR REPLACE INTO withdrawals (id, user_id, amount, date) VALUES (?, ?, ?, ?)');
      withdrawals.forEach(w => {
        stmt.run([w.id || uuidv4(), userId, w.amount, w.date]);
      });
      stmt.finalize();
    }
    
    res.json({ message: '同步成功' });
  });
});

// 添加单条交易
app.post('/api/trades/:userId', (req, res) => {
  const { userId } = req.params;
  const trade = req.body;
  const tradeId = trade.id || uuidv4();
  
  db.run(
    `INSERT OR REPLACE INTO trades (
      id, user_id, open_date, close_date, symbol, type, direction, entry_price, stop_loss,
      take_profit, stop_distance_pct, tp_distance_pct, position_size, actual_lots,
      actual_amount, r_amount, close_price, pnl_amount, pnl_r, hold_days, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tradeId, userId, trade.openDate, trade.closeDate, trade.symbol,
      trade.type, trade.direction, trade.entryPrice, trade.stopLoss, trade.takeProfit,
      trade.stopDistancePct, trade.tpDistancePct, trade.positionSize, trade.actualLots,
      trade.actualAmount, trade.rAmount, trade.closePrice, trade.pnlAmount, trade.pnlR,
      trade.holdDays, trade.status, trade.notes
    ],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: tradeId, message: '交易记录已保存' });
    }
  );
});

// 删除交易
app.delete('/api/trades/:userId/:tradeId', (req, res) => {
  const { userId, tradeId } = req.params;
  db.run('DELETE FROM trades WHERE id = ? AND user_id = ?', [tradeId, userId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '交易已删除' });
  });
});

// 添加入金
app.post('/api/deposits/:userId', (req, res) => {
  const { userId } = req.params;
  const { amount, date } = req.body;
  const depositId = uuidv4();
  
  db.run(
    'INSERT INTO deposits (id, user_id, amount, date) VALUES (?, ?, ?, ?)',
    [depositId, userId, amount, date],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: depositId, message: '入金记录已保存' });
    }
  );
});

// 添加出金
app.post('/api/withdrawals/:userId', (req, res) => {
  const { userId } = req.params;
  const { amount, date } = req.body;
  const withdrawalId = uuidv4();
  
  db.run(
    'INSERT INTO withdrawals (id, user_id, amount, date) VALUES (?, ?, ?, ?)',
    [withdrawalId, userId, amount, date],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: withdrawalId, message: '出金记录已保存' });
    }
  );
});

// 更新设置
app.post('/api/settings/:userId', (req, res) => {
  const { userId } = req.params;
  const { initCapital, riskPct, maxRisk, feeRate } = req.body;
  
  db.run(
    `INSERT OR REPLACE INTO settings (user_id, init_capital, risk_pct, max_risk, fee_rate, updated_at) 
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [userId, initCapital, riskPct, maxRisk, feeRate],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: '设置已保存' });
    }
  );
});

// 清空用户的所有数据
app.delete('/api/clear/:userId', (req, res) => {
  const { userId } = req.params;
  
  db.serialize(() => {
    // 清空交易记录
    db.run('DELETE FROM trades WHERE user_id = ?', [userId]);
    // 清空入金记录
    db.run('DELETE FROM deposits WHERE user_id = ?', [userId]);
    // 清空出金记录
    db.run('DELETE FROM withdrawals WHERE user_id = ?', [userId]);
    // 清空设置（可选，保留初始资金设置）
    
    console.log(`[清空] 用户 ${userId} 的数据已清空`);
    res.json({ message: '所有数据已清空' });
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`本地访问: http://localhost:${PORT}`);
});

module.exports = app;