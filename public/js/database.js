// ===== IndexedDB 数据库管理 =====

const DB_NAME = 'PositionManagerDB';
const DB_VERSION = 1;

// 数据库连接
var db = null;

// 初始化数据库
function initDatabase() {
  return new Promise(function(resolve, reject) {
    var request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = function(event) {
      console.error('数据库打开失败:', event.target.error);
      reject(event.target.error);
    };
    
    request.onsuccess = function(event) {
      db = event.target.result;
      console.log('数据库连接成功');
      resolve(db);
    };
    
    request.onupgradeneeded = function(event) {
      var database = event.target.result;
      
      // 交易记录表
      if (!database.objectStoreNames.contains('trades')) {
        var tradeStore = database.createObjectStore('trades', { keyPath: 'id' });
        tradeStore.createIndex('date', 'date', { unique: false });
        tradeStore.createIndex('status', 'status', { unique: false });
        tradeStore.createIndex('symbol', 'symbol', { unique: false });
      }
      
      // 资金记录表（入金）
      if (!database.objectStoreNames.contains('deposits')) {
        var depositStore = database.createObjectStore('deposits', { keyPath: 'id', autoIncrement: true });
        depositStore.createIndex('date', 'date', { unique: false });
      }
      
      // 资金记录表（出金）
      if (!database.objectStoreNames.contains('withdrawals')) {
        var withdrawStore = database.createObjectStore('withdrawals', { keyPath: 'id', autoIncrement: true });
        withdrawStore.createIndex('date', 'date', { unique: false });
      }
      
      // 账户参数表
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'key' });
      }
      
      console.log('数据库结构升级完成');
    };
  });
}

// ===== 交易记录操作 =====

// 保存交易记录
function saveTradeToDB(trade) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['trades'], 'readwrite');
    var store = transaction.objectStore('trades');
    var request = store.put(trade);
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 获取所有交易记录
function getAllTradesFromDB() {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['trades'], 'readonly');
    var store = transaction.objectStore('trades');
    var request = store.getAll();
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 删除交易记录
function deleteTradeFromDB(id) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['trades'], 'readwrite');
    var store = transaction.objectStore('trades');
    var request = store.delete(id);
    
    request.onsuccess = function() {
      resolve();
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 清空所有交易记录
function clearAllTradesFromDB() {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }

    var transaction = db.transaction(['trades'], 'readwrite');
    var store = transaction.objectStore('trades');
    var request = store.clear();

    request.onsuccess = function() {
      resolve();
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 清空 IndexedDB 所有数据（trades + deposits + withdrawals + settings）
function clearAllDataFromDB() {
  return new Promise(function(resolve, reject) {
    if (!db) {
      resolve(); // 没有数据库也视为成功
      return;
    }

    var stores = ['trades', 'deposits', 'withdrawals', 'settings'];
    var tx = db.transaction(stores, 'readwrite');
    var cleared = 0;

    for (var i = 0; i < stores.length; i++) {
      (function(storeName) {
        var store = tx.objectStore(storeName);
        var req = store.clear();
        req.onsuccess = function() { cleared++; if (cleared === stores.length) resolve(); };
        req.onerror = function(e) {
          console.warn('清空 ' + storeName + ' 失败:', e.target.error);
          cleared++;
          if (cleared === stores.length) resolve();
        };
      })(stores[i]);
    }
  });
}

// ===== 资金记录操作 =====

// 添加入金记录
function addDepositToDB(amount, date) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var record = {
      amount: amount,
      date: date,
      createdAt: new Date().toISOString()
    };
    
    var transaction = db.transaction(['deposits'], 'readwrite');
    var store = transaction.objectStore('deposits');
    var request = store.add(record);
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 添加出金记录
function addWithdrawalToDB(amount, date) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var record = {
      amount: amount,
      date: date,
      createdAt: new Date().toISOString()
    };
    
    var transaction = db.transaction(['withdrawals'], 'readwrite');
    var store = transaction.objectStore('withdrawals');
    var request = store.add(record);
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 获取所有入金记录
function getAllDepositsFromDB() {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['deposits'], 'readonly');
    var store = transaction.objectStore('deposits');
    var request = store.getAll();
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 获取所有出金记录
function getAllWithdrawalsFromDB() {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['withdrawals'], 'readonly');
    var store = transaction.objectStore('withdrawals');
    var request = store.getAll();
    
    request.onsuccess = function() {
      resolve(request.result);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 删除入金记录
function deleteDepositFromDB(id) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['deposits'], 'readwrite');
    var store = transaction.objectStore('deposits');
    var request = store.delete(id);
    
    request.onsuccess = function() {
      resolve();
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 删除出金记录
function deleteWithdrawalFromDB(id) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['withdrawals'], 'readwrite');
    var store = transaction.objectStore('withdrawals');
    var request = store.delete(id);
    
    request.onsuccess = function() {
      resolve();
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// ===== 设置操作 =====

// 保存设置
function saveSettingToDB(key, value) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['settings'], 'readwrite');
    var store = transaction.objectStore('settings');
    var request = store.put({ key: key, value: value });
    
    request.onsuccess = function() {
      resolve();
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// 获取设置
function getSettingFromDB(key) {
  return new Promise(function(resolve, reject) {
    if (!db) {
      reject(new Error('数据库未初始化'));
      return;
    }
    
    var transaction = db.transaction(['settings'], 'readonly');
    var store = transaction.objectStore('settings');
    var request = store.get(key);
    
    request.onsuccess = function() {
      resolve(request.result ? request.result.value : null);
    };
    request.onerror = function() {
      reject(request.error);
    };
  });
}

// ===== 数据迁移（从localStorage迁移到IndexedDB）=====

function migrateFromLocalStorage() {
  return new Promise(function(resolve, reject) {
    // 检查是否已经迁移过
    var migrated = localStorage.getItem('db_migrated_v1');
    if (migrated) {
      resolve(false);
      return;
    }
    
    var promises = [];
    
    // 迁移交易记录
    var tradesData = localStorage.getItem('trades_v4');
    if (tradesData) {
      try {
        var trades = JSON.parse(tradesData);
        trades.forEach(function(trade) {
          promises.push(saveTradeToDB(trade));
        });
      } catch (e) {
        console.error('迁移交易记录失败:', e);
      }
    }
    
    // 迁移资金记录
    var fundsData = localStorage.getItem('funds_v1');
    if (fundsData) {
      try {
        var funds = JSON.parse(fundsData);
        if (funds.deposits) {
          funds.deposits.forEach(function(d) {
            promises.push(addDepositToDB(d.amount, d.date));
          });
        }
        if (funds.withdrawals) {
          funds.withdrawals.forEach(function(w) {
            promises.push(addWithdrawalToDB(w.amount, w.date));
          });
        }
      } catch (e) {
        console.error('迁移资金记录失败:', e);
      }
    }
    
    // 迁移账户参数
    var accountData = localStorage.getItem('account_v1');
    if (accountData) {
      try {
        var account = JSON.parse(accountData);
        Object.keys(account).forEach(function(key) {
          promises.push(saveSettingToDB(key, account[key]));
        });
      } catch (e) {
        console.error('迁移账户参数失败:', e);
      }
    }
    
    Promise.all(promises).then(function() {
      localStorage.setItem('db_migrated_v1', 'true');
      console.log('数据迁移完成');
      resolve(true);
    }).catch(function(err) {
      reject(err);
    });
  });
}

// ===== 导出/导入数据库 =====

// 导出所有数据
function exportDatabase() {
  return new Promise(function(resolve, reject) {
    var data = {
      version: 1,
      exportTime: new Date().toISOString(),
      trades: [],
      deposits: [],
      withdrawals: [],
      settings: {}
    };
    
    Promise.all([
      getAllTradesFromDB(),
      getAllDepositsFromDB(),
      getAllWithdrawalsFromDB()
    ]).then(function(results) {
      data.trades = results[0];
      data.deposits = results[1];
      data.withdrawals = results[2];
      
      // 获取设置
      var settingKeys = ['initCapital', 'riskPct', 'maxRisk', 'feeRate'];
      var settingPromises = settingKeys.map(function(key) {
        return getSettingFromDB(key);
      });
      
      return Promise.all(settingPromises).then(function(values) {
        settingKeys.forEach(function(key, index) {
          data.settings[key] = values[index];
        });
        return data;
      });
    }).then(function(exportData) {
      var json = JSON.stringify(exportData, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '交易记录数据库备份_' + getToday() + '.json';
      a.click();
      resolve(exportData);
    }).catch(reject);
  });
}

// 导入数据到数据库
function importDatabase(jsonData) {
  return new Promise(function(resolve, reject) {
    if (!jsonData.trades || !Array.isArray(jsonData.trades)) {
      reject(new Error('无效的数据格式'));
      return;
    }
    
    var promises = [];
    
    // 导入交易记录
    jsonData.trades.forEach(function(trade) {
      promises.push(saveTradeToDB(trade));
    });
    
    // 导入资金记录
    if (jsonData.deposits) {
      jsonData.deposits.forEach(function(d) {
        promises.push(addDepositToDB(d.amount, d.date));
      });
    }
    if (jsonData.withdrawals) {
      jsonData.withdrawals.forEach(function(w) {
        promises.push(addWithdrawalToDB(w.amount, w.date));
      });
    }
    
    // 导入设置
    if (jsonData.settings) {
      Object.keys(jsonData.settings).forEach(function(key) {
        if (jsonData.settings[key] !== null) {
          promises.push(saveSettingToDB(key, jsonData.settings[key]));
        }
      });
    }
    
    Promise.all(promises).then(function() {
      resolve();
    }).catch(reject);
  });
}
