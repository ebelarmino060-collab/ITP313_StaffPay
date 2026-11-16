import { Op } from 'sequelize';
import { Attendance, Department, Employee, Position, Shift, plain, ACTIVE_STATUSES } from '../models/index.js';
import { today } from '../utils/time.js';

/** Dropdown data used by many pages. */
export async function lookups({ employees = false, allEmployees = false, shifts = false } = {}) {
  const out = {};
  out.departments = plain(await Department.findAll({ order: [['name', 'ASC']], include: [{ model: Position, as: 'positions' }] }));
  out.positions = out.departments.flatMap((d) => d.positions.map((p) => ({ ...p, department_name: d.name })));
  if (employees || allEmployees) {
    out.employees = plain(await Employee.findAll({
      where: allEmployees ? {} : { employment_status: ACTIVE_STATUSES },
      attributes: ['id', 'employee_code', 'first_name', 'middle_name', 'last_name', 'full_name', 'department_id', 'user_id', 'photo_path', 'email'],
      order: [['last_name', 'ASC'], ['first_name', 'ASC']],
    })).map((e) => ({ ...e, option_label: `${e.full_name} (${e.employee_code})` }));
  }
  if (shifts) out.shifts = plain(await Shift.findAll({ order: [['start_time', 'ASC']] }));
  return out;
}

/** Search condition on employee name / code / email. */
export const employeeSearch = (term) => (term ? {
  [Op.or]: ['first_name', 'last_name', 'employee_code', 'email'].map((f) => ({ [f]: { [Op.like]: `%${term}%` } })),
} : {});

/** Time clock widget data for an employee. */
export async function clockData(employee, attendance) {
  const date = today();
  const open = await attendance.openRecord(employee.id);
  const record = open || await Attendance.findOne({ where: { employee_id: employee.id, date }, include: [{ model: Shift, as: 'shift' }] });
  const w = await attendance.schedules.windowFor(employee.id, date);
  const rec = record ? plain(record) : null;
  return {
    date,
    record: rec,
    isTimedIn: Boolean(open),
    done: Boolean(rec?.time_in && rec?.time_out && !open),
    onLeave: rec?.status === 'on_leave' && !rec?.time_in,
    shift: w ? plain(w.shift) : null,
    scheduledIn: w?.in ?? null,
    scheduledOut: w?.out ?? null,
    holiday: (await attendance.schedules.holidayOn(date))?.name || null,
  };
}

/** Build a query string from an object (skipping empty values). */
export const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
