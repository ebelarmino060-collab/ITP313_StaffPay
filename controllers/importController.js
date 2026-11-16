import { AttendanceImport, AttendanceImportError, AttendanceImportFormat, User, plain } from '../models/index.js';
import { analyze, ATTENDANCE_TEMPLATE, buildSampleFile, cancelImport, commitImport, createPreview, DEFAULT_OPTIONS } from '../services/importService.js';
import { allSettings } from '../services/settings.js';
import { audit } from '../services/audit.js';
import { paginate, paginateArray } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { addDaysStr, today } from '../utils/time.js';
import { minutesToHours } from '../utils/format.js';

const ERROR_LABELS = {
  unknown_employee: 'Unknown Employee ID', invalid_date: 'Invalid date', invalid_time: 'Invalid time', invalid_status: 'Invalid IN/OUT',
  invalid: 'Invalid line', missing_time_out: 'Missing time-out', missing_time_in: 'Missing time-in', duplicate: 'Duplicate record',
  duplicate_line: 'Duplicate punch', locked: 'Payroll finalized', format: 'Format error', empty_file: 'Empty file',
};
const labelRow = (r) => ({
  ...r,
  hours: r.worked_minutes ? minutesToHours(r.worked_minutes) : '—',
  ot: r.overtime_minutes ? minutesToHours(r.overtime_minutes) : '—',
  notes_text: (r.notes || []).join('; '),
  error_label: r.error_type ? ERROR_LABELS[r.error_type] || r.error_type : null,
});

/** Upload form, formats and import history. */
export const index = wrap(async (req, res) => {
  const s = await allSettings();
  const formats = plain(await AttendanceImportFormat.findAll({ order: [['is_default', 'DESC'], ['name', 'ASC']] }));
  const { rows, pager } = await paginate(AttendanceImport, req, {
    attributes: { exclude: ['content', 'preview'] },
    include: [{ model: User, as: 'uploader', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
  }, 10);
  res.render('attendance/import', {
    title: 'Import Attendance',
    tab: 'import',
    formats: formats.map((f) => ({ ...f, form: { name: f.name, description: f.description || '', is_default: f.is_default, ...f.options } })),
    imports: rows,
    pager,
    defaults: { mark_absences: Boolean(s.import_mark_absences), approve_overtime: Boolean(s.import_approve_overtime) },
    blankFormat: { ...DEFAULT_OPTIONS, name: '', description: '' },
    download: { from: addDaysStr(today(), -1), to: addDaysStr(today(), -1), max: today() },
  });
});

/** Step 1: upload → parse → preview (nothing saved to attendance yet). */
export const upload = wrap(async (req, res) => {
  if (!req.file) throw new AppError('Choose an attendance TXT file to upload.');
  const content = req.file.buffer.toString('utf8');
  const imp = await createPreview({
    fileName: req.file.originalname.replace(/[^\w.\- ()]/g, '_').slice(0, 200),
    content,
    formatId: req.body.format_id ? Number(req.body.format_id) : null,
    user: req.user,
    options: { mark_absences: ['1', 'on', 'true'].includes(req.body.mark_absences), approve_overtime: ['1', 'on', 'true'].includes(req.body.approve_overtime) },
  });
  await audit(req, 'attendance_import_upload', `Uploaded attendance file ${imp.file_name} (${imp.total_lines} lines) for review`, imp);
  return res.redirect(`/attendance/import/${imp.id}`);
});

/** Preview (before commit) or result (after commit). */
export const show = wrap(async (req, res) => {
  const imp = await AttendanceImport.findByPk(req.params.id, { include: [{ model: User, as: 'uploader', attributes: ['id', 'name'] }, { model: AttendanceImportFormat, as: 'format' }] });
  if (!imp) throw new AppError('Import not found.', 404);
  const tab = ['ready', 'duplicate', 'error', 'missing', 'lines'].includes(req.query.tab) ? req.query.tab : null;
  const result = imp.preview || { rows: [], errors: [], missing: [], summary: {} };

  const rows = result.rows.map(labelRow);
  const groups = {
    ready: rows.filter((r) => r.import_status === 'ready'),
    duplicate: rows.filter((r) => r.import_status === 'duplicate'),
    error: rows.filter((r) => r.import_status === 'error'),
  };
  const lineErrors = (imp.status === 'completed'
    ? plain(await AttendanceImportError.findAll({ where: { import_id: imp.id }, order: [['line_no', 'ASC']] })).map((e) => ({ line: e.line_no, code: e.employee_code, date: e.date, type: e.error_type, message: e.message, raw: e.raw_line }))
    : result.errors).map((e) => ({ ...e, label: ERROR_LABELS[e.type] || e.type }));
  const active = tab || (imp.status === 'preview' ? 'ready' : 'ready');
  const list = active === 'lines' ? lineErrors : active === 'missing' ? result.missing : groups[active] || [];
  const { rows: pageRows, pager } = paginateArray(list, req, 25);

  res.render('attendance/importShow', {
    title: `Import #${imp.id} – ${imp.file_name}`,
    tab: 'import',
    imp: plain(imp),
    isPreview: imp.status === 'preview',
    summary: result.summary,
    counts: { ready: groups.ready.length, duplicate: groups.duplicate.length, error: groups.error.length, missing: result.missing.length, lines: lineErrors.length },
    active,
    showRows: ['ready', 'duplicate', 'error'].includes(active),
    pageRows,
    pager,
  });
});

/** Step 2: commit the preview inside a transaction. */
export const commit = wrap(async (req, res) => {
  const imp = await commitImport(req.params.id, req.user);
  await audit(req, 'attendance_import_commit',
    `Imported ${imp.records_imported} attendance record(s) from ${imp.file_name} (${imp.date_from} to ${imp.date_to}); ${imp.invalid_count} invalid, ${imp.duplicate_count} duplicate, ${imp.absences_marked} absence(s) marked`, imp);
  return done(req, res, `Import complete: ${imp.records_imported} attendance record(s) saved${imp.absences_marked ? `, ${imp.absences_marked} absence(s) marked` : ''}.`, `/attendance/import/${imp.id}`);
});

export const cancel = wrap(async (req, res) => {
  const imp = await cancelImport(req.params.id);
  await audit(req, 'attendance_import_cancel', `Cancelled import of ${imp.file_name}`, imp);
  return done(req, res, 'Import cancelled. Nothing was saved.', '/attendance/import');
});

/** Download the original uploaded file. */
export const file = wrap(async (req, res) => {
  const imp = await AttendanceImport.findByPk(req.params.id);
  if (!imp) throw new AppError('Import not found.', 404);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${imp.file_name.replace(/"/g, '')}"`);
  res.send(imp.content);
});

/**
 * Download an attendance TXT built from the real employees and their schedules, ready to import.
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   date range (default: yesterday; max 31 days; never in the future)
 *   ?days=N                          shortcut: the last N days
 *   ?problems=1                      add a few bad lines to see how errors are reported
 *   ?all=1                           include days that already have attendance (they preview as duplicates)
 */
export const sample = wrap(async (req, res) => {
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
  const t = today();
  let from; let to;
  if (isDate(req.query.from) || isDate(req.query.to)) {
    from = isDate(req.query.from) ? req.query.from : req.query.to;
    to = isDate(req.query.to) ? req.query.to : from;
    if (to < from) [from, to] = [to, from];
  } else {
    const days = Math.min(31, Math.max(1, Number(req.query.days) || 1));
    [from, to] = [addDaysStr(t, -days), addDaysStr(t, -1)];
  }
  if (to > t) to = t;
  if (from > to) throw new AppError('Choose dates up to today; attendance cannot be imported for future days.');
  const dates = [];
  for (let d = from; d <= to && dates.length < 31; d = addDaysStr(d, 1)) dates.push(d);
  const content = await buildSampleFile(dates, {
    withProblems: req.query.problems === '1',
    skipExisting: req.query.all !== '1',
    comments: true,
  });
  const name = `attendance-${dates[0]}${dates.length > 1 ? `_to_${dates[dates.length - 1]}` : ''}${req.query.problems === '1' ? '-with-errors' : ''}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(content);
});

/** Static template: the format, rules and a few example lines. */
export const template = wrap(async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance-template.txt"');
  res.send(ATTENDANCE_TEMPLATE);
});


// ---------------------------------------------------------------- import formats
const formatRules = {
  name: 'required|string|max:80', description: 'nullable|string|max:255', is_default: 'boolean',
  delimiter: 'required|in:auto,comma,tab,semicolon,pipe,space', header: 'required|in:auto,yes,no',
  col_employee: 'required|string|max:40', col_date: 'required|string|max:40', col_time: 'nullable|string|max:40', col_status: 'nullable|string|max:40',
  date_format: 'required|in:YMD,MDY,DMY', in_values: 'nullable|string|max:200', out_values: 'nullable|string|max:200',
};
const formatLabels = { col_employee: 'Employee ID column', col_date: 'Date column', delimiter: 'Delimiter' };

function formatPayload(data) {
  const { name, description, is_default: isDefault, ...opts } = data;
  for (const k of ['col_time', 'col_status', 'in_values', 'out_values']) opts[k] = opts[k] || '';
  return { name, description, is_default: isDefault, options: opts };
}

async function checkFormat(data, id = null) {
  const errors = {};
  if (data.col_status && !data.in_values) errors.in_values = 'Enter the value(s) that mean time-in (e.g. IN,0).';
  if (data.col_status && !data.out_values) errors.out_values = 'Enter the value(s) that mean time-out (e.g. OUT,1).';
  const dup = await AttendanceImportFormat.findOne({ where: { name: data.name || '' } });
  if (dup && dup.id !== id) errors.name = 'A format with this name already exists.';
  return errors;
}

export const storeFormat = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, formatRules, formatLabels);
  Object.assign(errors, await checkFormat(data));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#format-modal' });
  const payload = formatPayload(data);
  if (payload.is_default) await AttendanceImportFormat.update({ is_default: false }, { where: {} });
  const f = await AttendanceImportFormat.create(payload);
  await audit(req, 'import_format_create', `Created attendance import format "${f.name}"`, f);
  return done(req, res, 'Import format saved.');
});

export const updateFormat = wrap(async (req, res) => {
  const f = await AttendanceImportFormat.findByPk(req.params.id);
  if (!f) throw new AppError('Format not found.', 404);
  const { data, errors } = validate(req.body, formatRules, formatLabels);
  Object.assign(errors, await checkFormat(data, f.id));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#format-modal' });
  const payload = formatPayload(data);
  if (payload.is_default) await AttendanceImportFormat.update({ is_default: false }, { where: {} });
  await f.update(payload);
  await audit(req, 'import_format_update', `Updated attendance import format "${f.name}"`, f);
  return done(req, res, 'Import format updated.');
});

export const destroyFormat = wrap(async (req, res) => {
  const f = await AttendanceImportFormat.findByPk(req.params.id);
  if (!f) throw new AppError('Format not found.', 404);
  if (f.is_default) throw new AppError('Choose another default format before deleting this one.');
  await f.destroy();
  await audit(req, 'import_format_delete', `Deleted attendance import format "${f.name}"`);
  return done(req, res, 'Import format deleted.');
});

/** Quick parse test of a few pasted lines against a format (JSON, used by the format dialog). */
export const testFormat = wrap(async (req, res) => {
  const { data } = validate(req.body, formatRules);
  const content = String(req.body.sample || '').slice(0, 5000);
  const result = await analyze(content, formatPayload(data).options);
  res.json({
    summary: result.summary,
    rows: result.rows.slice(0, 5).map((r) => ({ code: r.employee_code, name: r.employee_name, date: r.date, in: r.time_in_label, out: r.time_out_label, status: r.import_status, message: r.message || '' })),
    errors: result.errors.slice(0, 5).map((e) => `Line ${e.line ?? '-'}: ${e.message}`),
  });
});
