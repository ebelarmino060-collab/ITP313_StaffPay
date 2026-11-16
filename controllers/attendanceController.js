import { Op } from 'sequelize';
import { Attendance, AttendanceCorrection, Department, Employee, OvertimeRequest, Shift, User } from '../models/index.js';
import { AttendanceService } from '../services/attendanceService.js';
import { generateReport } from '../services/reportService.js';
import { audit, notify } from '../services/audit.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { addDays, endOfMonth, monthStr, parseDate, toDateStr, today } from '../utils/time.js';
import { formatDate, minutesToHours } from '../utils/format.js';
import { employeeSearch, lookups } from './shared.js';

const employeeInclude = (q = {}) => ({
  model: Employee,
  as: 'employee',
  include: [{ model: Department, as: 'department' }],
  where: { ...(q.department_id ? { department_id: q.department_id } : {}), ...employeeSearch(q.search) },
});

/** Daily monitor: every employee's live status for one date. */
export const daily = wrap(async (req, res) => {
  const date = req.query.date && parseDate(req.query.date) ? toDateStr(req.query.date) : today();
  const service = new AttendanceService();
  const result = await service.dailyStatus(date, { departmentId: req.query.department_id || null });
  let rows = result.rows;
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  if (req.query.search) {
    const s = req.query.search.toLowerCase();
    rows = rows.filter((r) => `${r.employee.full_name} ${r.employee.employee_code}`.toLowerCase().includes(s));
  }
  rows = rows.map((r) => ({
    ...r,
    record: r.attendance ? { ...r.attendance } : { employee_id: r.employee.id, date, time_in: r.scheduled_in, time_out: r.scheduled_out, status: 'absent' },
  }));

  res.render('attendance/daily', {
    title: 'Daily Attendance',
    tab: 'daily',
    date,
    rows,
    summary: result.summary,
    holiday: result.holiday,
    filters: req.query,
    canMark: date <= today(),
    statusOptions: ['present', 'late', 'half_day', 'absent', 'on_leave', 'rest_day', 'awaiting'].map((value) => ({ value, label: value === 'awaiting' ? 'Not yet in' : value.replace('_', '-').replace(/\b\w/g, (c) => c.toUpperCase()) })),
    ...(await lookups({ employees: true })),
  });
});

export const records = wrap(async (req, res) => {
  const q = { from: toDateStr(addDays(new Date(), -13)), to: today(), ...req.query };
  const where = { date: { [Op.between]: [q.from, q.to] } };
  if (q.status) where.status = q.status;
  if (q.source) where.source = q.source;
  if (q.flag === 'late') where.late_minutes = { [Op.gt]: 0 };
  if (q.flag === 'undertime') where.undertime_minutes = { [Op.gt]: 0 };
  if (q.flag === 'overtime') where.overtime_minutes = { [Op.gt]: 0 };

  const { rows, pager } = await paginate(Attendance, req, {
    where,
    include: [employeeInclude(q), { model: Shift, as: 'shift' }],
    order: [['date', 'DESC'], ['time_in', 'DESC']],
  });
  res.render('attendance/records', { title: 'Attendance Records', tab: 'records', records: rows, pager, filters: q, ...(await lookups({ employees: true })) });
});

export const summary = wrap(async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthStr();
  const first = `${month}-01`;
  const last = toDateStr(endOfMonth(first));
  const report = await generateReport('attendance', { from: first, to: last < today() ? last : today(), department_id: req.query.department_id });
  res.render('attendance/summary', { title: 'Monthly Attendance Summary', tab: 'summary', report, month, filters: req.query, useCharts: true, ...(await lookups()) });
});

export const overtime = wrap(async (req, res) => {
  const q = { overtime_status: 'pending', ...req.query };
  const where = { overtime_minutes: { [Op.gt]: 0 } };
  if (q.overtime_status) where.overtime_status = q.overtime_status;
  const { rows, pager } = await paginate(Attendance, req, {
    where,
    include: [employeeInclude(q), { model: Shift, as: 'shift' }],
    order: [['date', 'DESC']],
  });
  res.render('attendance/overtime', { title: 'Overtime Review', tab: 'overtime', records: rows, pager, filters: q });
});

export const reviewOvertime = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { status: 'required|in:approved,rejected' });
  if (Object.keys(errors).length) throw new AppError(Object.values(errors)[0]);
  const a = await Attendance.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!a) throw new AppError('Record not found.', 404);
  if (a.overtime_minutes <= 0) throw new AppError('This record has no overtime to review.');
  await AttendanceService.assertNotLocked(a.date);
  await a.update({ overtime_status: data.status });
  const svc = new AttendanceService();
  await svc.syncOvertimeRequest(a);
  await OvertimeRequest.update({ reviewed_by: req.user.id, reviewed_at: new Date() }, { where: { attendance_id: a.id } });
  const hrs = minutesToHours(a.overtime_minutes);
  await notify(a.employee.user_id, `Overtime ${data.status}`, `Your ${hrs} of overtime on ${formatDate(a.date)} was ${data.status}.`, data.status === 'approved' ? 'success' : 'warning', '/my/attendance');
  await audit(req, `overtime_${data.status}`, `${data.status === 'approved' ? 'Approved' : 'Rejected'} ${hrs} overtime of ${a.employee.full_name} on ${a.date}`, a);
  return done(req, res, `Overtime ${data.status}.`);
});

const manualRules = {
  employee_id: 'nullable|int',
  date: 'nullable|date',
  time_in: 'nullable|datetime',
  time_out: 'nullable|datetime',
  status: 'nullable|in:absent,rest_day,on_leave',
  remarks: 'nullable|string|max:300',
};

function checkTimes(data, errors) {
  if (data.time_out && !data.time_in) errors.time_out = 'A time out requires a time in.';
  if (data.time_in && data.time_out && data.time_out <= data.time_in) errors.time_out = 'Time out must be after time in.';
  if (data.date && data.date > today()) errors.date = 'The date cannot be in the future.';
}

function applyManual(record, data) {
  record.time_in = data.time_in || null;
  record.time_out = data.time_out || null;
  if (!record.time_in) record.status = data.status || 'absent';
  if (data.remarks !== null) record.remarks = data.remarks;
}

export const store = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { ...manualRules, employee_id: 'required|int', date: 'required|date' }, { employee_id: 'Employee' });
  checkTimes(data, errors);
  if (!errors.employee_id && data.employee_id && !(await Employee.findByPk(data.employee_id))) errors.employee_id = 'Select a valid employee.';
  if (!errors.date) await AttendanceService.assertNotLocked(data.date);
  if (!errors.date && await Attendance.findOne({ where: { employee_id: data.employee_id, date: data.date } })) {
    errors.date = 'An attendance record already exists for this employee on that date. Edit it instead.';
  }
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#attendance-modal' });

  await AttendanceService.assertNotLocked(data.date);
  const record = Attendance.build({ employee_id: data.employee_id, date: data.date, source: 'manual' });
  applyManual(record, data);
  await new AttendanceService().recompute(record);
  const e = await Employee.findByPk(record.employee_id);
  await audit(req, 'attendance_create', `Manually recorded attendance of ${e.full_name} for ${record.date}`, record);
  return done(req, res, 'Attendance recorded.');
});

export const update = wrap(async (req, res) => {
  const record = await Attendance.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!record) throw new AppError('Record not found.', 404);
  await AttendanceService.assertNotLocked(record.date);
  const { data, errors } = validate(req.body, manualRules);
  checkTimes(data, errors);
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#attendance-modal' });
  const before = { time_in: record.time_in, time_out: record.time_out, status: record.status };
  applyManual(record, data);
  await new AttendanceService().recompute(record);
  await audit(req, 'attendance_update', `Edited attendance of ${record.employee.full_name} for ${record.date}`, record, {
    before, after: { time_in: record.time_in, time_out: record.time_out, status: record.status },
  });
  return done(req, res, 'Attendance updated.');
});

export const destroy = wrap(async (req, res) => {
  const record = await Attendance.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!record) throw new AppError('Record not found.', 404);
  await AttendanceService.assertNotLocked(record.date);
  await record.destroy();
  await audit(req, 'attendance_delete', `Deleted attendance record of ${record.employee?.full_name} on ${record.date}`);
  return done(req, res, 'Attendance record deleted.');
});

export const markAbsences = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { date: 'required|date' });
  if (Object.keys(errors).length || data.date > today()) throw new AppError('Choose today or a past date.');
  const count = await new AttendanceService().markAbsences(data.date);
  await audit(req, 'attendance_mark_absent', `Marked ${count} absence(s) for ${data.date}`);
  return done(req, res, `${count} absence record(s) created for ${formatDate(data.date)}.`);
});

// ---------------------------------------------------------------- corrections
export const corrections = wrap(async (req, res) => {
  const q = { status: 'pending', ...req.query };
  const { rows, pager } = await paginate(AttendanceCorrection, req, {
    where: q.status ? { status: q.status } : {},
    include: [employeeInclude(q), { model: Attendance, as: 'attendance' }, { model: User, as: 'reviewer', attributes: ['id', 'name'] }],
    order: [['created_at', 'DESC']],
  });
  res.render('attendance/corrections', { title: 'Correction Requests', tab: 'corrections', items: rows, pager, filters: q });
});

export const reviewCorrection = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { status: 'required|in:approved,rejected', remarks: 'nullable|string|max:500' });
  if (Object.keys(errors).length) throw new AppError(Object.values(errors)[0]);
  const c = await AttendanceCorrection.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!c) throw new AppError('Request not found.', 404);
  if (c.status !== 'pending') throw new AppError('This request has already been reviewed.');

  if (data.status === 'approved') {
    let record = await Attendance.findOne({ where: { employee_id: c.employee_id, date: c.date } });
    if (!record) record = Attendance.build({ employee_id: c.employee_id, date: c.date });
    await AttendanceService.assertNotLocked(c.date);
    record.source = 'correction';
    if (c.requested_time_in) record.time_in = c.requested_time_in;
    if (c.requested_time_out) record.time_out = c.requested_time_out;
    record.remarks = `Corrected: ${c.reason}`;
    await new AttendanceService().recompute(record);
    c.attendance_id = record.id;
  }
  await c.update({ status: data.status, remarks: data.remarks, reviewed_by: req.user.id, reviewed_at: new Date(), attendance_id: c.attendance_id });
  await notify(c.employee.user_id, `Attendance correction ${data.status}`,
    `Your correction request for ${formatDate(c.date)} was ${data.status}.${data.remarks ? ` Remarks: ${data.remarks}` : ''}`,
    data.status === 'approved' ? 'success' : 'warning', '/my/attendance');
  await audit(req, `correction_${data.status}`, `${data.status === 'approved' ? 'Approved' : 'Rejected'} attendance correction of ${c.employee.full_name} for ${c.date}`, c);
  return done(req, res, `Correction request ${data.status}.`);
});
