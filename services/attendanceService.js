import { Op } from 'sequelize';
import { Attendance, Employee, LeaveRequest, Department, Position, Shift, OvertimeRequest, Payroll, ACTIVE_STATUSES } from '../models/index.js';
import { ScheduleService } from './scheduleService.js';
import { allSettings } from './settings.js';
import { AppError } from '../utils/errors.js';
import { addDays, addHours, addMinutes, at, dateRange, minutesBetween, toDateStr, today } from '../utils/time.js';
import { formatDate, formatTime } from '../utils/format.js';

/** Employees may time in up to this many hours before their shift. */
const EARLY_TIME_IN_HOURS = 3;

/**
 * Time in / time out, late / undertime / overtime / night differential
 * computation and absence tracking.
 */
export class AttendanceService {
  constructor(schedules = new ScheduleService()) {
    this.schedules = schedules;
  }

  /** The open (timed in, not yet timed out) record of an employee. */
  async openRecord(employeeId) {
    return Attendance.findOne({
      where: { employee_id: employeeId, time_in: { [Op.ne]: null, [Op.gte]: addHours(new Date(), -24) }, time_out: null },
      order: [['time_in', 'DESC']],
    });
  }

  async timeIn(employee, ip = null) {
    const now = new Date();
    const open = await this.openRecord(employee.id);
    if (open) throw new AppError(`You are already timed in since ${formatDate(open.time_in)} ${formatTime(open.time_in)}. Please time out first.`);

    // Today's shift, or last night's overnight shift.
    let date = null;
    let window = null;
    for (const candidate of [toDateStr(now), toDateStr(addDays(now, -1))]) {
      const w = await this.schedules.windowFor(employee.id, candidate);
      if (!w) continue;
      const existing = await Attendance.findOne({ where: { employee_id: employee.id, date: candidate } });
      if (existing?.time_in) continue;
      if (now >= addHours(w.in, -EARLY_TIME_IN_HOURS) && now <= w.out) {
        date = candidate;
        window = w;
        break;
      }
    }
    if (!date) {
      date = toDateStr(now);
      window = await this.schedules.windowFor(employee.id, date);
    }

    let record = await Attendance.findOne({ where: { employee_id: employee.id, date } });
    if (record?.time_in) throw new AppError(`Your attendance for ${formatDate(date)} is already recorded.`);
    if (record?.status === 'on_leave') throw new AppError('You are on approved leave on this date.');
    if (!record) record = Attendance.build({ employee_id: employee.id, date });

    record.set({
      shift_id: window?.shift.id ?? null,
      scheduled_in: window?.in ?? null,
      scheduled_out: window?.out ?? null,
      time_in: now,
      time_in_ip: ip,
      source: 'time_clock',
      punch_count: 1,
      remarks: window ? record.remarks : 'Unscheduled / rest day duty',
    });
    return this.recompute(record);
  }

  async timeOut(employee) {
    const record = await this.openRecord(employee.id);
    if (!record) throw new AppError('You have not timed in yet.');
    record.time_out = new Date();
    record.punch_count = (record.punch_count || 1) + 1;
    return this.recompute(record);
  }

  /** Attendance inside a finalized (approved / paid) payroll period cannot be changed. */
  static async assertNotLocked(date) {
    const p = await Payroll.findOne({ where: { status: ['approved', 'paid'], period_start: { [Op.lte]: date }, period_end: { [Op.gte]: date } } });
    if (p) throw new AppError(`Payroll ${p.reference} is finalized for ${formatDate(date)}; its attendance is locked. An administrator must reopen the payroll first.`);
  }

  /** Recalculate status and minute counters, save the record and sync its overtime request. */
  async recompute(record) {
    await this.compute(record);
    await record.save();
    await this.syncOvertimeRequest(record);
    return record;
  }

  /** Keep the overtime_requests row in step with the record's overtime. */
  async syncOvertimeRequest(record, { transaction } = {}) {
    if (record.overtime_minutes > 0) {
      const status = record.overtime_status === 'none' ? 'pending' : record.overtime_status;
      const existing = await OvertimeRequest.findOne({ where: { attendance_id: record.id }, transaction });
      if (existing) await existing.update({ minutes: record.overtime_minutes, date: record.date, status }, { transaction });
      else await OvertimeRequest.create({ attendance_id: record.id, employee_id: record.employee_id, date: record.date, minutes: record.overtime_minutes, status }, { transaction });
    } else {
      await OvertimeRequest.destroy({ where: { attendance_id: record.id }, transaction });
    }
  }

  /**
   * Compute status, late, undertime, overtime, night differential and worked minutes
   * from time in / out and the employee's schedule. Does NOT save (used by import previews).
   */
  async compute(record) {
    const s = await allSettings();
    const grace = Number(s.grace_period_minutes ?? 10);
    const otMin = Number(s.overtime_min_minutes ?? 30);
    const otNeedsApproval = Boolean(s.overtime_requires_approval);

    if (!record.scheduled_in && record.date) {
      const w = await this.schedules.windowFor(record.employee_id, record.date);
      if (w) record.set({ shift_id: w.shift.id, scheduled_in: w.in, scheduled_out: w.out });
    }
    record.is_holiday = Boolean(await this.schedules.holidayOn(record.date));

    if (!record.time_in) {
      record.set({ worked_minutes: 0, late_minutes: 0, undertime_minutes: 0, overtime_minutes: 0, night_diff_minutes: 0, overtime_status: 'none' });
      if (!['on_leave', 'rest_day'].includes(record.status)) record.status = 'absent';
      return record;
    }

    const tin = record.time_in;
    const tout = record.time_out;
    const sin = record.scheduled_in;
    const sout = record.scheduled_out;

    let late = 0;
    if (sin && tin > addMinutes(sin, grace)) late = minutesBetween(sin, tin);

    let status = late > 0 ? 'late' : 'present';
    let worked = 0; let undertime = 0; let overtime = 0; let night = 0;

    if (tout) {
      const shift = await this.schedules.shiftById(record.shift_id);
      const breakMinutes = Number(shift?.break_minutes || 0);
      const span = Math.max(0, minutesBetween(tin, tout));
      worked = span >= 300 ? Math.max(0, span - breakMinutes) : span;

      if (sin && sout) {
        if (tout < sout) undertime = minutesBetween(tout, sout);
        const extra = tout > sout ? minutesBetween(sout, tout) : 0;
        overtime = extra >= otMin ? extra : 0;
        const scheduledMinutes = Math.max(1, minutesBetween(sin, sout) - breakMinutes);
        if (worked < scheduledMinutes / 2) status = 'half_day';
        // Night differential only counts hours inside the scheduled shift.
        const from = tin > sin ? tin : sin;
        const to = tout < sout ? tout : sout;
        night = to > from ? this.nightMinutes(from, to, s) : 0;
      } else {
        overtime = worked >= otMin ? worked : 0; // rest day / unscheduled duty
        night = this.nightMinutes(tin, tout, s);
      }
    }

    let overtimeStatus = 'none';
    if (overtime > 0) {
      overtimeStatus = ['approved', 'rejected'].includes(record.overtime_status)
        ? record.overtime_status
        : (otNeedsApproval ? 'pending' : 'approved');
    }

    record.set({
      status, worked_minutes: worked, late_minutes: late, undertime_minutes: undertime,
      overtime_minutes: overtime, overtime_status: overtimeStatus, night_diff_minutes: night,
    });
    return record;
  }

  /** Minutes of [from, to] that fall inside the night differential window (default 10 PM - 6 AM). */
  nightMinutes(from, to, s) {
    const start = s.night_diff_start || '22:00';
    const end = s.night_diff_end || '06:00';
    let total = 0;
    for (const day of dateRange(toDateStr(addDays(from, -1)), toDateStr(to))) {
      const wStart = at(day, start);
      let wEnd = at(day, end);
      if (wEnd <= wStart) wEnd = addDays(wEnd, 1);
      const a = from > wStart ? from : wStart;
      const b = to < wEnd ? to : wEnd;
      if (b > a) total += minutesBetween(a, b);
    }
    return total;
  }

  /** Create absent records for scheduled employees with no time in once the shift has ended. */
  async markAbsences(date) {
    if (await this.schedules.holidayOn(date)) return 0;
    const employees = await Employee.findAll({ where: { employment_status: ACTIVE_STATUSES, date_hired: { [Op.lte]: date } } });
    await this.schedules.preload(employees.map((e) => e.id));
    const existing = new Set((await Attendance.findAll({ where: { date }, attributes: ['employee_id'] })).map((a) => a.employee_id));
    const now = new Date();
    let created = 0;

    for (const e of employees) {
      if (existing.has(e.id)) continue;
      const w = await this.schedules.windowFor(e.id, date);
      if (!w || w.out > now) continue;
      const leave = await this.schedules.approvedLeaveOn(e.id, date);
      if (leave) {
        await this.createLeaveRecord(e.id, date, leave, w);
        continue;
      }
      await Attendance.create({
        employee_id: e.id, date, shift_id: w.shift.id, scheduled_in: w.in, scheduled_out: w.out, status: 'absent', remarks: 'No time in recorded', source: 'system',
      });
      created++;
    }
    return created;
  }

  async markAbsencesBetween(from, to) {
    const end = to < today() ? to : today();
    let count = 0;
    for (const d of dateRange(from, end)) count += await this.markAbsences(d);
    return count;
  }

  /** "On leave" attendance rows for each working day of an approved leave. */
  async applyLeave(leave) {
    for (const date of dateRange(leave.start_date, leave.end_date)) {
      if (!(await this.schedules.isWorkingDay(leave.employee_id, date))) continue;
      await this.createLeaveRecord(leave.employee_id, date, leave, await this.schedules.windowFor(leave.employee_id, date));
    }
  }

  async createLeaveRecord(employeeId, date, leave, w) {
    let record = await Attendance.findOne({ where: { employee_id: employeeId, date } });
    if (record?.time_in) return; // the employee actually reported for work
    if (!record) record = Attendance.build({ employee_id: employeeId, date });
    record.set({
      shift_id: w?.shift.id ?? null, scheduled_in: w?.in ?? null, scheduled_out: w?.out ?? null,
      status: 'on_leave', is_paid_leave: leave.is_paid, leave_request_id: leave.id, source: 'system',
      remarks: `${leave.leave_type[0].toUpperCase()}${leave.leave_type.slice(1)} leave`,
      worked_minutes: 0, late_minutes: 0, undertime_minutes: 0, overtime_minutes: 0, night_diff_minutes: 0, overtime_status: 'none',
    });
    await record.save();
  }

  /** Live status of every employed employee for one date (read only). */
  async dailyStatus(date, { departmentId = null } = {}) {
    const where = { employment_status: ACTIVE_STATUSES, date_hired: { [Op.lte]: date } };
    if (departmentId) where.department_id = departmentId;
    const employees = await Employee.findAll({
      where,
      include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }],
      order: [['last_name', 'ASC'], ['first_name', 'ASC']],
    });
    const ids = employees.map((e) => e.id);
    await this.schedules.preload(ids);
    const records = new Map((await Attendance.findAll({ where: { date, employee_id: ids }, include: [{ model: Shift, as: 'shift' }] })).map((r) => [r.employee_id, r]));
    const leaves = new Set((await LeaveRequest.findAll({
      where: { status: 'approved', start_date: { [Op.lte]: date }, end_date: { [Op.gte]: date }, employee_id: ids },
    })).map((l) => l.employee_id));
    const holiday = await this.schedules.holidayOn(date);

    const now = new Date();
    const summary = { total: 0, present: 0, late: 0, absent: 0, on_leave: 0, rest_day: 0, half_day: 0, awaiting: 0 };
    const rows = [];

    for (const e of employees) {
      const record = records.get(e.id);
      const w = await this.schedules.windowFor(e.id, date);
      let status;
      if (record) status = record.status;
      else if (leaves.has(e.id)) status = 'on_leave';
      else if (!w || holiday) status = 'rest_day';
      else {
        const half = addMinutes(w.in, Math.floor(minutesBetween(w.in, w.out) / 2));
        status = now > half ? 'absent' : 'awaiting';
      }
      summary.total++;
      summary[status] = (summary[status] || 0) + 1;
      rows.push({
        employee: { id: e.id, employee_code: e.employee_code, full_name: e.full_name, photo_url: e.photo_url, department: e.department?.name, position: e.position?.title },
        shift: w ? { id: w.shift.id, name: w.shift.name, color: w.shift.color } : null,
        scheduled_in: w?.in ?? null,
        scheduled_out: w?.out ?? null,
        attendance: record ? record.get({ plain: true }) : null,
        status,
      });
    }
    summary.reported = summary.present + summary.late + summary.half_day;
    return { date, summary, rows, holiday: holiday?.name || null };
  }
}
