/**
 * 浏览器环境模拟（用于在 Node.js 中测试前端代码）
 *
 * 用法：
 *   const { setupBrowserMock, teardownBrowserMock } = require('./browser-mock');
 *   setupBrowserMock();   // 在测试前调用
 *   // ... 加载并测试前端代码
 *   teardownBrowserMock(); // 在测试后清理
 */

'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 在全局对象上挂载模拟的浏览器 API。
 * 加载前端 JS 文件后，全局变量（如 `trades`、`db`、`updateAll` 等）会出现在 globalThis 上。
 */
function setupBrowserMock() {
  // 模拟 localStorage
  const localStorageStore = new Map();
  globalThis.localStorage = {
    getItem: (key) => localStorageStore.has(key) ? localStorageStore.get(key) : null,
    setItem: (key, value) => { localStorageStore.set(String(key), String(value)); },
    removeItem: (key) => { localStorageStore.delete(String(key)); },
    clear: () => localStorageStore.clear(),
    key: (i) => Array.from(localStorageStore.keys())[i] || null,
    get length() { return localStorageStore.size; }
  };

  // 模拟 sessionStorage
  const sessionStorageStore = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => sessionStorageStore.has(key) ? sessionStorageStore.get(key) : null,
    setItem: (key, value) => { sessionStorageStore.set(String(key), String(value)); },
    removeItem: (key) => { sessionStorageStore.delete(String(key)); },
    clear: () => sessionStorageStore.clear()
  };

  // 模拟 console（如果未定义）
  if (!globalThis.console) {
    globalThis.console = console;
  }

  // 模拟 window（轻量级）
  globalThis.window = globalThis.window || globalThis;

  // 模拟 window.location
  globalThis.location = globalThis.location || {
    origin: 'http://localhost:3000',
    href: 'http://localhost:3000/',
    protocol: 'http:',
    host: 'localhost:3000',
    hostname: 'localhost',
    port: '3000',
    pathname: '/',
    search: '',
    hash: ''
  };

  // 模拟 document
  const documentElements = new Map();
  function makeFakeElement(id) {
    const listeners = {};
    const element = {
      _id: id,
      _value: '',
      _textContent: '',
      _innerHTML: '',
      _classList: new Set(),
      _dataset: {},
      _attributes: {},
      style: new Proxy({}, {
        set: (target, prop, value) => { target[prop] = value; return true; },
        get: (target, prop) => prop in target ? target[prop] : ''
      }),
      classList: {
        add: (...cls) => cls.forEach(c => element._classList.add(c)),
        remove: (...cls) => cls.forEach(c => element._classList.delete(c)),
        contains: (c) => element._classList.has(c),
        toggle: (c) => element._classList.has(c) ? (element._classList.delete(c), false) : (element._classList.add(c), true)
      },
      dataset: new Proxy({}, {
        set: (target, prop, value) => { element._dataset[prop] = value; return true; },
        get: (target, prop) => element._dataset[prop]
      }),
      get value() { return element._value; },
      set value(v) { element._value = v; },
      get textContent() { return element._textContent; },
      set textContent(v) { element._textContent = v; },
      get innerHTML() { return element._innerHTML; },
      set innerHTML(v) { element._innerHTML = v; },
      addEventListener: (event, fn) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(fn);
      },
      removeEventListener: (event, fn) => {
        if (!listeners[event]) return;
        listeners[event] = listeners[event].filter(f => f !== fn);
      },
      dispatchEvent: (event) => {
        const list = listeners[event.type] || [];
        list.forEach(fn => fn(event));
        return true;
      },
      querySelector: (sel) => null,
      querySelectorAll: (sel) => [],
      appendChild: () => {},
      removeChild: () => {},
      insertBefore: () => {},
      setAttribute: (k, v) => { element._attributes[k] = v; },
      getAttribute: (k) => element._attributes[k],
      cloneNode: () => makeFakeElement(id + '_clone')
    };
    return element;
  }

  globalThis.document = {
    _elements: documentElements,
    getElementById: (id) => {
      if (!documentElements.has(id)) {
        documentElements.set(id, makeFakeElement(id));
      }
      return documentElements.get(id);
    },
    querySelector: (sel) => null,
    querySelectorAll: (sel) => [],
    createElement: (tag) => makeFakeElement('new_' + tag),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: makeFakeElement('html')
  };

  // 模拟 fetch（默认返回 200 OK 空响应）
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({}),
      text: async () => ''
    };
  };

  // 模拟 URL.createObjectURL / Blob
  globalThis.URL = globalThis.URL || {};
  globalThis.URL.createObjectURL = () => 'blob:mock';
  globalThis.URL.revokeObjectURL = () => {};

  if (typeof globalThis.Blob === 'undefined') {
    globalThis.Blob = class Blob {
      constructor(parts) { this.parts = parts; }
    };
  }

  // 模拟 Event
  globalThis.Event = class Event {
    constructor(type, init) {
      this.type = type;
      this.bubbles = !!(init && init.bubbles);
    }
  };

  // 模拟 navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'node-test' },
    writable: true,
    configurable: true
  });
}

/**
 * 清理全局对象上挂载的模拟 API。
 */
function teardownBrowserMock() {
  delete globalThis.localStorage;
  delete globalThis.sessionStorage;
  delete globalThis.document;
  delete globalThis.fetch;
  delete globalThis.window;
  delete globalThis.location;
  delete globalThis.Event;
  delete globalThis.navigator;
  if (globalThis.URL) {
    delete globalThis.URL.createObjectURL;
    delete globalThis.URL.revokeObjectURL;
  }
  if (globalThis.Blob) {
    delete globalThis.Blob;
  }
}

/**
 * 在 Node.js 环境中加载并执行前端 JS 文件，
 * 模拟 `<script>` 标签的全局加载行为。
 *
 * 使用间接 eval (0, eval)(code) 让顶层 `let`/`const`/`var` 声明
 * 进入 globalThis 的词法环境，从而可以被测试访问。
 *
 * @param {string[]} fileNames - JS 文件名数组（相对于 public/js/ 目录）
 */
function loadFrontendScripts(fileNames) {
  const jsDir = path.join(__dirname, '..', '..', 'public', 'js');
  for (const name of fileNames) {
    const filePath = path.join(jsDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error('找不到文件: ' + filePath);
    }
    const code = fs.readFileSync(filePath, 'utf8');
    // 间接 eval：在全局作用域中执行，模拟 <script> 标签行为
    (0, eval)(code);
  }
}

module.exports = {
  setupBrowserMock,
  teardownBrowserMock,
  loadFrontendScripts
};
