'use strict';

// AIHOT 原文正文抓取：AIHOT 官方 API 只提供标题与摘要，正文需要自行抓取原文页面。
// 约束：本项目部署脚本不做 npm install，因此这里必须零依赖实现（仅用 Node 内置模块）。
// 注意：原文链接中约一半指向 x.com，国内网络无法访问，这类链接会在抓取阶段失败并降级为外链。

const http = require('http');
const https = require('https');
const dns = require('dns');
const { TextDecoder } = require('util');

const FETCH_TIMEOUT_MS = 15 * 1000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 128;
const MIN_PARAGRAPH_CHARS = 12;
const MIN_ARTICLE_CHARS = 120;
// 这些来源在当前网络环境下必然连不上，直接快速失败，避免用户白等 15 秒超时
const UNSUPPORTED_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co)$/i;

const cache = new Map();

const BLOCKED_HOSTNAME = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal)$/i;

// 判定内网/保留地址，用于阻断 SSRF（只允许抓取公网内容）
function isPrivateAddress(address) {
  if (!address) return true;
  if (address.includes(':')) {
    const low = address.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('fe80')) return true;
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7));
    return false;
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    throw new Error('原文链接格式无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https 链接。');
  if (BLOCKED_HOSTNAME.test(parsed.hostname)) throw new Error('该地址不允许抓取。');
  let addresses;
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (e) {
    throw new Error('无法解析原文域名（可能网络不可达）。');
  }
  if (!addresses.length) throw new Error('无法解析原文域名（可能网络不可达）。');
  for (const item of addresses) {
    if (isPrivateAddress(item.address)) throw new Error('该地址不允许抓取。');
  }
  return parsed;
}

function detectCharset(headers, buffer) {
  const contentType = String((headers && headers['content-type']) || '');
  let match = contentType.match(/charset=["']?([\w-]+)/i);
  if (match) return match[1].toLowerCase();
  const head = buffer.slice(0, 4096).toString('latin1');
  match = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (match) return match[1].toLowerCase();
  match = head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i);
  if (match) return match[1].toLowerCase();
  return 'utf-8';
}

function decodeBody(buffer, headers) {
  const charset = detectCharset(headers, buffer);
  for (const name of [charset, 'utf-8']) {
    try {
      return new TextDecoder(name).decode(buffer);
    } catch (e) {
      // 该编码不被支持时换下一个
    }
  }
  return buffer.toString('utf8');
}

function requestOnce(target, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const lib = parsed.protocol === 'https:' ? https : http;
    const request = lib.get(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      timeout: FETCH_TIMEOUT_MS,
      // 部分站点响应头很大（Node 默认上限 16KB），放宽以免被误判为抓取失败
      maxHeaderSize: 64 * 1024
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) return reject(new Error('原文跳转次数过多。'));
        const next = new URL(response.headers.location, target).href;
        return resolve(follow(next, redirectsLeft - 1));
      }
      if (status !== 200) {
        response.resume();
        return reject(new Error('原文返回 HTTP ' + status + '，无法抓取。'));
      }
      const type = String(response.headers['content-type'] || '');
      if (type && !/text\/html|application\/xhtml|text\/plain/i.test(type)) {
        response.resume();
        return reject(new Error('该链接不是网页内容，无法提取正文。'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          request.destroy(new Error('原文体积过大，已中止抓取。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: response.headers }));
    });
    request.on('timeout', () => request.destroy(new Error('抓取原文超时。')));
    request.on('error', reject);
  });
}

// 每一跳都重新校验目标地址，防止通过重定向绕过内网限制
async function follow(target, redirectsLeft) {
  await assertPublicUrl(target);
  return requestOnce(target, redirectsLeft);
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  middot: '·', times: '×', copy: '©', reg: '®', deg: '°', laquo: '«', raquo: '»', bull: '•',
  sect: '§', para: '¶', plusmn: '±', frac12: '½', prime: '′', Prime: '″'
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; }
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      try { return String.fromCodePoint(Number(dec)); } catch (e) { return m; }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/[\s\u00a0]+/g, ' ').trim();
}

// 用于 pre / 引用容器：保留原有换行与段落结构，只压缩行内多余空白
function stripTagsKeepLines(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

function removeNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form|select|textarea|button|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(link|meta|base|input|br|hr|img|source|track|wbr)\b[^>]*\/?>/gi, ' ');
}

function pickMeta(html) {
  const pick = (re) => {
    const m = String(html).match(re);
    return m ? stripTags(m[1]) : '';
  };
  const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  const siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:site_name["']/i);
  const author = pick(/<meta[^>]+name=["']author["'][^>]*content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+property=["']article:author["'][^>]*content=["']([^"']*)["']/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  return {
    title: ogTitle || pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    siteName,
    author,
    description
  };
}

const HEADING_TAGS = /^h[1-6]$/;
// 标点或数字用于识别“像正文的句子”；又短又两者皆无的块基本是按钮、菜单等 UI 噪音
const SENTENCE_HINT = /[，。！？；：、,.!?;:…—（）()《》【】"']|\d/;

function isMeaningfulBlock(tag, text) {
  if (HEADING_TAGS.test(tag)) return text.length >= 2;
  if (text.length < MIN_PARAGRAPH_CHARS) return false;
  if (text.length < 24 && !SENTENCE_HINT.test(text)) return false;
  return true;
}

// 很多技术文档用「带背景色 / 左边框的容器」标注对话、工具调用、代码等片段。
// 这类容器内的多个 <p> 若被当作普通段落平铺，正文与日志就会糊成一团，因此整体识别为引用块。
const QUOTE_CONTAINER = /<div\b[^>]*style=["'][^"']*(?:border-left|background-color)[^"']*["'][^>]*>([\s\S]*?)<\/div\s*>/gi;

function extractBlocks(html) {
  const blocks = [];
  const pending = [];

  // 先把引用容器整体抽出来，原位置留占位符，避免其内部段落被单独展开
  const marked = String(html).replace(QUOTE_CONTAINER, (match, inner) => {
    const text = stripTagsKeepLines(inner);
    if (text.length < 8) return ' ';
    pending.push({ type: 'quote', text });
    return '\u0001' + (pending.length - 1) + '\u0001';
  });

  const re = /<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1\s*>|\u0001(\d+)\u0001/gi;
  let match;
  while ((match = re.exec(marked))) {
    if (match[3] !== undefined) {
      blocks.push(pending[Number(match[3])]);
      continue;
    }
    const tag = match[1].toLowerCase();
    const text = tag === 'pre' ? stripTagsKeepLines(match[2]) : stripTags(match[2]);
    if (!text) continue;
    if (tag !== 'pre' && !isMeaningfulBlock(tag, text)) continue;
    blocks.push({ type: tag === 'li' ? 'li' : tag, text });
  }
  return blocks;
}

function dedupeAdjacent(blocks) {
  const out = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && last.text === block.text) continue;
    out.push(block);
  }
  return out;
}

function extractArticle(html, pageUrl) {
  const meta = pickMeta(html);
  const cleaned = removeNoise(html);
  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/i);
  const scope = articleMatch && stripTags(articleMatch[1]).length > MIN_ARTICLE_CHARS ? articleMatch[1] : cleaned;

  let blocks = dedupeAdjacent(extractBlocks(scope));
  let charCount = blocks.reduce((sum, block) => sum + block.text.length, 0);

  // 结构化提取失败时，退化为整段纯文本，保证至少能看到内容
  if (charCount < MIN_ARTICLE_CHARS) {
    const text = stripTags(scope);
    blocks = text ? [{ type: 'p', text }] : [];
    charCount = text.length;
  }

  return {
    url: pageUrl,
    title: meta.title,
    siteName: meta.siteName,
    author: meta.author,
    description: meta.description,
    charCount,
    blocks
  };
}

async function fetchArticle(rawUrl) {
  const parsed = await assertPublicUrl(rawUrl);
  if (UNSUPPORTED_HOSTS.test(parsed.hostname)) {
    throw new Error('该来源（X / Twitter）在当前网络环境下无法抓取，请点击「阅读原文」查看。');
  }
  const key = parsed.href;
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.data;
  }

  const response = await follow(key, MAX_REDIRECTS);
  const html = decodeBody(response.buffer, response.headers);
  const article = extractArticle(html, key);
  if (!article.blocks.length) throw new Error('未能从该页面提取到正文内容。');

  cache.delete(key);
  cache.set(key, { data: article, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
  return article;
}

function mount(app, auth) {
  app.get('/api/aihot/article', auth.authMiddleware, async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!url) return res.status(400).json({ error: '缺少原文链接。' });
    if (url.length > 2048) return res.status(400).json({ error: '原文链接过长。' });
    try {
      const article = await fetchArticle(url);
      res.set('Cache-Control', 'private, no-store');
      res.json(article);
    } catch (error) {
      console.error('[aihot] 抓取原文失败:', url, '-', error.message);
      res.status(502).json({ error: error.message || '原文抓取失败，请稍后重试。', url });
    }
  });
}

module.exports = { mount, fetchArticle, extractArticle, isPrivateAddress };
