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
    '.ui-toast-container{position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:calc(100vw - 32px);}',
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
    '.ui-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:10001;opacity:0;transition:opacity .2s ease;}',
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
