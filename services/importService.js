/*
 * Attendance TXT import.
 *
 *   1. parse      – read the file with a configurable format (delimiter, columns, date format, IN/OUT codes)
 *   2. identify   – match every Employee ID to an employee record (tolerant: "EMP001" = "EMP-0001" = "emp 1")
 *   3. pair       – turn punches into one work day per employee: earliest time-in / latest time-out
 *   4. validate   – unknown IDs, bad dates/times, missing in/out, duplicates, finalized payroll periods
 *   5. compute    – worked hours, late, undertime and overtime against the employee's schedule
 *   6. preview    – nothing is saved until HR reviews and commits
 *   7. commit     – one database transaction; errors are kept in attendance_import_errors
 */
import crypto from 'crypto';
import { Op } from 'sequelize';
import {
  sequelize, Attendance, AttendanceImport, AttendanceImportError, AttendanceImportFormat, Employee, OvertimeRequest, Payroll,
} from '../models/index.js';
import { AttendanceService } from './attendanceService.js';
import { ScheduleService } from './scheduleService.js';
import { allSettings } from './settings.js';
import { AppError } from '../utils/errors.js';
import { dateRange, minutesBetween, toDateStr, today } from '../utils/time.js';
import { formatDate } from '../utils/format.js';

/** Built-in layouts (seeded into attendance_import_formats; HR can add their own). */
export const BUILTIN_FORMATS = [
  {
    name: 'Standard CSV (EMPLOYEE_ID,DATE,TIME,STATUS)',
    description: 'Comma-separated with a header row, e.g. EMP001,2026-11-01,08:00:00,IN',
    is_default: true,
    options: { delimiter: 'auto', header: 'auto', col_employee: '1', col_date: '2', col_time: '3', col_status: '4', date_format: 'YMD', in_values: 'IN,I,TIME IN,TIMEIN,C/IN,CHECK IN,CHECKIN', out_values: 'OUT,O,TIME OUT,TIMEOUT,C/OUT,CHECK OUT,CHECKOUT' },
  },
  {
    name: 'Biometric device log (tab-separated, 0 = in, 1 = out)',
    description: 'Typical fingerprint-device export: ID <tab> YYYY-MM-DD HH:MM:SS <tab> device <tab> 0/1 ...',
    options: { delimiter: 'tab', header: 'no', col_employee: '1', col_date: '2', col_time: '', col_status: '4', date_format: 'YMD', in_values: '0,I,IN', out_values: '1,O,OUT' },
  },
  {
    name: 'Punches only (first punch = in, last punch = out)',
    description: 'No IN/OUT column: EMPLOYEE_ID,DATE,TIME. The first punch of a shift is the time-in and the last is the time-out.',
    options: { delimiter: 'auto', header: 'auto', col_employee: '1', col_date: '2', col_time: '3', col_status: '', date_format: 'YMD', in_values: '', out_values: '' },
  },
  {
    name: 'US date format (MM/DD/YYYY)',
    description: 'Like the standard CSV but dates are written month first, e.g. EMP001,11/01/2026,8:00 AM,IN',
    options: { delimiter: 'auto', header: 'auto', col_employee: '1', col_date: '2', col_time: '3', col_status: '4', date_format: 'MDY', in_values: 'IN,I,TIME IN,C/IN,CHECKIN', out_values: 'OUT,O,TIME OUT,C/OUT,CHECKOUT' },
  },
];

export const DEFAULT_OPTIONS = BUILTIN_FORMATS[0].options;

export async function seedImportFormats() {
  for (const f of BUILTIN_FORMATS) {
    await AttendanceImportFormat.findOrCreate({ where: { name: f.name }, defaults: { ...f, is_default: Boolean(f.is_default) } });
  }
}

// ---------------------------------------------------------------- parsing helpers
const DELIMITERS = { comma: ',', tab: '\t', semicolon: ';', pipe: '|' };

function detectDelimiter(line) {
  if (line.includes('\t')) return '\t';
  const counts = [',', ';', '|'].map((d) => [d, line.split(d).length - 1]).sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : 'space';
}

function splitLine(line, delim) {
  const cells = delim === 'space' ? line.trim().split(/\s+/) : line.split(delim);
  return cells.map((c) => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

/** "YYYY-MM-DD" from many shapes; returns null when invalid. */
export function parseDateValue(value, dateFormat = 'YMD') {
  const s = String(value || '').trim();
  let y; let mo; let d; let m;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) {
    y = +m[3];
    if (dateFormat === 'DMY') [d, mo] = [+m[1], +m[2]];
    else [mo, d] = [+m[1], +m[2]];
  } else return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d || y < 2000 || y > 2100) return null;
  return toDateStr(dt);
}

/** { h, m, s } from "08:00", "8:00:00", "5:30 PM"; null when invalid. */
export function parseTimeValue(value) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/.exec(String(value || '').trim());
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  const se = +(m[3] || 0);
  if (m[4]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(m[4]) ? 12 : 0);
  }
  if (h > 23 || mi > 59 || se > 59) return null;
  return { h, m: mi, s: se };
}

/** Comparable key for an Employee ID: "EMP-0001", "emp001" and "EMP 1" all become "EMP1". */
export function normalizeCode(code) {
  const s = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = /^([A-Z]*)0*(\d+)$/.exec(s);
  return m ? `${m[1]}${m[2]}` : s;
}

const codeList = (s) => String(s || '').split(',').map((v) => v.trim().toUpperCase().replace(/\s+/g, ' ')).filter(Boolean);

function columnIndex(spec, header) {
  const v = String(spec ?? '').trim();
  if (!v) return -1;
  if (/^\d+$/.test(v)) return Number(v) - 1;
  if (!header) return -2; // a name was given but the file has no header
  const want = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return header.findIndex((h) => h.toUpperCase().replace(/[^A-Z0-9]/g, '') === want);
}

/**
 * Parse file content into punches.
 * Returns { punches: [{ line, raw, code, date, at, type }], errors: [...], totalLines }
 */
export function parseContent(content, options = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const lines = String(content || '').replace(/^﻿/, '').split(/\r?\n/);
  const errors = [];
  const punches = [];
  const dataLines = lines.map((raw, i) => ({ raw, line: i + 1 })).filter((l) => l.raw.trim() && !l.raw.trim().startsWith('#'));
  if (!dataLines.length) return { punches, errors: [{ line: null, type: 'empty_file', message: 'The file has no attendance lines.' }], totalLines: 0 };

  const delim = o.delimiter === 'auto' || !o.delimiter ? detectDelimiter(dataLines[0].raw) : (DELIMITERS[o.delimiter] || 'space');
  const first = splitLine(dataLines[0].raw, delim);

  // Header row: explicit, or detected when the first row's date column is not a date.
  let header = null;
  if (o.header === 'yes') header = first;
  else if (o.header !== 'no') {
    const di = columnIndex(o.col_date, first);
    const looksLikeName = !/^\d+$/.test(String(o.col_date)) || di < 0;
    const dateCell = di >= 0 ? (first[di] || '').split(/[ T]/)[0] : '';
    if (looksLikeName || !parseDateValue(dateCell, o.date_format)) header = first;
  }
  const rows = header ? dataLines.slice(1) : dataLines;

  const idx = {
    employee: columnIndex(o.col_employee, header),
    date: columnIndex(o.col_date, header),
    time: columnIndex(o.col_time, header),
    status: columnIndex(o.col_status, header),
  };
  for (const k of ['employee', 'date', 'time', 'status']) {
    const spec = String(o[`col_${k}`] ?? '').trim();
    const required = k === 'employee' || k === 'date';
    if ((required && !spec) || (spec && (idx[k] < 0 || idx[k] >= Math.max(first.length, 1)))) {
      return { punches, errors: [{ line: null, type: 'format', message: `The "${k}" column (${spec || 'not set'}) was not found. Check the import format. First line has ${first.length} column(s): ${first.join(' | ')}` }], totalLines: rows.length };
    }
  }
  const inCodes = codeList(o.in_values);
  const outCodes = codeList(o.out_values);
  const hasStatus = idx.status >= 0;

  for (const { raw, line } of rows) {
    const cells = splitLine(raw, delim);
    const code = (cells[idx.employee] || '').trim();
    const fail = (type, message) => errors.push({ line, raw, code, date: null, type, message });
    if (!code) { fail('invalid', 'Missing Employee ID.'); continue; }

    let dateCell = cells[idx.date] || '';
    let timeCell = idx.time >= 0 ? (cells[idx.time] || '') : '';
    if (idx.time < 0) {
      const parts = dateCell.trim().split(/[ T]+/);
      dateCell = parts[0];
      timeCell = parts.slice(1).join(' ');
    }
    const date = parseDateValue(dateCell, o.date_format);
    if (!date) { fail('invalid_date', `Invalid date "${dateCell}".`); continue; }
    const t = parseTimeValue(timeCell);
    if (!t) { errors.push({ line, raw, code, date, type: 'invalid_time', message: `Invalid time "${timeCell}".` }); continue; }

    let type = null;
    if (hasStatus) {
      const st = String(cells[idx.status] || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (inCodes.includes(st)) type = 'in';
      else if (outCodes.includes(st)) type = 'out';
      else { errors.push({ line, raw, code, date, type: 'invalid_status', message: `Unknown IN/OUT value "${cells[idx.status] || ''}".` }); continue; }
    }
    const at = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), t.h, t.m, t.s);
    punches.push({ line, raw, code, date, at, type });
  }
  return { punches, errors, totalLines: rows.length };
}

// ---------------------------------------------------------------- analysis
const fmtClock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Build employee lookup maps for automatic identification. */
async function employeeIndex() {
  const employees = await Employee.findAll({ attributes: ['id', 'employee_code', 'first_name', 'middle_name', 'last_name', 'employment_status', 'date_hired', 'department_id'] });
  const byKey = new Map();
  const byNumber = new Map();
  for (const e of employees) {
    byKey.set(normalizeCode(e.employee_code), e);
    const n = /(\d+)$/.exec(e.employee_code)?.[1];
    if (n) {
      const k = String(Number(n));
      byNumber.set(k, byNumber.has(k) ? null : e); // null = ambiguous
    }
  }
  return {
    employees,
    find(code) {
      const key = normalizeCode(code);
      if (byKey.has(key)) return byKey.get(key);
      if (/^\d+$/.test(key)) return byNumber.get(String(Number(key))) || null; // numeric device IDs
      return null;
    },
  };
}

/** Group one employee's sorted punches into work days. */
function pairPunches(punches, maxMinutes) {
  const days = []; // { date, in, out, punches, notes[], problem }
  const hasTypes = punches.some((p) => p.type);

  if (hasTypes) {
    let open = null;
    const close = (session) => days.push(session);
    for (const p of punches) {
      if (p.type === 'in') {
        if (open && !open.out) {
          if (minutesBetween(open.in.at, p.at) <= maxMinutes && open.in.date === p.date) {
            open.punches.push(p); // repeated time-in: keep the earliest
            open.notes.add('Multiple time-in punches (earliest used)');
            continue;
          }
          close({ ...open, problem: 'missing_time_out' });
        } else if (open) close(open);
        open = { date: p.date, in: p, out: null, punches: [p], notes: new Set() };
      } else if (open && minutesBetween(open.in.at, p.at) <= maxMinutes) {
        if (open.out) open.notes.add('Multiple time-out punches (latest used)');
        open.out = p;
        open.punches.push(p);
      } else {
        if (open) { close(open.out ? open : { ...open, problem: 'missing_time_out' }); open = null; }
        days.push({ date: p.date, in: null, out: p, punches: [p], notes: new Set(), problem: 'missing_time_in' });
      }
    }
    if (open) close(open.out ? open : { ...open, problem: 'missing_time_out' });
  } else {
    // No IN/OUT column: cluster punches; first = in, last = out.
    let cluster = null;
    for (const p of punches) {
      if (cluster && minutesBetween(cluster[0].at, p.at) <= maxMinutes) cluster.push(p);
      else { if (cluster) days.push(cluster); cluster = [p]; }
    }
    if (cluster) days.push(cluster);
    days.splice(0, days.length, ...days.map((c) => ({
      date: c[0].date, in: c[0], out: c.length > 1 ? c[c.length - 1] : null, punches: c,
      notes: new Set(c.length > 2 ? ['More than two punches (first and last used)'] : []),
      problem: c.length > 1 ? null : 'missing_time_out',
    })));
  }

  // Several sessions on the same work date (e.g. split shift / lunch out-in) are merged.
  const merged = new Map();
  for (const d of days) {
    const key = `${d.date}|${d.problem ? `p${d.punches[0].line}` : 'ok'}`;
    const prev = merged.get(key);
    if (prev && !d.problem) {
      prev.out = d.out.at > prev.out.at ? d.out : prev.out;
      prev.in = d.in.at < prev.in.at ? d.in : prev.in;
      prev.punches.push(...d.punches);
      prev.notes.add('Several in/out pairs merged (earliest in, latest out)');
    } else merged.set(key, d);
  }
  return [...merged.values()];
}

/**
 * Analyse file content without saving anything.
 * Returns { rows, errors, missing, summary, dateFrom, dateTo }.
 */
export async function analyze(content, options = {}) {
  const s = await allSettings();
  const maxMinutes = Number(s.import_max_shift_hours || 20) * 60;
  const parsed = parseContent(content, options);
  const errors = parsed.errors.map((e) => ({ ...e }));
  const index = await employeeIndex();
  const schedules = new ScheduleService();
  const attendance = new AttendanceService(schedules);

  // Identify employees and drop exact duplicate punches.
  const byEmployee = new Map();
  const unknownCodes = new Set();
  const seen = new Set();
  let duplicatePunches = 0;
  for (const p of parsed.punches) {
    const emp = index.find(p.code);
    if (!emp) {
      unknownCodes.add(p.code.toUpperCase());
      errors.push({ line: p.line, raw: p.raw, code: p.code, date: p.date, type: 'unknown_employee', message: `Employee ID "${p.code}" does not exist.` });
      continue;
    }
    const key = `${emp.id}|${p.at.getTime()}|${p.type}`;
    if (seen.has(key)) {
      duplicatePunches++;
      errors.push({ line: p.line, raw: p.raw, code: p.code, date: p.date, type: 'duplicate_line', message: 'Duplicate punch (same employee, time and type) – ignored.' });
      continue;
    }
    seen.add(key);
    if (!byEmployee.has(emp.id)) byEmployee.set(emp.id, { emp, punches: [] });
    byEmployee.get(emp.id).punches.push(p);
  }

  const allDates = parsed.punches.map((p) => p.date).sort();
  const dateFrom = allDates[0] || null;
  const dateTo = allDates[allDates.length - 1] || null;

  // Finalized payroll periods cannot receive new attendance.
  const locked = dateFrom ? await Payroll.findAll({
    where: { status: ['approved', 'paid'], period_start: { [Op.lte]: dateTo }, period_end: { [Op.gte]: dateFrom } },
  }) : [];
  const lockedBy = (date) => locked.find((p) => p.period_start <= date && p.period_end >= date);

  const existing = dateFrom ? await Attendance.findAll({
    where: { employee_id: [...byEmployee.keys()], date: { [Op.between]: [dateFrom, dateTo] } },
  }) : [];
  const existingKey = new Map(existing.map((a) => [`${a.employee_id}|${a.date}`, a]));

  await schedules.preload([...byEmployee.keys()]);
  const rows = [];
  const t = today();

  for (const { emp, punches } of byEmployee.values()) {
    punches.sort((a, b) => a.at - b.at);
    for (const day of pairPunches(punches, maxMinutes)) {
      const notes = [...day.notes];
      const row = {
        key: `${emp.id}|${day.date}|${day.punches[0].line}`,
        employee_id: emp.id,
        employee_code: emp.employee_code,
        employee_name: emp.full_name,
        file_code: day.punches[0].code,
        date: day.date,
        time_in: day.in ? day.in.at.toISOString() : null,
        time_out: day.out ? day.out.at.toISOString() : null,
        time_in_label: day.in ? fmtClock(day.in.at) : null,
        time_out_label: day.out ? `${fmtClock(day.out.at)}${day.in && toDateStr(day.out.at) !== day.date ? ' (+1)' : ''}` : null,
        lines: day.punches.map((p) => p.line),
        punch_count: day.punches.length,
        import_status: 'ready',
        notes,
      };
      const problem = (type, message) => {
        row.import_status = type === 'duplicate' ? 'duplicate' : 'error';
        row.error_type = type;
        row.message = message;
      };

      if (day.problem === 'missing_time_out') problem('missing_time_out', 'Time-in without a matching time-out.');
      else if (day.problem === 'missing_time_in') problem('missing_time_in', 'Time-out without a matching time-in.');
      else if (day.date > t) problem('invalid_date', 'The date is in the future.');
      else if (emp.date_hired > day.date) problem('invalid_date', `Before the employee's hire date (${formatDate(emp.date_hired)}).`);
      else if (lockedBy(day.date)) problem('locked', `Payroll ${lockedBy(day.date).reference} is already finalized for this date.`);
      else {
        const prev = existingKey.get(`${emp.id}|${day.date}`);
        if (prev?.time_in) problem('duplicate', `Attendance for this date is already recorded (${prev.source === 'import' ? 'previous import' : prev.source.replace('_', ' ')}).`);
        else if (prev?.status === 'on_leave') notes.push('Employee was on approved leave – the leave day is replaced by worked time');
        else if (prev) notes.push('Replaces an automatic absence record');
      }

      // Hours, late, undertime and overtime against the schedule (also for review of problem rows).
      if (day.in && day.out) {
        const rec = Attendance.build({ employee_id: emp.id, date: day.date, time_in: day.in.at, time_out: day.out.at });
        await attendance.compute(rec);
        Object.assign(row, {
          shift_id: rec.shift_id,
          scheduled_in: rec.scheduled_in ? rec.scheduled_in.toISOString() : null,
          scheduled_out: rec.scheduled_out ? rec.scheduled_out.toISOString() : null,
          status: rec.status,
          worked_minutes: rec.worked_minutes,
          late_minutes: rec.late_minutes,
          undertime_minutes: rec.undertime_minutes,
          overtime_minutes: rec.overtime_minutes,
          night_diff_minutes: rec.night_diff_minutes,
          is_holiday: rec.is_holiday,
          unscheduled: !rec.scheduled_in,
        });
        if (!rec.scheduled_in) notes.push('No scheduled shift (rest day / unscheduled) – all hours count as overtime');
      }
      if (row.import_status !== 'ready') {
        errors.push({ line: day.punches[0].line, raw: day.punches.map((p) => p.raw).join(' | '), code: row.file_code, date: day.date, type: row.error_type, message: `${emp.full_name}: ${row.message}` });
      }
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.date + a.employee_name).localeCompare(b.date + b.employee_name));

  // The file covers the WORK dates of its rows (a 6 AM time-out belongs to the previous night's shift).
  const workDates = rows.map((r) => r.date).filter((d) => d <= t).sort();
  const rangeFrom = workDates[0] || null;
  const rangeTo = workDates[workDates.length - 1] || null;

  // Scheduled employees with no punches on a date of the file (they become absent unless on leave / holiday).
  const missing = [];
  if (rangeFrom) {
    const active = index.employees.filter((e) => ['active', 'probationary', 'on_leave'].includes(e.employment_status));
    await schedules.preload(active.map((e) => e.id));
    const existingAll = await Attendance.findAll({ where: { employee_id: active.map((e) => e.id), date: { [Op.between]: [rangeFrom, rangeTo] } }, attributes: ['employee_id', 'date'] });
    const has = new Set([...existingAll.map((a) => `${a.employee_id}|${a.date}`), ...rows.map((r) => `${r.employee_id}|${r.date}`)]);
    for (const e of active) {
      const dates = [];
      for (const d of dateRange(rangeFrom, rangeTo)) {
        if (e.date_hired > d || has.has(`${e.id}|${d}`) || await schedules.holidayOn(d)) continue;
        if (await schedules.windowFor(e.id, d)) dates.push(d);
      }
      if (dates.length) missing.push({ employee_id: e.id, employee_code: e.employee_code, employee_name: e.full_name, days: dates.length, dates: dates.map((d) => formatDate(d, 'short')).join(', ') });
    }
  }

  const ready = rows.filter((r) => r.import_status === 'ready');
  const summary = {
    total_lines: parsed.totalLines,
    punches: parsed.punches.length,
    identified_employees: byEmployee.size,
    unrecognized_ids: unknownCodes.size,
    unrecognized_list: [...unknownCodes].join(', '),
    records_ready: ready.length,
    duplicate_count: rows.filter((r) => r.import_status === 'duplicate').length + duplicatePunches,
    invalid_count: errors.filter((e) => !['duplicate', 'duplicate_line'].includes(e.type)).length,
    error_rows: rows.filter((r) => r.import_status === 'error').length,
    overtime_minutes: ready.reduce((sum, r) => sum + (r.overtime_minutes || 0), 0),
    worked_minutes: ready.reduce((sum, r) => sum + (r.worked_minutes || 0), 0),
    missing_employees: missing.length,
    missing_days: missing.reduce((n, m) => n + m.days, 0),
  };
  return { rows, errors, missing, summary, dateFrom: rangeFrom || dateFrom, dateTo: rangeTo || dateTo };
}

// ---------------------------------------------------------------- upload / commit / cancel
export const hashContent = (content) => crypto.createHash('sha256').update(content).digest('hex');

/** Store an upload as a preview (nothing is written to attendance yet). */
export async function createPreview({ fileName, content, formatId, user, options }) {
  if (/\u0000/.test(content)) throw new AppError('The file is not a text file.');
  const format = formatId ? await AttendanceImportFormat.findByPk(formatId) : await AttendanceImportFormat.findOne({ where: { is_default: true } });
  const formatOptions = format?.options || DEFAULT_OPTIONS;
  const fileHash = hashContent(content);
  const already = await AttendanceImport.findOne({ where: { file_hash: fileHash, status: 'completed' } });
  if (already) throw new AppError(`This exact file was already imported on ${formatDate(already.committed_at)} (import #${already.id}). Duplicate imports are blocked.`);

  const result = await analyze(content, formatOptions);
  if (!result.rows.length && !result.errors.length) throw new AppError('No attendance lines were found in the file.');
  return AttendanceImport.create({
    file_name: fileName,
    file_hash: fileHash,
    file_size: Buffer.byteLength(content),
    content,
    format_id: format?.id ?? null,
    format_options: formatOptions,
    status: 'preview',
    date_from: result.dateFrom,
    date_to: result.dateTo,
    total_lines: result.summary.total_lines,
    identified_employees: result.summary.identified_employees,
    unrecognized_ids: result.summary.unrecognized_ids,
    records_ready: result.summary.records_ready,
    duplicate_count: result.summary.duplicate_count,
    invalid_count: result.summary.invalid_count,
    preview: result,
    options,
    uploaded_by: user?.id ?? null,
  });
}

/**
 * Save the ready rows of a preview (re-analysed so nothing changed in between),
 * keep every problem in attendance_import_errors, then mark absences.
 */
export async function commitImport(importId, user) {
  const imp = await AttendanceImport.findByPk(importId);
  if (!imp) throw new AppError('Import not found.', 404);
  if (imp.status !== 'preview') throw new AppError(`This import is already ${imp.status}.`);
  const dup = await AttendanceImport.findOne({ where: { file_hash: imp.file_hash, status: 'completed' } });
  if (dup) throw new AppError(`This exact file was already imported (import #${dup.id}).`);

  const result = await analyze(imp.content, imp.format_options);
  const ready = result.rows.filter((r) => r.import_status === 'ready');
  const approveOt = Boolean(imp.options?.approve_overtime);
  const saved = [];

  await sequelize.transaction(async (transaction) => {
    for (const r of ready) {
      let rec = await Attendance.findOne({ where: { employee_id: r.employee_id, date: r.date }, transaction });
      if (rec?.time_in) continue; // recorded by someone else since the preview
      if (!rec) rec = Attendance.build({ employee_id: r.employee_id, date: r.date });
      rec.set({
        shift_id: r.shift_id ?? null,
        scheduled_in: r.scheduled_in ? new Date(r.scheduled_in) : null,
        scheduled_out: r.scheduled_out ? new Date(r.scheduled_out) : null,
        time_in: new Date(r.time_in),
        time_out: new Date(r.time_out),
        status: r.status,
        worked_minutes: r.worked_minutes,
        late_minutes: r.late_minutes,
        undertime_minutes: r.undertime_minutes,
        overtime_minutes: r.overtime_minutes,
        overtime_status: r.overtime_minutes > 0 ? (approveOt ? 'approved' : 'pending') : 'none',
        night_diff_minutes: r.night_diff_minutes,
        is_holiday: Boolean(r.is_holiday),
        is_paid_leave: false,
        leave_request_id: null,
        source: 'import',
        import_id: imp.id,
        punch_count: r.punch_count,
        remarks: r.notes.length ? r.notes.join('; ') : null,
      });
      await rec.save({ transaction });
      saved.push(rec);
    }
    if (result.errors.length) {
      await AttendanceImportError.bulkCreate(result.errors.map((e) => ({
        import_id: imp.id, line_no: e.line, employee_code: e.code || null, date: e.date || null,
        error_type: e.type, message: e.message, raw_line: e.raw ? String(e.raw).slice(0, 1000) : null,
      })), { transaction });
    }
    await imp.update({
      status: 'completed',
      committed_at: new Date(),
      records_imported: saved.length,
      records_ready: result.summary.records_ready,
      identified_employees: result.summary.identified_employees,
      unrecognized_ids: result.summary.unrecognized_ids,
      duplicate_count: result.summary.duplicate_count + (ready.length - saved.length),
      invalid_count: result.summary.invalid_count,
      date_from: result.dateFrom,
      date_to: result.dateTo,
      preview: result,
      uploaded_by: imp.uploaded_by ?? user?.id ?? null,
    }, { transaction });
  });

  // Overtime approvals and automatic absences (outside the transaction).
  const service = new AttendanceService();
  for (const rec of saved) {
    await service.syncOvertimeRequest(rec);
    if (approveOt && rec.overtime_minutes > 0) {
      await OvertimeRequest.update({ reviewed_by: user?.id ?? null, reviewed_at: new Date(), remarks: 'Approved automatically on import' }, { where: { attendance_id: rec.id } });
    }
  }
  let absences = 0;
  if (imp.options?.mark_absences && result.dateFrom) {
    for (const d of dateRange(result.dateFrom, result.dateTo)) absences += await service.markAbsences(d);
    await imp.update({ absences_marked: absences });
  }
  return imp;
}

export async function cancelImport(importId) {
  const imp = await AttendanceImport.findByPk(importId);
  if (!imp) throw new AppError('Import not found.', 404);
  if (imp.status !== 'preview') throw new AppError(`This import is already ${imp.status}.`);
  await imp.update({ status: 'cancelled', preview: null });
  return imp;
}

/** Build a sample TXT file (standard format) for scheduled employees on the given dates. */
export async function buildSampleFile(dates, { employees = null, withProblems = false, skipExisting = false, comments = false } = {}) {
  const schedules = new ScheduleService();
  const list = employees || await Employee.findAll({ where: { employment_status: ['active', 'probationary'] }, order: [['employee_code', 'ASC']] });
  await schedules.preload(list.map((e) => e.id));
  // Days that already have a record (time clock, earlier import, leave, absence) would only come back as duplicates.
  const taken = new Set();
  if (skipExisting && dates.length) {
    const rows = await Attendance.findAll({ where: { employee_id: list.map((e) => e.id), date: { [Op.between]: [dates[0], dates[dates.length - 1]] } }, attributes: ['employee_id', 'date'] });
    for (const r of rows) taken.add(`${r.employee_id}|${r.date}`);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${toDateStr(d)},${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const lines = [];
  if (comments) {
    lines.push(
      '# StaffPay attendance file - import it under Attendance > Import TXT',
      '# Format: EMPLOYEE_ID,DATE (YYYY-MM-DD),TIME (HH:MM or HH:MM:SS),STATUS (IN or OUT) - one punch per line',
      '# Lines starting with # are ignored. A time-out after midnight closes the previous night\'s shift.',
    );
  }
  lines.push('EMPLOYEE_ID,DATE,TIME,STATUS');
  const now = new Date();
  let n = 0;
  for (const date of dates) {
    for (const e of list) {
      const w = await schedules.windowFor(e.id, date);
      if (!w || taken.has(`${e.id}|${date}`) || (e.date_hired && e.date_hired > date)) continue;
      n++;
      if (n % 23 === 0) continue; // absent
      const tin = new Date(w.in.getTime() + ((n * 7) % 30 - 18) * 60000);
      const extra = n % 9 === 0 ? 75 : n % 13 === 0 ? -40 : (n * 3) % 10;
      const tout = new Date(w.out.getTime() + extra * 60000);
      if (tout > now) continue; // shift not finished yet
      lines.push(`${e.employee_code},${stamp(tin)},IN`, `${e.employee_code},${stamp(tout)},OUT`);
    }
  }
  if (withProblems && dates.length) {
    const d = dates[dates.length - 1];
    lines.push(`EMP999,${d},08:00:00,IN`, `EMP999,${d},17:00:00,OUT`); // unknown employee
    lines.push(`${list[0]?.employee_code || 'EMP001'},2026-13-45,08:00:00,IN`); // invalid date
    lines.push(`${list[1]?.employee_code || 'EMP002'},${d},25:61:00,OUT`); // invalid time
  }
  return `${lines.join('\n')}\n`;
}

/** Downloadable template: the format, the rules and a few example lines. */
export const ATTENDANCE_TEMPLATE = `# StaffPay attendance import template
# ------------------------------------------------------------------
# One punch per line:  EMPLOYEE_ID,DATE,TIME,STATUS
#   EMPLOYEE_ID  the employee code in StaffPay (EMP001, EMP-001 and emp1 all match EMP001)
#   DATE         YYYY-MM-DD  (e.g. 2026-11-12)
#   TIME         24-hour HH:MM or HH:MM:SS, or 8:00 AM
#   STATUS       IN or OUT
# Lines starting with # are ignored; the header row is optional.
# Night shift: put the next-morning OUT on its real date - it closes the previous night's shift.
# Delete these example lines and add your own, then upload under Attendance > Import TXT.
# ------------------------------------------------------------------
EMPLOYEE_ID,DATE,TIME,STATUS
EMP001,2026-11-12,08:00:00,IN
EMP001,2026-11-12,17:00:00,OUT
EMP002,2026-11-12,06:00:00,IN
EMP002,2026-11-12,14:00:00,OUT
EMP005,2026-11-12,22:00:00,IN
EMP005,2026-11-13,06:00:00,OUT
`;
