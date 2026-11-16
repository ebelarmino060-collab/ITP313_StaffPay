import { Op } from 'sequelize';
import bcrypt from 'bcryptjs';
import { AuditLog, Employee, SystemSetting, User, ROLES } from '../models/index.js';
import { audit } from '../services/audit.js';
import { castValue, flushSettings, setSetting, setting } from '../services/settings.js';
import { removeUpload, storedPath } from '../middleware/upload.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { lookups } from './shared.js';

// ---------------------------------------------------------------- users
export const users = wrap(async (req, res) => {
  const where = {};
  if (req.query.search) where[Op.or] = [{ name: { [Op.like]: `%${req.query.search}%` } }, { email: { [Op.like]: `%${req.query.search}%` } }];
  if (req.query.role) where.role = req.query.role;
  const { rows, pager } = await paginate(User, req, {
    where,
    include: [{ model: Employee, as: 'employee', attributes: ['id', 'employee_code', 'first_name', 'middle_name', 'last_name', 'full_name', 'user_id'] }],
    order: [['name', 'ASC']],
  });
  const { employees } = await lookups({ allEmployees: true });
  res.render('admin/users', {
    title: 'User Accounts',
    users: rows.map((u) => ({ ...u, isMe: u.id === req.user.id, form: { name: u.name, email: u.email, role: u.role, is_active: u.is_active, employee_id: u.employee?.id ?? '' } })),
    pager,
    filters: req.query,
    employees: employees.map((e) => ({ ...e, option_label: `${e.option_label}${e.user_id ? ' – has account' : ''}` })),
  });
});

const userRules = (creating) => ({
  name: 'required|string|max:120',
  email: 'required|email|max:150',
  password: `${creating ? 'required' : 'nullable'}|string|min:8`,
  role: `required|in:${ROLES.join(',')}`,
  is_active: 'boolean',
  employee_id: 'nullable|int',
});

async function userErrors(data, user = null) {
  const errors = {};
  if (data.email && await User.findOne({ where: { email: data.email.toLowerCase(), ...(user ? { id: { [Op.ne]: user.id } } : {}) } })) errors.email = 'This email is already used by another account.';
  if (data.employee_id) {
    const e = await Employee.findByPk(data.employee_id);
    if (!e) errors.employee_id = 'Select a valid employee.';
    else if (e.user_id && e.user_id !== user?.id) errors.employee_id = 'That employee is already linked to another account.';
  }
  return errors;
}

async function linkEmployee(user, employeeId) {
  await Employee.update({ user_id: null }, { where: { user_id: user.id, ...(employeeId ? { id: { [Op.ne]: employeeId } } : {}) } });
  if (employeeId) await Employee.update({ user_id: user.id }, { where: { id: employeeId } });
}

export const storeUser = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, userRules(true));
  Object.assign(errors, await userErrors(data));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#user-modal' });
  const user = await User.create({ name: data.name, email: data.email.toLowerCase(), password: await bcrypt.hash(data.password, 10), role: data.role, is_active: data.is_active });
  await linkEmployee(user, data.employee_id);
  await audit(req, 'user_create', `Created ${user.role} account for ${user.name} (${user.email})`, user);
  return done(req, res, 'User account created.');
});

export const updateUser = wrap(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw new AppError('User not found.', 404);
  const { data, errors } = validate(req.body, userRules(false));
  Object.assign(errors, await userErrors(data, user));
  if (user.id === req.user.id && (data.role !== 'admin' || !data.is_active)) errors.role = 'You cannot remove your own administrator access.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#user-modal' });
  const changes = { name: data.name, email: data.email.toLowerCase(), role: data.role, is_active: data.is_active };
  if (data.password) changes.password = await bcrypt.hash(data.password, 10);
  await user.update(changes);
  await linkEmployee(user, data.employee_id);
  await audit(req, 'user_update', `Updated account of ${user.name}${data.password ? ' (password reset)' : ''}`, user, { role: data.role, is_active: data.is_active });
  return done(req, res, 'User account updated.');
});

export const destroyUser = wrap(async (req, res) => {
  const user = await User.findByPk(req.params.id);
  if (!user) throw new AppError('User not found.', 404);
  if (user.id === req.user.id) throw new AppError('You cannot delete your own account.');
  await Employee.update({ user_id: null }, { where: { user_id: user.id } });
  await user.destroy();
  await audit(req, 'user_delete', `Deleted account of ${user.name} (${user.email})`);
  return done(req, res, 'User account deleted.');
});

// ---------------------------------------------------------------- settings
const GROUPS = [
  { key: 'hotel', label: 'Hotel Information' },
  { key: 'attendance', label: 'Attendance', note: 'Late is counted after the grace period. Overtime must reach the minimum minutes after the shift ends.' },
  { key: 'import', label: 'Attendance Import', note: 'Defaults for the TXT attendance import. Column layouts are managed on the Import Attendance page (Import Formats).' },
  { key: 'payroll', label: 'Payroll', note: 'Daily rate = monthly basic ÷ working days per month. Hourly rate = daily rate ÷ hours per day.' },
  { key: 'contributions', label: 'Contributions & Tax', note: 'Employee-share rates for SSS, PhilHealth and Pag-IBIG, and the BIR TRAIN withholding tax table. Review these against the latest government circulars.' },
  { key: 'leave', label: 'Leave', note: 'Default yearly allocations used when a new leave balance is created.' },
];

export const settings = wrap(async (req, res) => {
  const tab = GROUPS.some((g) => g.key === req.query.tab) ? req.query.tab : 'hotel';
  const rows = await SystemSetting.findAll({ where: { group: tab }, order: [['id', 'ASC']] });
  const logo = await setting('hotel_logo');
  res.render('admin/settings', {
    title: 'System Settings',
    tab,
    group: GROUPS.find((g) => g.key === tab),
    groups: GROUPS.map((g) => ({ ...g, active: g.key === tab })),
    fields: rows.filter((s) => s.key !== 'hotel_logo').map((s) => ({
      key: s.key, label: s.label, type: s.type, value: castValue(s.value, s.type),
      isBoolean: s.type === 'boolean', isNumber: s.type === 'number', isTime: s.key.startsWith('night_diff_'),
      isFrequency: s.key === 'pay_frequency', wide: s.key === 'hotel_address',
    })),
    logoUrl: logo ? `/uploads/${logo}` : null,
  });
});

export const updateSettings = wrap(async (req, res) => {
  const tab = req.body._tab;
  const rows = await SystemSetting.findAll({ where: { group: tab } });
  const errors = {};
  const changes = {};
  for (const s of rows) {
    if (s.key === 'hotel_logo') continue;
    let value = req.body[s.key];
    if (s.type === 'boolean') value = value ? '1' : '0';
    else if (value === undefined) continue;
    else value = String(value).trim();
    if (s.type === 'number' && (value === '' || Number.isNaN(Number(value)) || Number(value) < 0)) { errors[s.key] = `${s.label} must be a non-negative number.`; continue; }
    if (s.key.startsWith('night_diff_') && !/^\d{2}:\d{2}$/.test(value)) { errors[s.key] = `${s.label} must be a time (HH:MM).`; continue; }
    if (s.key === 'pay_frequency' && !['semi_monthly', 'monthly'].includes(value)) { errors[s.key] = 'Invalid pay frequency.'; continue; }
    if (value !== String(s.value ?? '')) changes[s.key] = { from: s.value, to: value };
  }
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: null });
  for (const [key, { to }] of Object.entries(changes)) await SystemSetting.update({ value: to }, { where: { key } });
  flushSettings();
  if (Object.keys(changes).length) await audit(req, 'settings_update', `Updated system settings: ${Object.keys(changes).join(', ')}`, null, changes);
  return done(req, res, 'Settings saved.');
});

export const uploadLogo = wrap(async (req, res) => {
  if (!req.file) throw new AppError('Choose an image to upload.');
  removeUpload(await setting('hotel_logo'));
  await setSetting('hotel_logo', storedPath(req.file, 'branding'));
  await audit(req, 'settings_logo', 'Updated the hotel logo');
  return done(req, res, 'Logo uploaded.');
});

// ---------------------------------------------------------------- audit logs
export const auditLogs = wrap(async (req, res) => {
  const where = {};
  if (req.query.search) where.description = { [Op.like]: `%${req.query.search}%` };
  if (req.query.action) where.action = { [Op.like]: `${req.query.action}%` };
  if (req.query.from || req.query.to) {
    where.created_at = {};
    if (req.query.from) where.created_at[Op.gte] = new Date(`${req.query.from}T00:00:00`);
    if (req.query.to) where.created_at[Op.lte] = new Date(`${req.query.to}T23:59:59`);
  }
  const { rows, pager } = await paginate(AuditLog, req, { where, include: [{ model: User, as: 'user', attributes: ['id', 'name', 'role'] }], order: [['created_at', 'DESC'], ['id', 'DESC']] }, 20);
  const actions = [['payroll', 'Payroll'], ['employee', 'Employees'], ['attendance', 'Attendance'], ['overtime', 'Overtime'], ['correction', 'Corrections'],
    ['leave', 'Leave'], ['schedule', 'Schedules'], ['user', 'User accounts'], ['settings', 'Settings'], ['report', 'Report exports'], ['login', 'Sign-ins']];
  res.render('admin/audit', {
    title: 'Audit Logs',
    logs: rows.map((l) => ({
      ...l,
      tone: /delete|reject/.test(l.action) ? 'danger' : /approve|create/.test(l.action) ? 'success' : l.action.startsWith('payroll') ? 'navy' : 'info',
      changesText: l.changes ? JSON.stringify(l.changes, null, 2) : null,
    })),
    pager,
    filters: req.query,
    actions: actions.map(([value, label]) => ({ value, label })),
  });
});
