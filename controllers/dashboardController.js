import { Op } from 'sequelize';
import {
  Attendance, AttendanceCorrection, AttendanceImport, AuditLog, Department, Employee, LeaveBalance, LeaveRequest, Payroll, PayrollDetail, User,
  plain, ACTIVE_STATUSES, ROLES,
} from '../models/index.js';
import { AttendanceService } from '../services/attendanceService.js';
import { ensureBalances } from '../services/leaveService.js';
import { wrap } from '../utils/errors.js';
import { addDays, startOfMonth, toDateStr, today } from '../utils/time.js';
import { formatDate } from '../utils/format.js';
import { clockData } from './shared.js';

export const dashboard = wrap(async (req, res) => {
  if (['admin', 'hr'].includes(req.user.role)) return management(req, res);
  return employeeDashboard(req, res);
});

async function management(req, res) {
  const service = new AttendanceService();
  const date = today();
  const daily = await service.dailyStatus(date);

  const currentPayroll = await Payroll.findOne({ where: { period_start: { [Op.lte]: date }, period_end: { [Op.gte]: date } }, order: [['period_start', 'DESC']] })
    || await Payroll.findOne({ order: [['period_start', 'DESC']] });

  // Attendance for the last 7 days.
  const weekly = { labels: [], present: [], late: [], absent: [], on_leave: [] };
  for (let i = 6; i >= 0; i--) {
    const d = toDateStr(addDays(new Date(), -i));
    let c;
    if (d === date) {
      const s = daily.summary;
      c = { present: s.present + s.half_day, late: s.late, absent: s.absent, on_leave: s.on_leave };
    } else {
      const rows = await Attendance.findAll({ where: { date: d }, attributes: ['status'] });
      const n = (...st) => rows.filter((r) => st.includes(r.status)).length;
      c = { present: n('present', 'half_day'), late: n('late'), absent: n('absent'), on_leave: n('on_leave') };
    }
    weekly.labels.push(d === date ? 'Today' : formatDate(d, 'weekday'));
    for (const k of ['present', 'late', 'absent', 'on_leave']) weekly[k].push(c[k]);
  }

  const departments = await Department.findAll({ order: [['name', 'ASC']] });
  const deptCounts = [];
  for (const d of departments) {
    const n = await Employee.count({ where: { department_id: d.id, employment_status: ACTIVE_STATUSES } });
    if (n) deptCounts.push({ label: d.name, value: n });
  }

  // Only computed payrolls belong in the trend (drafts are still 0).
  const trend = (await Payroll.findAll({ where: { status: { [Op.ne]: 'draft' } }, order: [['period_start', 'DESC']], limit: 6 })).reverse();

  const recent = await Attendance.findAll({
    where: { time_in: { [Op.ne]: null } },
    include: [{ model: Employee, as: 'employee' }],
    order: [['updated_at', 'DESC']],
    limit: 8,
  });

  const data = {
    title: 'Dashboard',
    useCharts: true,
    greeting: (() => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'; })(),
    firstName: req.user.name.split(' ')[0],
    stats: {
      total_employees: await Employee.count({ where: { employment_status: ACTIVE_STATUSES } }),
      present_today: daily.summary.reported,
      absent_today: daily.summary.absent,
      on_leave_today: daily.summary.on_leave,
      late_today: daily.summary.late,
      awaiting_today: daily.summary.awaiting,
      pending_leaves: await LeaveRequest.count({ where: { status: 'pending' } }),
      pending_corrections: await AttendanceCorrection.count({ where: { status: 'pending' } }),
      pending_overtime: await Attendance.count({ where: { overtime_status: 'pending' } }),
      overtime_hours_month: Math.round(((await Attendance.sum('overtime_minutes', { where: { date: { [Op.between]: [toDateStr(startOfMonth()), date] } } })) || 0) / 6) / 10,
      payroll_expenses_year: (await Payroll.sum('total_gross', { where: { status: ['approved', 'paid'], period_start: { [Op.between]: [`${date.slice(0, 4)}-01-01`, `${date.slice(0, 4)}-12-31`] } } })) || 0,
    },
    lastImport: plain(await AttendanceImport.findOne({ where: { status: 'completed' }, attributes: { exclude: ['content', 'preview'] }, order: [['committed_at', 'DESC']] })),
    currentPayroll: currentPayroll ? plain(currentPayroll) : null,
    charts: {
      weekly: { type: 'bar', stacked: true, labels: weekly.labels, datasets: [
        { label: 'Present', data: weekly.present }, { label: 'Late', data: weekly.late },
        { label: 'Absent', data: weekly.absent }, { label: 'On Leave', data: weekly.on_leave },
      ], colors: ['#1e3a5f', '#f59e0b', '#ef4444', '#0ea5e9'] },
      departments: { type: 'doughnut', labels: deptCounts.map((d) => d.label), datasets: [{ label: 'Employees', data: deptCounts.map((d) => d.value) }] },
      payroll: { type: 'line', money: true, labels: trend.map((p) => formatDate(p.period_end, 'short')), datasets: [
        { label: 'Gross', data: trend.map((p) => p.total_gross) }, { label: 'Net', data: trend.map((p) => p.total_net) },
      ], colors: ['#3b82f6', '#1e3a5f'] },
    },
    recent: recent.map((a) => ({
      employee: a.employee?.full_name, photo_url: a.employee?.photo_url, action: a.time_out ? 'Timed out' : 'Timed in', time: a.time_out || a.time_in, status: a.status,
    })),
    pendingLeaves: plain(await LeaveRequest.findAll({ where: { status: 'pending' }, include: [{ model: Employee, as: 'employee' }], order: [['start_date', 'ASC']], limit: 5 })),
  };

  if (req.user.role === 'admin') {
    data.usersByRole = await Promise.all(ROLES.map(async (r) => ({ role: r, count: await User.count({ where: { role: r } }) })));
    data.recentAudit = plain(await AuditLog.findAll({ include: [{ model: User, as: 'user' }], order: [['created_at', 'DESC']], limit: 6 }));
  }
  return res.render('dashboard/management', data);
}

async function employeeDashboard(req, res) {
  const employee = req.user.employee;
  if (!employee) return res.render('dashboard/employee', { title: 'Dashboard', noEmployee: true });
  const service = new AttendanceService();
  const monthStart = toDateStr(startOfMonth());
  const month = await Attendance.findAll({ where: { employee_id: employee.id, date: { [Op.between]: [monthStart, today()] } } });
  const n = (...st) => month.filter((r) => st.includes(r.status)).length;
  const sum = (k) => month.reduce((t, r) => t + r[k], 0);
  await ensureBalances(employee.id, new Date().getFullYear());

  const slips = await PayrollDetail.findAll({
    where: { employee_id: employee.id },
    include: [{ model: Payroll, as: 'payroll', where: { status: ['approved', 'paid'] } }],
  });
  slips.sort((a, b) => b.payroll.period_end.localeCompare(a.payroll.period_end));

  const week = await service.schedules.calendar([employee], today(), toDateStr(addDays(new Date(), 6)));

  res.render('dashboard/employee', {
    title: 'Dashboard',
    employee: plain(employee),
    clock: await clockData(employee, service),
    month: {
      present: n('present', 'late', 'half_day'), late: n('late'), absent: n('absent'), on_leave: n('on_leave'),
      late_minutes: sum('late_minutes'), overtime_hours: Math.round(sum('overtime_minutes') / 6) / 10, hours_worked: Math.round(sum('worked_minutes') / 6) / 10,
    },
    balances: plain(await LeaveBalance.findAll({ where: { employee_id: employee.id, year: new Date().getFullYear() } })),
    pendingLeaves: await LeaveRequest.count({ where: { employee_id: employee.id, status: 'pending' } }),
    latestPayslip: slips[0] ? plain(slips[0]) : null,
    week: week.rows[0]?.days || [],
  });
}
