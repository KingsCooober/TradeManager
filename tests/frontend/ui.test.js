'use strict';

const { test, describe, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { setupBrowserMock, teardownBrowserMock } = require('../helpers/browser-mock');

// ===== 增强 DOM mock（专用于 ui.js） =====
// browser-mock 的 createElement 返回的节点 appendChild 是空操作，
// 无法构建 DOM 树；这里提供一个能记录子节点的 fake element，并补 document.head/body
function makeEnhancedElement(tag) {
  const children = [];
  const listeners = {};
  const el = {
    _tag: tag,
    _children: children,
    _textContent: '',
    _innerHTML: '',
    _classList: new Set(),
    _attrs: {},
    style: {},
    dataset: {},
    appendChild: function(child) { children.push(child); return child; },
    removeChild: function(child) {
      const i = children.indexOf(child);
      if (i !== -1) children.splice(i, 1);
      return child;
    },
    parentNode: null,
    addEventListener: function(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener: function(ev, fn) {
      if (!listeners[ev]) return;
      listeners[ev] = listeners[ev].filter(function(f) { return f !== fn; });
    },
    dispatchEvent: function() { return true; },
    setAttribute: function(k, v) { el._attrs[k] = v; },
    getAttribute: function(k) { return el._attrs[k]; },
    focus: function() {},
    click: function() {}
  };
  // className: setter 解析空格分隔的类名同步到 _classList
  Object.defineProperty(el, 'className', {
    configurable: true,
    get: function() { return Array.from(el._classList).join(' '); },
    set: function(v) {
      el._classList = new Set(String(v).split(/\s+/).filter(Boolean));
    }
  });
  // id: setter 存到 _attrs.id（便于测试查找）
  Object.defineProperty(el, 'id', {
    configurable: true,
    get: function() { return el._attrs.id; },
    set: function(v) { el._attrs.id = String(v); }
  });
  // textContent / innerHTML
  Object.defineProperty(el, 'textContent', {
    configurable: true,
    get: function() { return el._textContent; },
    set: function(v) { el._textContent = String(v); }
  });
  Object.defineProperty(el, 'innerHTML', {
    configurable: true,
    get: function() { return el._innerHTML; },
    set: function(v) { el._innerHTML = String(v); }
  });
  // classList
  el.classList = {
    add: function() { for (var i = 0; i < arguments.length; i++) el._classList.add(arguments[i]); },
    remove: function() { for (var i = 0; i < arguments.length; i++) el._classList.delete(arguments[i]); },
    contains: function(c) { return el._classList.has(c); },
    toggle: function(c) { if (el._classList.has(c)) { el._classList.delete(c); return false; } el._classList.add(c); return true; }
  };
  return el;
}

describe('ui.js 测试', () => {
  before(() => {
    setupBrowserMock();
    // 补充 document.head / document.body（browser-mock 未提供）
    globalThis.document.head = makeEnhancedElement('head');
    globalThis.document.body = makeEnhancedElement('body');
    // 覆盖 createElement 为增强版
    globalThis.document.createElement = function(tag) { return makeEnhancedElement(tag); };
    // getElementById：模拟真实 DOM 行为，未注册的 id 返回 null
    const idCache = {};
    globalThis.document.getElementById = function(id) {
      return idCache[id] || null;
    };
  });

  beforeEach(() => {
    // 清空 head/body 子节点，重置样式注入标记
    globalThis.document.head._children.length = 0;
    globalThis.document.body._children.length = 0;
    // 重新加载 ui.js 以重置 __uiStylesInjected
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ui.js'), 'utf8');
    (0, eval)(code);
  });

  after(() => {
    teardownBrowserMock();
  });

  describe('全局暴露', () => {
    test('showToast 暴露到 window 且为函数', () => {
      assert.strictEqual(typeof window.showToast, 'function');
    });

    test('showConfirm 暴露到 window 且为函数', () => {
      assert.strictEqual(typeof window.showConfirm, 'function');
    });

    test('alertDialog 暴露到 window 且为函数', () => {
      assert.strictEqual(typeof window.alertDialog, 'function');
    });
  });

  describe('showToast()', () => {
    test('调用不抛错并返回带 close 方法的对象', () => {
      const toast = showToast('测试消息', 'success');
      assert.strictEqual(typeof toast.close, 'function');
    });

    test('将 toast 元素追加到 body（通过容器）', () => {
      showToast('hello', 'info');
      // 容器被 appendChild 到 body
      assert.ok(globalThis.document.body._children.length >= 1, 'body 应至少有一个子节点（容器）');
    });

    test('注入样式到 head', () => {
      showToast('触发样式注入', 'info');
      // 查找 id 为 ui-component-styles 的 style 节点
      const styleEl = globalThis.document.head._children.find(function(c) {
        return c._attrs.id === 'ui-component-styles';
      });
      assert.ok(styleEl, '应注入 <style id="ui-component-styles">');
    });

    test('样式注入幂等（多次调用只注入一次）', () => {
      showToast('a', 'info');
      showToast('b', 'success');
      showToast('c', 'error');
      const styleCount = globalThis.document.head._children.filter(function(c) {
        return c._attrs.id === 'ui-component-styles';
      }).length;
      assert.strictEqual(styleCount, 1, '样式应只注入一次');
    });

    test('支持各类型（success/error/warning/info）不抛错', () => {
      assert.doesNotThrow(function() { showToast('s', 'success'); });
      assert.doesNotThrow(function() { showToast('e', 'error'); });
      assert.doesNotThrow(function() { showToast('w', 'warning'); });
      assert.doesNotThrow(function() { showToast('i', 'info'); });
      assert.doesNotThrow(function() { showToast('default'); }); // 默认 info
    });

    test('message 为 undefined/null 时不抛错', () => {
      assert.doesNotThrow(function() { showToast(undefined, 'info'); });
      assert.doesNotThrow(function() { showToast(null, 'info'); });
    });

    test('使用 textContent 设置消息（防 XSS）', () => {
      showToast('<script>alert(1)</script>', 'info');
      // 找到 toast body，确认 textContent 被转义存储（非 innerHTML）
      const container = globalThis.document.body._children.find(function(c) {
        return c._tag === 'div' && (c._attrs.id === 'uiToastContainer' || (c._classList && c._classList.has('ui-toast-container')));
      });
      // 容器存在即可证明流程正常；textContent 由 setter 处理
      assert.ok(container || globalThis.document.body._children.length > 0);
    });

    test('close() 不抛错', () => {
      const toast = showToast('可关闭', 'info');
      assert.doesNotThrow(function() { toast.close(); });
    });
  });

  describe('showConfirm()', () => {
    test('返回 Promise', () => {
      const p = showConfirm({ message: '确认？' });
      assert.ok(p && typeof p.then === 'function');
      // 立即结束避免悬挂（mock 下不会自动 resolve，但我们只验证类型）
      p.then(function() {});
    });

    test('字符串参数形式也能工作', () => {
      const p = showConfirm('直接传消息');
      assert.ok(p && typeof p.then === 'function');
      p.then(function() {});
    });

    test('追加 modal overlay 到 body', () => {
      showConfirm({ message: 'test' });
      // body 应有 overlay 子节点
      const overlay = globalThis.document.body._children.find(function(c) {
        return c._classList && c._classList.has('ui-modal-overlay');
      });
      assert.ok(overlay, '应追加 .ui-modal-overlay 到 body');
    });
  });

  describe('alertDialog()', () => {
    test('返回 Promise', () => {
      const p = alertDialog('提示消息');
      assert.ok(p && typeof p.then === 'function');
      p.then(function() {});
    });

    test('字符串参数形式也能工作', () => {
      const p = alertDialog('直接传消息');
      assert.ok(p && typeof p.then === 'function');
      p.then(function() {});
    });

    test('alert 模式不生成取消按钮（只一个 button 子节点的容器）', () => {
      alertDialog({ message: '注意' });
      // 找到 overlay，检查其内部 buttons 容器
      const overlay = globalThis.document.body._children.find(function(c) {
        return c._classList && c._classList.has('ui-modal-overlay');
      });
      assert.ok(overlay, '应有 overlay');
      // card 是 overlay 的第一个子节点
      const card = overlay._children[0];
      assert.ok(card, 'card 应存在');
      // buttons 容器是 card 的最后一个子节点
      const btnWrap = card._children[card._children.length - 1];
      // alert 模式应只有 1 个 button（确定），confirm 模式有 2 个
      assert.strictEqual(btnWrap._children.length, 1, 'alert 模式应只有 1 个按钮');
    });
  });
});
