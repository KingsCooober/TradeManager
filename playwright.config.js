// playwright.config.js
// Trade Manager E2E 测试配置
// 跨浏览器支持 + 多维度报告 + 错误截图/视频
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './tests/e2e/specs',
  // 不匹配 utils/ pages/ fixtures/ 目录作为测试
  testIgnore: ['**/utils/**', '**/pages/**', '**/fixtures/**', '**/helpers/**'],

  // 全局超时：单个测试最长运行时间
  timeout: 30 * 1000,
  // 断言超时
  expect: { timeout: 5000 },

  // 并行执行（本地开发时）
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // CI 模式下重试 2 次，本地 0 次
  retries: process.env.CI ? 2 : 0,
  // CI 模式单 worker 避免冲突，本地多 worker
  workers: process.env.CI ? 1 : undefined,

  // 多格式报告
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never', title: 'Trade Manager E2E' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
    ['junit', { outputFile: 'playwright-report/junit.xml' }],
    // 简洁的控制台报告
    ['line'],
  ],

  // 全局共享配置
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10 * 1000,
    navigationTimeout: 15 * 1000,
    // 视口默认设置
    viewport: { width: 1280, height: 720 },
    // 接受下载
    acceptDownloads: true,
  },

  // 仅使用 Edge 浏览器（用户机器只安装了 Edge）
  projects: [
    {
      name: 'edge',
      use: {
        // Edge 基于 Chromium，使用 chromium 引擎并指定 Edge 通道
        ...devices['Desktop Chrome'],
        channel: 'msedge',
      },
    },
    
  ],

  // 自动启动服务器
  webServer: {
    command: 'node server/server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
    stdout: 'ignore',
    stderr: 'pipe',
  },

  // 输出目录
  outputDir: 'test-results/',
});
