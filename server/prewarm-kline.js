#!/usr/bin/env node
// 批量预热：把名单里（默认市值 >50 亿）的标的近 N 年日 K 线拉进本地库
//
// 背景：
//   本地库（server/kline-store.js）默认是"按需惰性同步"——用户点到哪只才拉哪只。
//   这个脚本用于**一次性把名单里的全部标的灌满**，之后用户随便切标的都是毫秒级命中，
//   不必等第一次访问时的 200~600ms 回源。
//
// 用法：
//   node server/prewarm-kline.js                     # 默认 >50 亿、10 年、4 并发
//   node server/prewarm-kline.js --years 5           # 只要 5 年
//   node server/prewarm-kline.js --concurrency 6     # 提高并发（注意上游限流）
//   node server/prewarm-kline.js --mcap 100          # 只预热 >100 亿
//   node server/prewarm-kline.js --limit 20          # 只跑前 20 只（试跑）
//   node server/prewarm-kline.js --symbols sh600000,sz000001
//   node server/prewarm-kline.js --force             # 忽略"已够新"，全部重拉
//   node server/prewarm-kline.js --retry-failed      # 只重试上次失败的标的
//   node server/prewarm-kline.js --dry               # 只列计划，不实际拉
//
// 断点续跑：
//   脚本自身无状态，但**每次启动都先查库**：本地已有足够根数且 last_date 新鲜的
//   标的直接跳过。所以中断后重新执行同一条命令即可从断点继续，不需要额外的进度文件。
//   失败清单会写到 server/cache/prewarm-failed.json，可用 --retry-failed 单独重试。
//
// 上游限流（实测教训）：
//   东财 push2 全系域名在连续批量请求后会被 WAF 封禁（socket hang up 且长时间不恢复）。
//   腾讯 web.ifzq.gtimg.cn 相对宽容，但仍需节流：默认并发 4、每只之间 120ms 间隔。
//   若发现失败率突然升高，脚本会自动降速（见 ADAPTIVE 部分）。

const fs = require('fs');
const path = require('path');
const klineStore = require('./kline-store');
const market = require('./market-quote');

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const o = {
    mcap: 50, years: 10, concurrency: 4, gapMs: 120, limit: 0,
    force: false, dry: false, retryFailed: false, symbols: null,
    from: null,          // 'YYYY-MM-DD'：从指定日期拉至今（覆盖 years）
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mcap') o.mcap = Number(next());
    else if (a === '--years') o.years = Number(next());
    else if (a === '--concurrency') o.concurrency = Math.max(1, Number(next()));
    else if (a === '--gap') o.gapMs = Math.max(0, Number(next()));
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--force') o.force = true;
    else if (a === '--dry') o.dry = true;
    else if (a === '--retry-failed') o.retryFailed = true;
    else if (a === '--from') o.from = String(next());
    else if (a === '--symbols') o.symbols = String(next()).split(',').map(s => s.trim()).filter(Boolean);
  }
  return o;
}

const ARGS = parseArgs(process.argv);
const FAILED_FILE = path.join(__dirname, 'cache', 'prewarm-failed.json');

// 目标根数：一年约 243 个交易日，留 5% 余量
// --from 模式：按起始日期算目标根数（至今的自然日跨度 × 243/365 + 5% 余量）
function calcTargetBars() {
  if (ARGS.from && /^\d{4}-\d{2}-\d{2}$/.test(ARGS.from)) {
    const days = Math.max(1, Math.round((Date.now() - new Date(ARGS.from + 'T00:00:00Z').getTime()) / 86400000));
    return Math.ceil(days * 243 / 365 * 1.05);
  }
  return Math.ceil(ARGS.years * 243 * 1.05);
}
const TARGET_BARS = calcTargetBars();
// "够新"的天数：覆盖周末 + 节假日
const MAX_STALE_DAYS = 4;
const REQUEST_TIMEOUT_MS = 45000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}
function nowStr() { return new Date().toTimeString().slice(0, 8); }

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + label)), ms)),
  ]);
}

// ---------- 主流程 ----------
async function main() {
  await klineStore.initStore();

  if (ARGS.dry) console.log('[预热] dry-run，只列计划不拉数据');
  console.log(`[预热] 参数: 市值>${ARGS.mcap}亿  ` +
    (ARGS.from ? `从 ${ARGS.from} 至今(目标${TARGET_BARS}根)` : `${ARGS.years}年(目标${TARGET_BARS}根)`) +
    `  并发${ARGS.concurrency}  间隔${ARGS.gapMs}ms${ARGS.force ? '  --force' : ''}`);

  // 1) 决定要跑哪些标的
  let list;
  if (ARGS.symbols) {
    list = ARGS.symbols.map(s => ({ symbol: s, name: '' }));
    console.log(`[预热] 指定标的 ${list.length} 只`);
  } else if (ARGS.retryFailed) {
    if (!fs.existsSync(FAILED_FILE)) {
      console.log('[预热] 没有失败清单，无需重试'); return;
    }
    const prev = JSON.parse(fs.readFileSync(FAILED_FILE, 'utf8'));
    list = (prev.failed || []).map(x => ({ symbol: x.symbol, name: x.name || '' }));
    console.log(`[预热] 从失败清单载入 ${list.length} 只`);
  } else {
    list = await klineStore.getWarmupCandidates(ARGS.mcap, ARGS.limit);
    console.log(`[预热] 名单载入 ${list.length} 只（市值>${ARGS.mcap}亿）`);
  }
  if (!list.length) { console.log('[预热] 名单为空，先跑 refresh-stock-list.js'); return; }

  // 2) 过滤掉已经够新够全的
  // --from 模式：覆盖判断 = first_date ≤ from 且 last_date 在 4 天内
  // （根数判断不适用：新股/长期停牌股根数天然少于目标，但只要覆盖了起点就算够）
  const todo = [];
  const skip = { fresh: 0 };
  const staleCutoff = new Date(Date.now() - 4 * 86400000);
  const staleCutoffStr = staleCutoff.getFullYear() + '-' +
    String(staleCutoff.getMonth() + 1).padStart(2, '0') + '-' +
    String(staleCutoff.getDate()).padStart(2, '0');
  for (const it of list) {
    if (ARGS.force) { todo.push(it); continue; }
    const meta = await klineStore.getMeta(it.symbol);
    if (ARGS.from && /^\d{4}-\d{2}-\d{2}$/.test(ARGS.from)) {
      if (meta && meta.first_date && meta.first_date <= ARGS.from &&
          meta.last_date && meta.last_date >= staleCutoffStr) { skip.fresh++; continue; }
    } else if (klineStore.isCoverageEnough(meta, TARGET_BARS, MAX_STALE_DAYS)) { skip.fresh++; continue; }
    it._meta = meta;
    todo.push(it);
  }
  console.log(`[预热] 需拉取 ${todo.length} 只，跳过 ${skip.fresh} 只（本地已足够新）`);

  if (!todo.length) { console.log('[预热] 全部已就绪，无需拉取'); return; }
  if (ARGS.dry) {
    todo.slice(0, 10).forEach((x, i) => console.log(`   ${i + 1}. ${x.symbol} ${x.name || ''}`));
    if (todo.length > 10) console.log(`   ... 还有 ${todo.length - 10} 只`);
    return;
  }

  // 3) 并发拉取（worker pool）
  const t0 = Date.now();
  let done = 0, okCount = 0, failCount = 0, barsTotal = 0;
  const failed = [];
  let gap = ARGS.gapMs;          // 自适应节流：失败率升高就加大间隔
  const recent = [];             // 最近 20 次的结果，用于判断失败率

  async function worker(queue) {
    while (queue.length) {
      const it = queue.shift();
      if (!it) break;
      const t = Date.now();
      try {
        // noCache: 避免把上千只标的的完整 K 线驻留进程内存
        // ★ force: --force 时必须一并传下去。noCache 只跳过内存缓存，
        //   本地 SQLite 库依然会命中并直接返回旧数据（实测：只传 noCache 时
        //   全量重拉 3094 只仅耗时数秒、一条记录都没更新）。
        const data = await withTimeout(
          market.getKLineSnapshotForSymbol(it.symbol, TARGET_BARS,
            Object.assign(
              { noCache: true, force: !!ARGS.force },
              (ARGS.from && /^\d{4}-\d{2}-\d{2}$/.test(ARGS.from)) ? { startDate: ARGS.from } : {}
            )),
          REQUEST_TIMEOUT_MS, it.symbol
        );
        const bars = (data && data.dates && data.dates.length) || 0;
        if (bars === 0) throw new Error('上游返回 0 根');
        barsTotal += bars;
        okCount++;
        recent.push(true);
        done++;
        const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
        console.log(`[${done}/${todo.length}] ✓ ${it.symbol} ${(it.name || data.name || '').padEnd(8)} ` +
          `${String(bars).padStart(5)}根 ${String(Date.now() - t).padStart(5)}ms  ` +
          `(${rate}只/s 剩~${fmtDur((todo.length - done) / Math.max(0.1, rate) * 1000)})`);
      } catch (e) {
        failCount++;
        recent.push(false);
        done++;
        failed.push({ symbol: it.symbol, name: it.name, error: e.message });
        console.log(`[${done}/${todo.length}] ✗ ${it.symbol} ${it.name || ''}  ${e.message}`);
      }
      if (recent.length > 20) recent.shift();

      // 自适应：最近 20 次失败 >= 4 次 → 间隔翻倍（最多 1500ms）；全成功则逐步回收
      if (recent.length >= 10) {
        const fails = recent.filter(x => !x).length;
        if (fails >= 4 && gap < 1500) { gap = Math.min(1500, gap * 2); console.log(`[预热] 失败偏多，间隔升至 ${gap}ms`); }
        else if (fails === 0 && gap > ARGS.gapMs) { gap = Math.max(ARGS.gapMs, Math.floor(gap / 2)); }
      }
      if (gap > 0) await sleep(gap);
    }
  }

  const queue = todo.slice();
  await Promise.all(Array.from({ length: ARGS.concurrency }, () => worker(queue)));

  // 4) 汇总 + 失败清单
  const elapsed = Date.now() - t0;
  const stats = await klineStore.getStats();
  console.log('\n================ 预热完成 ================');
  console.log(`  本次耗时     ${fmtDur(elapsed)}`);
  console.log(`  成功 / 失败  ${okCount} / ${failCount}`);
  console.log(`  本次新增根数 ${barsTotal}`);
  console.log(`  库内合计     ${stats.symbols} 只 / ${stats.bars} 行 / 名单 ${stats.metas} 条`);

  if (failed.length) {
    fs.mkdirSync(path.dirname(FAILED_FILE), { recursive: true });
    fs.writeFileSync(FAILED_FILE, JSON.stringify({
      at: new Date().toISOString(), args: ARGS, failed,
    }, null, 2));
    console.log(`\n  失败 ${failed.length} 只已写入 ${FAILED_FILE}`);
    console.log('  可用 --retry-failed 单独重试');
    // 打印失败原因归类，便于判断是限流还是代码问题
    const byErr = {};
    failed.forEach(f => { byErr[f.error] = (byErr[f.error] || 0) + 1; });
    Object.entries(byErr).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .forEach(([k, v]) => console.log(`    ${v}× ${k}`));
  } else if (fs.existsSync(FAILED_FILE)) {
    fs.unlinkSync(FAILED_FILE);   // 全成功则清掉历史失败清单
  }

  // 5) 抽样校验：随机挑 3 只核对根数与日期跨度
  if (okCount > 0) {
    console.log('\n---- 抽样校验 ----');
    const sample = todo.slice(0, 3);
    for (const s of sample) {
      const meta = await klineStore.getMeta(s.symbol);
      if (!meta) continue;
      console.log(`  ${meta.symbol} ${(meta.name || '').padEnd(8)} ${meta.bar_count} 根  ` +
        `${meta.first_date} ~ ${meta.last_date}`);
    }
  }
  return { okCount, failCount, barsTotal };
}

main().then(() => process.exit(0)).catch(e => {
  console.error('[预热] 致命错误: ' + (e && e.stack || e));
  process.exit(1);
});
