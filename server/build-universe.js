#!/usr/bin/env node
// 建「回测标的池」：按**总市值降序**取前 N 只沪深 A 股，写入 bt_universe
//
// 为什么单独建池，而不是每次按 stock_meta.mcap_yi 现排？
//   1) 市值天天变，名单跟着抖 —— 今天灌满 3500 只的数据，明天可能有一批掉出
//      "前 3500"，那份数据就白占了几个 GB，而新进名单的票又没数据；
//   2) 预热脚本要能报进度、断点续跑，名单必须是一个**可枚举的固定集合**；
//   3) 随机标的按钮抽的是"这个池子里的票"，语义上就该是快照而非实时排名。
//   所以池子只在显式重建时整体替换（saveUniverse 是单事务 DELETE + INSERT）。
//
// 用法：
//   node server/build-universe.js                  # 默认前 3500 只
//   node server/build-universe.js --top 1000       # 只取前 1000
//   node server/build-universe.js --min-mcap 30    # 额外要求市值 > 30 亿
//   node server/build-universe.js --dry            # 只看结果不写库
//
// 数据源：东财 clist（代码 + 市值一次拿全）→ 失败降级 新浪枚举 + 腾讯补市值。
//   两个源都复用 refresh-stock-list.js 里已经踩过坑的实现，不再另写一份。

const klineStore = require('./kline-store');
const { fetchFromEastmoney, fetchSymbolsFromSina, fillMcapFromTencent } = require('./refresh-stock-list');

function parseArgs(argv) {
  const o = { top: 3500, minMcap: 0, dry: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') o.top = Math.max(1, Number(argv[++i]) || 3500);
    else if (a === '--min-mcap') o.minMcap = Number(argv[++i]) || 0;
    else if (a === '--dry') o.dry = true;
  }
  return o;
}

// 与 refresh-stock-list 的 isAShare 同口径：只要沪深主板/创业板/科创板
//   （北交所 bj 不在本项目回测范围；B 股、基金、债券由东财的 fs 参数排除）
function isAShare(symbol) {
  const s = String(symbol || '').toLowerCase();
  return /^sh(60|68)\d{4}$/.test(s) || /^sz(00|30)\d{4}$/.test(s);
}

async function main() {
  const ARGS = parseArgs(process.argv);
  console.log('[池] 目标：按总市值降序取前 ' + ARGS.top + ' 只沪深 A 股' +
    (ARGS.minMcap ? '，且市值 > ' + ARGS.minMcap + ' 亿' : '') + (ARGS.dry ? '（dry-run）' : ''));

  await klineStore.initStore();

  // ---------- 1) 拿全市场快照 ----------
  let all = null;
  const t0 = Date.now();
  try {
    all = await fetchFromEastmoney();
    console.log('[池] 数据源 东财 clist：' + all.length + ' 只，' +
      ((Date.now() - t0) / 1000).toFixed(1) + 's');
  } catch (e) {
    console.warn('[池] 东财不可用（' + e.message + '），改用 新浪+腾讯');
  }
  if (!all || !all.length) {
    all = await fetchSymbolsFromSina();
    console.log('[池] 新浪枚举：' + all.length + ' 只');
    const filled = await fillMcapFromTencent(all);
    console.log('[池] 腾讯补市值：' + filled + '/' + all.length);
    all = all.filter(x => x.mcap_yi > 0);
    if (!all.length) throw new Error('市值全部补齐失败（腾讯接口异常）');
  }

  // ---------- 2) 过滤 + 排序 + 截断 ----------
  const before = all.length;
  const pool = all
    .filter(x => isAShare(x.symbol) && (Number(x.mcap_yi) || 0) > ARGS.minMcap)
    .sort((a, b) => (b.mcap_yi || 0) - (a.mcap_yi || 0));
  console.log('[池] 过滤后 ' + pool.length + ' 只（原始 ' + before + ' 只）');

  if (pool.length < ARGS.top) {
    console.warn('[池] ⚠️ 候选只有 ' + pool.length + ' 只，不足目标的 ' + ARGS.top +
      ' 只 —— 全市场 A 股总数就在这个量级，按实际数量建池');
  }
  const picked = pool.slice(0, ARGS.top).map((x, i) => ({
    symbol: x.symbol, rank: i + 1, name: x.name || '', mcap_yi: Number(x.mcap_yi) || 0,
  }));

  if (!picked.length) throw new Error('名单为空，拒绝写库');

  // ---------- 3) 输出概览（判断名单是否合理的关键信息） ----------
  const fmt = (x) => (x.name || x.symbol) + '(' + x.symbol + ', ' + x.mcap_yi.toFixed(0) + '亿)';
  console.log('\n---- 名单概览 ----');
  console.log('  第 1    名: ' + fmt(picked[0]));
  console.log('  第 2    名: ' + fmt(picked[1] || picked[0]));
  console.log('  第 3    名: ' + fmt(picked[2] || picked[0]));
  const tail = picked.slice(-3);
  tail.forEach((x, i) => {
    console.log('  第 ' + String(picked.length - tail.length + i + 1).padStart(4) + ' 名: ' + fmt(x));
  });
  const mcapVals = picked.map(x => x.mcap_yi).sort((a, b) => a - b);
  const med = mcapVals[Math.floor(mcapVals.length / 2)] || 0;
  console.log('  市值中位数: ' + med.toFixed(1) + ' 亿   最小: ' + mcapVals[0].toFixed(1) + ' 亿');

  if (ARGS.dry) { console.log('\n[池] dry-run，未写库'); return; }

  // ---------- 4) 写库 ----------
  const n = await klineStore.saveUniverse(picked);
  console.log('\n[池] 已写入 bt_universe：' + n + ' 只');

  // 顺带把 name / mcap_yi 同步进 stock_meta：
  //   随机按钮、预热脚本都从 stock_meta 读 name 与 bar_count，
  //   池子建完但这些字段还是空的话，前端会显示成裸代码。
  let synced = 0;
  for (let i = 0; i < picked.length; i += 200) {
    synced += await klineStore.upsertMetaBatch(picked.slice(i, i + 200));
  }
  console.log('[池] 已同步 stock_meta 名称/市值：' + synced + ' 条');

  const stats = await klineStore.getUniverseStats();
  console.log('[池] 池子现状: ' + stats.total + ' 只 / 已入库 ' + stats.loaded +
    ' 只 / 2016 起完整 ' + stats.full + ' 只 / 可用 ' + stats.usable + ' 只');
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('[池] 失败: ' + (e && e.stack || e));
    process.exit(1);
  });
}

module.exports = { main };
