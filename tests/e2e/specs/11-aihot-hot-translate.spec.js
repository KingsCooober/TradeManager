// tests/e2e/specs/11-aihot-hot-translate.spec.js
// 11 - AIHOT 热点榜「展开原文 → 翻译全文」回归测试
//
// 背景：热点榜卡片是 <article class="ah-hot-card">，而「全部 AI 动态」列表是
// <article class="ah-card">。toggleTranslate 曾写死 button.closest('.ah-card')，
// 导致热点榜里点「翻译全文」静默失效 —— 按钮点得到，但接口请求根本不发出去。
// 本用例锁死该行为，防止回归。
const { test, expect } = require('@playwright/test');

const HOT = {
  items: [{
    rank: 1,
    title: 'OpenAI 发布新智能体 Dots',
    links: { original: 'https://example.com/story', aihot: 'https://aihot.news/x' },
    sourceCount: 4,
    signalCount: 9,
    participantCount: 3,
    sourceNames: ['The Verge', 'TechCrunch'],
    latestAt: '2026-10-10T12:00:00Z'
  }]
};

const ARTICLE = {
  title: 'OpenAI unveils Dots',
  siteName: 'The Verge',
  charCount: 132,
  blocks: [
    { type: 'p', text: 'At DevDay, CEO Sam Altman said the company wants to "set a new standard for privacy in frontier AI."' },
    { type: 'p', text: 'Meta responded the same day, saying its Muse agent was "built from the ground up for privacy."' }
  ]
};

const TRANSLATED = {
  engine: 'llm',
  translations: [
    '在 DevDay 上，CEO Sam Altman 表示公司希望"为前沿 AI 设定隐私保护的新标准"。',
    'Meta 当天回应称，其 Muse 智能体"从零开始专为隐私而打造"。'
  ],
  failed: 0,
  total: 2
};

test.describe('11 - AIHOT 热点榜翻译', () => {
  test.beforeEach(async ({ page }) => {
    // 免登录：直接注入令牌，并桩掉全部 /api 请求
    await page.addInitScript(() => {
      localStorage.setItem('sync_token', 'e2e-stub-token');
      localStorage.setItem('sync_user', JSON.stringify({ id: 1, username: 'e2e', role: 'admin' }));
    });
    await page.route('**/api/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      let body = {};
      if (pathname === '/api/aihot/hot-topics') body = HOT;
      else if (pathname === '/api/aihot/article') body = ARTICLE;
      else if (pathname === '/api/aihot/translate') body = TRANSLATED;
      else if (pathname === '/api/aihot/items') body = { items: [], page: {} };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
  });

  test('热点榜点「翻译全文」应真的发出翻译请求并渲染译文', async ({ page, baseURL }) => {
    const translateCalls = [];
    page.on('request', (req) => {
      if (req.url().indexOf('/api/aihot/translate') >= 0) translateCalls.push(req.method());
    });

    await page.goto(baseURL + '/aihot.html');
    await page.waitForSelector('#ahApp:not([hidden])');

    // 切到热点榜并展开原文
    await page.click('[data-ah-section="hot"]');
    await page.waitForSelector('.ah-hot-card');
    await page.click('.ah-hot-card [data-ah-expand]');
    await page.waitForSelector('.ah-hot-card .ah-article-tools');

    // 点「翻译全文」
    await page.click('.ah-hot-card [data-ah-translate]');

    // 断言：接口被调用 + 译文渲染出来（旧代码这里是 0 段、请求数为 0）
    await expect(page.locator('.ah-hot-card .ah-trans')).toHaveCount(2);
    expect(translateCalls.length).toBeGreaterThan(0);
    await expect(page.locator('.ah-hot-card .ah-article-trans-error')).toHaveText('');
  });
});
