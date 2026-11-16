import { Op } from 'sequelize';
import { Department, Employee, Position, plain, ACTIVE_STATUSES } from '../models/index.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { audit } from '../services/audit.js';

export const index = wrap(async (req, res) => {
  const departments = plain(await Department.findAll({ include: [{ model: Position, as: 'positions' }], order: [['name', 'ASC'], [{ model: Position, as: 'positions' }, 'title', 'ASC']] }));
  for (const d of departments) {
    d.employees_count = await Employee.count({ where: { department_id: d.id, employment_status: ACTIVE_STATUSES } });
    for (const p of d.positions) p.employees_count = await Employee.count({ where: { position_id: p.id, employment_status: ACTIVE_STATUSES } });
  }
  const selected = departments.find((d) => String(d.id) === String(req.query.department)) || departments[0] || null;
  res.render('organization', { title: 'Departments & Positions', departments: departments.map((d) => ({ ...d, active: d.id === selected?.id })), selected });
});

const deptRules = { name: 'required|string|max:100', code: 'required|string|max:20', description: 'nullable|string|max:500' };

async function deptUnique(data, id = null) {
  const errors = {};
  const not = id ? { id: { [Op.ne]: id } } : {};
  if (data.name && await Department.findOne({ where: { name: data.name, ...not } })) errors.name = 'A department with this name already exists.';
  if (data.code && await Department.findOne({ where: { code: data.code, ...not } })) errors.code = 'This code is already used.';
  return errors;
}

export const storeDepartment = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, deptRules);
  if (data.code) data.code = data.code.toUpperCase();
  Object.assign(errors, await deptUnique(data));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#department-modal' });
  const d = await Department.create(data);
  await audit(req, 'department_create', `Created department ${d.name}`, d);
  return done(req, res, 'Department created.', `/organization?department=${d.id}`);
});

export const updateDepartment = wrap(async (req, res) => {
  const d = await Department.findByPk(req.params.id);
  if (!d) throw new AppError('Department not found.', 404);
  const { data, errors } = validate(req.body, deptRules);
  if (data.code) data.code = data.code.toUpperCase();
  Object.assign(errors, await deptUnique(data, d.id));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#department-modal' });
  await d.update(data);
  await audit(req, 'department_update', `Updated department ${d.name}`, d);
  return done(req, res, 'Department updated.');
});

export const destroyDepartment = wrap(async (req, res) => {
  const d = await Department.findByPk(req.params.id);
  if (!d) throw new AppError('Department not found.', 404);
  if (await Employee.count({ where: { department_id: d.id } })) throw new AppError('This department still has employees. Reassign them before deleting.');
  await d.destroy();
  await audit(req, 'department_delete', `Deleted department ${d.name}`);
  return done(req, res, 'Department deleted.', '/organization');
});

const posRules = { department_id: 'required|int', title: 'required|string|max:100', description: 'nullable|string|max:500', default_salary: 'nullable|number|min:0' };

async function posErrors(data, id = null) {
  const errors = {};
  if (data.department_id && !(await Department.findByPk(data.department_id))) errors.department_id = 'Select a valid department.';
  if (data.title && await Position.findOne({ where: { department_id: data.department_id, title: data.title, ...(id ? { id: { [Op.ne]: id } } : {}) } })) {
    errors.title = 'This position already exists in the department.';
  }
  return errors;
}

export const storePosition = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, posRules);
  Object.assign(errors, await posErrors(data));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#position-modal' });
  const p = await Position.create({ ...data, default_salary: data.default_salary ?? 0 });
  await audit(req, 'position_create', `Created position ${p.title}`, p);
  return done(req, res, 'Position created.', `/organization?department=${p.department_id}`);
});

export const updatePosition = wrap(async (req, res) => {
  const p = await Position.findByPk(req.params.id);
  if (!p) throw new AppError('Position not found.', 404);
  const { data, errors } = validate(req.body, posRules);
  Object.assign(errors, await posErrors(data, p.id));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#position-modal' });
  await p.update({ ...data, default_salary: data.default_salary ?? 0 });
  await audit(req, 'position_update', `Updated position ${p.title}`, p);
  return done(req, res, 'Position updated.', `/organization?department=${p.department_id}`);
});

export const destroyPosition = wrap(async (req, res) => {
  const p = await Position.findByPk(req.params.id);
  if (!p) throw new AppError('Position not found.', 404);
  if (await Employee.count({ where: { position_id: p.id } })) throw new AppError('Employees still hold this position. Reassign them before deleting.');
  await p.destroy();
  await audit(req, 'position_delete', `Deleted position ${p.title}`);
  return done(req, res, 'Position deleted.');
});
