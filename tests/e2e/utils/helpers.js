// tests/e2e/utils/helpers.js
// 测试通用辅助函数

/**
 * 生成随机字符串
 * @param {number} length 长度
 * @returns {string}
 */
function randomString(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * 生成随机数字（包含小数）
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @param {number} decimals 小数位
 * @returns {number}
 */
function randomNumber(min = 1, max = 100, decimals = 2) {
  const n = Math.random() * (max - min) + min;
  const p = Math.pow(10, decimals);
  return Math.round(n * p) / p;
}

/**
 * 生成随机整数
 */
function randomInt(min = 1, max = 1000) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 生成今天的 ISO 日期字符串 YYYY-MM-DD
 */
function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * 生成 N 天前 / 后的日期字符串
 */
function getDateString(daysOffset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return d.toISOString().split('T')[0];
}

/**
 * 生成唯一的用户名（带时间戳）
 */
function uniqueUsername(prefix = 'user') {
  return `${prefix}_${Date.now()}_${randomString(4)}`;
}

/**
 * 等待 API 响应
 */
async function waitForApi(page, urlPattern, method = 'GET', timeout = 10000) {
  return page.waitForResponse(
    (response) => {
      const matchesUrl = typeof urlPattern === 'string'
        ? response.url().includes(urlPattern)
        : urlPattern.test(response.url());
      const matchesMethod = !method || response.request().method() === method;
      return matchesUrl && matchesMethod;
    },
    { timeout }
  );
}

/**
 * 拦截并 mock 服务器响应
 */
async function mockServerResponse(page, urlPattern, responseBody, options = {}) {
  await page.route(urlPattern, async (route) => {
    await route.fulfill({
      status: options.status || 200,
      contentType: options.contentType || 'application/json',
      body: typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
    });
  });
}

/**
 * 清理本地存储（localStorage）
 */
async function clearLocalStorage(page) {
  await page.evaluate(() => {
    try {
      localStorage.clear();
    } catch (e) {
      console.warn('clear localStorage error', e);
    }
  });
}

/**
 * 清理 IndexedDB
 */
async function clearIndexedDB(page) {
  await page.evaluate(async () => {
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB.databases) return;
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((dbInfo) =>
          new Promise((resolve) => {
            if (!dbInfo.name) return resolve();
            const req = indexedDB.deleteDatabase(dbInfo.name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          })
        )
      );
    } catch (e) {
      console.warn('clear indexedDB error', e);
    }
  });
}

/**
 * 清理所有存储（localStorage + IndexedDB）
 */
async function clearAllStorage(page) {
  await clearLocalStorage(page);
  await clearIndexedDB(page);
}

/**
 * 直接将交易数据写入 IndexedDB（绕过 localStorage 迁移机制）
 * 适用于设置测试数据后强制重新加载的场景
 * @param {import('@playwright/test').Page} page
 * @param {Array<object>} trades
 */
async function seedTradesToIndexedDB(page, trades) {
  await page.evaluate((trades) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('PositionManagerDB', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('trades')) {
          const ts = db.createObjectStore('trades', { keyPath: 'id' });
          ts.createIndex('date', 'date', { unique: false });
        }
      };
      req.onsuccess = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('trades')) {
          db.close();
          return reject(new Error('trades store not available'));
        }
        try {
          const tx = db.transaction(['trades'], 'readwrite');
          const store = tx.objectStore('trades');
          store.clear();
          for (const t of trades) {
            store.put(t);
          }
          tx.oncomplete = () => {
            try {
              localStorage.setItem('trades_v4', JSON.stringify(trades));
            } catch (_) {}
            db.close();
            resolve();
          };
          tx.onerror = (e) => {
            db.close();
            reject(new Error(e?.message || 'tx error'));
          };
        } catch (e) {
          db.close();
          reject(e);
        }
      };
      req.onerror = (e) => reject(new Error(e?.target?.error?.message || 'open error'));
    });
  }, trades);
}

/**
 * 直接将交易计划写入 IndexedDB（v2 schema）
 * @param {import('@playwright/test').Page} page
 * @param {Array<object>} plans
 */
async function seedPlansToIndexedDB(page, plans) {
  await page.evaluate((plans) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('PositionManagerDB', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('plans')) {
          const ps = db.createObjectStore('plans', { keyPath: 'id' });
          ps.createIndex('date', 'date', { unique: false });
          ps.createIndex('status', 'status', { unique: false });
          ps.createIndex('userId', 'userId', { unique: false });
          ps.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains('planTemplates')) {
          db.createObjectStore('planTemplates', { keyPath: 'id' });
        }
      };
      req.onsuccess = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('plans')) {
          db.close();
          return reject(new Error('plans store not available'));
        }
        try {
          const tx = db.transaction(['plans'], 'readwrite');
          const store = tx.objectStore('plans');
          store.clear();
          for (const p of plans) {
            store.put(p);
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = (e) => {
            db.close();
            reject(new Error(e?.message || 'tx error'));
          };
        } catch (e) {
          db.close();
          reject(e);
        }
      };
      req.onerror = (e) => reject(new Error(e?.target?.error?.message || 'open error'));
    });
  }, plans);
}

/**
 * 直接将计划模板写入 IndexedDB
 * @param {import('@playwright/test').Page} page
 * @param {Array<object>} templates
 */
async function seedTemplatesToIndexedDB(page, templates) {
  await page.evaluate((templates) => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('PositionManagerDB', 2);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('planTemplates')) {
          db.createObjectStore('planTemplates', { keyPath: 'id' });
        }
      };
      req.onsuccess = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('planTemplates')) {
          db.close();
          return reject(new Error('planTemplates store not available'));
        }
        try {
          const tx = db.transaction(['planTemplates'], 'readwrite');
          const store = tx.objectStore('planTemplates');
          store.clear();
          for (const t of templates) {
            store.put(t);
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = (e) => {
            db.close();
            reject(new Error(e?.message || 'tx error'));
          };
        } catch (e) {
          db.close();
          reject(e);
        }
      };
      req.onerror = (e) => reject(new Error(e?.target?.error?.message || 'open error'));
    });
  }, templates);
}

/**
 * 抑制浏览器对话框（alert/confirm/prompt），返回其内容
 */
function setupDialogHandler(page, action = 'accept', promptText = '') {
  page.on('dialog', async (dialog) => {
    if (action === 'accept') {
      await dialog.accept(promptText);
    } else {
      await dialog.dismiss();
    }
  });
}

/**
 * 等待元素可见
 */
async function waitForVisible(locator, timeout = 5000) {
  await locator.waitFor({ state: 'visible', timeout });
}

/**
 * 安全执行：捕获并返回错误
 */
async function safe(fn) {
  try {
    return await fn();
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * 暂停等待（仅用于调试）
 */
async function pause(ms = 500) {
  await new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  randomString,
  randomNumber,
  randomInt,
  getTodayString,
  getDateString,
  uniqueUsername,
  waitForApi,
  mockServerResponse,
  clearLocalStorage,
  clearIndexedDB,
  clearAllStorage,
  seedTradesToIndexedDB,
  seedPlansToIndexedDB,
  seedTemplatesToIndexedDB,
  setupDialogHandler,
  waitForVisible,
  safe,
  pause,
};
