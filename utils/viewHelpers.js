/*
 * Handlebars helpers available in every .xian view.
 */
import { ICONS } from './icons.js';
import {
  STATUS_MAPS, ROLE_LABELS, LEAVE_TYPE_LABELS, EMPLOYMENT_TYPE_LABELS, DEDUCTION_TYPE_LABELS, WEEKDAYS,
} from './constants.js';
import {
  money, number, formatDate, formatTime, formatDateTime, formatClock, minutesToHours, titleCase, initials,
} from './format.js';
import { toDateStr, toDateTimeInput, toDateTimeStr, parseDate, today } from './time.js';

const isOptions = (x) => x && typeof x === 'object' && 'hash' in x && 'data' in x;
const args = (list) => list.filter((a) => !isOptions(a));

export function registerHelpers(hbs) {
  const { SafeString, escapeExpression: esc } = hbs.handlebars;
  const h = (name, fn) => hbs.registerHelper(name, fn);

  // ---- logic
  h('eq', (a, b) => String(a) === String(b));
  h('ne', (a, b) => String(a) !== String(b));
  h('gt', (a, b) => Number(a) > Number(b));
  h('gte', (a, b) => Number(a) >= Number(b));
  h('lt', (a, b) => Number(a) < Number(b));
  h('and', (...a) => args(a).every(Boolean));
  h('or', (...a) => args(a).some(Boolean));
  h('not', (a) => !a);
  h('includes', (list, v) => Array.isArray(list) && list.map(String).includes(String(v)));
  h('default', (v, fallback) => (v === null || v === undefined || v === '' ? fallback : v));
  h('concat', (...a) => args(a).join(''));
  h('add', (a, b) => Number(a) + Number(b));
  h('len', (x) => (Array.isArray(x) ? x.length : 0));
  /** Build an object from hash arguments: (object a=1 b=2) */
  h('object', (opts) => ({ ...(opts?.hash || {}) }));

  // ---- formatting
  h('money', (v) => money(v));
  h('num', (v, d) => number(v, typeof d === 'number' ? d : 2));
  h('date', (v, style) => formatDate(v, typeof style === 'string' ? style : 'medium'));
  h('time', (v) => formatTime(v));
  h('datetime', (v) => formatDateTime(v));
  h('clock', (v) => formatClock(v));
  h('hours', (m) => minutesToHours(m));
  h('titleCase', (v) => titleCase(v));
  h('initials', (v) => initials(v));
  h('percent', (v) => `${Math.round(Number(v) * 100)}%`);
  /** Attendance percentage (already 0-100); blank when not applicable. */
  h('pct', (v) => (v === '' || v === null || v === undefined ? '—' : `${number(v, 1)}%`));
  h('dateInput', (v) => (v ? toDateStr(v) : ''));
  h('datetimeInput', (v) => toDateTimeInput(v));
  h('datetimeStr', (v) => toDateTimeStr(v) || '');
  h('isPast', (d) => d && d < today());
  h('isToday', (d) => d === today());
  h('roleLabel', (r) => ROLE_LABELS[r] || r);
  h('leaveType', (t) => LEAVE_TYPE_LABELS[t] || titleCase(t));
  h('employmentType', (t) => EMPLOYMENT_TYPE_LABELS[t] || titleCase(t));
  h('deductionType', (t) => DEDUCTION_TYPE_LABELS[t] || titleCase(t));
  h('weekdays', (list) => WEEKDAYS.filter((d) => (list || []).map(Number).includes(d.value)).map((d) => d.short).join(', ') || 'None');
  h('shortShift', (name) => String(name || '').replace(' Shift', ''));

  // ---- markup
  h('icon', (name, size) => {
    const s = typeof size === 'number' ? size : 18;
    return new SafeString(`<svg class="icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`);
  });

  /** {{badge status "attendance"}}  or  {{badge label=".." tone=".."}} */
  h('badge', (...a) => {
    const opts = a.find(isOptions);
    const [status, mapName = 'attendance'] = args(a);
    const def = (STATUS_MAPS[mapName] || {})[status] || {};
    const label = opts?.hash?.label || def.label || titleCase(status);
    const tone = opts?.hash?.tone || def.tone || 'neutral';
    return new SafeString(`<span class="badge badge-${esc(tone)}">${esc(label)}</span>`);
  });

  h('avatar', (name, url, size) => {
    const s = typeof size === 'number' ? size : 36;
    if (url && typeof url === 'string') return new SafeString(`<img class="avatar" src="${esc(url)}" alt="" style="width:${s}px;height:${s}px">`);
    return new SafeString(`<span class="avatar avatar-initials" style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.38)}px">${esc(initials(name || ''))}</span>`);
  });

  h('selected', (a, b) => (String(a ?? '') === String(b ?? '') ? 'selected' : ''));
  h('checked', (v) => (v ? 'checked' : ''));
  h('active', (cond) => (cond ? 'active' : ''));

  // Dates are serialised in hotel time ("YYYY-MM-DD HH:MM:SS") instead of UTC ISO strings.
  function localReplacer(key, value) {
    const raw = this[key];
    return raw instanceof Date ? toDateTimeStr(raw) : value;
  }
  /** Attribute-safe JSON (use inside quotes: data-record="{{json this}}"). */
  h('json', (v) => JSON.stringify(v ?? null, localReplacer));
  /** JSON for <script type="application/json"> blocks. */
  h('jsonScript', (v) => new SafeString(JSON.stringify(v ?? null, localReplacer).replace(/</g, '\\u003c')));

  /** <option> list: {{options list selectedValue placeholder="All"}} */
  h('options', (list, selected, opts) => {
    const o = isOptions(selected) ? selected : opts;
    const sel = isOptions(selected) ? null : selected;
    const placeholder = o?.hash?.placeholder;
    const valueKey = o?.hash?.value || 'value';
    const labelKey = o?.hash?.label || 'label';
    let html = placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '';
    for (const item of list || []) {
      const v = item[valueKey];
      html += `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(item[labelKey])}</option>`;
    }
    return new SafeString(html);
  });

  h('parseDay', (d) => parseDate(d)?.getDate());

  /** Report cell formatting by column type. */
  h('cell', (value, type) => {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'money') return money(value);
    if (type === 'date') return formatDate(value);
    if (type === 'time') return formatDateTime(value);
    if (type === 'number') return Number.isInteger(Number(value)) ? String(value) : number(value, 2);
    return value;
  });
}
