/* StaffPay client-side behaviour for the XianFire server-rendered pages. */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const csrf = () => $('meta[name="csrf-token"]')?.content || '';
  const pad = (n) => String(n).padStart(2, '0');

  // ---------------------------------------------------------------- toasts
  function toast(message, type = 'success') {
    let stack = $('.toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; document.body.appendChild(stack); }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('data-toast', '');
    el.innerHTML = '<span></span><button type="button" class="toast-close" data-toast-close aria-label="Dismiss">×</button>';
    el.querySelector('span').textContent = message;
    stack.appendChild(el);
    autoDismiss(el);
  }
  function autoDismiss(el) {
    const ms = el.classList.contains('toast-error') ? 7000 : 4500;
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, ms);
  }
  $$('[data-toast]').forEach(autoDismiss);
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toast-close]');
    if (btn) btn.closest('[data-toast]').remove();
  });
  window.StaffPay = { toast };

  // ---------------------------------------------------------------- sidebar & dropdowns
  const sidebar = $('[data-sidebar]');
  const overlay = $('[data-sidebar-overlay]');
  const setSidebar = (open) => { sidebar?.classList.toggle('open', open); overlay?.classList.toggle('show', open); };
  $('[data-sidebar-open]')?.addEventListener('click', () => setSidebar(true));
  $('[data-sidebar-close]')?.addEventListener('click', () => setSidebar(false));
  overlay?.addEventListener('click', () => setSidebar(false));

  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-dropdown-toggle]');
    $$('[data-dropdown].open').forEach((d) => { if (!toggle || d !== toggle.closest('[data-dropdown]')) { if (!d.contains(e.target)) d.classList.remove('open'); } });
    if (toggle) {
      const dd = toggle.closest('[data-dropdown]');
      dd.classList.toggle('open');
      if (dd.classList.contains('open') && dd.hasAttribute('data-notifications')) loadNotifications();
    }
  });

  // ---------------------------------------------------------------- clocks
  const fmtTime = (d, seconds = true) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const fmtDate = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  function tick() {
    const now = new Date();
    $$('[data-clock="time"]').forEach((el) => { el.textContent = fmtTime(now); });
    $$('[data-clock="date"]').forEach((el) => { el.textContent = fmtDate(now); });
    $$('[data-elapsed-since]').forEach((el) => {
      const start = parseLocal(el.dataset.elapsedSince);
      if (!start) return;
      const mins = Math.max(0, Math.floor((now - start) / 60000));
      el.textContent = `${Math.floor(mins / 60)}h ${mins % 60}m`;
    });
  }
  tick();
  setInterval(tick, 1000);

  function parseLocal(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : null;
  }

  // ---------------------------------------------------------------- modals
  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add('modal-open');
    const first = modal.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
    if (first) setTimeout(() => first.focus(), 30);
  }
  function closeModal(modal) {
    modal.hidden = true;
    if (!$$('.modal-backdrop:not([hidden])').length) document.body.classList.remove('modal-open');
  }

  function clearErrors(form) {
    $$('.field.has-error', form).forEach((f) => f.classList.remove('has-error'));
    $$('[data-field-error]', form).forEach((e) => e.remove());
  }

  function showErrors(form, errors = {}) {
    for (const [name, message] of Object.entries(errors)) {
      const input = form.querySelector(`[name="${name}"], [name="${name}[]"]`);
      const field = input?.closest('.field') || input?.parentElement;
      if (!field) continue;
      field.classList.add('has-error');
      const span = document.createElement('span');
      span.className = 'field-error';
      span.setAttribute('data-field-error', '');
      span.textContent = message;
      field.appendChild(span);
    }
  }

  /** Fill a form from a record object (by input name). */
  function fillForm(form, record) {
    for (const el of form.elements) {
      if (!el.name || el.name === '_csrf' || el.type === 'file') continue;
      const key = el.name.replace(/\[\]$/, '');
      if (!(key in record)) continue;
      let value = record[key];
      if (el.type === 'checkbox') {
        if (el.name.endsWith('[]')) el.checked = (Array.isArray(value) ? value : [value]).map(String).includes(el.value);
        else el.checked = value === true || value === 1 || value === '1' || value === 'on' || value === 'true';
      } else if (el.type === 'radio') {
        el.checked = String(value) === el.value;
      } else {
        if (value === null || value === undefined) value = '';
        if (el.type === 'datetime-local' && value) value = String(value).replace(' ', 'T').slice(0, 16);
        if (el.type === 'date' && value) value = String(value).slice(0, 10);
        if (el.type === 'time' && value) value = String(value).slice(0, 5);
        el.value = value;
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-modal]');
    if (opener) {
      e.preventDefault();
      const modal = $(opener.dataset.modal);
      if (!modal) return;
      const form = modal.querySelector('form');
      if (form) {
        form.reset();
        clearErrors(form);
        $$('[data-show-when-new]', form).forEach((x) => { x.hidden = Boolean(opener.dataset.record); });
        $$('[data-show-when-edit]', form).forEach((x) => { x.hidden = !opener.dataset.record; });
        if (opener.dataset.action) form.action = opener.dataset.action;
        const record = opener.dataset.record ? JSON.parse(opener.dataset.record) : {};
        $$('[data-show-if]', form).forEach((x) => { x.hidden = !record[x.dataset.showIf]; });
        $$('[data-hide-if]', form).forEach((x) => { x.hidden = Boolean(record[x.dataset.hideIf]); });
        if (opener.dataset.record) fillForm(form, record);
        if (opener.dataset.defaults) fillForm(form, JSON.parse(opener.dataset.defaults));
        syncToggles();
        const submit = form.querySelector('[data-submit-label]');
        if (submit && opener.dataset.submit) submit.textContent = opener.dataset.submit;
        if (submit && opener.dataset.tone) submit.className = `btn btn-${opener.dataset.tone}`;
      }
      const title = modal.querySelector('[data-modal-title]');
      if (title) title.textContent = opener.dataset.title || title.dataset.default;
      const sub = modal.querySelector('[data-modal-subtitle]');
      if (sub && opener.dataset.subtitle !== undefined) sub.textContent = opener.dataset.subtitle;
      $$('[data-fill-text]', modal).forEach((el) => {
        const v = opener.dataset[`text${el.dataset.fillText}`];
        if (v !== undefined) el.textContent = v;
      });
      openModal(modal);
      return;
    }
    const closer = e.target.closest('[data-close]');
    if (closer) closeModal(closer.closest('.modal-backdrop'));
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target.classList?.contains('modal-backdrop')) closeModal(e.target);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop:not([hidden])').forEach(closeModal);
  });

  // Re-open a modal after a failed submission (server flashes values + errors).
  const state = $('#form-state');
  if (state) {
    try {
      const fs = JSON.parse(state.textContent);
      const modal = fs.modal && $(fs.modal);
      const form = modal ? modal.querySelector('form') : (fs.form && $(fs.form));
      if (form) {
        if (fs.action && modal) form.action = fs.action;
        fillForm(form, fs.values || {});
        showErrors(form, fs.errors || {});
        if (modal) openModal(modal);
      }
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- confirm dialogs
  const confirmDialog = $('#confirm-dialog');
  let pendingForm = null;
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.confirm && !form.dataset.confirmed && confirmDialog) {
      e.preventDefault();
      pendingForm = form;
      $('[data-confirm-message]', confirmDialog).textContent = form.dataset.confirm;
      $('[data-confirm-title]', confirmDialog).textContent = form.dataset.confirmTitle || 'Are you sure?';
      const ok = $('[data-confirm-ok]', confirmDialog);
      ok.textContent = form.dataset.confirmLabel || 'Confirm';
      ok.className = `btn btn-${form.dataset.confirmTone || 'danger'}`;
      openModal(confirmDialog);
      return;
    }
    // Busy state on submit buttons (prevents double submission).
    const btn = e.submitter || form.querySelector('[type=submit]');
    if (btn && !form.target) setTimeout(() => btn.classList.add('is-busy'), 0);
  });
  $('[data-confirm-ok]', confirmDialog || document)?.addEventListener('click', () => {
    if (!pendingForm) return;
    pendingForm.dataset.confirmed = '1';
    closeModal(confirmDialog);
    if (pendingForm.requestSubmit) pendingForm.requestSubmit(); else pendingForm.submit();
  });

  // ---------------------------------------------------------------- filters auto-submit
  $$('form[data-autosubmit]').forEach((form) => {
    let t;
    form.addEventListener('change', (e) => {
      if (e.target.matches('select, input[type=date], input[type=month], input[type=checkbox]')) {
        const page = form.querySelector('[name=page]'); if (page) page.value = 1;
        form.submit();
      }
    });
    form.addEventListener('input', (e) => {
      if (!e.target.matches('input[type=search]')) return;
      clearTimeout(t);
      t = setTimeout(() => form.submit(), 600);
    });
  });

  // ---------------------------------------------------------------- check-all & list filter
  document.addEventListener('change', (e) => {
    const all = e.target.closest('[data-check-all]');
    if (all) $$(all.dataset.checkAll).filter((c) => !c.closest('[hidden]') && c.closest('label')?.style.display !== 'none').forEach((c) => { c.checked = all.checked; });
  });
  document.addEventListener('input', (e) => {
    const f = e.target.closest('[data-filter-list]');
    if (!f) return;
    const q = f.value.toLowerCase();
    $$(`${f.dataset.filterList} label`).forEach((l) => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none'; });
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-filter-target]');
    if (!sel) return;
    const v = sel.value;
    $$(`${sel.dataset.filterTarget} [data-group]`).forEach((l) => { l.style.display = !v || l.dataset.group === v ? '' : 'none'; });
  });

  // Employee form: choosing a position fills department + default salary.
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-position-select]');
    if (!sel) return;
    const opt = sel.selectedOptions[0];
    const form = sel.form;
    if (opt?.dataset.department && form.department_id) form.department_id.value = opt.dataset.department;
    if (opt?.dataset.salary && form.basic_salary && !form.basic_salary.value) form.basic_salary.value = opt.dataset.salary;
  });
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-department-select]');
    if (!sel) return;
    const pos = sel.form?.position_id;
    if (!pos) return;
    $$('option[data-department]', pos).forEach((o) => { o.hidden = Boolean(sel.value) && o.dataset.department !== sel.value; });
    if (pos.selectedOptions[0]?.hidden) pos.value = '';
  });

  // Holiday type -> default rate
  document.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-holiday-type]');
    if (sel && sel.form.rate) sel.form.rate.value = sel.value === 'regular' ? '2.00' : '1.30';
  });

  // Toggle sections with a checkbox: <input data-toggle-target="#id">
  function syncToggles() { $$('[data-toggle-target]').forEach((c) => { const t = $(c.dataset.toggleTarget); if (t) t.hidden = !c.checked; }); }
  document.addEventListener('change', (e) => { if (e.target.closest('[data-toggle-target]')) syncToggles(); });
  syncToggles();

  // ---------------------------------------------------------------- leave preview
  $$('[data-leave-preview]').forEach((box) => {
    const form = box.closest('form');
    const out = $('[data-leave-preview-output]', box);
    const update = async () => {
      const s = form.start_date.value; const e = form.end_date.value;
      if (!s || !e || e < s) { out.textContent = ''; return; }
      try {
        const res = await fetch(`/my/leaves/preview.json?start_date=${s}&end_date=${e}&leave_type=${form.leave_type.value}`, { headers: { Accept: 'application/json' } });
        const data = await res.json();
        out.textContent = data.message || '';
        out.className = `alert alert-${data.warning ? 'warning' : 'info'} leave-preview`;
      } catch { out.textContent = ''; }
    };
    form.addEventListener('change', (ev) => {
      if (ev.target.name === 'start_date' && !form.end_date.value) form.end_date.value = form.start_date.value;
      update();
    });
  });

  // ---------------------------------------------------------------- notifications
  async function loadNotifications() {
    const list = $('[data-notification-list]');
    if (!list) return;
    try {
      const res = await fetch('/notifications.json', { headers: { Accept: 'application/json' } });
      const data = await res.json();
      renderUnread(data.unread);
      list.innerHTML = '';
      if (!data.data.length) { list.innerHTML = '<p class="text-muted notifications-empty">You\'re all caught up.</p>'; return; }
      for (const n of data.data) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `notification-item ${n.read_at ? '' : 'unread'}`;
        b.innerHTML = `<span class="notification-dot tone-${n.type}"></span><span class="notification-text"><strong></strong><span></span><small></small></span>`;
        b.querySelector('strong').textContent = n.title;
        b.querySelector('.notification-text span').textContent = n.message;
        b.querySelector('small').textContent = n.created_label;
        b.addEventListener('click', async () => {
          if (!n.read_at) await post(`/notifications/${n.id}/read`);
          if (n.link) window.location.href = n.link; else loadNotifications();
        });
        list.appendChild(b);
      }
    } catch {
      list.innerHTML = '<p class="text-muted notifications-empty">Could not load notifications.</p>';
    }
  }
  function renderUnread(n) {
    const dot = $('[data-unread]');
    if (!dot) return;
    dot.hidden = !n;
    dot.textContent = n > 9 ? '9+' : n;
  }
  async function post(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf() },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
  }
  $('[data-mark-all]')?.addEventListener('click', async () => { await post('/notifications/read-all'); loadNotifications(); });
  if ($('[data-unread]')) {
    setInterval(async () => {
      try { const r = await fetch('/notifications.json', { headers: { Accept: 'application/json' } }); if (r.ok) renderUnread((await r.json()).unread); } catch { /* offline */ }
    }, 60000);
  }

  // ---------------------------------------------------------------- import format tester
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-format-test]');
    if (!btn) return;
    const form = btn.closest('form');
    const out = $('[data-format-result]', form);
    const body = Object.fromEntries(new FormData(form).entries());
    body.sample = $('[data-format-sample]', form).value;
    out.hidden = false;
    out.textContent = 'Testing…';
    try {
      const res = await fetch('/attendance/import/formats/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf() },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { out.textContent = data.message || 'Test failed.'; return; }
      const lines = [`Punches read: ${data.summary.punches} · employees identified: ${data.summary.identified_employees} · unknown IDs: ${data.summary.unrecognized_ids}`];
      data.rows.forEach((r) => lines.push(`${r.code} ${r.name} ${r.date}  in ${r.in || '—'}  out ${r.out || '—'}  [${r.status}] ${r.message}`));
      data.errors.forEach((er) => lines.push(`! ${er}`));
      out.textContent = lines.join('\n');
    } catch {
      out.textContent = 'Could not reach the server.';
    }
  });

  // ---------------------------------------------------------------- print
  document.addEventListener('click', (e) => { if (e.target.closest('[data-print]')) window.print(); });

  // ---------------------------------------------------------------- charts (Chart.js)
  const COLORS = ['#1e3a5f', '#f59e0b', '#ef4444', '#0ea5e9', '#10b981', '#8b5cf6', '#3b82f6', '#64748b'];
  if (window.Chart) {
    Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
    Chart.defaults.color = '#6b7686';
    $$('canvas[data-chart]').forEach((canvas) => {
      const cfg = JSON.parse(document.getElementById(canvas.dataset.chart).textContent);
      const peso = (v) => `₱${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const isPie = cfg.type === 'doughnut' || cfg.type === 'pie';
      const colors = cfg.colors || COLORS;
      new Chart(canvas, {
        type: cfg.type || 'bar',
        data: {
          labels: cfg.labels,
          datasets: cfg.datasets.map((d, i) => ({
            ...d,
            backgroundColor: isPie ? colors : colors[i % colors.length],
            borderColor: isPie ? '#fff' : colors[i % colors.length],
            borderWidth: cfg.type === 'line' ? 2 : isPie ? 2 : 0,
            tension: 0.3,
            borderRadius: cfg.type === 'bar' && !cfg.stacked ? 4 : 0,
            pointRadius: 3,
          })),
        },
        options: {
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } },
            tooltip: { callbacks: cfg.money ? { label: (c) => `${c.dataset.label || c.label}: ${peso(c.parsed.y ?? c.parsed)}` } : {} },
          },
          scales: isPie ? {} : {
            x: { stacked: Boolean(cfg.stacked), grid: { display: false } },
            y: { stacked: Boolean(cfg.stacked), beginAtZero: true, ticks: cfg.money ? { callback: (v) => `${Math.round(v / 1000)}k` } : { precision: 0 } },
          },
          cutout: cfg.type === 'doughnut' ? '60%' : undefined,
        },
      });
    });
  }
})();
