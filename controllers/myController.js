import { Op } from 'sequelize';
import {
  Attendance, AttendanceCorrection, LeaveBalance, LeaveRequest, Payroll, PayrollDetail, Shift, User, WorkSchedule, plain, LEAVE_TYPES, PAID_LEAVE_TYPES,
} from '../models/index.js';
import { AttendanceService } from '../services/attendanceService.js';
import { ScheduleService } from '../services/scheduleService.js';
import { balanceFor, ensureBalances } from '../services/leaveService.js';
import { notifyManagement } from '../services/audit.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { addDays, dateRange, daysBetween, endOfMonth, isoWeekday, monthStr, parseDate, startOfWeek, toDateStr, toDateTimeInput, today } from '../utils/time.js';
import { formatDate, formatTime, minutesToHours } from '../utils/format.js';
import { LEAVE_TYPE_LABELS } from '../utils/constants.js';
import { clockData, qs } from './shared.js';
import { employeeSummaries } from '../services/analyticsService.js';
import { salaryRates } from './employeeController.js';

const monthNav = (month, base) => {
  const [y, m] = month.split('-').map(Number);
  const prev = toDateStr(new Date(y, m - 2, 1)).slice(0, 7);
  const next = toDateStr(new Date(y, m, 1)).slice(0, 7);
  return { prev: `${base}?month=${prev}`, next: `${base}?month=${next}` };
};

/** Pad a list of {date} cells so the month grid starts on Monday. */
const monthCells = (days) => [...Array(isoWeekday(days[0].date) - 1).fill(null), ...days];

// ---------------------------------------------------------------- time clock & attendance
export const attendance = wrap(async (req, res) => {
  const employee = req.user.employee;
  const service = new AttendanceService();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthStr();
  const from = `${month}-01`;
  const to = toDateStr(endOfMonth(from));
  const records = await Attendance.findAll({ where: { employee_id: employee.id, date: { [Op.between]: [from, to] } }, include: [{ model: Shift, as: 'shift' }], order: [['date', 'ASC']] });
  const byDate = new Map(records.map((r) => [r.date, plain(r)]));
  const t = today();

  const days = [];
  for (const date of dateRange(from, to)) {
    const w = await service.schedules.windowFor(employee.id, date);
    const record = byDate.get(date) || null;
    const status = record?.status || (!w ? 'rest_day' : date < t ? 'no_record' : 'scheduled');
    days.push({
      date,
      record,
      status,
      showBadge: !['scheduled', 'rest_day'].includes(status),
      shift: w ? plain(w.shift) : null,
      holiday: (await service.schedules.holidayOn(date))?.name || null,
      isToday: date === t,
      canCorrect: date <= t,
      correction: { date, requested_time_in: toDateTimeInput(record?.time_in || w?.in), requested_time_out: toDateTimeInput(record?.time_out || w?.out) },
    });
  }
  const n = (s) => records.filter((r) => r.status === s).length;
  const sum = (k) => records.reduce((a, r) => a + r[k], 0);
  const corrections = await paginate(AttendanceCorrection, req, {
    where: { employee_id: employee.id }, include: [{ model: User, as: 'reviewer', attributes: ['id', 'name'] }], order: [['created_at', 'DESC']],
  }, 10);

  res.render('my/attendance', {
    title: 'Time Clock & Attendance',
    clock: await clockData(employee, service),
    month,
    monthLabel: formatDate(from, 'month'),
    links: monthNav(month, '/my/attendance'),
    cells: monthCells(days),
    listDays: days.filter((d) => d.record),
    view: req.query.view === 'list' ? 'list' : 'calendar',
    listUrl: `/my/attendance?${qs({ month, view: 'list' })}`,
    calendarUrl: `/my/attendance?${qs({ month })}`,
    summary: {
      present: n('present'), late: n('late'), half_day: n('half_day'), absent: n('absent'), on_leave: n('on_leave'),
      late_minutes: sum('late_minutes'), undertime_minutes: sum('undertime_minutes'),
      overtime_hours: Math.round(sum('overtime_minutes') / 6) / 10, hours_worked: Math.round(sum('worked_minutes') / 6) / 10,
    },
    corrections: corrections.rows,
    pager: corrections.pager,
    summaries: await employeeSummaries(employee.id),
  });
});

export const timeIn = wrap(async (req, res) => {
  const record = await new AttendanceService().timeIn(req.user.employee, req.ip);
  let msg = `Timed in at ${formatTime(record.time_in)}.`;
  if (record.late_minutes > 0) msg += ` You are ${record.late_minutes} minute(s) late.`;
  return done(req, res, msg);
});

export const timeOut = wrap(async (req, res) => {
  const r = await new AttendanceService().timeOut(req.user.employee);
  let msg = `Timed out at ${formatTime(r.time_out)}. Worked ${minutesToHours(r.worked_minutes)}.`;
  if (r.undertime_minutes > 0) msg += ` Early time-out: ${r.undertime_minutes} minute(s) undertime.`;
  if (r.overtime_minutes > 0) msg += ` Overtime of ${minutesToHours(r.overtime_minutes)} recorded${r.overtime_status === 'pending' ? ' (pending approval)' : ''}.`;
  return done(req, res, msg);
});

export const requestCorrection = wrap(async (req, res) => {
  const employee = req.user.employee;
  const { data, errors } = validate(req.body, {
    date: 'required|date', requested_time_in: 'nullable|datetime', requested_time_out: 'nullable|datetime', reason: 'required|string|min:5|max:500',
  }, { requested_time_in: 'Correct time in', requested_time_out: 'Correct time out' });
  if (data.date && data.date > today()) errors.date = 'You cannot request a correction for a future date.';
  if (!data.requested_time_in && !data.requested_time_out) errors.requested_time_in = 'Enter the correct time in and/or time out.';
  if (data.requested_time_in && data.requested_time_out && data.requested_time_out <= data.requested_time_in) errors.requested_time_out = 'Time out must be after time in.';
  const record = data.date ? await Attendance.findOne({ where: { employee_id: employee.id, date: data.date } }) : null;
  if (!errors.requested_time_in && !data.requested_time_in && !record?.time_in) errors.requested_time_in = 'There is no time in on record for this date, so please include your time in.';
  if (!errors.date && await AttendanceCorrection.findOne({ where: { employee_id: employee.id, date: data.date, status: 'pending' } })) {
    errors.date = 'You already have a pending correction request for this date.';
  }
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#correction-modal' });

  await AttendanceCorrection.create({
    employee_id: employee.id, attendance_id: record?.id ?? null, date: data.date,
    requested_time_in: data.requested_time_in, requested_time_out: data.requested_time_out, reason: data.reason,
  });
  await notifyManagement('Attendance correction request', `${employee.full_name} requested an attendance correction for ${formatDate(data.date)}.`, 'info', '/attendance/corrections');
  return done(req, res, 'Correction request submitted. HR will review it.');
});

// ---------------------------------------------------------------- schedule
export const schedule = wrap(async (req, res) => {
  const employee = req.user.employee;
  const service = new ScheduleService();
  const view = req.query.view === 'week' ? 'week' : 'month';
  const anchor = parseDate(req.query.date) || new Date();
  let from; let to; let prev; let next; let label;
  if (view === 'week') {
    from = toDateStr(startOfWeek(anchor)); to = toDateStr(addDays(from, 6));
    prev = toDateStr(addDays(from, -7)); next = toDateStr(addDays(from, 7));
    label = `${formatDate(from, 'short')} – ${formatDate(to)}`;
  } else {
    from = `${toDateStr(anchor).slice(0, 7)}-01`; to = toDateStr(endOfMonth(from));
    prev = toDateStr(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1)); next = toDateStr(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    label = formatDate(from, 'month');
  }
  const cal = await service.calendar([employee], from, to);
  const days = (cal.rows[0]?.days || []).map((d) => ({ ...d, isToday: d.date === today() }));
  const current = await service.scheduleOn(employee.id, today());
  const upcoming = await WorkSchedule.findAll({
    where: { employee_id: employee.id, effective_from: { [Op.gt]: today() } }, include: [{ model: Shift, as: 'shift' }], order: [['effective_from', 'ASC']],
  });
  res.render('my/schedule', {
    title: 'My Schedule',
    view, label, days, cells: view === 'month' ? monthCells(days) : null,
    current: current ? plain(current) : null,
    upcoming: plain(upcoming),
    links: {
      prev: `/my/schedule?${qs({ view, date: prev })}`, next: `/my/schedule?${qs({ view, date: next })}`,
      week: `/my/schedule?${qs({ view: 'week', date: from })}`, month: `/my/schedule?${qs({ view: 'month', date: from })}`,
    },
  });
});

// ---------------------------------------------------------------- leaves
export const leaves = wrap(async (req, res) => {
  const employee = req.user.employee;
  const year = new Date().getFullYear();
  await ensureBalances(employee.id, year);
  const where = { employee_id: employee.id };
  if (req.query.status) where.status = req.query.status;
  const { rows, pager } = await paginate(LeaveRequest, req, { where, include: [{ model: User, as: 'reviewer', attributes: ['id', 'name'] }], order: [['created_at', 'DESC']] });
  res.render('my/leaves', {
    title: 'My Leave Requests',
    balances: plain(await LeaveBalance.findAll({ where: { employee_id: employee.id, year } })),
    leaves: rows,
    pager,
    filters: req.query,
  });
});

async function leaveDays(employeeId, start, end) {
  return new ScheduleService().workingDaysBetween(employeeId, start, end);
}

export const previewLeave = wrap(async (req, res) => {
  const employee = req.user.employee;
  const start = parseDate(req.query.start_date);
  const end = parseDate(req.query.end_date);
  if (!start || !end || end < start) return res.json({ days: 0, message: '' });
  const days = await leaveDays(employee.id, toDateStr(start), toDateStr(end));
  const type = req.query.leave_type;
  let message = `This request uses ${days} working day(s) (rest days and holidays are excluded).`;
  let warning = days === 0;
  if (PAID_LEAVE_TYPES.includes(type)) {
    const b = await balanceFor(employee.id, start.getFullYear(), type);
    message += ` You have ${b.remaining} ${LEAVE_TYPE_LABELS[type].toLowerCase()} day(s) remaining.`;
    if (days > b.remaining) warning = true;
  } else if (type === 'unpaid') {
    message += ' Unpaid leave days are deducted from your salary.';
  }
  return res.json({ days, message, warning });
});

export const fileLeave = wrap(async (req, res) => {
  const employee = req.user.employee;
  const { data, errors } = validate(req.body, {
    leave_type: `required|in:${LEAVE_TYPES.join(',')}`, start_date: 'required|date', end_date: 'required|date', reason: 'required|string|min:5|max:1000',
  });
  if (!Object.keys(errors).length) {
    if (data.end_date < data.start_date) errors.end_date = 'The end date must be on or after the start date.';
    else if (data.leave_type === 'vacation' && data.start_date < today()) errors.start_date = 'Vacation leave must be filed in advance.';
    else if (daysBetween(data.start_date, data.end_date) > 60) errors.end_date = 'A single leave request cannot exceed 60 days.';
    else if (data.start_date.slice(0, 4) !== data.end_date.slice(0, 4)) errors.end_date = 'Please file separate requests for each calendar year.';
  }
  let days = 0;
  if (!Object.keys(errors).length) {
    days = await leaveDays(employee.id, data.start_date, data.end_date);
    if (!days) errors.start_date = 'The selected dates fall on your rest days or holidays only.';
  }
  if (!Object.keys(errors).length) {
    const overlap = await LeaveRequest.findOne({ where: { employee_id: employee.id, status: ['pending', 'approved'], start_date: { [Op.lte]: data.end_date }, end_date: { [Op.gte]: data.start_date } } });
    if (overlap) errors.start_date = 'You already have a pending or approved leave covering some of these dates.';
  }
  if (!Object.keys(errors).length && PAID_LEAVE_TYPES.includes(data.leave_type)) {
    const year = Number(data.start_date.slice(0, 4));
    const b = await balanceFor(employee.id, year, data.leave_type);
    const pending = await LeaveRequest.sum('days', { where: { employee_id: employee.id, leave_type: data.leave_type, status: 'pending', start_date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } } }) || 0;
    if (b.remaining - pending < days) {
      errors.leave_type = `Insufficient ${data.leave_type} leave balance: ${b.remaining} day(s) remaining${pending ? ` (${pending} pending)` : ''}, ${days} requested. You may file unpaid leave instead.`;
    }
  }
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#leave-modal' });

  await LeaveRequest.create({ employee_id: employee.id, leave_type: data.leave_type, start_date: data.start_date, end_date: data.end_date, days, reason: data.reason });
  await notifyManagement('New leave request', `${employee.full_name} filed ${days} day(s) of ${data.leave_type} leave (${formatDate(data.start_date, 'short')} - ${formatDate(data.end_date)}).`, 'info', '/leaves');
  return done(req, res, 'Leave request submitted.');
});

export const cancelLeave = wrap(async (req, res) => {
  const leave = await LeaveRequest.findByPk(req.params.id);
  if (!leave || leave.employee_id !== req.user.employee.id) throw new AppError('You can only cancel your own leave requests.', 403);
  if (leave.status !== 'pending') throw new AppError('Only pending requests can be cancelled.');
  await leave.update({ status: 'cancelled' });
  return done(req, res, 'Leave request cancelled.');
});

// ---------------------------------------------------------------- payslips
export const payslips = wrap(async (req, res) => {
  const employee = req.user.employee;
  const year = Number(req.query.year) || new Date().getFullYear();
  const details = plain(await PayrollDetail.findAll({
    where: { employee_id: employee.id },
    include: [{ model: Payroll, as: 'payroll', where: { status: ['approved', 'paid'], period_start: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } } }],
  })).sort((a, b) => b.payroll.period_start.localeCompare(a.payroll.period_start));
  const sum = (k) => details.reduce((t, d) => t + d[k], 0);
  const y = new Date().getFullYear();
  res.render('my/payslips', {
    title: 'My Payslips',
    payslips: details,
    year,
    years: [y - 3, y - 2, y - 1, y].map((v) => ({ value: v, label: `Year ${v}` })),
    monthly: employee.basic_salary,
    rates: await salaryRates(employee.basic_salary),
    summary: { gross: sum('gross_salary'), deductions: sum('total_deductions'), net: sum('net_salary'), tax: sum('withholding_tax'), contributions: sum('sss') + sum('philhealth') + sum('pagibig') },
  });
});
