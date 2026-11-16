import { Op } from 'sequelize';
import { Attendance, Department, Employee, Holiday, Shift, WorkSchedule, plain, ACTIVE_STATUSES, DAY_NAMES } from '../models/index.js';
import { ScheduleService } from '../services/scheduleService.js';
import { audit, notify } from '../services/audit.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { addDays, addDaysStr, endOfMonth, parseDate, startOfMonth, startOfWeek, toDateStr, today } from '../utils/time.js';
import { formatDate } from '../utils/format.js';
import { employeeSearch, lookups, qs } from './shared.js';

// ---------------------------------------------------------------- roster calendar
export const calendar = wrap(async (req, res) => {
  const view = req.query.view === 'month' ? 'month' : 'week';
  const anchor = parseDate(req.query.date) || new Date();
  let from; let to; let prev; let next;
  if (view === 'week') {
    const start = startOfWeek(anchor);
    from = toDateStr(start);
    to = toDateStr(addDays(start, 6));
    prev = addDaysStr(from, -7);
    next = addDaysStr(from, 7);
  } else {
    from = toDateStr(startOfMonth(anchor));
    to = toDateStr(endOfMonth(anchor));
    prev = toDateStr(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    next = toDateStr(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
  }

  const where = { employment_status: ACTIVE_STATUSES };
  if (req.query.department_id) where.department_id = req.query.department_id;
  const employees = await Employee.findAll({
    where,
    include: [{ model: Department, as: 'department' }, ...(req.query.shift_id ? [{ model: WorkSchedule, as: 'schedules', where: { shift_id: req.query.shift_id }, attributes: [] }] : [])],
    order: [['last_name', 'ASC'], ['first_name', 'ASC']],
  });
  const grid = await new ScheduleService().calendar(employees, from, to);
  const base = { view, department_id: req.query.department_id, shift_id: req.query.shift_id };

  res.render('schedules/calendar', {
    title: 'Roster Calendar',
    tab: 'calendar',
    view,
    label: view === 'week' ? `${formatDate(from, 'short')} – ${formatDate(to)}` : formatDate(from, 'month'),
    dates: grid.dates.map((d) => ({ date: d, isToday: d === today() })),
    rows: grid.rows,
    links: {
      prev: `/schedules?${qs({ ...base, date: prev })}`,
      next: `/schedules?${qs({ ...base, date: next })}`,
      today: `/schedules?${qs(base)}`,
      week: `/schedules?${qs({ ...base, view: 'week', date: from })}`,
      month: `/schedules?${qs({ ...base, view: 'month', date: from })}`,
    },
    filters: req.query,
    ...(await lookups({ shifts: true })),
  });
});

// ---------------------------------------------------------------- assignments
export const assignments = wrap(async (req, res) => {
  const q = { active: '1', ...req.query };
  const where = {};
  if (q.shift_id) where.shift_id = q.shift_id;
  if (q.active === '1') {
    where.effective_from = { [Op.lte]: today() };
    where[Op.or] = [{ effective_to: null }, { effective_to: { [Op.gte]: today() } }];
  }
  const { rows, pager } = await paginate(WorkSchedule, req, {
    where,
    include: [
      { model: Employee, as: 'employee', where: { ...employeeSearch(q.search), ...(q.department_id ? { department_id: q.department_id } : {}) }, include: [{ model: Department, as: 'department' }] },
      { model: Shift, as: 'shift' },
    ],
    order: [['effective_from', 'DESC'], ['id', 'DESC']],
  });
  const t = today();
  res.render('schedules/assignments', {
    title: 'Schedule Assignments',
    tab: 'assignments',
    schedules: rows.map((s) => ({ ...s, state: s.effective_from > t ? 'upcoming' : s.effective_to && s.effective_to < t ? 'ended' : 'active' })),
    pager,
    filters: q,
    ...(await lookups({ employees: true, shifts: true })),
  });
});

const scheduleRules = {
  shift_id: 'required|int',
  working_days: 'required|array|each:int',
  effective_from: 'required|date',
  effective_to: 'nullable|date',
  notes: 'nullable|string|max:300',
};
const scheduleLabels = { shift_id: 'Shift', working_days: 'Working days', effective_from: 'Effective from' };

function checkSchedule(data, errors) {
  data.working_days = [...new Set(data.working_days.filter((d) => d >= 1 && d <= 7))].sort();
  if (!errors.working_days && !data.working_days.length) errors.working_days = 'Select at least one working day.';
  if (data.effective_to && data.effective_from && data.effective_to < data.effective_from) errors.effective_to = 'The end date must be after the start date.';
}

export const assign = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { ...scheduleRules, employee_ids: 'required|array|each:int' }, { ...scheduleLabels, employee_ids: 'Employees' });
  checkSchedule(data, errors);
  const shift = data.shift_id ? await Shift.findByPk(data.shift_id) : null;
  if (!errors.shift_id && !shift) errors.shift_id = 'Select a valid shift.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#schedule-modal' });

  const from = data.effective_from;
  const to = data.effective_to;
  const ids = [...new Set(data.employee_ids)];
  for (const employeeId of ids) {
    // Replace schedules starting within the new range, and close the one running into it.
    await WorkSchedule.destroy({ where: { employee_id: employeeId, effective_from: to ? { [Op.between]: [from, to] } : { [Op.gte]: from } } });
    await WorkSchedule.update({ effective_to: addDaysStr(from, -1) }, {
      where: { employee_id: employeeId, effective_from: { [Op.lt]: from }, [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: from } }] },
    });
    await WorkSchedule.create({ employee_id: employeeId, shift_id: shift.id, working_days: data.working_days, effective_from: from, effective_to: to, notes: data.notes, created_by: req.user.id });
  }

  const dayNames = data.working_days.map((d) => DAY_NAMES[d]).join(', ');
  const userIds = (await Employee.findAll({ where: { id: ids, user_id: { [Op.ne]: null } }, attributes: ['user_id'] })).map((e) => e.user_id);
  await notify(userIds, 'Work schedule updated', `You are assigned to the ${shift.label} on ${dayNames} starting ${formatDate(from)}.`, 'info', '/my/schedule');
  await audit(req, 'schedule_assign', `Assigned ${ids.length} employee(s) to ${shift.name} from ${from}`, shift, { employee_ids: ids, working_days: data.working_days, effective_to: to });
  return done(req, res, `${ids.length} schedule(s) assigned.`);
});

export const updateSchedule = wrap(async (req, res) => {
  const s = await WorkSchedule.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!s) throw new AppError('Schedule not found.', 404);
  const { data, errors } = validate(req.body, scheduleRules, scheduleLabels);
  checkSchedule(data, errors);
  if (!errors.shift_id && !(await Shift.findByPk(data.shift_id))) errors.shift_id = 'Select a valid shift.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#schedule-edit-modal' });
  await s.update(data);
  await audit(req, 'schedule_update', `Updated schedule #${s.id} of ${s.employee.full_name}`, s);
  return done(req, res, 'Schedule updated.');
});

export const destroySchedule = wrap(async (req, res) => {
  const s = await WorkSchedule.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!s) throw new AppError('Schedule not found.', 404);
  await s.destroy();
  await audit(req, 'schedule_delete', `Removed schedule #${s.id} of ${s.employee?.full_name}`);
  return done(req, res, 'Schedule removed.');
});

// ---------------------------------------------------------------- shifts
export const shifts = wrap(async (req, res) => {
  const t = today();
  const list = plain(await Shift.findAll({ order: [['start_time', 'ASC']] }));
  for (const s of list) {
    s.active_assignments = await WorkSchedule.count({
      where: { shift_id: s.id, effective_from: { [Op.lte]: t }, [Op.or]: [{ effective_to: null }, { effective_to: { [Op.gte]: t } }] },
    });
    s.form = { name: s.name, start_time: s.start_time.slice(0, 5), end_time: s.end_time.slice(0, 5), break_minutes: s.break_minutes, color: s.color, description: s.description };
  }
  res.render('schedules/shifts', { title: 'Shifts', tab: 'shifts', shifts: list });
});

const shiftRules = {
  name: 'required|string|max:60', start_time: 'required|time', end_time: 'required|time',
  break_minutes: 'nullable|int|min:0|max:180', color: 'nullable|string|max:20', description: 'nullable|string|max:300',
};

async function shiftData(req, id = null) {
  const { data, errors } = validate(req.body, shiftRules, { start_time: 'Time in', end_time: 'Time out' });
  if (data.start_time && data.start_time === data.end_time) errors.end_time = 'Time out must differ from time in.';
  if (data.name && await Shift.findOne({ where: { name: data.name, ...(id ? { id: { [Op.ne]: id } } : {}) } })) errors.name = 'A shift with this name already exists.';
  data.start_time = data.start_time ? `${data.start_time.slice(0, 5)}:00` : null;
  data.end_time = data.end_time ? `${data.end_time.slice(0, 5)}:00` : null;
  data.break_minutes = data.break_minutes ?? 0;
  data.color = data.color || '#1e3a5f';
  return { data, errors };
}

export const storeShift = wrap(async (req, res) => {
  const { data, errors } = await shiftData(req);
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#shift-modal' });
  const s = await Shift.create(data);
  await audit(req, 'shift_create', `Created shift ${s.label}`, s);
  return done(req, res, 'Shift created.');
});

export const updateShift = wrap(async (req, res) => {
  const s = await Shift.findByPk(req.params.id);
  if (!s) throw new AppError('Shift not found.', 404);
  const { data, errors } = await shiftData(req, s.id);
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#shift-modal' });
  await s.update(data);
  await audit(req, 'shift_update', `Updated shift ${s.label}`, s);
  return done(req, res, 'Shift updated.');
});

export const destroyShift = wrap(async (req, res) => {
  const s = await Shift.findByPk(req.params.id);
  if (!s) throw new AppError('Shift not found.', 404);
  if (await WorkSchedule.count({ where: { shift_id: s.id } })) throw new AppError('This shift is used by employee schedules. Remove those assignments first.');
  await s.destroy();
  await audit(req, 'shift_delete', `Deleted shift ${s.name}`);
  return done(req, res, 'Shift deleted.');
});

// ---------------------------------------------------------------- holidays
export const holidays = wrap(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const list = plain(await Holiday.findAll({ where: { date: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } }, order: [['date', 'ASC']] }));
  const y = new Date().getFullYear();
  res.render('schedules/holidays', {
    title: 'Holidays', tab: 'holidays', holidays: list, year,
    years: [y - 2, y - 1, y, y + 1, y + 2].map((v) => ({ value: v, label: v })),
  });
});

const holidayRules = { name: 'required|string|max:120', date: 'required|date', type: 'required|in:regular,special', rate: 'nullable|number|min:1|max:5' };

async function holidayData(req, id = null) {
  const { data, errors } = validate(req.body, holidayRules);
  if (data.date && await Holiday.findOne({ where: { date: data.date, ...(id ? { id: { [Op.ne]: id } } : {}) } })) errors.date = 'There is already a holiday on this date.';
  data.rate = data.rate ?? (data.type === 'regular' ? 2 : 1.3);
  return { data, errors };
}

export const storeHoliday = wrap(async (req, res) => {
  const { data, errors } = await holidayData(req);
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#holiday-modal' });
  const h = await Holiday.create(data);
  await Attendance.update({ is_holiday: true }, { where: { date: h.date } });
  await audit(req, 'holiday_create', `Added holiday ${h.name} on ${h.date}`, h);
  return done(req, res, 'Holiday added.');
});

export const updateHoliday = wrap(async (req, res) => {
  const h = await Holiday.findByPk(req.params.id);
  if (!h) throw new AppError('Holiday not found.', 404);
  const { data, errors } = await holidayData(req, h.id);
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#holiday-modal' });
  const oldDate = h.date;
  await h.update(data);
  if (oldDate !== h.date) {
    await Attendance.update({ is_holiday: false }, { where: { date: oldDate } });
    await Attendance.update({ is_holiday: true }, { where: { date: h.date } });
  }
  await audit(req, 'holiday_update', `Updated holiday ${h.name}`, h);
  return done(req, res, 'Holiday updated.');
});

export const destroyHoliday = wrap(async (req, res) => {
  const h = await Holiday.findByPk(req.params.id);
  if (!h) throw new AppError('Holiday not found.', 404);
  await Attendance.update({ is_holiday: false }, { where: { date: h.date } });
  await h.destroy();
  await audit(req, 'holiday_delete', `Removed holiday ${h.name} (${h.date})`);
  return done(req, res, 'Holiday removed.');
});
