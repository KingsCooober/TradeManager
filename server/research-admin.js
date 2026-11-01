#!/usr/bin/env node
'use strict';

// 研报抓取源（订阅）管理 CLI。
//
// 背景：研报库的界面 2026-10-20 下线了，自动抓取仍在跑（Python 服务内部线程），
// 但「改抓什么、多久抓一次、每次几篇」没有入口了。本脚本补上这块，
// 直接调研报服务本机接口（127.0.0.1:8765/api），不需要登录、不需要开浏览器。
//
// 用法：
//   node research-admin.js status                       # 抓取总状态（开关/每日上限/下次时间）
//   node research-admin.js list                         # 现有订阅，含上次结果
//   node research-admin.js sources                       # 可用来源与类型
//   node research-admin.js add eastmoney industry --name "行业研报 · 东财" --interval 720 --max 5 --days 7
//   node research-admin.js set 2 --interval 1440         # 改频次（分钟）
//   node research-admin.js set 2 --enabled off           # 暂停某条订阅
//   node research-admin.js run 2                         # 立刻抓一次
//   node research-admin.js del 3                         # 删除订阅
//
// 注意：真正决定「抓不抓」的还有全局开关与每日上限，存在 research.db 的 settings 表
//（autofetch_enabled / autofetch_daily_limit），改法见 status 命令的提示。

const http = require('http');

const HOST = process.env.RESEARCH_HOST || '127.0.0.1';
const PORT = parseInt(process.env.RESEARCH_PORT, 10) || 8765;
const BASE = `http://${HOST}:${PORT}/api`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: HOST,
      port: PORT,
      method,
      path: '/api' + path,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : { Accept: 'application/json' },
      timeout: 120000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        if ((res.statusCode || 0) >= 400) {
          const detail = (parsed && (parsed.detail || parsed.error)) || raw.slice(0, 200);
          return reject(new Error(`HTTP ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('研报服务响应超时（抓正文可能要几分钟）')));
    req.on('error', (err) => reject(new Error(err.code === 'ECONNREFUSED'
      ? `研报服务没在跑（${HOST}:${PORT}），先启动主站：pm2 restart trademanager`
      : err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 极简参数解析：--key value 收进 flags，其余进 positional */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function pad(value, width) {
  const text = String(value === undefined || value === null ? '' : value);
  // 中文字符按两格算，避免表格错位
  const length = text.replace(/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/g, 'xx').length;
  return text + ' '.repeat(Math.max(0, width - length));
}

const STATUS_LABEL = {
  ok: '正常',
  partial: '部分失败',
  error: '失败',
  '': '未运行'
};

async function cmdStatus() {
  const payload = await request('GET', '/autofetch/status?logs=5');
  const status = payload.status || {};
  console.log('抓取总开关 : ' + (status.enabled ? '开' : '关'));
  console.log('每日上限   : ' + status.daily_limit + ' 篇（今天已抓 ' + status.today_created + '）');
  console.log('订阅数量   : ' + status.enabled_count + ' 启用 / ' + status.subscription_count + ' 总数');
  console.log('下次运行   : ' + (status.next_run_at || '—'));
  console.log('当前任务   : ' + (status.running ? (status.current || '进行中') : '空闲'));
  console.log('累计自动入库: ' + status.total_auto_reports + ' 篇');
  if (status.last_error) console.log('最近错误   : ' + status.last_error);
  console.log('');
  console.log('提示：总开关与每日上限存在 research.db 的 settings 表');
  console.log('      autofetch_enabled = 1 / 0，autofetch_daily_limit = 30');
}

async function cmdList() {
  const payload = await request('GET', '/subscriptions');
  const items = payload.items || [];
  if (!items.length) {
    console.log('还没有任何订阅。用 `node research-admin.js sources` 看可用来源。');
    return;
  }
  console.log(pad('ID', 4) + pad('状态', 14) + pad('来源', 12) + pad('类型', 10) + pad('频次', 10) + pad('每次', 6) + '名称');
  for (const item of items) {
    const freq = item.interval_minutes >= 60
      ? (item.interval_minutes / 60) + ' 小时'
      : item.interval_minutes + ' 分钟';
    const state = (item.enabled ? '启用' : '暂停') + '/' + (STATUS_LABEL[item.last_status] || item.last_status);
    console.log(
      pad(item.id, 4) + pad(state, 14) + pad(item.source, 12) + pad(item.type, 10) +
      pad(freq, 10) + pad(item.max_per_run, 6) + item.name
    );
    if (item.last_message) console.log('        ↳ ' + item.last_message.slice(0, 90));
  }
}

async function cmdSources() {
  const payload = await request('GET', '/feeds/sources');
  for (const source of payload.sources || []) {
    console.log('● ' + source.key + '  ' + source.label);
    console.log('  类型: ' + (source.types || []).map((t) => `${t.key}(${t.label})`).join('  '));
  }
  console.log('');
  console.log('用法示例: node research-admin.js add eastmoney industry --name "行业研报" --interval 720 --max 5 --days 7');
}

async function cmdAdd(positional, flags) {
  const [source, type] = positional;
  if (!source || !type) throw new Error('用法: add <source> <type> [--name 名字] [--interval 分钟] [--max 每次篇数] [--days 回看天数]');
  const body = {
    source,
    type,
    name: typeof flags.name === 'string' ? flags.name : `${source} · ${type}`,
    interval_minutes: flags.interval ? parseInt(flags.interval, 10) : 720,
    max_per_run: flags.max ? parseInt(flags.max, 10) : 5,
    lookback_days: flags.days ? parseInt(flags.days, 10) : 7,
    fetch_content: flags['no-content'] ? 0 : 1,
    enabled: 1
  };
  if (typeof flags.org === 'string') body.org_code = flags.org;
  if (typeof flags.keyword === 'string') body.keyword = flags.keyword;
  const created = await request('POST', '/subscriptions', body);
  console.log('已创建订阅 #' + created.id + '：' + created.name);
}

async function cmdSet(positional, flags) {
  const id = positional[0];
  if (!id) throw new Error('用法: set <id> [--interval 分钟] [--max 篇数] [--days 天数] [--enabled on|off] [--name 名字]');
  const body = {};
  if (flags.interval) body.interval_minutes = parseInt(flags.interval, 10);
  if (flags.max) body.max_per_run = parseInt(flags.max, 10);
  if (flags.days) body.lookback_days = parseInt(flags.days, 10);
  if (flags.name) body.name = String(flags.name);
  if (flags.enabled !== undefined) {
    body.enabled = ['on', '1', 'true', 'yes'].includes(String(flags.enabled).toLowerCase()) ? 1 : 0;
  }
  if (!Object.keys(body).length) throw new Error('没给出要改的字段');
  const updated = await request('PATCH', '/subscriptions/' + encodeURIComponent(id), body);
  console.log('已更新 #' + updated.id + '：' + updated.name + '（' + (updated.enabled ? '启用' : '暂停') + '）');
}

async function cmdRun(positional) {
  const id = positional[0];
  if (!id) throw new Error('用法: run <id>');
  console.log('正在抓取 #' + id + '（含正文，可能要 1~2 分钟）…');
  const result = await request('POST', '/subscriptions/' + encodeURIComponent(id) + '/run');
  console.log('完成：新建 ' + (result.created || 0) + ' 篇' + (result.total ? '（共扫描 ' + result.total + ' 条）' : ''));
  if (result.notes && result.notes.length) console.log('备注：' + result.notes.join('；'));
}

async function cmdDel(positional) {
  const id = positional[0];
  if (!id) throw new Error('用法: del <id>');
  await request('DELETE', '/subscriptions/' + encodeURIComponent(id));
  console.log('已删除 #' + id);
}

const COMMANDS = {
  status: cmdStatus,
  list: cmdList,
  ls: cmdList,
  sources: cmdSources,
  add: cmdAdd,
  set: cmdSet,
  run: cmdRun,
  del: cmdDel,
  rm: cmdDel
};

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const name = positional.shift();
  if (!name || name === 'help' || flags.help) {
    console.log('研报抓取源管理\n');
    console.log('  status                       抓取总状态');
    console.log('  list                         现有订阅');
    console.log('  sources                      可用来源与类型');
    console.log('  add <source> <type> [...]    新增订阅');
    console.log('  set <id> [...]               修改订阅');
    console.log('  run <id>                     立即抓一次');
    console.log('  del <id>                     删除订阅');
    return;
  }
  const handler = COMMANDS[name];
  if (!handler) throw new Error('未知命令：' + name + '（用 help 看用法）');
  await handler(positional, flags);
}

main().catch((error) => {
  console.error('✗ ' + (error && error.message));
  process.exitCode = 1;
});
