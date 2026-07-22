// ===== 通用 custom-select 组件 =====
// 把一个原生 <select> 转换为与"开仓计算器-买点类型"完全一致的视觉与交互。
// 保留原 select 的 value、change 事件、selectedIndex 等接口，调用方无需修改业务逻辑。
//
// 用法（页面初始化完成后调用一次即可）：
//   upgradeSelectToCustom(document.querySelector('#xxx'));
//   // 批量：
//   document.querySelectorAll('.dr-select').forEach(upgradeSelectToCustom);
//
// 依赖：main.css 中的 .custom-select / .custom-select-options 样式

(function () {
  if (window.upgradeSelectToCustom) return;  // 防止重复加载

  // 当前已打开的 custom-select（用于点击外部关闭时排除自身）
  var openWrappers = new Set();

  function getSelectedText(sel) {
    if (sel.selectedIndex < 0) return '';
    var opt = sel.options[sel.selectedIndex];
    return opt ? opt.text : '';
  }

  function closeAll(exceptWrapper) {
    openWrappers.forEach(function (w) {
      if (w === exceptWrapper) return;
      w.classList.remove('open');
    });
  }

  // 同步原 select.value 到 custom-select 显示
  function syncDisplay(sel, valueSpan, optionsList) {
    valueSpan.textContent = getSelectedText(sel) || '';
    var idx = sel.selectedIndex;
    var items = optionsList.querySelectorAll('li');
    items.forEach(function (li, i) {
      li.classList.toggle('selected', i === idx);
    });
  }

  function upgradeSelectToDOM(sel) {
    if (!sel || sel.tagName !== 'SELECT') return;
    if (sel.dataset.csUpgraded === '1') return;
    sel.dataset.csUpgraded = '1';

    // 隐藏原 select
    sel.style.display = 'none';

    // 如果 select 已经被 .custom-select-wrapper 包住，复用之；否则创建
    var parent = sel.parentNode;
    var wrapper;
    if (parent && parent.classList && parent.classList.contains('custom-select-wrapper')) {
      wrapper = parent;
    } else {
      wrapper = document.createElement('div');
      wrapper.className = 'custom-select-wrapper';
      sel.parentNode.insertBefore(wrapper, sel);
      wrapper.appendChild(sel);
    }

    // 创建 custom-select 显示区
    var customSelect = document.createElement('div');
    customSelect.className = 'custom-select';
    customSelect.tabIndex = 0;

    var valueSpan = document.createElement('span');
    valueSpan.className = 'custom-select-value';

    var arrow = document.createElement('span');
    arrow.className = 'custom-select-arrow';
    arrow.textContent = '▼';

    customSelect.appendChild(valueSpan);
    customSelect.appendChild(arrow);

    // 创建 options 列表
    var optionsList = document.createElement('ul');
    optionsList.className = 'custom-select-options';

    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      var li = document.createElement('li');
      li.dataset.value = o.value;
      li.dataset.index = String(i);
      li.textContent = o.text;
      if (i === sel.selectedIndex) li.classList.add('selected');
      optionsList.appendChild(li);
    }

    wrapper.appendChild(customSelect);
    wrapper.appendChild(optionsList);

    // 标记 wrapper 包含的 custom-select
    wrapper.classList.add('cs-wrapper');

    // 同步显示
    syncDisplay(sel, valueSpan, optionsList);

    // 点击 custom-select 展开/收起
    customSelect.addEventListener('mousedown', function (e) {
      e.preventDefault();  // 防止 input 失焦
    });
    customSelect.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = wrapper.classList.contains('open');
      closeAll(wrapper);
      if (isOpen) {
        wrapper.classList.remove('open');
        customSelect.classList.remove('open');
        optionsList.classList.remove('open');
      } else {
        wrapper.classList.add('open');
        customSelect.classList.add('open');
        optionsList.classList.add('open');
        openWrappers.add(wrapper);
        // 滚动到选中项
        var selLi = optionsList.querySelector('li.selected');
        if (selLi) selLi.scrollIntoView({ block: 'nearest' });
      }
    });

    // 点击 option
    Array.prototype.forEach.call(optionsList.querySelectorAll('li'), function (li) {
      li.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(li.dataset.index, 10);
        if (sel.selectedIndex === idx) {
          wrapper.classList.remove('open');
          customSelect.classList.remove('open');
          optionsList.classList.remove('open');
          return;
        }
        sel.selectedIndex = idx;
        // 触发 change 事件（保持与原生 select 行为一致）
        var ev = document.createEvent('Event');
        ev.initEvent('change', true, true);
        sel.dispatchEvent(ev);
        wrapper.classList.remove('open');
        customSelect.classList.remove('open');
        optionsList.classList.remove('open');
      });
    });

    // 键盘交互
    customSelect.addEventListener('keydown', function (e) {
      var key = e.key;
      if (key === 'ArrowDown') {
        e.preventDefault();
        if (!wrapper.classList.contains('open')) {
          wrapper.classList.add('open');
          customSelect.classList.add('open');
          optionsList.classList.add('open');
          openWrappers.add(wrapper);
          return;
        }
        var idx = Math.min(sel.selectedIndex + 1, sel.options.length - 1);
        if (idx !== sel.selectedIndex) {
          sel.selectedIndex = idx;
          var ev = document.createEvent('Event');
          ev.initEvent('change', true, true);
          sel.dispatchEvent(ev);
        }
      } else if (key === 'ArrowUp') {
        e.preventDefault();
        if (!wrapper.classList.contains('open')) return;
        var idx2 = Math.max(sel.selectedIndex - 1, 0);
        if (idx2 !== sel.selectedIndex) {
          sel.selectedIndex = idx2;
          var ev2 = document.createEvent('Event');
          ev2.initEvent('change', true, true);
          sel.dispatchEvent(ev2);
        }
      } else if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        if (wrapper.classList.contains('open')) {
          wrapper.classList.remove('open');
          customSelect.classList.remove('open');
          optionsList.classList.remove('open');
        } else {
          closeAll(wrapper);
          wrapper.classList.add('open');
          customSelect.classList.add('open');
          optionsList.classList.add('open');
          openWrappers.add(wrapper);
        }
      } else if (key === 'Escape') {
        e.preventDefault();
        wrapper.classList.remove('open');
        customSelect.classList.remove('open');
        optionsList.classList.remove('open');
      }
    });

    // 监听 select 的 change 事件（程序触发或外部设置 value 时同步显示）
    sel.addEventListener('change', function () {
      syncDisplay(sel, valueSpan, optionsList);
    });
  }

  // 点击外部关闭所有 custom-select
  document.addEventListener('click', function (e) {
    var target = e.target;
    var foundWrapper = null;
    var node = target;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('cs-wrapper')) {
        foundWrapper = node;
        break;
      }
      node = node.parentNode;
    }
    closeAll(foundWrapper);
    if (foundWrapper) {
      foundWrapper.classList.remove('open');
    }
  });

  window.upgradeSelectToCustom = upgradeSelectToDOM;
})();
