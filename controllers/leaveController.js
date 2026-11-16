import { Department, Employee, LeaveBalance, LeaveRequest, User, plain, ACTIVE_STATUSES, PAID_LEAVE_TYPES } from '../models/index.js';
import { AttendanceService } from '../services/attendanceService.js';
import { audit, notify } from '../services/audit.js';
import { balanceFor, ensureBalances } from '../services/leaveService.js';
import { paginate } from '../utils/paginate.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { formatDate } from '../utils/format.js';
import { employeeSearch, lookups } from './shared.js';

export const requests = wrap(async (req, res) => {
  const q = { status: 'pending', ...req.query };
  const where = {};
  if (q.status) where.status = q.status;
  if (q.leave_type) where.leave_type = q.leave_type;
  const { rows, pager } = await paginate(LeaveRequest, req, {
    where,
    include: [
      { model: Employee, as: 'employee', where: { ...employeeSearch(q.search), ...(q.department_id ? { department_id: q.department_id } : {}) }, include: [{ model: Department, as: 'department' }] },
      { model: User, as: 'reviewer', attributes: ['id', 'name'] },
    ],
    order: [['created_at', 'DESC']],
  });
  res.render('leaves/requests', { title: 'Leave Requests', tab: 'requests', leaves: rows, pager, filters: q, ...(await lookups()) });
});

export const review = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { status: 'required|in:approved,rejected', remarks: 'nullable|string|max:500' });
  if (Object.keys(errors).length) throw new AppError(Object.values(errors)[0]);
  const leave = await LeaveRequest.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!leave) throw new AppError('Leave request not found.', 404);
  if (leave.status !== 'pending') throw new AppError(`This leave request has already been ${leave.status}.`);

  if (data.status === 'approved' && leave.is_paid) {
    const balance = await balanceFor(leave.employee_id, Number(leave.start_date.slice(0, 4)), leave.leave_type);
    if (balance.remaining < leave.days) {
      throw new AppError(`Insufficient ${leave.leave_type} leave balance (${balance.remaining} day(s) remaining, ${leave.days} requested).`);
    }
    await balance.increment('used', { by: leave.days });
  }
  await leave.update({ status: data.status, remarks: data.remarks, reviewed_by: req.user.id, reviewed_at: new Date() });
  if (data.status === 'approved') await new AttendanceService().applyLeave(leave);

  const range = `${formatDate(leave.start_date, 'short')} - ${formatDate(leave.end_date)}`;
  await notify(leave.employee.user_id, `Leave request ${data.status}`,
    `${leave.leave_type[0].toUpperCase()}${leave.leave_type.slice(1)} leave for ${range} was ${data.status}.${data.remarks ? ` Remarks: ${data.remarks}` : ''}`,
    data.status === 'approved' ? 'success' : 'warning', '/my/leaves');
  await audit(req, `leave_${data.status}`, `${data.status === 'approved' ? 'Approved' : 'Rejected'} ${leave.leave_type} leave of ${leave.employee.full_name} (${range})`, leave);
  return done(req, res, `Leave request ${data.status}.`);
});

export const balances = wrap(async (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const where = { employment_status: ACTIVE_STATUSES, ...employeeSearch(req.query.search) };
  if (req.query.department_id) where.department_id = req.query.department_id;
  const { rows, pager } = await paginate(Employee, req, { where, include: [{ model: Department, as: 'department' }], order: [['last_name', 'ASC'], ['first_name', 'ASC']] }, 20);
  for (const e of rows) await ensureBalances(e.id, year);
  const all = await LeaveBalance.findAll({ where: { year, employee_id: rows.map((e) => e.id) } });
  const y = new Date().getFullYear();
  res.render('leaves/balances', {
    title: 'Leave Balances',
    tab: 'balances',
    year,
    years: [y - 2, y - 1, y, y + 1].map((v) => ({ value: v, label: v })),
    rows: rows.map((e) => ({
      employee: e,
      balances: PAID_LEAVE_TYPES.map((t) => {
        const b = all.find((x) => x.employee_id === e.id && x.leave_type === t);
        return b ? { ...plain(b), employee_name: e.full_name } : null;
      }),
    })),
    pager,
    filters: req.query,
    ...(await lookups()),
  });
});

export const updateBalance = wrap(async (req, res) => {
  const b = await LeaveBalance.findByPk(req.params.id, { include: [{ model: Employee, as: 'employee' }] });
  if (!b) throw new AppError('Balance not found.', 404);
  const { data, errors } = validate(req.body, { allocated: 'required|number|min:0|max:365', used: 'required|number|min:0|max:365' });
  if (Object.keys(errors).length) return invalid(req, res, errors, { modal: '#balance-modal' });
  await b.update(data);
  await audit(req, 'leave_balance_update', `Adjusted ${b.leave_type} leave balance of ${b.employee.full_name} (${b.year})`, b, data);
  return done(req, res, 'Leave balance updated.');
});

export const history = wrap(async (req, res) => {
  const e = await Employee.findByPk(req.params.id, { include: [{ model: Department, as: 'department' }] });
  if (!e) throw new AppError('Employee not found.', 404);
  const year = Number(req.query.year) || new Date().getFullYear();
  await ensureBalances(e.id, year);
  res.render('leaves/history', {
    title: `Leave History – ${e.full_name}`,
    tab: 'balances',
    employee: plain(e),
    year,
    balances: plain(await LeaveBalance.findAll({ where: { employee_id: e.id, year } })),
    requests: plain(await LeaveRequest.findAll({ where: { employee_id: e.id }, include: [{ model: User, as: 'reviewer', attributes: ['id', 'name'] }], order: [['start_date', 'DESC']] })),
  });
});
