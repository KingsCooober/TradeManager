// 一次性补齐历史数据脚本
// 数据源：
//   - 融资融券：东方财富 datacenter-web（最近 N 天）
//   - 沪/深成交额：东方财富 push2his K 线接口（row[6] = 成交额，单位：元）
// 涨跌停历史数据无法从公开 API 一次性补齐（新浪只有当日），所以图表从今天开始累积
//
// 运行方式：node server/backfill-history.js

const path = require('path');
const https = require('https');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(DB_PATH);

// 强制 IPv4 + 超时，避免 push2his 走 IPv6 时出现 "socket hang up"
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {}

function httpsGet(url, ref, encoding) {
  return new Promise(function(resolve, reject) {
    const u = new URL(url);
    const req = https.request({
      host: u.host,
      path: u.pathname + u.search,
      method: 'GET',
      family: 4,            // ★ 强制 IPv4
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Referer': ref || 'https://quote.eastmoney.com/',
        'Connection': 'close'
      }
    }, function(res) {
      const chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
    });
    req.on('timeout', function() { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 拉融资融券历史（最近 N 天）
// 注：datacenter-web 在 Node https 模块里偶尔 hang up，用 curl 进程更稳
async function fetchMarginHistory(days) {
  const { execFile } = require('child_process');
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&pageSize=' + days + '&sortColumns=dim_date&sortTypes=-1';
  const buf = await new Promise(function(resolve, reject) {
    execFile('curl', ['-4', '-s', '--connect-timeout', '10', '--max-time', '30', '-A', 'Mozilla/5.0', url],
      function(err, stdout) {
        if (err) return reject(err);
        resolve(Buffer.from(stdout, 'utf8'));
      });
  });
  const json = JSON.parse(buf.toString('utf8'));
  if (!json.result || !Array.isArray(json.result.data)) {
    throw new Error('融资融券历史接口无数据');
  }
  return json.result.data;
}

// 拉指数 K线历史（取每日成交额，单位：元）
// secid: 1.000001 = 上证指数; 0.399001 = 深证成指
async function fetchIndexKLine(secid, count) {
  const { execFile } = require('child_process');
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + secid +
    '&fields1=f1,f2,f3,f4,f5' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
    '&klt=101&fqt=0&end=20991231&lmt=' + count;
  const buf = await new Promise(function(resolve, reject) {
    execFile('curl', ['-4', '-s', '--connect-timeout', '10', '--max-time', '30', '-A', 'Mozilla/5.0', '-H', 'Referer: https://quote.eastmoney.com/', url],
      function(err, stdout) {
        if (err) return reject(err);
        resolve(Buffer.from(stdout, 'utf8'));
      });
  });
  const json = JSON.parse(buf.toString('utf8'));
  if (!json.data || !Array.isArray(json.data.klines)) {
    throw new Error('K线接口无数据: secid=' + secid);
  }
  return json.data.klines.map(function(line) {
    const f = line.split(',');
    // 字段顺序: 日期,开,收,高,低,成交量(手),成交额(元),振幅%,涨跌幅%,换手%,5日均量
    return {
      date: f[0],
      volumeShares: parseFloat(f[5]) || 0,  // 成交量（手）
      amountYuan:   parseFloat(f[6]) || 0    // 成交额（元）
    };
  });
}

function dateFormat(d) {
  return String(d).slice(0, 10);
}

function num(v) { return (typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : 0)); }

async function main() {
  console.log('===== 开始补齐历史数据 =====');
  // 近 2 年（交易日数 ≈ 500，含周末/节假日缓冲）
  const DAYS = 500;

  // 1. 融资融券
  console.log('1) 拉融资融券历史...');
  const marginHistory = await fetchMarginHistory(DAYS);
  console.log('   获取 ' + marginHistory.length + ' 天数据');

  // 2. 沪市/深市指数 K线成交额（东方财富）
  console.log('2) 拉沪市/深市 K线历史（东方财富）...');
  const shKLine = await fetchIndexKLine('1.000001', DAYS + 10);
  const szKLine = await fetchIndexKLine('0.399001', DAYS + 10);
  console.log('   sh000001: ' + shKLine.length + ' 天, sz399001: ' + szKLine.length + ' 天');

  // 3. 按日期合并
  const shByDate = {};
  shKLine.forEach(function(k) { shByDate[k.date] = k.amountYuan; });
  const szByDate = {};
  szKLine.forEach(function(k) { szByDate[k.date] = k.amountYuan; });

  // 4. 写入数据库（先清空除今天外的所有历史记录的成交额字段，避免脏数据残留）
  const today = new Date().toISOString().slice(0, 10);
  await new Promise(function(resolve) {
    db.run('UPDATE market_history SET amount_sh_yi=0, amount_sz_yi=0, amount_total_yi=0 WHERE date < ?', [today], function() { resolve(); });
  });
  console.log('3) 已清空历史记录的成交额字段，准备重写...');

  let inserted = 0, updated = 0;
  for (const r of marginHistory) {
    const date = dateFormat(r.DIM_DATE);
    if (date >= today) continue;  // 跳过今天（实时数据更准）
    const shYuan = shByDate[date] || 0;
    const szYuan = szByDate[date] || 0;
    if (shYuan === 0 && szYuan === 0) continue;  // 没有成交额数据则跳过
    const rzye = num(r.RZYE);
    const rzrqye = num(r.RZRQYE);
    const rzyePrev = num(r.RZYE_PREV);
    const marginChangePct = rzyePrev > 0 ? ((rzye - rzyePrev) / rzyePrev) * 100 : 0;

    await new Promise(function(resolve) {
      db.run(`INSERT INTO market_history
        (date, rzye, rzrqye, margin_change_pct, amount_sh_yi, amount_sz_yi, amount_total_yi, north_net_yi, fetched_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'eastmoney-backfill')
        ON CONFLICT(date) DO UPDATE SET
          rzye=excluded.rzye,
          rzrqye=excluded.rzrqye,
          margin_change_pct=excluded.margin_change_pct,
          amount_sh_yi=excluded.amount_sh_yi,
          amount_sz_yi=excluded.amount_sz_yi,
          amount_total_yi=excluded.amount_total_yi,
          fetched_at=excluded.fetched_at,
          source=excluded.source`,
        [date, rzye, rzrqye, marginChangePct,
         shYuan / 1e8, szYuan / 1e8, (shYuan + szYuan) / 1e8,
         new Date().toISOString()],
        function(err) {
          if (err) console.warn('   失败 ' + date + ':', err.message);
          else if (this.changes > 0) {
            inserted += this.changes;
            console.log('   ' + date + ' 沪=' + (shYuan/1e8).toFixed(1) + '亿, 深=' + (szYuan/1e8).toFixed(1) + '亿, 融资=' + (rzye/1e8).toFixed(0) + '亿');
          }
          resolve();
        });
    });
  }

  console.log('===== 完成，共变更 ' + inserted + ' 条历史记录 =====');
  db.close();
}

main().catch(function(e) {
  console.error('补齐失败:', e.message);
  process.exit(1);
});
