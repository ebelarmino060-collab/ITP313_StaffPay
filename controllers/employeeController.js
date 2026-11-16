import { Op } from 'sequelize';
import bcrypt from 'bcryptjs';
import {
  Allowance, Attendance, Department, Employee, LeaveBalance, LeaveRequest, Payroll, PayrollDetail, Position, SalaryDeduction,
  Shift, User, WorkSchedule, plain, EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, ROLES,
} from '../models/index.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { audit } from '../services/audit.js';
import { ensureBalances } from '../services/leaveService.js';
import { allSettings } from '../services/settings.js';
import { ScheduleService } from '../services/scheduleService.js';
import { removeUpload, storedPath } from '../middleware/upload.js';
import { today } from '../utils/time.js';
import { employeeSearch, lookups } from './shared.js';

const RULES = {
  employee_code: 'nullable|string|max:30',
  first_name: 'required|string|max:80',
  middle_name: 'nullable|string|max:80',
  last_name: 'required|string|max:80',
  gender: 'nullable|in:male,female,other',
  birth_date: 'nullable|date',
  contact_number: 'nullable|phone',
  email: 'nullable|email|max:150',
  address: 'nullable|string|max:500',
  department_id: 'nullable|int',
  position_id: 'nullable|int',
  employment_status: `required|in:${EMPLOYMENT_STATUSES.join(',')}`,
  employment_type: `required|in:${EMPLOYMENT_TYPES.join(',')}`,
  date_hired: 'required|date',
  basic_salary: 'required|number|min:0|max:9999999',
  create_account: 'boolean',
  password: 'nullable|string|min:8',
  new_password: 'nullable|string|min:8',
  role: `nullable|in:${ROLES.join(',')}`,
  shift_id: 'nullable|int',
  working_days: 'array|each:int',
};
const LABELS = { basic_salary: 'Basic salary', date_hired: 'Date hired', contact_number: 'Contact number' };
const FIELDS = ['employee_code', 'first_name', 'middle_name', 'last_name', 'gender', 'birth_date', 'contact_number', 'email', 'address',
  'department_id', 'position_id', 'employment_status', 'employment_type', 'date_hired', 'basic_salary'];

/** Values used to fill the edit modal. */
export const formRecord = (e) => ({
  ...Object.fromEntries(FIELDS.map((f) => [f, e[f] ?? ''])),
  has_account: Boolean(e.user_id),
  account_email: e.user?.email || '',
});

export const index = wrap(async (req, res) => {
  const q = req.query;
  const where = { ...employeeSearch(q.search) };
  for (const f of ['department_id', 'position_id', 'employment_status', 'employment_type']) if (q[f]) where[f] = q[f];
  const sortable = { name: [['last_name', 'ASC'], ['first_name', 'ASC']], code: [['employee_code', 'ASC']], hired: [['date_hired', 'DESC']], salary: [['basic_salary', 'DESC']] };

  const { rows, pager } = await paginate(Employee, req, {
    where,
    include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }, { model: User, as: 'user', attributes: ['id', 'email', 'role', 'is_active'] }],
    order: sortable[q.sort] || sortable.name,
  });

  res.render('employees/index', {
    title: 'Employees',
    employees: await Promise.all(rows.map(async (e) => ({ ...e, form: formRecord(e), rates: await salaryRates(e.basic_salary) }))),
    pager,
    filters: q,
    ...(await lookups({ shifts: true })),
  });
});

export const show = wrap(async (req, res) => {
  const e = await Employee.findByPk(req.params.id, {
    include: [
      { model: Department, as: 'department' }, { model: Position, as: 'position' },
      { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'is_active', 'last_login_at'] },
      { model: WorkSchedule, as: 'schedules', include: [{ model: Shift, as: 'shift' }] },
      { model: Allowance, as: 'allowances' }, { model: SalaryDeduction, as: 'deductions' },
    ],
    order: [[{ model: WorkSchedule, as: 'schedules' }, 'effective_from', 'DESC']],
  });
  if (!e) throw new AppError('Employee not found.', 404);
  const year = new Date().getFullYear();
  await ensureBalances(e.id, year);
  const schedule = await new ScheduleService().scheduleOn(e.id, today());

  res.render('employees/show', {
    title: e.full_name,
    employee: plain(e),
    form: formRecord(plain(e)),
    rates: await salaryRates(e.basic_salary),
    currentSchedule: schedule ? plain(schedule) : null,
    balances: plain(await LeaveBalance.findAll({ where: { employee_id: e.id, year } })),
    leaves: plain(await LeaveRequest.findAll({ where: { employee_id: e.id }, order: [['created_at', 'DESC']], limit: 5 })),
    attendance: plain(await Attendance.findAll({ where: { employee_id: e.id }, include: [{ model: Shift, as: 'shift' }], order: [['date', 'DESC']], limit: 10 })),
    payslips: plain(await PayrollDetail.findAll({ where: { employee_id: e.id }, include: [{ model: Payroll, as: 'payroll' }], order: [['created_at', 'DESC']], limit: 6 })),
    ...(await lookups({ shifts: true })),
  });
});

async function checkUnique(data, employee = null) {
  const errors = {};
  if (data.employee_code) {
    const dup = await Employee.findOne({ where: { employee_code: data.employee_code, ...(employee ? { id: { [Op.ne]: employee.id } } : {}) } });
    if (dup) errors.employee_code = 'This employee ID is already used.';
  }
  if (data.email) {
    const dupE = await Employee.findOne({ where: { email: data.email, ...(employee ? { id: { [Op.ne]: employee.id } } : {}) } });
    if (dupE) errors.email = 'Another employee already uses this email address.';
    const dupU = await User.findOne({ where: { email: data.email, ...(employee?.user_id ? { id: { [Op.ne]: employee.user_id } } : {}) } });
    if (dupU && !errors.email) errors.email = 'A user account already uses this email address.';
  }
  if (data.create_account && !employee?.user_id) {
    if (!data.email) errors.email = 'An email address is required to create a login account.';
    if (!data.password) errors.password = 'A password (at least 8 characters) is required for the login account.';
  }
  return errors;
}

/** Next unique Employee ID: EMP001, EMP002, ... (used to identify employees in attendance TXT files). */
export async function nextEmployeeCode() {
  const codes = (await Employee.findAll({ where: { employee_code: { [Op.like]: 'EMP%' } }, attributes: ['employee_code'] })).map((e) => e.employee_code);
  let n = codes.reduce((max, c) => Math.max(max, Number((/(\d+)$/.exec(c) || [])[1] || 0)), 0) + 1;
  let code;
  do { code = `EMP${String(n++).padStart(3, '0')}`; } while (await Employee.findOne({ where: { employee_code: code } }));
  return code;
}

/** Salary rates derived from the monthly basic salary and the payroll settings. */
export async function salaryRates(basicSalary) {
  const s = await allSettings();
  const daily = Number(basicSalary || 0) / (Number(s.working_days_per_month) || 26);
  return { daily: Math.round(daily * 100) / 100, hourly: Math.round((daily / (Number(s.hours_per_day) || 8)) * 100) / 100, days: Number(s.working_days_per_month) || 26 };
}

/** Deactivate / reactivate the employee's login account. */
export const toggleAccount = wrap(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id, { include: [{ model: User, as: 'user' }] });
  if (!employee) throw new AppError('Employee not found.', 404);
  if (!employee.user) throw new AppError('This employee has no login account. Edit the employee to create one.');
  if (employee.user.id === req.user.id) throw new AppError('You cannot deactivate your own account.');
  const active = !employee.user.is_active;
  await employee.user.update({ is_active: active });
  await audit(req, active ? 'employee_account_activate' : 'employee_account_deactivate',
    `${active ? 'Reactivated' : 'Deactivated'} the login account of ${employee.full_name} (${employee.employee_code})`, employee);
  return done(req, res, `${employee.full_name}'s account was ${active ? 'reactivated' : 'deactivated'}.`);
});

export const store = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, RULES, LABELS);
  Object.assign(errors, await checkUnique(data));
  if (Object.keys(errors).length) {
    removeUpload(storedPath(req.file, 'photos'));
    return invalid(req, res, errors, { modal: '#employee-modal' });
  }

  const attrs = Object.fromEntries(FIELDS.map((f) => [f, data[f]]));
  attrs.employee_code = attrs.employee_code || await nextEmployeeCode();
  attrs.photo_path = storedPath(req.file, 'photos');
  const employee = await Employee.create(attrs);

  if (data.create_account) {
    const user = await User.create({ name: employee.full_name, email: data.email, password: await bcrypt.hash(data.password, 10), role: data.role || 'employee' });
    await employee.update({ user_id: user.id });
  }
  if (data.shift_id) {
    await WorkSchedule.create({
      employee_id: employee.id, shift_id: data.shift_id, working_days: data.working_days.length ? data.working_days : [1, 2, 3, 4, 5, 6],
      effective_from: employee.date_hired > today() ? employee.date_hired : today(), created_by: req.user.id,
    });
  }
  await ensureBalances(employee.id, new Date().getFullYear());
  await audit(req, 'employee_create', `Added employee ${employee.full_name} (${employee.employee_code})`, employee);
  return done(req, res, `${employee.full_name} was added as ${employee.employee_code}.`);
});

export const update = wrap(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id, { include: [{ model: User, as: 'user' }] });
  if (!employee) throw new AppError('Employee not found.', 404);
  const { data, errors } = validate(req.body, RULES, LABELS);
  if (!data.employee_code) errors.employee_code = 'Employee ID is required.';
  Object.assign(errors, await checkUnique(data, employee));
  if (Object.keys(errors).length) {
    removeUpload(storedPath(req.file, 'photos'));
    return invalid(req, res, errors, { modal: '#employee-modal' });
  }

  const before = employee.get({ plain: true });
  const attrs = Object.fromEntries(FIELDS.map((f) => [f, data[f]]));
  if (req.file) {
    removeUpload(employee.photo_path);
    attrs.photo_path = storedPath(req.file, 'photos');
  }
  await employee.update(attrs);

  if (employee.user) {
    const userChanges = { name: employee.full_name };
    if (data.email) userChanges.email = data.email;
    if (data.new_password) userChanges.password = await bcrypt.hash(data.new_password, 10);
    if (['resigned', 'terminated'].includes(employee.employment_status)) userChanges.is_active = false;
    await employee.user.update(userChanges);
  } else if (data.create_account) {
    const user = await User.create({ name: employee.full_name, email: data.email, password: await bcrypt.hash(data.password, 10), role: data.role || 'employee' });
    await employee.update({ user_id: user.id });
  }

  const changes = Object.fromEntries(FIELDS.filter((f) => String(before[f] ?? '') !== String(employee[f] ?? '')).map((f) => [f, { from: before[f], to: employee[f] }]));
  await audit(req, 'employee_update', `Updated employee ${employee.full_name} (${employee.employee_code})`, employee, changes);
  return done(req, res, 'Employee updated successfully.');
});

export const destroy = wrap(async (req, res) => {
  const employee = await Employee.findByPk(req.params.id, { include: [{ model: User, as: 'user' }] });
  if (!employee) throw new AppError('Employee not found.', 404);
  const label = `${employee.full_name} (${employee.employee_code})`;
  removeUpload(employee.photo_path);
  const user = employee.user;
  await employee.destroy();
  if (user && user.role === 'employee') await user.destroy();
  await audit(req, 'employee_delete', `Deleted employee ${label}`);
  return done(req, res, `Employee ${label} deleted.`, '/employees');
});
