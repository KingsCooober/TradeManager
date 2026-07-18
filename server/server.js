const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 行情代理：绕过 CORS 限制
// 多数据源 fallback：东方财富 → 新浪 → 腾讯
app.get('/api/quote', (req, res) => {
  const secid = req.query.secid;
  if (!secid || !/^[01]\.\d{6}$/.test(secid)) {
    return res.status(400).json({ error: 'invalid secid', expected: '1.600000 或 0.000001' });
  }
  const code = secid.split('.')[1];
  const market = secid.split('.')[0]; // 0=深, 1=沪
  const sinaSymbol = (market === '1' ? 'sh' : 'sz') + code;

  // 优先用东方财富（数据最全）
  const eastmoneyUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f58,f60,f168,f169,f170`;

  const fetchWithTimeout = (url, options, timeoutMs = 4000) => {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? require('https') : require('http');
      const req = mod.get(url, options, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.setTimeout(timeoutMs);
    });
  };

  // 方案1：东方财富
  fetchWithTimeout(eastmoneyUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*',
    },
  }).then(r => {
    const json = JSON.parse(r.body);
    if (json && json.data && json.data.f43 != null) {
      const d = json.data;
      return res.json({
        rc: 0,
        data: {
          symbol: code,
          name: d.f58 || '',
          price: d.f43 / 100,
          open: d.f46 != null ? d.f46 / 100 : null,
          high: d.f44 != null ? d.f44 / 100 : null,
          low: d.f45 != null ? d.f45 / 100 : null,
          preClose: d.f60 != null ? d.f60 / 100 : null,
          change: d.f169 != null ? d.f169 / 100 : null,
          changePct: d.f170 != null ? d.f170 / 100 : null,
          source: 'eastmoney',
        },
      });
    }
    throw new Error('no data');
  }).catch(e1 => {
    // 方案2：新浪 hq.sinajs.cn（最宽松，CORS 也通）
    const sinaUrl = `https://hq.sinajs.cn/list=${sinaSymbol}`;
    fetchWithTimeout(sinaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://finance.sina.com.cn/',
      },
    }).then(r => {
      // 返回格式: var hq_str_sh600519="贵州茅台,1488.00,1490.00,...";
      const m = r.body.match(/="([^"]+)"/);
      if (!m) throw new Error('sina parse fail');
      const parts = m[1].split(',');
      if (parts.length < 32) throw new Error('sina fields insufficient');
      const name = parts[0];
      const open = parseFloat(parts[1]);
      const preClose = parseFloat(parts[2]);
      const price = parseFloat(parts[3]);
      const high = parseFloat(parts[4]);
      const low = parseFloat(parts[5]);
      const change = price - preClose;
      const changePct = (change / preClose) * 100;
      res.json({
        rc: 0,
        data: {
          symbol: code, name, price, open, high, low, preClose,
          change, changePct, source: 'sina',
        },
      });
    }).catch(e2 => {
      res.status(502).json({
        error: 'all sources failed',
        eastmoney: e1.message,
        sina: e2.message,
      });
    });
  });
});

// 数据库初始化
const db = new sqlite3.Database(path.join(__dirname, 'data.db'));

db.serialize(() => {
  // 用户表
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // 尝试添加管理员字段（忽略已存在的错误）
  db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.warn('添加 role 字段失败:', err.message);
    }
  });

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

  // 复盘总结表
  db.run(`CREATE TABLE IF NOT EXISTS diary2 (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    symbol TEXT,
    pnl_percent REAL,
    trade_logic TEXT,
    mood TEXT,
    follow_system TEXT DEFAULT '否',
    lesson TEXT,
    improvement TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  // 每日复盘表
  db.run(`CREATE TABLE IF NOT EXISTS daily_reviews (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    review_date TEXT NOT NULL,
    market_json TEXT,
    themes_json TEXT,
    trade_reviews_json TEXT,
    discipline_json TEXT,
    summary_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// ===== API 路由 =====

// 用户注册
app.post('/api/register', (req, res) => {
  const { username, password, role = 'user' } = req.body;
  const userId = uuidv4();
  
  if (role === 'admin' && username !== 'admin') {
    return res.status(403).json({ error: '只有管理员可以创建管理员账户' });
  }
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(
    'INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)',
    [userId, username, hashedPassword, role],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: '用户名已存在' });
        }
        return res.status(500).json({ error: err.message });
      }
      db.run('INSERT INTO settings (user_id) VALUES (?)', [userId]);
      res.json({ userId, username, role, message: '注册成功' });
    }
  );
});

// 用户登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(401).json({ error: '用户名或密码错误' });
      
      const isPasswordValid = bcrypt.compareSync(password, row.password);
      if (!isPasswordValid) return res.status(401).json({ error: '用户名或密码错误' });
      
      res.json({ userId: row.id, username: row.username, role: row.role, message: '登录成功' });
    }
  );
});

// 修改密码
app.post('/api/change-password', (req, res) => {
  const { userId, oldPassword, newPassword } = req.body;
  
  if (!userId || !oldPassword || !newPassword) {
    return res.status(400).json({ error: '请提供用户ID、旧密码和新密码' });
  }
  
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少需要6位' });
  }
  
  db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(401).json({ error: '用户不存在' });
    
    const isOldPasswordValid = bcrypt.compareSync(oldPassword, row.password);
    if (!isOldPasswordValid) {
      return res.status(401).json({ error: '旧密码错误' });
    }
    
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    
    db.run(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, userId],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: '密码修改成功' });
      }
    );
  });
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
    // 清空日记2
    db.run('DELETE FROM diary2 WHERE user_id = ?', [userId]);
    // 清空每日复盘
    db.run('DELETE FROM daily_reviews WHERE user_id = ?', [userId]);
    
    console.log(`[清空] 用户 ${userId} 的数据已清空`);
    res.json({ message: '所有数据已清空' });
  });
});

// ===== 复盘总结2 API =====

// 获取用户复盘总结2数据
app.get('/api/diary/:userId', (req, res) => {
  const { userId } = req.params;
  
  db.all(
    'SELECT * FROM diary2 WHERE user_id = ? ORDER BY trade_date DESC',
    [userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ diary: rows || [] });
    }
  );
});

// 保存日记2数据
app.post('/api/diary/:userId', (req, res) => {
  const { userId } = req.params;
  const { diary } = req.body;
  
  if (!diary || !Array.isArray(diary)) {
    return res.status(400).json({ error: '无效的数据格式' });
  }
  
  db.serialize(() => {
    // 使用 INSERT OR REPLACE 更新或插入记录，保留其他数据
    const stmt = db.prepare(`INSERT OR REPLACE INTO diary2 (
      id, user_id, trade_date, symbol, pnl_percent,
      trade_logic, mood, follow_system, lesson, improvement,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    
    diary.forEach(item => {
      stmt.run([
        item.id || uuidv4(),
        userId,
        item.tradeDate,
        item.symbol,
        item.pnlPercent,
        item.tradeLogic,
        item.mood,
        item.followSystem || '否',
        item.lesson,
        item.improvement,
        item.createdAt || new Date().toISOString(),
        item.updatedAt || new Date().toISOString()
      ]);
    });
    
    stmt.finalize();
    
    res.json({ message: '复盘总结数据已保存', count: diary.length });
  });
});

// ===== 每日复盘 API =====

// 获取用户某日的复盘
app.get('/api/daily-review/:userId', (req, res) => {
  const { userId } = req.params;
  const { date } = req.query;

  if (date) {
    db.get(
      'SELECT * FROM daily_reviews WHERE user_id = ? AND review_date = ?',
      [userId, date],
      (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ review: row || null });
      }
    );
  } else {
    db.all(
      'SELECT * FROM daily_reviews WHERE user_id = ? ORDER BY review_date DESC',
      [userId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ reviews: rows || [] });
      }
    );
  }
});

// 保存每日复盘
app.post('/api/daily-review/:userId', (req, res) => {
  const { userId } = req.params;
  const { review } = req.body;

  if (!review || !review.date) {
    return res.status(400).json({ error: '无效的数据格式' });
  }

  const reviewId = review.id || uuidv4();

  db.run(
    `INSERT OR REPLACE INTO daily_reviews (
      id, user_id, review_date, market_json, themes_json,
      trade_reviews_json, discipline_json, summary_json,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reviewId, userId, review.date,
      JSON.stringify(review.market || []),
      JSON.stringify(review.themes || []),
      JSON.stringify(review.tradeReviews || []),
      JSON.stringify(review.discipline || {}),
      JSON.stringify(Object.assign({}, review.summary || {}, { overallReason: review.overallReason || '', sentimentCycle: review.sentimentCycle || null })),
      review.createdAt || new Date().toISOString(),
      new Date().toISOString()
    ],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: reviewId, message: '复盘已保存' });
    }
  );
});

// ===== 管理员 API =====

// 验证管理员权限
function checkAdmin(userId, callback) {
  db.get('SELECT role FROM users WHERE id = ?', [userId], (err, row) => {
    if (err) return callback(err);
    if (!row || row.role !== 'admin') {
      return callback(new Error('权限不足，需要管理员权限'));
    }
    callback(null);
  });
}

// 管理员获取所有用户列表
app.get('/api/admin/users', (req, res) => {
  const { adminId } = req.query;
  
  checkAdmin(adminId, (err) => {
    if (err) return res.status(403).json({ error: err.message });
    
    db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC', (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ users: rows });
    });
  });
});

// 管理员获取指定用户的所有数据
app.get('/api/admin/user/:userId', (req, res) => {
  const { userId } = req.params;
  const { adminId } = req.query;
  
  checkAdmin(adminId, (err) => {
    if (err) return res.status(403).json({ error: err.message });
    
    const result = { trades: [], deposits: [], withdrawals: [], diary2: [], settings: null };
    
    db.get('SELECT * FROM settings WHERE user_id = ?', [userId], (err, settings) => {
      if (settings) result.settings = settings;
      
      db.all('SELECT * FROM trades WHERE user_id = ? ORDER BY open_date DESC', [userId], (err, trades) => {
        result.trades = trades || [];
        
        db.all('SELECT * FROM deposits WHERE user_id = ? ORDER BY date DESC', [userId], (err, deposits) => {
          result.deposits = deposits || [];
          
          db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY date DESC', [userId], (err, withdrawals) => {
            result.withdrawals = withdrawals || [];
            
            db.all('SELECT * FROM diary2 WHERE user_id = ? ORDER BY trade_date DESC', [userId], (err, diary2) => {
              result.diary2 = diary2 || [];
              
              db.get('SELECT username FROM users WHERE id = ?', [userId], (err, user) => {
                result.username = user ? user.username : null;
                res.json(result);
              });
            });
          });
        });
      });
    });
  });
});

// 管理员删除指定用户及其所有数据
app.delete('/api/admin/user/:userId', (req, res) => {
  const { userId } = req.params;
  const { adminId } = req.query;
  
  checkAdmin(adminId, (err) => {
    if (err) return res.status(403).json({ error: err.message });
    
    db.serialize(() => {
      db.run('DELETE FROM trades WHERE user_id = ?', [userId]);
      db.run('DELETE FROM deposits WHERE user_id = ?', [userId]);
      db.run('DELETE FROM withdrawals WHERE user_id = ?', [userId]);
      db.run('DELETE FROM settings WHERE user_id = ?', [userId]);
      db.run('DELETE FROM users WHERE id = ?', [userId]);
      
      console.log(`[管理员删除] 用户 ${userId} 及其所有数据已删除`);
      res.json({ message: '用户及其所有数据已删除' });
    });
  });
});

// 管理员创建管理员账户
app.post('/api/admin/register', (req, res) => {
  const { adminId, username, password } = req.body;
  
  checkAdmin(adminId, (err) => {
    if (err) return res.status(403).json({ error: err.message });
    
    const userId = uuidv4();
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    db.run(
      'INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)',
      [userId, username, hashedPassword, 'admin'],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(400).json({ error: '用户名已存在' });
          }
          return res.status(500).json({ error: err.message });
        }
        db.run('INSERT INTO settings (user_id) VALUES (?)', [userId]);
        res.json({ userId, username, role: 'admin', message: '管理员账户创建成功' });
      }
    );
  });
});

// 管理员统计数据
app.get('/api/admin/stats', (req, res) => {
  const { adminId } = req.query;
  
  checkAdmin(adminId, (err) => {
    if (err) return res.status(403).json({ error: err.message });
    
    db.get('SELECT COUNT(*) as user_count FROM users', (err, userResult) => {
      db.get('SELECT COUNT(*) as trade_count FROM trades', (err, tradeResult) => {
        db.get('SELECT COUNT(*) as deposit_count, SUM(amount) as total_deposit FROM deposits', (err, depositResult) => {
          db.get('SELECT COUNT(*) as withdrawal_count, SUM(amount) as total_withdrawal FROM withdrawals', (err, withdrawalResult) => {
            res.json({
              user_count: userResult.user_count || 0,
              trade_count: tradeResult.trade_count || 0,
              deposit_count: depositResult.deposit_count || 0,
              total_deposit: depositResult.total_deposit || 0,
              withdrawal_count: withdrawalResult.withdrawal_count || 0,
              total_withdrawal: withdrawalResult.total_withdrawal || 0
            });
          });
        });
      });
    });
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
  console.log(`本地访问: http://localhost:${PORT}`);
});

module.exports = app;