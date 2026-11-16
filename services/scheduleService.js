import { Op } from 'sequelize';
import { WorkSchedule, Shift, Holiday, LeaveRequest } from '../models/index.js';
import { at, addDays, dateRange, isoWeekday } from '../utils/time.js';

/**
 * Resolves which shift an employee works on a date. Create one instance per
 * request; schedules and holidays are memoised inside it.
 */
export class ScheduleService {
  constructor() {
    this.schedules = new Map();
    this.holidays = null;
    this.shifts = new Map();
  }

  async preload(employeeIds) {
    const need = [...new Set(employeeIds)].filter((id) => !this.schedules.has(id));
    if (!need.length) return;
    const rows = await WorkSchedule.findAll({
      where: { employee_id: need },
      include: [{ model: Shift, as: 'shift' }],
      order: [['effective_from', 'DESC'], ['id', 'DESC']],
    });
    for (const id of need) this.schedules.set(id, rows.filter((r) => r.employee_id === id));
  }

  forget(employeeId) {
    this.schedules.delete(employeeId);
  }

  async scheduleOn(employeeId, date) {
    await this.preload([employeeId]);
    return this.schedules.get(employeeId).find((s) => s.effective_from <= date && (!s.effective_to || s.effective_to >= date)) || null;
  }

  async hasSchedule(employeeId, date) {
    return Boolean(await this.scheduleOn(employeeId, date));
  }

  /** Scheduled window { schedule, shift, in, out } or null on rest days / no schedule. */
  async windowFor(employeeId, date) {
    const schedule = await this.scheduleOn(employeeId, date);
    if (!schedule || !schedule.shift) return null;
    if (!schedule.working_days.map(Number).includes(isoWeekday(date))) return null;
    const { shift } = schedule;
    const start = at(date, shift.start_time);
    let end = at(date, shift.end_time);
    if (end <= start) end = addDays(end, 1); // overnight shift
    return { schedule, shift, in: start, out: end };
  }

  async shiftById(id) {
    if (!id) return null;
    if (!this.shifts.has(id)) this.shifts.set(id, await Shift.findByPk(id));
    return this.shifts.get(id);
  }

  async holidayOn(date) {
    if (!this.holidays) {
      const all = await Holiday.findAll();
      this.holidays = new Map(all.map((h) => [h.date, h]));
    }
    return this.holidays.get(date) || null;
  }

  /** Working day for leave/payroll purposes. Employees without a schedule are assumed to work Mon-Sat. */
  async isWorkingDay(employeeId, date) {
    if (await this.holidayOn(date)) return false;
    if (await this.hasSchedule(employeeId, date)) return Boolean(await this.windowFor(employeeId, date));
    return isoWeekday(date) !== 7;
  }

  async workingDaysBetween(employeeId, from, to) {
    let count = 0;
    for (const d of dateRange(from, to)) if (await this.isWorkingDay(employeeId, d)) count++;
    return count;
  }

  async approvedLeaveOn(employeeId, date) {
    return LeaveRequest.findOne({
      where: { employee_id: employeeId, status: 'approved', start_date: { [Op.lte]: date }, end_date: { [Op.gte]: date } },
    });
  }

  /** Roster grid: one row per employee, one cell per date. */
  async calendar(employees, from, to) {
    const ids = employees.map((e) => e.id);
    await this.preload(ids);
    const dates = dateRange(from, to);
    const leaves = await LeaveRequest.findAll({
      where: { employee_id: ids, status: 'approved', start_date: { [Op.lte]: to }, end_date: { [Op.gte]: from } },
    });

    const rows = [];
    for (const e of employees) {
      const days = [];
      for (const date of dates) {
        const holiday = await this.holidayOn(date);
        const leave = leaves.find((l) => l.employee_id === e.id && l.start_date <= date && l.end_date >= date);
        const w = await this.windowFor(e.id, date);
        const type = leave ? 'leave' : w ? 'shift' : (await this.hasSchedule(e.id, date)) ? 'rest_day' : 'unscheduled';
        days.push({
          date,
          type,
          shift: w ? { id: w.shift.id, name: w.shift.name, short: w.shift.name.replace(' Shift', ''), start_time: w.shift.start_time, end_time: w.shift.end_time, color: w.shift.color } : null,
          leave_type: leave?.leave_type || null,
          holiday: holiday?.name || null,
        });
      }
      rows.push({
        employee: { id: e.id, employee_code: e.employee_code, full_name: e.full_name, department: e.department?.name, position: e.position?.title },
        days,
      });
    }
    return { dates, rows };
  }
}
