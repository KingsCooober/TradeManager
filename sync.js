/**
 * 数据同步模块 - 连接后端服务器实现多设备同步
 * 
 * 字段映射说明：
 * 前端字段 -> 后端字段
 * date -> open_date
 * exitDate -> close_date  
 * symbol -> symbol
 * buyType -> type
 * dir -> direction
 * entry -> entry_price
 * stop -> stop_loss
 * target -> take_profit
 * posSize -> position_size
 * actualLots -> actual_lots
 * riskAmount -> r_amount
 * exit -> close_price
 * pnl -> pnl_amount
 * pnlR -> pnl_r
 * status -> status
 * note -> notes
 */

const SYNC_CONFIG = {
  // 服务器地址 - 部署后修改为实际地址
  serverUrl: localStorage.getItem('sync_server_url') || 'http://localhost:3000',
  // 同步间隔（毫秒）
  syncInterval: 30000,
  // 自动同步开关（默认开启）
  autoSync: localStorage.getItem('sync_auto') !== 'false'
};

let currentUser = null;
let syncTimer = null;

// 已删除记录的ID列表（用于同步删除操作）
let pendingDeletedTrades = JSON.parse(localStorage.getItem('pending_deleted_trades') || '[]');
let pendingDeletedDeposits = JSON.parse(localStorage.getItem('pending_deleted_deposits') || '[]');
let pendingDeletedWithdrawals = JSON.parse(localStorage.getItem('pending_deleted_withdrawals') || '[]');

// ===== 用户认证 =====

function setServerUrl(url) {
  SYNC_CONFIG.serverUrl = url.replace(/\/$/, '');
  localStorage.setItem('sync_server_url', SYNC_CONFIG.serverUrl);
}

function getServerUrl() {
  return SYNC_CONFIG.serverUrl;
}

async function register(username, password) {
  try {
    console.log('[sync] 尝试注册:', SYNC_CONFIG.serverUrl + '/api/register', '用户:', username);
    var regUrl = SYNC_CONFIG.serverUrl + '/api/register';
    const res = await fetch(regUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    // 先用 text() 安全读取，避免 json() 解析非 JSON 内容报错
    var rawText = '';
    try {
      rawText = await res.text();
    } catch(e) {
      throw new Error('无法读取服务器响应: ' + e.message);
    }

    // 安全解析 JSON
    var data;
    try {
      data = JSON.parse(rawText);
    } catch(parseErr) {
      throw new Error('服务器返回异常（HTTP ' + res.status + '）: ' + rawText.substring(0, 150));
    }

    if (!res.ok) throw new Error(data.error || '注册失败（' + res.status + '）');
    currentUser = { id: data.userId, username: data.username };
    localStorage.setItem('sync_user', JSON.stringify(currentUser));
    return data;
  } catch (err) {
    console.error('注册失败:', err);
    throw err;
  }
}

async function login(username, password) {
  try {
    var loginUrl = `${SYNC_CONFIG.serverUrl}/api/login`;
    console.log('[sync] 尝试登录:', loginUrl, '用户:', username);
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    console.log('[sync] 登录响应状态:', res.status, 'Content-Type:', res.headers.get('content-type'));

    // 先用 text() 安全读取，避免 json() 解析非 JSON 内容报错
    var rawText = '';
    try {
      rawText = await res.text();
    } catch(e) {
      throw new Error('无法读取服务器响应: ' + e.message);
    }
    console.log('[sync] 原始响应内容(前200字):', rawText.substring(0, 200));

    // 检查是否为 JSON
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      throw new Error('服务器返回异常（HTTP ' + res.status + '）：\n' +
        rawText.substring(0, 150) +
        '\n\n请检查：\n1. 服务器地址 "' + SYNC_CONFIG.serverUrl + '" 是否正确？\n2. 服务器是否已启动？（运行 node server/server.js）');
    }

    // 安全解析 JSON
    var data;
    try {
      data = JSON.parse(rawText);
    } catch(parseErr) {
      throw new Error('服务器返回的JSON格式有误: ' + rawText.substring(0, 100));
    }
    if (!res.ok) throw new Error(data.error || '登录失败（' + res.status + '）');
    currentUser = { id: data.userId, username: data.username };
    localStorage.setItem('sync_user', JSON.stringify(currentUser));
    return data;
  } catch (err) {
    console.error('登录失败:', err);
    throw err;
  }
}

function logout() {
  currentUser = null;
  localStorage.removeItem('sync_user');
  stopAutoSync();
}

function getCurrentUser() {
  if (!currentUser) {
    const saved = localStorage.getItem('sync_user');
    if (saved) currentUser = JSON.parse(saved);
  }
  return currentUser;
}

function isLoggedIn() {
  return !!getCurrentUser();
}

// ===== 字段转换函数 =====

// 前端交易记录 -> 后端格式
function tradeToServerFormat(trade) {
  return {
    id: String(trade.id),
    openDate: trade.date || '',
    closeDate: trade.exitDate || '',
    symbol: trade.symbol || '',
    type: trade.buyType || '',
    direction: trade.dir || '多',
    entryPrice: parseFloat(trade.entry) || 0,
    stopLoss: parseFloat(trade.stop) || 0,
    takeProfit: parseFloat(trade.target) || 0,
    stopDistancePct: 0, // 计算字段
    tpDistancePct: 0,   // 计算字段
    positionSize: parseFloat(trade.posSize) || 0,
    actualLots: parseFloat(trade.actualLots) || 0,
    actualAmount: parseFloat(trade.posSize) || 0,
    rAmount: parseFloat(trade.riskAmount) || 0,
    closePrice: parseFloat(trade.exit) || 0,
    pnlAmount: parseFloat(trade.pnl) || 0,
    pnlR: parseFloat(trade.pnlR) || 0,
    holdDays: 0,
    status: trade.status || 'open',
    notes: trade.note || ''
  };
}

// 后端格式 -> 前端交易记录
function tradeFromServerFormat(t) {
  return {
    id: t.id,
    date: t.open_date || '',
    exitDate: t.close_date || '',
    symbol: t.symbol || '',
    buyType: t.type || '',
    dir: t.direction || '多',
    entry: t.entry_price || '',
    stop: t.stop_loss || '',
    target: t.take_profit || '',
    posSize: t.position_size || '',
    actualLots: t.actual_lots || null,
    riskAmount: t.r_amount || '',
    exit: t.close_price || '',
    pnl: t.pnl_amount || '',
    pnlR: t.pnl_r || '',
    status: t.status || 'open',
    note: t.notes || '',
    followedPlan: '是',
    openTime: new Date().toISOString()
  };
}

// ===== 数据同步 =====

async function syncToServer() {
  const user = getCurrentUser();
  if (!user) {
    console.log('未登录，跳过同步');
    return;
  }
  
  try {
    // 转换交易记录格式
    const tradesForServer = (trades || []).map(tradeToServerFormat);
    
    // 转换入金记录
    const depositsForServer = (deposits || []).map(d => ({
      id: d.id ? String(d.id) : undefined,
      amount: parseFloat(d.amount) || 0,
      date: d.date || ''
    }));
    
    // 转换出金记录
    const withdrawalsForServer = (withdrawals || []).map(w => ({
      id: w.id ? String(w.id) : undefined,
      amount: parseFloat(w.amount) || 0,
      date: w.date || ''
    }));
    
    // 获取设置
    const settings = {
      initCapital: parseFloat(document.getElementById('initCapital')?.value) || 100000,
      riskPct: parseFloat(document.getElementById('riskPct')?.value) || 1,
      maxRisk: parseFloat(document.getElementById('maxRisk')?.value) || 1000,
      feeRate: parseFloat(document.getElementById('feeRate')?.value) || 0.03
    };
    
    const localData = {
      trades: tradesForServer,
      deposits: depositsForServer,
      withdrawals: withdrawalsForServer,
      settings: settings,
      // 发送待删除的记录ID
      deletedTradeIds: pendingDeletedTrades,
      deletedDepositIds: pendingDeletedDeposits,
      deletedWithdrawalIds: pendingDeletedWithdrawals
    };
    
    console.log('上传到服务器的数据:', localData);
    
    // 上传到服务器
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/sync/${user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(localData)
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    
    // 同步成功后清空待删除列表
    pendingDeletedTrades = [];
    pendingDeletedDeposits = [];
    pendingDeletedWithdrawals = [];
    localStorage.setItem('pending_deleted_trades', '[]');
    localStorage.setItem('pending_deleted_deposits', '[]');
    localStorage.setItem('pending_deleted_withdrawals', '[]');
    
    console.log('同步到服务器成功');
    showSyncStatus('已同步到服务器', 'success');
    return true;
  } catch (err) {
    console.error('同步到服务器失败:', err);
    showSyncStatus('同步失败: ' + err.message, 'error');
    return false;
  }
}

async function syncFromServer() {
  const user = getCurrentUser();
  if (!user) {
    console.log('未登录，跳过同步');
    return;
  }
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/sync/${user.id}`);
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error);
    }
    
    const serverData = await res.json();
    console.log('从服务器获取的数据:', serverData);
    
    // 转换并更新交易记录
    if (serverData.trades) {
      trades = serverData.trades.map(tradeFromServerFormat);
      console.log('转换后的交易记录:', trades);
      await save();
    }
    
    // 转换并更新入金记录
    if (serverData.deposits) {
      deposits = serverData.deposits.map(d => ({
        id: d.id,
        amount: d.amount,
        date: d.date
      }));
      saveFunds();
    }
    
    // 转换并更新出金记录
    if (serverData.withdrawals) {
      withdrawals = serverData.withdrawals.map(w => ({
        id: w.id,
        amount: w.amount,
        date: w.date
      }));
      saveFunds();
    }
    
    // 更新设置
    if (serverData.settings) {
      document.getElementById('initCapital').value = serverData.settings.init_capital;
      document.getElementById('riskPct').value = serverData.settings.risk_pct;
      document.getElementById('maxRisk').value = serverData.settings.max_risk;
      document.getElementById('feeRate').value = serverData.settings.fee_rate;
      saveAccountParams();
    }
    
    // 刷新界面
    updateAll();
    
    console.log('从服务器同步成功');
    showSyncStatus('已从服务器同步 ' + (serverData.trades?.length || 0) + ' 条交易', 'success');
    return true;
  } catch (err) {
    console.error('从服务器同步失败:', err);
    showSyncStatus('同步失败: ' + err.message, 'error');
    return false;
  }
}

async function fullSync() {
  showSyncStatus('正在同步...', 'info');
  
  // 先上传到服务器
  const uploadOk = await syncToServer();
  if (!uploadOk) return false;
  
  // 再从服务器下载
  const downloadOk = await syncFromServer();
  return downloadOk;
}

// ===== 自动同步 =====

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  SYNC_CONFIG.autoSync = true;
  localStorage.setItem('sync_auto', 'true');
  
  syncTimer = setInterval(() => {
    if (getCurrentUser()) {
      syncToServer();
    }
  }, SYNC_CONFIG.syncInterval);
  
  console.log('自动同步已启动');
}

function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  SYNC_CONFIG.autoSync = false;
  localStorage.setItem('sync_auto', 'false');
  console.log('自动同步已停止');
}

function toggleAutoSync() {
  if (SYNC_CONFIG.autoSync) {
    stopAutoSync();
  } else {
    startAutoSync();
  }
  return SYNC_CONFIG.autoSync;
}

// ===== 单条数据操作 =====

async function addTradeToServer(trade) {
  const user = getCurrentUser();
  if (!user) return;
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/trades/${user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tradeToServerFormat(trade))
    });
    return res.ok;
  } catch (err) {
    console.error('保存交易到服务器失败:', err);
    return false;
  }
}

async function deleteTradeFromServer(tradeId) {
  const user = getCurrentUser();
  if (!user) return false;
  
  // 添加到待删除列表（用于下次同步时确保删除）
  const idStr = String(tradeId);
  if (pendingDeletedTrades.indexOf(idStr) === -1) {
    pendingDeletedTrades.push(idStr);
    localStorage.setItem('pending_deleted_trades', JSON.stringify(pendingDeletedTrades));
  }
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/trades/${user.id}/${tradeId}`, {
      method: 'DELETE'
    });
    
    if (res.ok) {
      // 删除成功后从待删除列表移除
      pendingDeletedTrades = pendingDeletedTrades.filter(id => id !== idStr);
      localStorage.setItem('pending_deleted_trades', JSON.stringify(pendingDeletedTrades));
    }
    
    return res.ok;
  } catch (err) {
    console.error('删除服务器交易失败:', err);
    // 即使API调用失败，ID仍在待删除列表中，下次同步时会处理
    return false;
  }
}

// 清空服务器上的所有数据
async function clearServerData() {
  const user = getCurrentUser();
  if (!user) {
    console.log('未登录，跳过清空服务器');
    return;
  }

  try {
    // 调用服务器 API 清空用户的所有交易数据
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/clear/${user.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.ok) {
      console.log('服务器数据已清空');
      showSyncStatus('已清空服务器数据', 'success');
      // 清除同步状态
      lastSyncTime = null;
      localStorage.removeItem('last_sync_time');
    } else {
      const err = await res.json();
      throw new Error(err.error || '清空失败');
    }

    return true;
  } catch (err) {
    console.error('清空服务器数据失败:', err);
    showSyncStatus('清空服务器失败: ' + err.message, 'error');
    return false;
  }
}

async function addDepositToServer(amount, date) {
  const user = getCurrentUser();
  if (!user) return;
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/deposits/${user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, date })
    });
    return res.ok;
  } catch (err) {
    console.error('保存入金到服务器失败:', err);
    return false;
  }
}

async function addWithdrawalToServer(amount, date) {
  const user = getCurrentUser();
  if (!user) return;
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/withdrawals/${user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, date })
    });
    return res.ok;
  } catch (err) {
    console.error('保存出金到服务器失败:', err);
    return false;
  }
}

async function saveSettingsToServer() {
  const user = getCurrentUser();
  if (!user) return;
  
  const settings = {
    initCapital: parseFloat(document.getElementById('initCapital')?.value) || 100000,
    riskPct: parseFloat(document.getElementById('riskPct')?.value) || 1,
    maxRisk: parseFloat(document.getElementById('maxRisk')?.value) || 1000,
    feeRate: parseFloat(document.getElementById('feeRate')?.value) || 0.03
  };
  
  try {
    const res = await fetch(`${SYNC_CONFIG.serverUrl}/api/settings/${user.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    return res.ok;
  } catch (err) {
    console.error('保存设置到服务器失败:', err);
    return false;
  }
}

// ===== UI 辅助 =====

function showSyncStatus(message, type) {
  const statusEl = document.getElementById('syncStatus');
  if (!statusEl) return;
  
  statusEl.textContent = message;
  statusEl.className = 'sync-status ' + type;
  
  setTimeout(() => {
    statusEl.textContent = '';
    statusEl.className = 'sync-status';
  }, 3000);
}

function updateSyncUI() {
  const user = getCurrentUser();
  const loginSection = document.getElementById('syncLoginSection');
  const userSection = document.getElementById('syncUserSection');
  const serverUrlInput = document.getElementById('syncServerUrl');
  
  if (serverUrlInput) serverUrlInput.value = getServerUrl();
  
  if (user) {
    if (loginSection) loginSection.style.display = 'none';
    if (userSection) {
      userSection.style.display = 'block';
      document.getElementById('syncUsername').textContent = user.username;
    }
  } else {
    if (loginSection) loginSection.style.display = 'block';
    if (userSection) userSection.style.display = 'none';
  }
}

// ===== 初始化 =====

function initSync() {
  // 恢复登录状态
  getCurrentUser();
  
  // 如果设置了自动同步，启动它
  if (SYNC_CONFIG.autoSync && currentUser) {
    startAutoSync();
  }
  
  console.log('同步模块已初始化');
}

// 导出函数
window.syncModule = {
  setServerUrl,
  getServerUrl,
  register,
  login,
  logout,
  isLoggedIn,
  getCurrentUser,
  syncToServer,
  syncFromServer,
  fullSync,
  startAutoSync,
  stopAutoSync,
  toggleAutoSync,
  clearServerData,
  addTradeToServer,
  deleteTradeFromServer,
  addDepositToServer,
  addWithdrawalToServer,
  saveSettingsToServer,
  showSyncStatus,
  updateSyncUI,
  initSync
};