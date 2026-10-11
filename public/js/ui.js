// ===== UI 工具：Toast 通知 + ConfirmDialog 确认弹窗 =====
// P1-2: 替代浏览器原生 alert/confirm，提供非阻塞、可定制的统一交互
//
// 用法：
//   showToast('保存成功', 'success');                      // 自动消失的通知
//   showToast('请输入有效金额', 'error');                  // 错误提示
//   const ok = await showConfirm({ title:'删除', message:'确认删除？' });
//   if (!ok) return;
//   await alertDialog('操作完成', 'success');              // 单按钮确认框
//
// 样式：toast 样式由本文件动态注入（自包含）；confirm/alert 复用页面已有的
//       .modal-overlay / .modal-content / .btn-primary / .btn-gray 等类。

// ===== 样式注入（仅一次） =====
var __uiStylesInjected = false;
function __injectUiStyles() {
  if (__uiStylesInjected) return;
  __uiStylesInjected = true;
  if (typeof document === 'undefined' || !document.head) return;

  var style = document.createElement('style');
  style.id = 'ui-component-styles';
  style.textContent = [
    '/* ===== Toast 容器 ===== */',
    '.ui-toast-container{position:fixed;top:16px;right:16px;z-index:var(--z-toast);display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:calc(100vw - 32px);}',
    '/* ===== Toast 单条 ===== */',
    '.ui-toast{pointer-events:auto;min-width:260px;max-width:380px;padding:12px 16px 12px 14px;border-radius:var(--radius-md,8px);box-shadow:0 6px 20px rgba(0,0,0,0.18);display:flex;align-items:flex-start;gap:10px;font-size:14px;line-height:1.5;background:var(--bg-elevated,#fff);color:var(--text-primary,#222);border-left:4px solid var(--color-primary,#4361ee);opacity:0;transform:translateX(20px);transition:opacity .25s ease,transform .25s ease;word-break:break-word;}',
    '.ui-toast.ui-toast-show{opacity:1;transform:translateX(0);}',
    '.ui-toast-icon{font-size:18px;line-height:1.2;flex-shrink:0;}',
    '.ui-toast-body{flex:1;min-width:0;}',
    '.ui-toast-close{flex-shrink:0;background:none;border:none;color:var(--text-tertiary,#999);cursor:pointer;font-size:16px;line-height:1;padding:2px 0 0 4px;}',
    '.ui-toast-close:hover{color:var(--text-primary,#222);}',
    '/* 类型变体 */',
    '.ui-toast.ui-toast-success{border-left-color:var(--color-green,#22c55e);}',
    '.ui-toast.ui-toast-error{border-left-color:var(--color-red,#ef4444);}',
    '.ui-toast.ui-toast-warning{border-left-color:var(--color-yellow,#f59e0b);}',
    '.ui-toast.ui-toast-info{border-left-color:var(--color-primary,#4361ee);}',
    '/* 暗色主题适配 */',
    '[data-theme="dark"] .ui-toast{background:var(--bg-elevated,#2a2a2a);color:var(--text-primary,#eee);box-shadow:0 6px 24px rgba(0,0,0,0.4);}',
    '/* ===== ConfirmDialog / Alert 遮罩（复用 .modal-overlay，补一个更高 z-index 的别名） ===== */',
    '.ui-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:var(--z-dialog);opacity:0;transition:opacity .2s ease;}',
    '.ui-modal-overlay.ui-modal-show{opacity:1;}',
    '.ui-modal-card{background:var(--bg-elevated,#fff);border-radius:var(--radius-md,8px);max-width:420px;width:calc(100vw - 32px);padding:0;box-shadow:0 12px 40px rgba(0,0,0,0.25);overflow:hidden;transform:translateY(-12px) scale(0.98);transition:transform .2s ease;}',
    '.ui-modal-overlay.ui-modal-show .ui-modal-card{transform:translateY(0) scale(1);}',
    '.ui-modal-header{padding:16px 20px 8px;display:flex;align-items:center;gap:8px;}',
    '.ui-modal-header h3{margin:0;font-size:16px;font-weight:600;color:var(--text-primary,#222);}',
    '.ui-modal-icon{font-size:20px;}',
    '.ui-modal-body{padding:4px 20px 16px;color:var(--text-secondary,#555);font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}',
    '.ui-modal-buttons{padding:0 20px 16px;display:flex;justify-content:flex-end;gap:10px;}',
    '[data-theme="dark"] .ui-modal-card{background:var(--bg-elevated,#2a2a2a);}'
  ].join('\n');
  document.head.appendChild(style);
}

// ===== Toast 实现 =====

function __ensureToastContainer() {
  var container = document.getElementById('uiToastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'uiToastContainer';
    container.className = 'ui-toast-container';
    document.body.appendChild(container);
  }
  return container;
}

var __toastIcons = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ'
};

// 显示 Toast 通知（非阻塞，自动消失）
// message: 文本（必填）；type: success/error/warning/info，默认 info
// duration: 毫秒，默认 3000；传 0 表示不自动关闭
function showToast(message, type, duration) {
  __injectUiStyles();
  if (typeof message === 'undefined' || message === null) message = '';
  message = String(message);
  type = type || 'info';
  if (!__toastIcons[type]) type = 'info';
  duration = (typeof duration === 'number') ? duration : 3000;

  var container = __ensureToastContainer();

  var toast = document.createElement('div');
  toast.className = 'ui-toast ui-toast-' + type;

  var icon = document.createElement('span');
  icon.className = 'ui-toast-icon';
  icon.textContent = __toastIcons[type];

  var body = document.createElement('span');
  body.className = 'ui-toast-body';
  body.textContent = message; // 使用 textContent 避免 XSS

  toast.appendChild(icon);
  toast.appendChild(body);

  var closeTimer = null;
  function removeToast() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    toast.classList.remove('ui-toast-show');
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 250);
  }

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ui-toast-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '✕';
  closeBtn.onclick = removeToast;
  toast.appendChild(closeBtn);

  container.appendChild(toast);
  // 触发进入动画
  setTimeout(function() { toast.classList.add('ui-toast-show'); }, 10);

  if (duration > 0) {
    closeTimer = setTimeout(removeToast, duration);
  }

  return { close: removeToast };
}

// ===== ConfirmDialog / Alert 实现 =====

// 通用模态弹窗（内部使用），返回 Promise<boolean>
// options: { title, message, type, confirmText, cancelText, showCancel }
//   showCancel=false 时为单按钮 alert 模式
function __showModal(options) {
  __injectUiStyles();
  options = options || {};
  var title = options.title || '提示';
  var message = (options.message === undefined || options.message === null) ? '' : String(options.message);
  var type = options.type || 'info';
  var showCancel = options.showCancel !== false; // 默认显示取消按钮
  var confirmText = options.confirmText || '确定';
  var cancelText = options.cancelText || '取消';

  var overlay = document.createElement('div');
  overlay.className = 'ui-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  var card = document.createElement('div');
  card.className = 'ui-modal-card modal-content modal-content--small';

  // header
  var header = document.createElement('div');
  header.className = 'ui-modal-header';
  var iconSpan = document.createElement('span');
  iconSpan.className = 'ui-modal-icon';
  iconSpan.textContent = (type === 'warning') ? '⚠' : (type === 'error') ? '⛔' : (type === 'success') ? '✓' : 'ℹ';
  var titleEl = document.createElement('h3');
  titleEl.textContent = title; // textContent 防 XSS
  header.appendChild(iconSpan);
  header.appendChild(titleEl);
  card.appendChild(header);

  // body
  var body = document.createElement('div');
  body.className = 'ui-modal-body';
  body.textContent = message; // textContent 防 XSS
  card.appendChild(body);

  // buttons
  var btnWrap = document.createElement('div');
  btnWrap.className = 'ui-modal-buttons modal-buttons';

  // 用闭包持有 resolve；close 时调用它（保证 Promise 一次性 settle）
  var settled = false;
  var resolveFn = null;

  function close(value) {
    if (settled) return;
    settled = true;
    overlay.classList.remove('ui-modal-show');
    setTimeout(function() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 200);
    if (resolveFn) resolveFn(value);
    document.removeEventListener('keydown', onKeydown);
  }

  if (showCancel) {
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-gray';
    cancelBtn.textContent = cancelText;
    cancelBtn.onclick = function() { close(false); };
    btnWrap.appendChild(cancelBtn);
  }

  var okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'btn btn-primary';
  okBtn.textContent = confirmText;
  okBtn.onclick = function() { close(true); };
  btnWrap.appendChild(okBtn);

  card.appendChild(btnWrap);
  overlay.appendChild(card);

  // 点击遮罩关闭（等同取消）
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) close(false);
  });

  // ESC 关闭（等同取消）；alert 模式下 Enter 确认
  function onKeydown(e) {
    if (e.key === 'Escape') {
      close(false);
    } else if (e.key === 'Enter' && !showCancel) {
      close(true);
    }
  }
  document.addEventListener('keydown', onKeydown);

  document.body.appendChild(overlay);
  // 触发进入动画并聚焦确认按钮
  setTimeout(function() {
    overlay.classList.add('ui-modal-show');
    okBtn.focus();
  }, 10);

  return new Promise(function(resolve) {
    resolveFn = resolve;
  });
}

// 显示确认弹窗（返回 Promise<boolean>，true=确认，false=取消）
// options: { title, message, type, confirmText, cancelText }
function showConfirm(options) {
  if (typeof options === 'string') options = { message: options };
  options = options || {};
  options.showCancel = true;
  return __showModal(options);
}

// 显示单按钮提示弹窗（返回 Promise<void>，作为 alert 的异步替代）
// options: { title, message, type, confirmText } 或直接传 message 字符串
function alertDialog(options) {
  if (typeof options === 'string') options = { message: options };
  options = options || {};
  options.showCancel = false;
  return __showModal(options).then(function() { /* 忽略结果 */ });
}

// ===== 兼容：提供 window.alert2/confirm2 作为渐进迁移的别名（不覆盖原生 alert/confirm） =====
// 现有代码可逐步替换；在完全迁移前不影响原生行为
window.showToast = showToast;
window.showConfirm = showConfirm;
window.alertDialog = alertDialog;

// ===== 输入框错误态辅助（配合 main.css 的 .input-error）=====
// 用法：校验失败时 markInputError(el 或 id, '提示文案')；成功时 clearInputError(el)。
// 挂上错误态后，用户一输入即自动摘除（下方事件委托），无需手动清理时序。
function markInputError(target, message) {
  var el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  el.classList.add('input-error');
  if (message) showToast(message, 'error');
}

function clearInputError(target) {
  var el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  el.classList.remove('input-error');
}

// 输入即清理错误态（一次性全局委托）
(function __installInputErrorAutoClear() {
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('input-error')) {
      t.classList.remove('input-error');
    }
  });
})();

// ===== 弹窗开关统一辅助（全站 .modal-overlay 只用 classList('show') 一种机制）=====
// ★ 背景：index.html 曾有 11 个弹窗用 style.display='flex'/'none'，
//   唯独 equityModal 用 classList('show')（charts.js），两套机制在 CSS 上互斥
//   （.modal-overlay 基类 display:none，.show 才是 flex），
//   导致无法用单一选择器查"当前打开的弹窗"。
//   统一后：打开加 .show、关闭移除 .show，并清掉历史遗留的内联 display 避免双轨残留。
// 本文件在所有页面最先加载（index.html:790），确保 calculator.js/table.js 等后加载模块可用。
function openModalOverlay(id) {
  var el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  el.classList.add('show');
  el.style.removeProperty('display'); // 清除旧机制残留的内联 display
  __uiSetModalOpen(el, true);
}

function closeModalOverlay(id) {
  var el = typeof id === 'string' ? document.getElementById(id) : id;
  if (!el) return;
  el.classList.remove('show');
  el.style.removeProperty('display');
  __uiSetModalOpen(el, false);
}

// ===== 焦点陷阱 + body 滚动锁定（自 daily-review.js 的 setupDRFocusTrap 提升为全站组件）=====
// 原实现仅在 daily-review 页生效；现挂到 openModalOverlay/closeModalOverlay 上，
// 走统一开关机制的弹窗自动获得：Tab 循环、打开聚焦、关闭归还焦点、背景滚动锁定。
var __uiLastFocused = null;
var __uiFocusTrapHandler = null;
var __uiModalOpenCount = 0;

function __uiSetModalOpen(modalEl, opening) {
  if (opening) {
    __uiModalOpenCount++;
    __uiSetupFocusTrap(modalEl);
  } else {
    __uiModalOpenCount = Math.max(0, __uiModalOpenCount - 1);
    __uiTeardownFocusTrap(modalEl);
  }
  // body 滚动锁定：仅当"没有弹窗打开"时解锁（支持叠开场景）
  if (typeof document !== 'undefined' && document.body) {
    document.body.style.overflow = (__uiModalOpenCount > 0) ? 'hidden' : '';
  }
}

function __uiSetupFocusTrap(modalEl) {
  if (!modalEl || modalEl.__uiFocusTrap) return;
  modalEl.__uiFocusTrap = true;

  // 记录触发元素，关闭时归还
  __uiLastFocused = document.activeElement;

  // 焦点移入弹窗（优先第一个可聚焦元素，其次弹窗本身）
  setTimeout(function () {
    if (!modalEl.classList.contains('show')) return; // 可能已被关闭
    var focusable = modalEl.querySelector('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    else modalEl.focus();
  }, 50);

  // 移除旧处理器（叠开时只保留最上层弹窗的陷阱）
  if (__uiFocusTrapHandler) {
    document.removeEventListener('keydown', __uiFocusTrapHandler);
    __uiFocusTrapHandler = null;
  }

  // Tab 循环：焦点困在弹窗内，不会逃逸到背景
  __uiFocusTrapHandler = function (e) {
    if (e.key !== 'Tab' || !modalEl.classList.contains('show')) return;
    var focusables = modalEl.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', __uiFocusTrapHandler);
}

function __uiTeardownFocusTrap(modalEl) {
  if (modalEl && modalEl.__uiFocusTrap) modalEl.__uiFocusTrap = false;
  if (__uiFocusTrapHandler) {
    document.removeEventListener('keydown', __uiFocusTrapHandler);
    __uiFocusTrapHandler = null;
  }
  // 归还焦点到打开弹窗前的元素
  if (__uiLastFocused && typeof __uiLastFocused.focus === 'function') {
    try { __uiLastFocused.focus(); } catch (e) { /* 元素可能已移除 */ }
    __uiLastFocused = null;
  }
}

// Esc 关闭当前打开的弹窗（index 页此前无任何键盘关闭路径）。
// 只处理主页面弹窗；daily-review/diary2 有各自的 Esc 分发，ui.js 的对话框自己管理 Esc，
// 这里按"页面是否定义了对应关闭函数"判定，避免跨页误关。
(function __installGlobalEscClose() {
  var closers = {
    tradeConfirmModal: 'closeTradeConfirmModal',
    tradeDetailModal: 'closeTradeDetailModal',
    tradeEditModal: 'closeTradeEditModal',
    depositModal: 'closeDepositModal',
    withdrawModal: 'closeWithdrawModal',
    settingsModal: 'closeSettingsModal',
    clearConfirmModal: 'closeClearConfirm',
    loginModal: 'closeLoginModal',
    changePasswordModal: 'closeChangePasswordModal',
    equityModal: 'closeEquityModal'
  };
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelector('.modal-overlay.show');
    if (!open) return;
    var fn = closers[open.id];
    if (fn && typeof window[fn] === 'function') {
      e.preventDefault();
      window[fn]();
    }
  });
})();
