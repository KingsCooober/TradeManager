// ===== 每日交易计划 页面主逻辑 =====
// 依赖：utils.js, database.js, sync.js, plan.js, charts.js

(function () {
  'use strict';

  // ===== 状态 =====
  var planCurrentEditing = null;   // 当前编辑中的计划（含 items）
  var planCurrentList = [];        // 当前展示的计划列表
  var planSelectedIds = new Set(); // 批量选择
  var planSortKey = 'updatedAt';
  var planSortOrder = 'desc';
  var planCurrentUser = null;
  var planIsLoggedIn = false;
  var planAutoSaveTimer = null;
  var planReminderTimers = new Map();

  // ===== 初始化 =====
  async function initPlanPage() {
    // 主题（与主页面统一使用 app_theme 键名）
    var savedTheme = localStorage.getItem('app_theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // 登录态
    checkLoginStatus();
    updateHeaderSyncUI();

    // 加载数据
    await loadAndRender();

    // 启动提醒
    startReminderScheduler();
  }

  async function loadAndRender() {
    try {
      var plans = await PlanModule.getAllPlans();
      planCurrentList = plans;
      renderPlanList();
      renderSummary();
      renderCharts();
    } catch (e) {
      console.error('加载计划失败:', e);
      showToast('加载计划失败：' + e.message, 'error');
    }
  }

  // ===== 列表渲染 =====
  function renderPlanList() {
    var container = document.getElementById('planList');
    var empty = document.getElementById('planEmptyState');
    var hint = document.getElementById('planListHint');

    var status = document.getElementById('statusFilter').value;
    var kw = (document.getElementById('searchKeyword').value || '').toLowerCase().trim();

    var dateFilter = document.getElementById('quickDateFilter').value;
    var dateRange = getDateRangeByQuickFilter(dateFilter);

    var filtered = planCurrentList.filter(function (p) {
      if (status !== 'all' && p.status !== status) return false;
      if (dateRange && (p.date < dateRange.start || p.date > dateRange.end)) return false;
      if (kw) {
        var haystack = (p.strategy || '') + ' ' + (p.marketSentiment || '') + ' ' + (p.notes || '');
        p.items.forEach(function (it) { haystack += ' ' + (it.symbol || ''); });
        if (haystack.toLowerCase().indexOf(kw) === -1) return false;
      }
      return true;
    });

    // 排序
    filtered.sort(function (a, b) {
      var va = a[planSortKey] || '';
      var vb = b[planSortKey] || '';
      if (planSortKey === 'date' || planSortKey === 'updatedAt' || planSortKey === 'createdAt') {
        va = Number(va) || 0; vb = Number(vb) || 0;
        return planSortOrder === 'asc' ? va - vb : vb - va;
      }
      if (va < vb) return planSortOrder === 'asc' ? -1 : 1;
      if (va > vb) return planSortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    hint.textContent = '共 ' + filtered.length + ' / ' + planCurrentList.length + ' 条';

    if (filtered.length === 0) {
      container.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    container.innerHTML = filtered.map(function (p) { return renderPlanCard(p); }).join('');
  }

  function renderPlanCard(p) {
    var status = PlanModule.PLAN_STATUS[p.status] || { label: p.status, color: 'gray' };
    var summary = PlanModule.summarizePlan(p);
    var marketsHtml = (p.markets || []).map(function (m) { return '<span class="tag">' + escapeHtml(m) + '</span>'; }).join('');
    var sessionLabel = (PlanModule.SESSION[p.tradingSession] || {}).label || '-';
    if (p.tradingSession === 'custom') sessionLabel = p.customSession || '自定义';

    var itemsHtml = (p.items || []).slice(0, 3).map(function (it) {
      var dirLabel = (PlanModule.DIRECTION[it.direction] || {}).label || it.direction;
      return '<div class="plan-card-item">' +
        '<span class="item-symbol">' + escapeHtml(it.symbol || '-') + '</span>' +
        '<span class="item-dir-' + it.direction + '">' + dirLabel + '</span>' +
        '</div>';
    }).join('');
    if ((p.items || []).length > 3) {
      itemsHtml += '<div class="plan-card-item" style="justify-content:center;color:var(--text-tertiary)">+ ' + (p.items.length - 3) + ' 更多</div>';
    }

    var pnlClass = summary.totalActualPnl >= 0 ? 'pnl-pos' : 'pnl-neg';
    var pnlText = (summary.totalActualPnl >= 0 ? '+' : '') + formatMoney(summary.totalActualPnl);

    return '' +
      '<div class="plan-card status-' + p.status + '">' +
        '<div class="plan-card-head">' +
          '<div class="plan-card-title">' +
            '<span>📅 ' + p.date + '</span>' +
            (p.reminderEnabled ? '<span class="reminder-badge">⏰ ' + (p.reminderTime || '') + '</span>' : '') +
          '</div>' +
          '<span class="plan-card-status status-' + p.status + '">' + status.label + '</span>' +
        '</div>' +
        '<div class="plan-card-body">' +
          '<div class="plan-card-meta">' + marketsHtml + '<span class="tag">🕐 ' + escapeHtml(sessionLabel) + '</span></div>' +
          (p.strategy ? '<div class="plan-card-strategy">' + escapeHtml(p.strategy) + '</div>' : '') +
          (itemsHtml ? '<div class="plan-card-items">' + itemsHtml + '</div>' : '<div class="plan-card-strategy" style="color:var(--text-tertiary)">暂无交易标的</div>') +
          '<div class="plan-card-stats">' +
            '<div class="plan-card-stat"><span class="label">标的数</span><span class="value">' + summary.itemCount + '</span></div>' +
            '<div class="plan-card-stat"><span class="label">已执行</span><span class="value">' + summary.executedCount + '</span></div>' +
            '<div class="plan-card-stat"><span class="label">计划风险</span><span class="value">¥' + formatMoney(summary.totalPlannedRisk) + '</span></div>' +
            '<div class="plan-card-stat"><span class="label">实际盈亏</span><span class="value ' + pnlClass + '">' + pnlText + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="plan-card-foot">' +
          '<button class="btn btn-ghost" onclick="viewPlan(\'' + p.id + '\')">👁 查看</button>' +
          '<button class="btn btn-ghost" onclick="editPlan(\'' + p.id + '\')">✏️ 编辑</button>' +
          '<button class="btn btn-ghost" onclick="duplicatePlan(\'' + p.id + '\')">📋 复制</button>' +
          '<button class="btn btn-ghost-danger" onclick="deletePlanConfirm(\'' + p.id + '\')">🗑</button>' +
        '</div>' +
      '</div>';
  }

  // ===== 统计区 =====
  function renderSummary() {
    var total = planCurrentList.length;
    var completed = planCurrentList.filter(function (p) { return p.status === 'completed'; }).length;
    var active = planCurrentList.filter(function (p) { return p.status === 'confirmed' || p.status === 'executed'; }).length;
    var rate = total === 0 ? 0 : Math.round((completed / total) * 100);
    var totalPnl = 0, totalRisk = 0;
    planCurrentList.forEach(function (p) {
      var s = PlanModule.summarizePlan(p);
      totalPnl += s.totalActualPnl;
      totalRisk += s.totalPlannedRisk;
    });

    document.getElementById('stat-total-count').textContent = total;
    document.getElementById('stat-completed-count').textContent = completed;
    document.getElementById('stat-completed-rate').textContent = rate + '%';
    document.getElementById('stat-active-count').textContent = active;

    var pnlEl = document.getElementById('stat-total-pnl');
    pnlEl.textContent = '¥' + formatMoney(totalPnl);
    pnlEl.className = 'stat-value ' + (totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg');

    document.getElementById('stat-total-risk').textContent = '¥' + formatMoney(totalRisk);
  }

  // ===== 图表 =====
  function renderCharts() {
    if (typeof drawPlanPnlChart === 'function') {
      drawPlanPnlChart('planPnlChart', planCurrentList);
    }
    if (typeof drawPlanStatusChart === 'function') {
      var counts = {};
      Object.keys(PlanModule.PLAN_STATUS).forEach(function (k) { counts[k] = 0; });
      planCurrentList.forEach(function (p) { counts[p.status] = (counts[p.status] || 0) + 1; });
      drawPlanStatusChart('planStatusChart', counts);
    }
  }

  // ===== 快速日期筛选 =====
  function getDateRangeByQuickFilter(type) {
    if (type === 'all') return null;
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    var today = new Date(y, m, d);
    if (type === 'today') return { start: iso(today), end: iso(today) };
    if (type === 'tomorrow') { var t = new Date(today); t.setDate(t.getDate() + 1); return { start: iso(t), end: iso(t) }; }
    if (type === 'thisWeek') {
      var dow = (today.getDay() + 6) % 7; // 周一为 0
      var mon = new Date(today); mon.setDate(today.getDate() - dow);
      var sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      return { start: iso(mon), end: iso(sun) };
    }
    if (type === 'lastWeek') {
      var dow2 = (today.getDay() + 6) % 7;
      var lmon = new Date(today); lmon.setDate(today.getDate() - dow2 - 7);
      var lsun = new Date(lmon); lsun.setDate(lmon.getDate() + 6);
      return { start: iso(lmon), end: iso(lsun) };
    }
    if (type === 'thisMonth') {
      var first = new Date(y, m, 1);
      var last = new Date(y, m + 1, 0);
      return { start: iso(first), end: iso(last) };
    }
    return null;
  }

  function applyQuickDateFilter() { renderPlanList(); }

  // ===== 编辑模态框 =====
  function openPlanEditModal(plan) {
    planCurrentEditing = plan;
    var modal = document.getElementById('planEditModal');
    var title = document.getElementById('planEditTitle');
    title.textContent = plan._isNew ? '➕ 新建交易计划' : ('✏️ 编辑计划 · ' + plan.date);
    document.getElementById('planEditBody').innerHTML = renderEditForm(plan);
    modal.style.display = 'flex';
  }

  function closePlanEditModal() {
    document.getElementById('planEditModal').style.display = 'none';
    planCurrentEditing = null;
  }

  function renderEditForm(plan) {
    var p = plan;
    var statusOptions = Object.keys(PlanModule.PLAN_STATUS).map(function (k) {
      return '<option value="' + k + '"' + (k === p.status ? ' selected' : '') + '>' + PlanModule.PLAN_STATUS[k].label + '</option>';
    }).join('');

    var sessionOptions = Object.keys(PlanModule.SESSION).map(function (k) {
      return '<option value="' + k + '"' + (k === p.tradingSession ? ' selected' : '') + '>' + PlanModule.SESSION[k].label + '</option>';
    }).join('');

    var marketsChips = PlanModule.MARKETS.map(function (m) {
      var active = (p.markets || []).indexOf(m) >= 0;
      return '<span class="market-chip' + (active ? ' active' : '') + '" data-market="' + m + '" onclick="toggleMarketChip(this)">' + m + '</span>';
    }).join('');

    var itemsHtml = (p.items || []).map(function (it, idx) { return renderItemBlock(it, idx); }).join('');

    return '' +
      '<div class="form-section">' +
        '<div class="form-section-title">📋 基本信息</div>' +
        '<div class="form-grid">' +
          '<div class="modal-field"><label>计划日期</label><input type="date" id="f-date" value="' + p.date + '"></div>' +
          '<div class="modal-field"><label>计划状态</label><select id="f-status">' + statusOptions + '</select></div>' +
        '</div>' +
        '<div class="modal-field">' +
          '<label>交易市场（可多选）</label>' +
          '<div class="market-chips" id="f-markets">' + marketsChips + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="form-section">' +
        '<div class="form-section-title">🎯 策略与目标</div>' +
        '<div class="modal-field"><label>主要交易策略</label><textarea id="f-strategy" placeholder="描述你的交易策略，例如：顺势突破、回调入场...">' + escapeHtml(p.strategy) + '</textarea></div>' +
        '<div class="form-grid">' +
          '<div class="modal-field"><label>盈利目标（元）</label><input type="number" id="f-profitTarget" value="' + (p.profitTarget || '') + '" step="0.01"></div>' +
          '<div class="modal-field"><label>风险控制目标（元）</label><input type="number" id="f-riskTarget" value="' + (p.riskTarget || '') + '" step="0.01"></div>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div class="modal-field"><label>交易时段</label><select id="f-session" onchange="onSessionChange()">' + sessionOptions + '</select></div>' +
          '<div class="modal-field" id="f-customSessionField" style="' + (p.tradingSession === 'custom' ? '' : 'display:none') + '"><label>自定义时段</label><input type="text" id="f-customSession" value="' + escapeHtml(p.customSession) + '" placeholder="如：09:30-11:30"></div>' +
        '</div>' +
        '<div class="modal-field"><label>市场情绪分析</label><textarea id="f-sentiment" placeholder="对当前市场情绪的判断...">' + escapeHtml(p.marketSentiment) + '</textarea></div>' +
      '</div>' +

      '<div class="form-section">' +
        '<div class="form-section-title">📊 具体交易标的</div>' +
        '<div class="plan-items-container" id="f-items-container">' + itemsHtml + '</div>' +
        '<button class="add-item-btn" onclick="addPlanItem()" style="margin-top:10px">+ 添加交易标的</button>' +
      '</div>' +

      '<div class="form-section">' +
        '<div class="form-section-title">⏰ 提醒与备注</div>' +
        '<div class="form-grid">' +
          '<div class="modal-field">' +
            '<label>启用提醒</label>' +
            '<select id="f-reminderEnabled" onchange="onReminderToggle()">' +
              '<option value="false"' + (!p.reminderEnabled ? ' selected' : '') + '>关闭</option>' +
              '<option value="true"' + (p.reminderEnabled ? ' selected' : '') + '>开启</option>' +
            '</select>' +
          '</div>' +
          '<div class="modal-field" id="f-reminderTimeField" style="' + (p.reminderEnabled ? '' : 'display:none') + '">' +
            '<label>提醒时间</label><input type="time" id="f-reminderTime" value="' + (p.reminderTime || '09:00') + '">' +
          '</div>' +
        '</div>' +
        '<div class="modal-field"><label>附加说明 / 笔记</label><textarea id="f-notes" placeholder="任何想记录的内容...">' + escapeHtml(p.notes) + '</textarea></div>' +
      '</div>';
  }

  function renderItemBlock(it, idx) {
    var directionOptions = Object.keys(PlanModule.DIRECTION).map(function (k) {
      return '<option value="' + k + '"' + (k === it.direction ? ' selected' : '') + '>' + PlanModule.DIRECTION[k].label + '</option>';
    }).join('');

    var execOptions = Object.keys(PlanModule.EXEC_STATUS).map(function (k) {
      return '<option value="' + k + '"' + (k === it.executionStatus ? ' selected' : '') + '>' + PlanModule.EXEC_STATUS[k].label + '</option>';
    }).join('');

    var rr = PlanModule.calcRR(it.entryPriceMin, it.targetPrice, it.stopLossPrice, it.direction);
    var rrBadge = '';
    if (rr && rr.ratio != null) {
      var cls = rr.ratio >= 2 ? 'good' : (rr.ratio >= 1 ? 'warn' : 'bad');
      rrBadge = '<span class="item-rr-badge ' + cls + '">R/R ' + PlanModule.formatRR(rr) + '</span>';
    }

    return '' +
      '<div class="plan-item-block" data-item-id="' + it.id + '">' +
        '<div class="plan-item-head">' +
          '<div class="plan-item-head-title">标的 #' + (idx + 1) + rrBadge + '</div>' +
          '<button class="plan-item-remove" onclick="removePlanItem(\'' + it.id + '\')" title="删除此标的">×</button>' +
        '</div>' +
        '<div class="form-grid">' +
          '<div class="modal-field"><label>标的代码/名称</label><input type="text" data-field="symbol" value="' + escapeHtml(it.symbol) + '" placeholder="如 BTC/USDT"></div>' +
          '<div class="modal-field"><label>交易方向</label><select data-field="direction" onchange="onItemFieldChange(\'' + it.id + '\')">' + directionOptions + '</select></div>' +
        '</div>' +
        '<div class="form-grid-3">' +
          '<div class="modal-field"><label>入场价区间-低</label><input type="number" data-field="entryPriceMin" value="' + (it.entryPriceMin || '') + '" step="0.0001" onchange="onItemFieldChange(\'' + it.id + '\')"></div>' +
          '<div class="modal-field"><label>入场价区间-高</label><input type="number" data-field="entryPriceMax" value="' + (it.entryPriceMax || '') + '" step="0.0001"></div>' +
          '<div class="modal-field"><label>实际入场价</label><input type="number" data-field="actualEntryPrice" value="' + (it.actualEntryPrice || '') + '" step="0.0001"></div>' +
        '</div>' +
        '<div class="form-grid-3">' +
          '<div class="modal-field"><label>目标止盈价</label><input type="number" data-field="targetPrice" value="' + (it.targetPrice || '') + '" step="0.0001" onchange="onItemFieldChange(\'' + it.id + '\')"></div>' +
          '<div class="modal-field"><label>止损价</label><input type="number" data-field="stopLossPrice" value="' + (it.stopLossPrice || '') + '" step="0.0001" onchange="onItemFieldChange(\'' + it.id + '\')"></div>' +
          '<div class="modal-field"><label>计划数量/仓位</label><input type="number" data-field="quantity" value="' + (it.quantity || '') + '" step="0.0001"></div>' +
        '</div>' +
        '<div class="modal-field"><label>交易理由/依据</label><textarea data-field="reason" placeholder="入场逻辑、技术形态、消息面...">' + escapeHtml(it.reason) + '</textarea></div>' +

        '<div class="form-section-title" style="margin-top:14px">📈 执行跟踪</div>' +
        '<div class="form-grid">' +
          '<div class="modal-field"><label>执行状态</label><select data-field="executionStatus">' + execOptions + '</select></div>' +
          '<div class="modal-field"><label>执行时间</label><input type="time" data-field="executionTime" value="' + escapeHtml(it.executionTime) + '"></div>' +
        '</div>' +
        '<div class="form-grid-3">' +
          '<div class="modal-field"><label>实际出场价</label><input type="number" data-field="actualExitPrice" value="' + (it.actualExitPrice || '') + '" step="0.0001"></div>' +
          '<div class="modal-field"><label>交易费用</label><input type="number" data-field="fee" value="' + (it.fee || 0) + '" step="0.01"></div>' +
          '<div class="modal-field"><label>实际盈亏</label><input type="number" data-field="realizedPnl" value="' + (it.realizedPnl != null ? it.realizedPnl : '') + '" step="0.01" placeholder="自动计算"></div>' +
        '</div>' +
        '<div class="modal-field"><label>结果备注</label><textarea data-field="resultNote" placeholder="成功/失败原因...">' + escapeHtml(it.resultNote) + '</textarea></div>' +
      '</div>';
  }

  // ===== 标的子项管理 =====
  function addPlanItem() {
    if (!planCurrentEditing) return;
    planCurrentEditing.items.push(PlanModule.createEmptyItem());
    refreshItemsContainer();
  }

  function removePlanItem(itemId) {
    if (!planCurrentEditing) return;
    if (!confirm('确认删除此交易标的？')) return;
    planCurrentEditing.items = planCurrentEditing.items.filter(function (it) { return it.id !== itemId; });
    refreshItemsContainer();
  }

  function refreshItemsContainer() {
    var container = document.getElementById('f-items-container');
    if (!container) return;
    container.innerHTML = planCurrentEditing.items.map(function (it, idx) { return renderItemBlock(it, idx); }).join('');
  }

  // ===== 收集表单数据 =====
  function collectFormData() {
    var p = planCurrentEditing;
    if (!p) return null;
    p.date = document.getElementById('f-date').value;
    p.status = document.getElementById('f-status').value;
    p.strategy = document.getElementById('f-strategy').value;
    p.profitTarget = numOrNull(document.getElementById('f-profitTarget').value);
    p.riskTarget = numOrNull(document.getElementById('f-riskTarget').value);
    p.tradingSession = document.getElementById('f-session').value;
    p.customSession = document.getElementById('f-customSession').value || '';
    p.marketSentiment = document.getElementById('f-sentiment').value;
    p.reminderEnabled = document.getElementById('f-reminderEnabled').value === 'true';
    p.reminderTime = document.getElementById('f-reminderTime').value;
    p.notes = document.getElementById('f-notes').value;

    // 收集 markets
    var chips = document.querySelectorAll('#f-markets .market-chip.active');
    p.markets = Array.prototype.map.call(chips, function (c) { return c.getAttribute('data-market'); });

    // 收集 items
    var blocks = document.querySelectorAll('.plan-item-block');
    var newItems = [];
    blocks.forEach(function (block) {
      var itemId = block.getAttribute('data-item-id');
      var existing = (p.items || []).find(function (it) { return it.id === itemId; });
      var it = existing || PlanModule.createEmptyItem();
      block.querySelectorAll('[data-field]').forEach(function (el) {
        var field = el.getAttribute('data-field');
        var val = el.value;
        if (['entryPriceMin', 'entryPriceMax', 'actualEntryPrice', 'targetPrice', 'stopLossPrice', 'quantity', 'actualExitPrice', 'fee', 'realizedPnl'].indexOf(field) >= 0) {
          it[field] = numOrNull(val);
        } else {
          it[field] = val;
        }
      });
      // 自动计算实际盈亏
      if (it.actualExitPrice != null && it.actualEntryPrice != null) {
        it.realizedPnl = PlanModule.calcPnL(it.direction, it.actualEntryPrice, it.actualExitPrice, it.quantity, it.fee);
      }
      newItems.push(it);
    });
    p.items = newItems;
    return p;
  }

  // ===== 保存 =====
  async function saveCurrentPlan() {
    var p = collectFormData();
    if (!p) return;
    // 状态自动联动
    if (p.items.length > 0 && p.status === 'draft' && confirm('该计划已添加交易标的，是否自动标记为"已确认"？')) {
      p.status = 'confirmed';
    }
    if (p.items.some(function (it) { return it.executionStatus === 'full' || it.executionStatus === 'partial'; }) && p.status === 'confirmed') {
      p.status = 'executed';
    }
    try {
      await PlanModule.savePlan(p);
      closePlanEditModal();
      showToast('计划已保存', 'success');
      await loadAndRender();
    } catch (e) {
      console.error(e);
      showToast('保存失败：' + e.message, 'error');
    }
  }

  // ===== 模板功能 =====
  async function openTemplateModal() {
    var modal = document.getElementById('templateModal');
    modal.style.display = 'flex';
    var tmpls = await PlanModule.getAllTemplates();
    var list = document.getElementById('templateList');
    var empty = document.getElementById('templateEmptyState');
    if (!tmpls || tmpls.length === 0) {
      list.innerHTML = ''; empty.style.display = 'block'; return;
    }
    empty.style.display = 'none';
    list.innerHTML = tmpls.map(function (t) {
      return '<div class="template-item">' +
        '<div class="template-item-name">📋 ' + escapeHtml(t.name) + ' <small style="color:var(--text-tertiary)">（' + (t.items || []).length + ' 个标的）</small></div>' +
        '<div class="template-item-actions">' +
          '<button class="btn btn-ghost" onclick="applyTemplate(\'' + t.id + '\')">应用</button>' +
          '<button class="btn btn-ghost-danger" onclick="deleteTemplateConfirm(\'' + t.id + '\')">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function closeTemplateModal() { document.getElementById('templateModal').style.display = 'none'; }

  async function saveAsTemplateFromEdit() {
    var name = prompt('请输入模板名称：', '我的模板');
    if (!name) return;
    var p = collectFormData();
    if (!p) return;
    var tmpl = {
      id: PlanModule.genId('tmpl'),
      name: name,
      markets: p.markets,
      strategy: p.strategy,
      profitTarget: p.profitTarget,
      riskTarget: p.riskTarget,
      tradingSession: p.tradingSession,
      customSession: p.customSession,
      marketSentiment: p.marketSentiment,
      items: p.items.map(function (it) {
        return {
          id: PlanModule.genId('item'),
          symbol: it.symbol,
          direction: it.direction,
          entryPriceMin: it.entryPriceMin,
          entryPriceMax: it.entryPriceMax,
          targetPrice: it.targetPrice,
          stopLossPrice: it.stopLossPrice,
          quantity: it.quantity,
          reason: it.reason,
        };
      }),
    };
    try {
      await PlanModule.saveTemplate(tmpl);
      showToast('模板已保存', 'success');
    } catch (e) {
      showToast('保存失败：' + e.message, 'error');
    }
  }

  async function applyTemplate(tmplId) {
    var tmpls = await PlanModule.getAllTemplates();
    var t = tmpls.find(function (x) { return x.id === tmplId; });
    if (!t) return;
    var newPlan = PlanModule.createEmptyPlan();
    newPlan.markets = (t.markets || []).slice();
    newPlan.strategy = t.strategy;
    newPlan.profitTarget = t.profitTarget;
    newPlan.riskTarget = t.riskTarget;
    newPlan.tradingSession = t.tradingSession;
    newPlan.customSession = t.customSession;
    newPlan.marketSentiment = t.marketSentiment;
    newPlan.items = (t.items || []).map(function (it) {
      var copy = PlanModule.createEmptyItem();
      Object.keys(it).forEach(function (k) { copy[k] = it[k]; });
      return copy;
    });
    newPlan._isNew = true;
    closeTemplateModal();
    openPlanEditModal(newPlan);
  }

  async function deleteTemplateConfirm(tmplId) {
    if (!confirm('确认删除该模板？')) return;
    await PlanModule.deleteTemplate(tmplId);
    openTemplateModal();
  }

  // ===== 列表操作 =====
  function createNewPlan() {
    var p = PlanModule.createEmptyPlan();
    p._isNew = true;
    openPlanEditModal(p);
  }

  async function editPlan(id) {
    var p = await PlanModule.getPlan(id);
    if (!p) { showToast('计划不存在', 'error'); return; }
    openPlanEditModal(p);
  }

  async function viewPlan(id) {
    var p = await PlanModule.getPlan(id);
    if (!p) { showToast('计划不存在', 'error'); return; }
    var summary = PlanModule.summarizePlan(p);
    var status = PlanModule.PLAN_STATUS[p.status];
    var msg = '' +
      '日期: ' + p.date + '\n' +
      '状态: ' + (status ? status.label : p.status) + '\n' +
      '策略: ' + (p.strategy || '-') + '\n' +
      '标的数: ' + summary.itemCount + '\n' +
      '已执行: ' + summary.executedCount + '\n' +
      '计划风险: ¥' + formatMoney(summary.totalPlannedRisk) + '\n' +
      '实际盈亏: ' + formatMoney(summary.totalActualPnl);
    alert(msg);
  }

  async function duplicatePlan(id) {
    var p = await PlanModule.getPlan(id);
    if (!p) return;
    var copy = JSON.parse(JSON.stringify(p));
    copy.id = PlanModule.genId('plan');
    copy.date = PlanModule.todayISO();
    copy.status = 'draft';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    copy.items.forEach(function (it) { it.id = PlanModule.genId('item'); it.executionStatus = 'not_executed'; it.actualEntryPrice = null; it.actualExitPrice = null; it.realizedPnl = null; });
    try {
      await PlanModule.savePlan(copy);
      showToast('已复制为新计划', 'success');
      await loadAndRender();
    } catch (e) {
      showToast('复制失败：' + e.message, 'error');
    }
  }

  async function deletePlanConfirm(id) {
    if (!confirm('确认删除此计划？此操作不可恢复。')) return;
    try {
      await PlanModule.deletePlan(id);
      showToast('已删除', 'success');
      await loadAndRender();
    } catch (e) {
      showToast('删除失败：' + e.message, 'error');
    }
  }

  // ===== 导入/导出 =====
  function exportAllPlans() {
    var data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      plans: planCurrentList,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'trading-plans-' + PlanModule.todayISO() + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('已导出', 'success');
  }

  async function importPlansData(event) {
    var file = event.target.files[0];
    if (!file) return;
    var text = await file.text();
    try {
      var data = JSON.parse(text);
      if (!data.plans || !Array.isArray(data.plans)) throw new Error('文件格式不正确');
      if (!confirm('将导入 ' + data.plans.length + ' 条计划，是否继续？')) return;
      for (var p of data.plans) {
        if (!p.id) p.id = PlanModule.genId('plan');
        await PlanModule.savePlan(p);
      }
      showToast('导入成功', 'success');
      await loadAndRender();
    } catch (e) {
      showToast('导入失败：' + e.message, 'error');
    }
    event.target.value = '';
  }

  // ===== 提醒调度 =====
  function startReminderScheduler() {
    if (planReminderTimers.size > 0) {
      planReminderTimers.forEach(function (t) { clearTimeout(t); });
      planReminderTimers.clear();
    }
    var now = new Date();
    planCurrentList.forEach(function (p) {
      if (!p.reminderEnabled || !p.reminderTime) return;
      var parts = p.reminderTime.split(':');
      var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(parts[0]), Number(parts[1]), 0);
      if (target.getTime() <= now.getTime()) return; // 已过时间不提醒
      var diff = target.getTime() - now.getTime();
      if (diff > 24 * 60 * 60 * 1000) return;
      var timer = setTimeout(function () {
        showToast('⏰ 提醒：' + p.date + ' 的交易计划待执行', 'info');
        try { if (Notification && Notification.permission === 'granted') new Notification('交易计划提醒', { body: p.date + ' 的计划待执行' }); } catch (e) {}
      }, diff);
      planReminderTimers.set(p.id, timer);
    });
  }

  // ===== 事件回调（暴露到 window 供 inline 使用）=====
  window.toggleMarketChip = function (chip) {
    chip.classList.toggle('active');
  };

  window.onSessionChange = function () {
    var v = document.getElementById('f-session').value;
    document.getElementById('f-customSessionField').style.display = v === 'custom' ? '' : 'none';
  };

  window.onReminderToggle = function () {
    var v = document.getElementById('f-reminderEnabled').value;
    document.getElementById('f-reminderTimeField').style.display = v === 'true' ? '' : 'none';
  };

  window.onItemFieldChange = function (itemId) {
    // 输入变化时重算 R/R 徽章
    var block = document.querySelector('.plan-item-block[data-item-id="' + itemId + '"]');
    if (!block) return;
    var fields = {};
    block.querySelectorAll('[data-field]').forEach(function (el) {
      fields[el.getAttribute('data-field')] = el.value;
    });
    var rr = PlanModule.calcRR(fields.entryPriceMin, fields.targetPrice, fields.stopLossPrice, fields.direction);
    var titleEl = block.querySelector('.plan-item-head-title');
    if (!titleEl) return;
    var oldBadge = titleEl.querySelector('.item-rr-badge');
    if (oldBadge) oldBadge.remove();
    if (rr && rr.ratio != null) {
      var cls = rr.ratio >= 2 ? 'good' : (rr.ratio >= 1 ? 'warn' : 'bad');
      var badge = document.createElement('span');
      badge.className = 'item-rr-badge ' + cls;
      badge.textContent = 'R/R ' + PlanModule.formatRR(rr);
      titleEl.appendChild(badge);
    }
  };

  // ===== 头部同步相关（与主页面保持一致）=====
  // 注意：登录信息存储在 localStorage 的 'sync_user' 键（见 sync.js）
  // sync.js 已经导出了 getCurrentUser() 和 isLoggedIn() 全局函数，直接复用
  function checkLoginStatus() {
    var u = null;
    try {
      // 优先使用 sync.js 暴露的全局函数
      if (typeof getCurrentUser === 'function') {
        u = getCurrentUser();
      } else {
        // 兜底：直接读取 localStorage
        var saved = localStorage.getItem('sync_user');
        if (saved) u = JSON.parse(saved);
      }
    } catch (e) { u = null; }
    planCurrentUser = u;
    planIsLoggedIn = !!(u && u.username);
  }

  function updateHeaderSyncUI() {
    var lo = document.getElementById('headerSyncLoggedIn');
    var lo2 = document.getElementById('headerSyncLoggedOut');
    var username = document.getElementById('headerUsername');
    var autoBtn = document.getElementById('headerBtnAutoSync');
    if (planIsLoggedIn) {
      lo.style.display = 'flex';
      lo2.style.display = 'none';
      if (username) username.textContent = planCurrentUser.username;
    } else {
      lo.style.display = 'none';
      lo2.style.display = 'flex';
    }
    var autoSync = (typeof SYNC_CONFIG !== 'undefined' && SYNC_CONFIG.autoSync);
    if (autoBtn) autoBtn.textContent = '自动: ' + (autoSync ? '开' : '关');
  }

  // 暴露给 inline onclick
  window.goBackToMain = function () { location.href = 'index.html'; };
  window.closePlanEditModal = closePlanEditModal;
  window.saveCurrentPlan = saveCurrentPlan;
  window.addPlanItem = addPlanItem;
  window.removePlanItem = removePlanItem;
  window.createNewPlan = createNewPlan;
  window.editPlan = editPlan;
  window.viewPlan = viewPlan;
  window.duplicatePlan = duplicatePlan;
  window.deletePlanConfirm = deletePlanConfirm;
  window.exportAllPlans = exportAllPlans;
  window.importPlansData = importPlansData;
  window.applyQuickDateFilter = applyQuickDateFilter;
  window.openTemplateModal = openTemplateModal;
  window.closeTemplateModal = closeTemplateModal;
  window.saveAsTemplateFromEdit = saveAsTemplateFromEdit;
  window.applyTemplate = applyTemplate;
  window.deleteTemplateConfirm = deleteTemplateConfirm;
  window.renderPlanList = renderPlanList;

  // ===== 工具 =====
  function numOrNull(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatMoney(n) {
    if (n == null || isNaN(n)) return '0.00';
    return Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function showToast(msg, type) {
    if (typeof showSyncStatus === 'function') {
      showSyncStatus(msg, type === 'error' ? 'error' : 'success');
    } else {
      console.log('[' + (type || 'info') + ']', msg);
    }
  }

  // ===== 头部 Modal 与认证（与主页面兼容的子集）=====
  window.openLoginModal = function () {
    var m = document.getElementById('loginModal');
    if (m) m.style.display = 'flex';
    setTimeout(function () { var u = document.getElementById('loginUsername'); if (u) u.focus(); }, 100);
  };
  window.closeLoginModal = function () {
    var m = document.getElementById('loginModal');
    if (m) m.style.display = 'none';
  };
  window.openChangePasswordModal = function () {
    var m = document.getElementById('changePasswordModal');
    if (m) m.style.display = 'flex';
  };
  window.closeChangePasswordModal = function () {
    var m = document.getElementById('changePasswordModal');
    if (m) m.style.display = 'none';
    var o = document.getElementById('oldPassword'); if (o) o.value = '';
    var n = document.getElementById('newPassword'); if (n) n.value = '';
    var c = document.getElementById('confirmPassword'); if (c) c.value = '';
  };

  window.handleLogin = async function () {
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    if (!username || !password) { showToast('请填写用户名和密码', 'error'); return; }
    try {
      var res = await login(username, password);
      if (res && res.success) {
        showToast('登录成功', 'success');
        closeLoginModal();
        planIsLoggedIn = true;
        checkLoginStatus();
        updateHeaderSyncUI();
      } else {
        showToast((res && res.error) || '登录失败', 'error');
      }
    } catch (e) {
      showToast('登录失败：' + e.message, 'error');
    }
  };

  window.handleRegister = async function () {
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    if (!username || !password) { showToast('请填写用户名和密码', 'error'); return; }
    if (password.length < 6) { showToast('密码至少 6 位', 'error'); return; }
    try {
      var res = await register(username, password);
      if (res && res.success) {
        showToast('注册成功，已自动登录', 'success');
        closeLoginModal();
        planIsLoggedIn = true;
        checkLoginStatus();
        updateHeaderSyncUI();
      } else {
        showToast((res && res.error) || '注册失败', 'error');
      }
    } catch (e) {
      showToast('注册失败：' + e.message, 'error');
    }
  };

  window.handleLogout = function () {
    if (!confirm('确定要退出登录吗？')) return;
    logout();
    planIsLoggedIn = false;
    planCurrentUser = null;
    checkLoginStatus();
    updateHeaderSyncUI();
    showToast('已退出', 'success');
  };

  window.handleChangePassword = async function () {
    var oldPwd = document.getElementById('oldPassword').value;
    var newPwd = document.getElementById('newPassword').value;
    var confirmPwd = document.getElementById('confirmPassword').value;
    if (!oldPwd || !newPwd) { showToast('请填写旧密码和新密码', 'error'); return; }
    if (newPwd.length < 6) { showToast('新密码至少 6 位', 'error'); return; }
    if (newPwd !== confirmPwd) { showToast('两次输入的新密码不一致', 'error'); return; }
    try {
      var user = getCurrentUser();
      if (!user) { showToast('请先登录', 'error'); return; }
      var res = await fetch((typeof getServerUrl === 'function' ? getServerUrl() : '') + '/api/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (user.token || '') },
        body: JSON.stringify({ username: user.username, oldPassword: oldPwd, newPassword: newPwd }),
      });
      var data = await res.json();
      if (data && data.success) {
        showToast('密码修改成功', 'success');
        closeChangePasswordModal();
      } else {
        showToast((data && data.error) || '修改失败', 'error');
      }
    } catch (e) {
      showToast('修改失败：' + e.message, 'error');
    }
  };

  window.handleFullSync = async function () {
    try {
      showToast('正在同步...', 'info');
      if (typeof fullSync === 'function') {
        await fullSync();
        showToast('同步完成', 'success');
        await loadAndRender();
      } else {
        showToast('同步模块未就绪', 'error');
      }
    } catch (e) {
      showToast('同步失败：' + e.message, 'error');
    }
  };

  window.handleToggleAutoSync = function () {
    if (typeof toggleAutoSync === 'function') {
      toggleAutoSync();
      updateHeaderSyncUI();
    }
  };

  // ===== 启动 =====
  document.addEventListener('DOMContentLoaded', function () {
    initDatabase()
      .then(function () { return initPlanPage(); })
      .catch(function (e) { console.error('初始化失败:', e); });
  });
})();
