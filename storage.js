// ===== 存储管理（使用 IndexedDB）=====

// 内存中的数据缓存
var trades = [];
var deposits = [];
var withdrawals = [];
var dbInitialized = false;

// 初始化存储
function initStorage() {
  return new Promise(function(resolve, reject) {
    if (dbInitialized) {
      resolve();
      return;
    }
    
    initDatabase().then(function() {
      // 尝试从localStorage迁移数据
      return migrateFromLocalStorage();
    }).then(function() {
      // 从数据库加载所有数据
      return loadAllFromDB();
    }).then(function() {
      dbInitialized = true;
      // 成功使用 IndexedDB 后，同步 localStorage 备份
      localStorage.setItem('trades_v4', JSON.stringify(trades));
      console.log('存储初始化完成，共加载 ' + trades.length + ' 笔记录');
      resolve();
    }).catch(function(err) {
      console.error('存储初始化失败:', err);
      // 如果IndexedDB失败，回退到localStorage
      loadFromLocalStorage();
      resolve();
    });
  });
}

// 从数据库加载所有数据
function loadAllFromDB() {
  return Promise.all([
    getAllTradesFromDB(),
    getAllDepositsFromDB(),
    getAllWithdrawalsFromDB(),
    loadSettingsFromDB()
  ]).then(function(results) {
    trades = results[0] || [];
    deposits = results[1] || [];
    withdrawals = results[2] || [];
  });
}

// 从数据库加载设置
function loadSettingsFromDB() {
  var keys = ['initCapital', 'riskPct', 'maxRisk', 'feeRate'];
  var promises = keys.map(function(key) {
    return getSettingFromDB(key);
  });
  
  return Promise.all(promises).then(function(values) {
    if (values[0]) document.getElementById('initCapital').value = values[0];
    if (values[1]) document.getElementById('riskPct').value = values[1];
    if (values[2]) document.getElementById('maxRisk').value = values[2];
    if (values[3] !== null) document.getElementById('feeRate').value = values[3];
  });
}

// 回退到localStorage
function loadFromLocalStorage() {
  trades = JSON.parse(localStorage.getItem('trades_v4') || '[]');
  var funds = JSON.parse(localStorage.getItem('funds_v1') || '{}');
  deposits = funds.deposits || [];
  withdrawals = funds.withdrawals || [];
  loadAccountParamsFromLocalStorage();
}

// 保存交易记录
function save() {
  if (dbInitialized && db) {
    // 获取当前数据库中的所有记录，删除不在 trades 数组中的记录
    return getAllTradesFromDB().then(function(existingTrades) {
      var tradeIds = trades.map(function(t) { return String(t.id); });
      var deletePromises = [];
      
      // 删除数据库中存在但不在当前 trades 数组中的记录
      existingTrades.forEach(function(existing) {
        if (tradeIds.indexOf(String(existing.id)) === -1) {
          deletePromises.push(deleteTradeFromDB(existing.id));
        }
      });
      
      return Promise.all(deletePromises);
    }).then(function() {
      // 保存所有交易到数据库（使用 put 会覆盖已有记录）
      var promises = trades.map(function(trade) {
        return saveTradeToDB(trade);
      });
      return Promise.all(promises);
    }).then(function() {
      // 同时更新 localStorage 作为备份，保持同步
      localStorage.setItem('trades_v4', JSON.stringify(trades));
      console.log('保存完成，共 ' + trades.length + ' 笔记录');
    }).catch(function(err) {
      console.error('保存到数据库失败:', err);
      throw err;
    });
  } else {
    // 回退到localStorage
    localStorage.setItem('trades_v4', JSON.stringify(trades));
    return Promise.resolve();
  }
}

// 保存单个交易
function saveTrade(trade) {
  if (dbInitialized && db) {
    return saveTradeToDB(trade);
  } else {
    return save();
  }
}

// 删除交易
function deleteTradeStorage(id) {
  if (dbInitialized && db) {
    return deleteTradeFromDB(id);
  } else {
    trades = trades.filter(function(t) { return t.id !== id; });
    return save();
  }
}

// 加载账户参数（从localStorage，用于回退）
function loadAccountParamsFromLocalStorage() {
  var acc = localStorage.getItem('account_v1');
  if (acc) {
    try {
      var params = JSON.parse(acc);
      if (params.initCapital) document.getElementById('initCapital').value = params.initCapital;
      if (params.riskPct) document.getElementById('riskPct').value = params.riskPct;
      if (params.maxRisk) document.getElementById('maxRisk').value = params.maxRisk;
      if (params.feeRate !== undefined) document.getElementById('feeRate').value = params.feeRate;
    } catch (e) {}
  }
}

// 加载账户参数
function loadAccountParams() {
  if (dbInitialized) {
    loadSettingsFromDB();
  } else {
    loadAccountParamsFromLocalStorage();
  }
}

// 保存账户参数
function saveAccountParams() {
  var params = {
    initCapital: parseFloat(document.getElementById('initCapital').value) || 100000,
    riskPct: parseFloat(document.getElementById('riskPct').value) || 2,
    maxRisk: parseFloat(document.getElementById('maxRisk').value) || 5,
    feeRate: parseFloat(document.getElementById('feeRate').value) || 0.1
  };
  
  if (dbInitialized && db) {
    var promises = Object.keys(params).map(function(key) {
      return saveSettingToDB(key, params[key]);
    });
    Promise.all(promises).catch(function(err) {
      console.error('保存设置失败:', err);
    });
  }
  
  // 同时保存到localStorage作为备份
  localStorage.setItem('account_v1', JSON.stringify(params));
}

// 加载资金记录
function loadFunds() {
  if (!dbInitialized) {
    var d = localStorage.getItem('funds_v1');
    if (d) {
      var f = JSON.parse(d);
      deposits = f.deposits || [];
      withdrawals = f.withdrawals || [];
    }
  }
}

// 保存资金记录
function saveFunds() {
  if (dbInitialized && db) {
    // 数据库会自动保存，这里不需要额外操作
  } else {
    localStorage.setItem('funds_v1', JSON.stringify({
      deposits: deposits,
      withdrawals: withdrawals
    }));
  }
}

// 添加入金记录
function addDeposit(amount, date) {
  if (dbInitialized && db) {
    return addDepositToDB(amount, date).then(function(id) {
      deposits.push({ id: id, amount: amount, date: date });
    });
  } else {
    var id = Date.now();
    deposits.push({ id: id, amount: amount, date: date });
    saveFunds();
    return Promise.resolve();
  }
}

// 添加出金记录
function addWithdrawal(amount, date) {
  if (dbInitialized && db) {
    return addWithdrawalToDB(amount, date).then(function(id) {
      withdrawals.push({ id: id, amount: amount, date: date });
    });
  } else {
    var id = Date.now();
    withdrawals.push({ id: id, amount: amount, date: date });
    saveFunds();
    return Promise.resolve();
  }
}

// 获取累计入金
function getTotalDeposit() {
  return deposits.reduce(function(s, v) { return s + v.amount; }, 0);
}

// 获取累计出金
function getTotalWithdraw() {
  return withdrawals.reduce(function(s, v) { return s + v.amount; }, 0);
}

// 获取初始资金
function getInitCapital() {
  return parseFloat(document.getElementById('initCapital').value) || 100000;
}

// 获取风险百分比
function getRiskPct() {
  return parseFloat(document.getElementById('riskPct').value) || 2;
}

// 获取最大风险倍数
function getMaxRisk() {
  return parseFloat(document.getElementById('maxRisk').value) || 5;
}

// 获取手续费率
function getFeeRate() {
  return parseFloat(document.getElementById('feeRate').value) || 0.1;
}

// 获取累计交易盈亏
function getTotalTradePnl() {
  var totalPnl = 0;
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    if (t.status !== 'open' && t.pnl !== '' && !isNaN(parseFloat(t.pnl))) {
      totalPnl += parseFloat(t.pnl);
    }
  }
  return totalPnl;
}

// 获取累计手续费
function getTotalFees() {
  var totalFees = 0;
  var feeRate = getFeeRate() / 100;
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    if (t.status !== 'open') {
      if (t.posSize && !isNaN(parseFloat(t.posSize))) {
        totalFees += parseFloat(t.posSize) * feeRate;
      }
      if (t.exit && !isNaN(parseFloat(t.exit)) && t.actualLots && !isNaN(parseFloat(t.actualLots))) {
        totalFees += parseFloat(t.exit) * parseFloat(t.actualLots) * feeRate;
      }
    }
  }
  return totalFees;
}

// 获取当前总资金
function getCurrentCapital() {
  var init = getInitCapital();
  var td = getTotalDeposit();
  var tw = getTotalWithdraw();
  var tradePnl = getTotalTradePnl();
  return init + td - tw + tradePnl;
}

// 获取已使用风险（基于实际可能止损金额）
function getUsedRisk() {
  var used = 0;
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    // 只计算持仓中的交易
    if (t.status === 'open') {
      var entry = parseFloat(t.entry);
      var stop = parseFloat(t.stop);
      var posSize = parseFloat(t.posSize);
      // 实际可能止损额 = 仓位金额 × |入场价-止损价| / 入场价
      if (entry && stop && posSize && entry > 0) {
        var stopPct = Math.abs(entry - stop) / entry;
        used += posSize * stopPct;
      }
    }
  }
  return used;
}

// 导出数据（从数据库）
function exportData() {
  if (dbInitialized && db) {
    exportDatabase().then(function(data) {
      var el = document.getElementById('syncStatus');
      el.textContent = '已导出 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      el.style.color = '#00e676';
      setTimeout(function() { el.textContent = ''; }, 5000);
    }).catch(function(err) {
      console.error('导出失败:', err);
      exportFromLocalStorage();
    });
  } else {
    exportFromLocalStorage();
  }
}

// 从localStorage导出（回退）
function exportFromLocalStorage() {
  var data = {
    version: 4,
    exportTime: new Date().toISOString(),
    initCapital: parseFloat(document.getElementById('initCapital').value) || 100000,
    riskPct: parseFloat(document.getElementById('riskPct').value) || 2,
    maxRisk: parseFloat(document.getElementById('maxRisk').value) || 5,
    feeRate: parseFloat(document.getElementById('feeRate').value) || 0.1,
    trades: trades
  };
  var json = JSON.stringify(data, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '交易记录备份_' + getToday() + '.json';
  a.click();
  var el = document.getElementById('syncStatus');
  el.textContent = '已导出 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  el.style.color = '#00e676';
  setTimeout(function() { el.textContent = ''; }, 5000);
}

// 导入数据
function importFromFile(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!confirm('导入将覆盖当前所有数据，是否继续？')) return;
      
      if (dbInitialized && db && data.trades) {
        // 清空现有数据
        clearAllTradesFromDB().then(function() {
          // 导入新数据
          return importDatabase(data);
        }).then(function() {
          // 重新加载
          return loadAllFromDB();
        }).then(function() {
          if (data.initCapital) document.getElementById('initCapital').value = data.initCapital;
          if (data.riskPct) document.getElementById('riskPct').value = data.riskPct;
          if (data.maxRisk) document.getElementById('maxRisk').value = data.maxRisk;
          if (data.feeRate !== undefined) document.getElementById('feeRate').value = data.feeRate;
          // 同步更新 localStorage
          localStorage.setItem('trades_v4', JSON.stringify(trades));
          updateAll();
          var el = document.getElementById('syncStatus');
          el.textContent = '导入成功，共 ' + data.trades.length + ' 笔';
          el.style.color = '#00e676';
          setTimeout(function() { el.textContent = ''; }, 5000);
        }).catch(function(err) {
          console.error('导入失败:', err);
          importToLocalStorage(data);
        });
      } else {
        importToLocalStorage(data);
      }
    } catch (err) {
      var el = document.getElementById('syncStatus');
      el.textContent = '解析失败';
      el.style.color = '#ff5252';
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// 导入到localStorage（回退）
function importToLocalStorage(data) {
  if (!data.trades || !Array.isArray(data.trades)) {
    var el = document.getElementById('syncStatus');
    el.textContent = '文件格式无效';
    el.style.color = '#ff5252';
    return;
  }
  trades = data.trades || [];
  if (data.initCapital) document.getElementById('initCapital').value = data.initCapital;
  if (data.riskPct) document.getElementById('riskPct').value = data.riskPct;
  if (data.maxRisk) document.getElementById('maxRisk').value = data.maxRisk;
  if (data.feeRate !== undefined) document.getElementById('feeRate').value = data.feeRate;
  save().then(function() {
    updateAll();
  });
  var el = document.getElementById('syncStatus');
  el.textContent = '导入成功，共 ' + trades.length + ' 笔';
  el.style.color = '#00e676';
  setTimeout(function() { el.textContent = ''; }, 5000);
}
