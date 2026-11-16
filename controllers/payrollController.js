import { Op } from 'sequelize';
import {
  Allowance, Attendance, Department, Employee, Payroll, PayrollDetail, Payslip, Position, SalaryDeduction, User, plain, DEDUCTION_TYPES,
} from '../models/index.js';
import { PayrollService } from '../services/payrollService.js';
import { allSettings } from '../services/settings.js';
import { audit, notify } from '../services/audit.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { addDays, daysBetween, endOfMonth, startOfMonth, toDateStr } from '../utils/time.js';
import { formatDate, money } from '../utils/format.js';
import { lookups } from './shared.js';

const STEPS = ['draft', 'calculated', 'approved', 'paid'];

async function findPayroll(id) {
  const p = await Payroll.findByPk(id);
  if (!p) throw new AppError('Payroll not found.', 404);
  return p;
}

async function suggestPeriod() {
  const last = await Payroll.findOne({ order: [['period_end', 'DESC']] });
  const start = last ? addDays(last.period_end, 1) : startOfMonth();
  const monthly = (await allSettings()).pay_frequency === 'monthly';
  const end = monthly || start.getDate() > 15 ? endOfMonth(start) : new Date(start.getFullYear(), start.getMonth(), 15);
  return { period_start: toDateStr(start), period_end: toDateStr(end), pay_date: toDateStr(addDays(end, 5)) };
}

export const index = wrap(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const where = { period_start: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } };
  if (req.query.status) where.status = req.query.status;
  const { rows, pager } = await paginate(Payroll, req, { where, order: [['period_start', 'DESC']] });
  const y = new Date().getFullYear();
  res.render('payroll/index', {
    title: 'Payroll',
    tab: 'runs',
    payrolls: rows,
    pager,
    year,
    years: [y - 2, y - 1, y, y + 1].map((v) => ({ value: v, label: v })),
    filters: req.query,
    suggestion: await suggestPeriod(),
  });
});

const periodRules = { period_start: 'required|date', period_end: 'required|date', pay_date: 'required|date', notes: 'nullable|string|max:500' };

async function periodErrors(data, id = null) {
  const errors = {};
  if (data.period_end && data.period_start && data.period_end < data.period_start) errors.period_end = 'The period end must be on or after the start.';
  if (data.pay_date && data.period_start && data.pay_date < data.period_start) errors.pay_date = 'The pay date must be on or after the period start.';
  if (!errors.period_end && data.period_start && data.period_end && daysBetween(data.period_start, data.period_end) > 31) errors.period_end = 'A pay period cannot be longer than one month.';
  if (!Object.keys(errors).length && data.period_start && data.period_end) {
    const overlap = await Payroll.findOne({ where: { period_start: { [Op.lte]: data.period_end }, period_end: { [Op.gte]: data.period_start }, ...(id ? { id: { [Op.ne]: id } } : {}) } });
    if (overlap) errors.period_start = `This period overlaps with payroll ${overlap.reference}.`;
  }
  return errors;
}

async function reference(start, end, id = null) {
  const base = `PR-${start.replace(/-/g, '')}-${end.slice(5).replace('-', '')}`;
  let ref = base;
  let i = 2;
  while (await Payroll.findOne({ where: { reference: ref, ...(id ? { id: { [Op.ne]: id } } : {}) } })) ref = `${base}-${i++}`;
  return ref;
}

export const store = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, periodRules, { period_start: 'Period start', period_end: 'Period end', pay_date: 'Pay date' });
  Object.assign(errors, await periodErrors(data));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#payroll-modal' });
  const p = await Payroll.create({ ...data, reference: await reference(data.period_start, data.period_end), status: 'draft', created_by: req.user.id });
  await audit(req, 'payroll_create', `Created payroll ${p.reference}`, p);
  return done(req, res, 'Payroll period created. Click Calculate to compute salaries.', `/payroll/${p.id}`);
});

export const show = wrap(async (req, res) => {
  const p = await Payroll.findByPk(req.params.id, {
    include: [{ model: User, as: 'creator', attributes: ['id', 'name'] }, { model: User, as: 'approver', attributes: ['id', 'name'] }],
  });
  if (!p) throw new AppError('Payroll not found.', 404);
  let details = plain(await PayrollDetail.findAll({
    where: { payroll_id: p.id },
    include: [{ model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }] }],
  }));
  details.sort((a, b) => (a.employee?.last_name || '').localeCompare(b.employee?.last_name || ''));
  if (req.query.search) {
    const s = req.query.search.toLowerCase();
    details = details.filter((d) => `${d.employee?.full_name} ${d.employee?.employee_code}`.toLowerCase().includes(s));
  }
  const sum = (k) => details.reduce((t, d) => t + Number(d[k] || 0), 0);
  const payroll = plain(p);
  const idx = STEPS.indexOf(p.status);

  res.render('payroll/show', {
    title: `Payroll ${p.reference}`,
    payroll,
    details: details.map((d) => ({ ...d, adjust: { adjustment_additions: d.adjustment_additions, adjustment_deductions: d.adjustment_deductions, adjustment_notes: d.adjustment_notes || '' } })),
    steps: STEPS.map((s, i) => ({ label: s[0].toUpperCase() + s.slice(1), num: i + 1, done: idx >= i, current: idx === i })),
    totals: {
      basic: sum('basic_salary'), ot: sum('overtime_pay'), holiday: sum('holiday_pay'), nd: sum('night_differential'),
      allow: sum('allowances') + sum('incentives') + sum('adjustment_additions'), gov: sum('sss') + sum('philhealth') + sum('pagibig'), tax: sum('withholding_tax'),
      absence: sum('absence_deduction'),
    },
    unapprovedOvertime: p.is_editable ? await Attendance.count({ where: { overtime_status: 'pending', date: { [Op.between]: [p.period_start, p.period_end] } } }) : 0,
    editable: p.is_editable,
    filters: req.query,
    form: { period_start: p.period_start, period_end: p.period_end, pay_date: p.pay_date, notes: p.notes || '' },
  });
});

export const update = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (!p.is_editable) throw new AppError('Approved payrolls can no longer be edited.');
  const { data, errors } = validate(req.body, periodRules);
  Object.assign(errors, await periodErrors(data, p.id));
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#payroll-modal' });
  const changed = data.period_start !== p.period_start || data.period_end !== p.period_end;
  await p.update({ ...data, ...(changed ? { reference: await reference(data.period_start, data.period_end, p.id), status: 'draft' } : {}) });
  if (changed) {
    await PayrollDetail.destroy({ where: { payroll_id: p.id } });
    await new PayrollService().refreshTotals(p);
  }
  await audit(req, 'payroll_update', `Updated payroll ${p.reference}`, p);
  return done(req, res, `Payroll updated.${changed ? ' Please recalculate.' : ''}`);
});

export const destroy = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (!p.is_editable) throw new AppError('Approved or paid payrolls cannot be deleted.');
  await p.destroy();
  await audit(req, 'payroll_delete', `Deleted payroll ${p.reference}`);
  return done(req, res, 'Payroll deleted.', '/payroll');
});

export const calculate = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (!p.is_editable) throw new AppError(`This payroll is already ${p.status} and cannot be recalculated.`);
  await new PayrollService().calculate(p);
  await audit(req, 'payroll_calculate', `Calculated payroll ${p.reference}: ${p.employee_count} employees, net ${money(p.total_net, 'PHP ')}`, p);
  return done(req, res, `Payroll calculated for ${p.employee_count} employee(s).`);
});

export const approve = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (p.status !== 'calculated') throw new AppError('Only calculated payrolls can be finalized.');
  const details = await PayrollDetail.findAll({ where: { payroll_id: p.id }, include: [{ model: Employee, as: 'employee', attributes: ['id', 'user_id'] }] });
  if (!details.length) throw new AppError('This payroll has no employees.');
  await p.update({ status: 'approved', approved_by: req.user.id, approved_at: new Date() });
  const issued = await new PayrollService().issuePayslips(p);
  const period = `${formatDate(p.period_start, 'short')} - ${formatDate(p.period_end)}`;
  for (const d of details) await notify(d.employee?.user_id, 'Payslip available', `Your payslip for ${period} is now available.`, 'success', `/my/payslips/${d.id}`);
  await audit(req, 'payroll_approve', `Finalized payroll ${p.reference} (net ${money(p.total_net, 'PHP ')}); ${issued} payslip(s) issued`, p);
  return done(req, res, `Payroll finalized and locked. ${issued} payslip(s) issued to employees.`);
});

export const markPaid = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (p.status !== 'approved') throw new AppError('Only finalized payrolls can be marked as paid.');
  await p.update({ status: 'paid', paid_at: new Date() });
  await Payslip.update({ payment_status: 'paid', paid_at: new Date() }, { where: { payroll_id: p.id } });
  await audit(req, 'payroll_paid', `Processed / released payment for payroll ${p.reference}`, p);
  return done(req, res, 'Payroll marked as paid.');
});

/** Authorized correction process: admin reopens a finalized (unpaid) payroll; recorded in the audit log. */
export const reopen = wrap(async (req, res) => {
  const p = await findPayroll(req.params.id);
  if (p.status !== 'approved') throw new AppError('Only finalized (unpaid) payrolls can be reopened.');
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 5) throw new AppError('Please give a reason (at least 5 characters) for reopening a finalized payroll.');
  await p.update({ status: 'calculated', approved_by: null, approved_at: null });
  await Payslip.destroy({ where: { payroll_id: p.id } });
  await audit(req, 'payroll_reopen', `Reopened finalized payroll ${p.reference}: ${reason}`, p, { reason });
  return done(req, res, 'Payroll reopened for corrections. Payslips are withdrawn until it is finalized again.');
});

export const updateDetail = wrap(async (req, res) => {
  const d = await PayrollDetail.findByPk(req.params.id, { include: [{ model: Payroll, as: 'payroll' }, { model: Employee, as: 'employee' }] });
  if (!d) throw new AppError('Payroll line not found.', 404);
  if (!d.payroll.is_editable) throw new AppError('This payroll is locked.');
  const { data, errors } = validate(req.body, {
    adjustment_additions: 'required|number|min:0|max:999999', adjustment_deductions: 'required|number|min:0|max:999999', adjustment_notes: 'nullable|string|max:500',
  }, { adjustment_additions: 'Additional earnings', adjustment_deductions: 'Additional deductions' });
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#adjust-modal' });
  const before = { additions: d.adjustment_additions, deductions: d.adjustment_deductions, net: d.net_salary };
  await new PayrollService().applyAdjustments(d, data.adjustment_additions, data.adjustment_deductions, data.adjustment_notes);
  await audit(req, 'payroll_adjust', `Adjusted payroll line of ${d.employee.full_name} in ${d.payroll.reference}`, d, {
    before, after: { additions: d.adjustment_additions, deductions: d.adjustment_deductions, net: d.net_salary },
  });
  return done(req, res, `Adjustments saved. New net pay: ${money(d.net_salary)}.`);
});

// ---------------------------------------------------------------- salary configuration
const KINDS = { allowances: Allowance, deductions: SalaryDeduction };

export const salary = wrap(async (req, res) => {
  const kind = req.query.kind === 'deductions' ? 'deductions' : 'allowances';
  const Model = KINDS[kind];
  const where = {};
  if (req.query.search) {
    const like = { [Op.like]: `%${req.query.search}%` };
    where[Op.or] = [{ name: like }, { '$employee.first_name$': like }, { '$employee.last_name$': like }, { '$employee.employee_code$': like }];
  }
  const { rows, pager } = await paginate(Model, req, {
    where,
    include: [{ model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }] }],
    order: [['created_at', 'DESC']],
  });
  res.render('payroll/salary', {
    title: 'Allowances, Incentives & Deductions',
    tab: 'salary',
    kind,
    isAllowances: kind === 'allowances',
    items: rows.map((i) => ({ ...i, form: { name: i.name, category: i.category, amount: i.amount, is_active: i.is_active, is_taxable: i.is_taxable, type: i.type, start_date: i.start_date, end_date: i.end_date } })),
    pager,
    filters: req.query,
    ...(await lookups({ employees: true })),
  });
});

function salaryRules(kind, creating) {
  const rules = { name: 'required|string|max:100', amount: 'required|number|min:0|max:999999', is_active: 'boolean' };
  if (creating) rules.employee_ids = 'required|array|each:int';
  if (kind === 'allowances') Object.assign(rules, { is_taxable: 'boolean', category: 'nullable|in:allowance,incentive' });
  else Object.assign(rules, { type: `required|in:${DEDUCTION_TYPES.join(',')}`, start_date: 'nullable|date', end_date: 'nullable|date' });
  return rules;
}

const kindOf = (req) => {
  if (!KINDS[req.params.kind]) throw new AppError('Not found.', 404);
  return req.params.kind;
};

export const storeSalary = wrap(async (req, res) => {
  const kind = kindOf(req);
  const { data, errors } = validate(req.body, salaryRules(kind, true), { employee_ids: 'Employees' });
  if (data.end_date && data.start_date && data.end_date < data.start_date) errors.end_date = 'End date must be after the start date.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#salary-modal' });
  const { employee_ids: ids, ...attrs } = data;
  if (kind === 'allowances' && !attrs.category) attrs.category = 'allowance';
  for (const employee_id of ids) await KINDS[kind].create({ ...attrs, employee_id });
  await audit(req, `${kind}_create`, `Added ${kind.slice(0, -1)} "${data.name}" (${data.amount}/period) to ${ids.length} employee(s)`);
  return done(req, res, `${kind === 'allowances' ? 'Allowance' : 'Deduction'} saved for ${ids.length} employee(s).`);
});

export const updateSalary = wrap(async (req, res) => {
  const kind = kindOf(req);
  const item = await KINDS[kind].findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!item) throw new AppError('Item not found.', 404);
  const { data, errors } = validate(req.body, salaryRules(kind, false));
  if (data.end_date && data.start_date && data.end_date < data.start_date) errors.end_date = 'End date must be after the start date.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#salary-modal' });
  if (kind === 'allowances' && !data.category) delete data.category;
  await item.update(data);
  await audit(req, `${kind}_update`, `Updated ${kind.slice(0, -1)} "${item.name}" of ${item.employee?.full_name}`, item);
  return done(req, res, 'Saved.');
});

export const destroySalary = wrap(async (req, res) => {
  const kind = kindOf(req);
  const item = await KINDS[kind].findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!item) throw new AppError('Item not found.', 404);
  await item.destroy();
  await audit(req, `${kind}_delete`, `Removed ${kind.slice(0, -1)} "${item.name}" of ${item.employee?.full_name}`);
  return done(req, res, 'Removed.');
});
