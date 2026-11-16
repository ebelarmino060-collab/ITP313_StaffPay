import { Op } from 'sequelize';
import { Attendance, Department, Employee, LeaveRequest, Payroll, PayrollDetail, Shift, User, LEAVE_TYPES } from '../models/index.js';
import { formatDate, titleCase } from '../utils/format.js';
import { startOfMonth, toDateStr, toDateTimeStr, today } from '../utils/time.js';

export const REPORT_TYPES = {
  attendance: { label: 'Attendance Summary', group: 'Attendance' },
  employee_history: { label: 'Employee Attendance History', group: 'Attendance' },
  absences: { label: 'Employee Absences', group: 'Attendance' },
  late: { label: 'Late Arrivals', group: 'Attendance' },
  overtime: { label: 'Overtime Hours', group: 'Attendance' },
  leaves: { label: 'Leave Records', group: 'Leave' },
  payroll: { label: 'Monthly Payroll', group: 'Payroll' },
  payroll_annual: { label: 'Annual Payroll Summary', group: 'Payroll' },
  payroll_expenses: { label: 'Payroll Expenses by Department', group: 'Payroll' },
};

const r2 = (v) => Math.round(v * 100) / 100;
const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
const groupBy = (rows, fn) => rows.reduce((m, r) => { const k = fn(r); (m.get(k) || m.set(k, []).get(k)).push(r); return m; }, new Map());

const employeeInclude = (f) => ({
  model: Employee,
  as: 'employee',
  include: [{ model: Department, as: 'department' }],
  ...(f.department_id ? { where: { department_id: f.department_id } } : {}),
});

/**
 * Builds a report as { title, subtitle, columns[{key,label,type}], rows[], summary[{label,value,type}], chart }
 * used by the reports page and by the PDF / Excel exports.
 */
export async function generateReport(type, filters = {}) {
  if (!REPORT_TYPES[type]) throw new Error('Unknown report type.');
  const f = { ...filters, from: filters.from || toDateStr(startOfMonth()), to: filters.to || today() };
  const builders = {
    attendance, absences, late, overtime, leaves, payroll, payroll_annual: payrollAnnual,
    employee_history: employeeHistory, payroll_expenses: payrollExpenses,
  };
  const report = await builders[type](f);
  return {
    type,
    title: REPORT_TYPES[type].label,
    subtitle: report.subtitle || `${formatDate(f.from)} - ${formatDate(f.to)}`,
    generated_at: toDateTimeStr(new Date()),
    filters: f,
    ...report,
  };
}

async function attendanceRecords(f, extra = {}) {
  return Attendance.findAll({
    where: { date: { [Op.between]: [f.from, f.to] }, ...(f.employee_id ? { employee_id: f.employee_id } : {}), ...extra },
    include: [employeeInclude(f), { model: Shift, as: 'shift' }],
    order: [['date', 'ASC']],
  });
}

function topByEmployee(records, label, valueFn = (items) => items.length) {
  const data = [...groupBy(records, (r) => r.employee_id).values()]
    .map((items) => ({ label: items[0].employee?.full_name, value: valueFn(items) }))
    .sort((a, b) => b.value - a.value).slice(0, 10);
  return { type: 'bar', labels: data.map((d) => d.label), datasets: [{ label, data: data.map((d) => d.value) }] };
}

async function attendance(f) {
  const records = await attendanceRecords(f);
  const rows = [...groupBy(records, (r) => r.employee_id).values()].map((items) => {
    const e = items[0].employee;
    const count = (s) => items.filter((i) => i.status === s).length;
    return {
      employee_code: e?.employee_code, name: e?.full_name, department: e?.department?.name,
      present: count('present'), late: count('late'), half_day: count('half_day'), absent: count('absent'), on_leave: count('on_leave'),
      late_minutes: sum(items, 'late_minutes'), undertime_minutes: sum(items, 'undertime_minutes'),
      overtime_hours: r2(sum(items, 'overtime_minutes') / 60), hours_worked: r2(sum(items, 'worked_minutes') / 60),
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const byDate = [...groupBy(records, (r) => r.date).entries()].sort(([a], [b]) => a.localeCompare(b));
  const c = (items, ...st) => items.filter((i) => st.includes(i.status)).length;

  return {
    columns: [
      { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' }, { key: 'department', label: 'Department' },
      { key: 'present', label: 'Present', type: 'number' }, { key: 'late', label: 'Late', type: 'number' },
      { key: 'half_day', label: 'Half-day', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' },
      { key: 'on_leave', label: 'On Leave', type: 'number' }, { key: 'late_minutes', label: 'Late (mins)', type: 'number' },
      { key: 'undertime_minutes', label: 'Undertime (mins)', type: 'number' }, { key: 'overtime_hours', label: 'OT (hrs)', type: 'number' },
      { key: 'hours_worked', label: 'Hours Worked', type: 'number' },
    ],
    rows,
    summary: [
      { label: 'Records', value: records.length },
      { label: 'Present', value: c(records, 'present', 'late', 'half_day') },
      { label: 'Late', value: c(records, 'late') },
      { label: 'Absent', value: c(records, 'absent') },
      { label: 'On Leave', value: c(records, 'on_leave') },
    ],
    chart: {
      type: 'bar', stacked: true,
      labels: byDate.map(([d]) => formatDate(d, 'short')),
      datasets: [
        { label: 'Present', data: byDate.map(([, i]) => c(i, 'present', 'half_day')) },
        { label: 'Late', data: byDate.map(([, i]) => c(i, 'late')) },
        { label: 'Absent', data: byDate.map(([, i]) => c(i, 'absent')) },
        { label: 'On Leave', data: byDate.map(([, i]) => c(i, 'on_leave')) },
      ],
    },
  };
}

/** Every attendance record (day by day) – pick an employee to get one person's history. */
async function employeeHistory(f) {
  const records = await attendanceRecords(f);
  records.sort((a, b) => (a.employee?.employee_code + a.date).localeCompare(b.employee?.employee_code + b.date));
  const s = (st) => records.filter((r) => r.status === st).length;
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' },
      { key: 'shift', label: 'Shift' }, { key: 'time_in', label: 'Time In', type: 'time' }, { key: 'time_out', label: 'Time Out', type: 'time' },
      { key: 'hours', label: 'Hours', type: 'number' }, { key: 'late_minutes', label: 'Late (min)', type: 'number' },
      { key: 'overtime_hours', label: 'OT (hrs)', type: 'number' }, { key: 'status', label: 'Status' }, { key: 'source', label: 'Source' },
    ],
    rows: records.map((r) => ({
      date: r.date, employee_code: r.employee?.employee_code, name: r.employee?.full_name, shift: r.shift?.name,
      time_in: r.time_in, time_out: r.time_out, hours: r2(r.worked_minutes / 60), late_minutes: r.late_minutes,
      overtime_hours: r2(r.overtime_minutes / 60), status: titleCase(r.status), source: r.import_id ? `TXT import #${r.import_id}` : titleCase(r.source),
    })),
    summary: [
      { label: 'Records', value: records.length }, { label: 'Present', value: s('present') }, { label: 'Late', value: s('late') },
      { label: 'Absent', value: s('absent') }, { label: 'On leave', value: s('on_leave') },
      { label: 'Hours worked', value: r2(sum(records, 'worked_minutes') / 60) }, { label: 'Overtime hours', value: r2(sum(records, 'overtime_minutes') / 60) },
    ],
    chart: topByEmployee(records, 'Hours worked', (items) => r2(sum(items, 'worked_minutes') / 60)),
  };
}

/** Payroll cost per department for payroll periods in the range. */
async function payrollExpenses(f) {
  const details = await PayrollDetail.findAll({
    where: f.employee_id ? { employee_id: f.employee_id } : {},
    include: [
      { model: Payroll, as: 'payroll', where: { period_start: { [Op.lte]: f.to }, period_end: { [Op.gte]: f.from }, ...(f.payroll_status ? { status: f.payroll_status } : {}) } },
      employeeInclude(f),
    ],
  });
  const rows = [...groupBy(details, (d) => d.employee?.department?.name || 'Unassigned').entries()].map(([dept, items]) => ({
    department: dept,
    employees: new Set(items.map((d) => d.employee_id)).size,
    regular: r2(sum(items, 'basic_salary')),
    overtime: r2(sum(items, 'overtime_pay')),
    allowances: r2(sum(items, 'allowances') + sum(items, 'incentives')),
    gross: r2(sum(items, 'gross_salary')),
    absences: r2(sum(items, 'absence_deduction')),
    contributions: r2(sum(items, 'sss') + sum(items, 'philhealth') + sum(items, 'pagibig')),
    net: r2(sum(items, 'net_salary')),
  })).sort((a, b) => b.gross - a.gross);
  return {
    columns: [
      { key: 'department', label: 'Department' }, { key: 'employees', label: 'Employees', type: 'number' },
      { key: 'regular', label: 'Regular Pay', type: 'money' }, { key: 'overtime', label: 'Overtime Pay', type: 'money' },
      { key: 'allowances', label: 'Allowances & Incentives', type: 'money' }, { key: 'gross', label: 'Gross Expense', type: 'money' },
      { key: 'absences', label: 'Absence Deductions', type: 'money' }, { key: 'contributions', label: 'Employee Contributions', type: 'money' },
      { key: 'net', label: 'Net Paid', type: 'money' },
    ],
    rows,
    summary: [
      { label: 'Gross payroll expense', value: r2(sum(details, 'gross_salary')), type: 'money' },
      { label: 'Overtime pay', value: r2(sum(details, 'overtime_pay')), type: 'money' },
      { label: 'Absence deductions', value: r2(sum(details, 'absence_deduction')), type: 'money' },
      { label: 'Net paid', value: r2(sum(details, 'net_salary')), type: 'money' },
    ],
    chart: { type: 'doughnut', money: true, labels: rows.map((r) => r.department), datasets: [{ label: 'Gross expense', data: rows.map((r) => r.gross) }] },
  };
}

async function absences(f) {
  const records = await attendanceRecords(f, { status: 'absent' });
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' },
      { key: 'department', label: 'Department' }, { key: 'shift', label: 'Shift' }, { key: 'remarks', label: 'Remarks' },
    ],
    rows: records.map((r) => ({
      date: r.date, employee_code: r.employee?.employee_code, name: r.employee?.full_name,
      department: r.employee?.department?.name, shift: r.shift?.name, remarks: r.remarks,
    })),
    summary: [
      { label: 'Total Absences', value: records.length },
      { label: 'Employees', value: new Set(records.map((r) => r.employee_id)).size },
    ],
    chart: topByEmployee(records, 'Absences'),
  };
}

async function late(f) {
  const records = await attendanceRecords(f, { late_minutes: { [Op.gt]: 0 } });
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' },
      { key: 'department', label: 'Department' }, { key: 'scheduled_in', label: 'Scheduled In', type: 'time' },
      { key: 'time_in', label: 'Time In', type: 'time' }, { key: 'late_minutes', label: 'Late (mins)', type: 'number' },
    ],
    rows: records.map((r) => ({
      date: r.date, employee_code: r.employee?.employee_code, name: r.employee?.full_name, department: r.employee?.department?.name,
      scheduled_in: r.scheduled_in, time_in: r.time_in, late_minutes: r.late_minutes,
    })),
    summary: [
      { label: 'Late Arrivals', value: records.length },
      { label: 'Total Late Minutes', value: sum(records, 'late_minutes') },
      { label: 'Average Minutes Late', value: records.length ? r2(sum(records, 'late_minutes') / records.length) : 0 },
    ],
    chart: topByEmployee(records, 'Late arrivals'),
  };
}

async function overtime(f) {
  const records = await attendanceRecords(f, { overtime_minutes: { [Op.gt]: 0 } });
  return {
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' },
      { key: 'department', label: 'Department' }, { key: 'scheduled_out', label: 'Scheduled Out', type: 'time' },
      { key: 'time_out', label: 'Time Out', type: 'time' }, { key: 'overtime_hours', label: 'OT (hrs)', type: 'number' },
      { key: 'overtime_status', label: 'Status' },
    ],
    rows: records.map((r) => ({
      date: r.date, employee_code: r.employee?.employee_code, name: r.employee?.full_name, department: r.employee?.department?.name,
      scheduled_out: r.scheduled_out, time_out: r.time_out, overtime_hours: r2(r.overtime_minutes / 60), overtime_status: titleCase(r.overtime_status),
    })),
    summary: [
      { label: 'OT Records', value: records.length },
      { label: 'Total OT Hours', value: r2(sum(records, 'overtime_minutes') / 60) },
      { label: 'Approved OT Hours', value: r2(sum(records.filter((r) => r.overtime_status === 'approved'), 'overtime_minutes') / 60) },
    ],
    chart: topByEmployee(records, 'Overtime hours', (items) => r2(sum(items, 'overtime_minutes') / 60)),
  };
}

async function leaves(f) {
  const records = await LeaveRequest.findAll({
    where: {
      start_date: { [Op.lte]: f.to }, end_date: { [Op.gte]: f.from },
      ...(f.employee_id ? { employee_id: f.employee_id } : {}), ...(f.status ? { status: f.status } : {}),
    },
    include: [employeeInclude(f), { model: User, as: 'reviewer' }],
    order: [['start_date', 'ASC']],
  });
  const days = (t, st) => sum(records.filter((r) => r.leave_type === t && r.status === st), 'days');
  return {
    columns: [
      { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' }, { key: 'department', label: 'Department' },
      { key: 'leave_type', label: 'Type' }, { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To', type: 'date' },
      { key: 'days', label: 'Days', type: 'number' }, { key: 'status', label: 'Status' }, { key: 'reviewed_by', label: 'Reviewed By' },
    ],
    rows: records.map((r) => ({
      employee_code: r.employee?.employee_code, name: r.employee?.full_name, department: r.employee?.department?.name,
      leave_type: titleCase(r.leave_type), start_date: r.start_date, end_date: r.end_date, days: r.days,
      status: titleCase(r.status), reviewed_by: r.reviewer?.name,
    })),
    summary: [
      { label: 'Requests', value: records.length },
      { label: 'Approved Days', value: sum(records.filter((r) => r.status === 'approved'), 'days') },
      { label: 'Pending', value: records.filter((r) => r.status === 'pending').length },
    ],
    chart: {
      type: 'bar', stacked: true, labels: LEAVE_TYPES.map(titleCase),
      datasets: ['approved', 'pending', 'rejected'].map((st) => ({ label: `${titleCase(st)} days`, data: LEAVE_TYPES.map((t) => days(t, st)) })),
    },
  };
}

async function payroll(f) {
  const details = await PayrollDetail.findAll({
    where: f.employee_id ? { employee_id: f.employee_id } : {},
    include: [
      { model: Payroll, as: 'payroll', where: { period_start: { [Op.lte]: f.to }, period_end: { [Op.gte]: f.from }, ...(f.payroll_status ? { status: f.payroll_status } : {}) } },
      employeeInclude(f),
    ],
  });
  details.sort((a, b) => (a.payroll.period_start + (a.employee?.last_name || '')).localeCompare(b.payroll.period_start + (b.employee?.last_name || '')));
  const byDept = [...groupBy(details, (d) => d.employee?.department?.name || 'Unassigned').entries()];

  return {
    columns: [
      { key: 'period', label: 'Pay Period' }, { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' },
      { key: 'department', label: 'Department' }, { key: 'basic_salary', label: 'Basic', type: 'money' },
      { key: 'overtime_pay', label: 'Overtime', type: 'money' }, { key: 'holiday_pay', label: 'Holiday', type: 'money' },
      { key: 'night_differential', label: 'Night Diff', type: 'money' }, { key: 'allowances', label: 'Allowances', type: 'money' },
      { key: 'gross_salary', label: 'Gross', type: 'money' }, { key: 'total_deductions', label: 'Deductions', type: 'money' },
      { key: 'net_salary', label: 'Net Pay', type: 'money' }, { key: 'status', label: 'Status' },
    ],
    rows: details.map((d) => ({
      period: `${formatDate(d.payroll.period_start, 'short')} - ${formatDate(d.payroll.period_end)}`,
      employee_code: d.employee?.employee_code, name: d.employee?.full_name, department: d.employee?.department?.name,
      basic_salary: d.basic_salary, overtime_pay: d.overtime_pay, holiday_pay: d.holiday_pay, night_differential: d.night_differential,
      allowances: d.allowances, gross_salary: d.gross_salary, total_deductions: d.total_deductions, net_salary: d.net_salary,
      status: titleCase(d.payroll.status),
    })),
    summary: [
      { label: 'Payslips', value: details.length },
      { label: 'Total Gross', value: r2(sum(details, 'gross_salary')), type: 'money' },
      { label: 'Total Deductions', value: r2(sum(details, 'total_deductions')), type: 'money' },
      { label: 'Total Net Pay', value: r2(sum(details, 'net_salary')), type: 'money' },
    ],
    chart: {
      type: 'bar', money: true, labels: byDept.map(([k]) => k),
      datasets: [
        { label: 'Gross', data: byDept.map(([, items]) => r2(sum(items, 'gross_salary'))) },
        { label: 'Net', data: byDept.map(([, items]) => r2(sum(items, 'net_salary'))) },
      ],
    },
  };
}

async function payrollAnnual(f) {
  const year = Number(f.year) || new Date().getFullYear();
  const payrolls = await Payroll.findAll({
    where: { period_start: { [Op.between]: [`${year}-01-01`, `${year}-12-31`] } },
    include: [{
      model: PayrollDetail, as: 'details', required: false,
      where: f.employee_id ? { employee_id: f.employee_id } : undefined,
      include: f.department_id ? [{ model: Employee, as: 'employee', where: { department_id: f.department_id } }] : [],
    }],
  });

  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const rows = names.map((month, i) => {
    const inMonth = payrolls.filter((p) => Number(p.period_start.slice(5, 7)) === i + 1);
    const d = inMonth.flatMap((p) => p.details);
    return {
      month, runs: inMonth.length, employees: new Set(d.map((x) => x.employee_id)).size,
      basic_salary: r2(sum(d, 'basic_salary')), overtime_pay: r2(sum(d, 'overtime_pay')), gross_salary: r2(sum(d, 'gross_salary')),
      contributions: r2(sum(d, 'sss') + sum(d, 'philhealth') + sum(d, 'pagibig')), withholding_tax: r2(sum(d, 'withholding_tax')),
      total_deductions: r2(sum(d, 'total_deductions')), net_salary: r2(sum(d, 'net_salary')),
    };
  });
  const all = payrolls.flatMap((p) => p.details);

  return {
    subtitle: `Year ${year}`,
    columns: [
      { key: 'month', label: 'Month' }, { key: 'runs', label: 'Payroll Runs', type: 'number' }, { key: 'employees', label: 'Employees', type: 'number' },
      { key: 'basic_salary', label: 'Basic', type: 'money' }, { key: 'overtime_pay', label: 'Overtime', type: 'money' },
      { key: 'gross_salary', label: 'Gross', type: 'money' }, { key: 'contributions', label: 'Gov. Contributions', type: 'money' },
      { key: 'withholding_tax', label: 'Tax', type: 'money' }, { key: 'total_deductions', label: 'Deductions', type: 'money' },
      { key: 'net_salary', label: 'Net Pay', type: 'money' },
    ],
    rows,
    summary: [
      { label: 'Payroll Runs', value: payrolls.length },
      { label: 'Annual Gross', value: r2(sum(all, 'gross_salary')), type: 'money' },
      { label: 'Annual Deductions', value: r2(sum(all, 'total_deductions')), type: 'money' },
      { label: 'Annual Net Pay', value: r2(sum(all, 'net_salary')), type: 'money' },
    ],
    chart: {
      type: 'line', money: true, labels: names.map((n) => n.slice(0, 3)),
      datasets: [{ label: 'Gross', data: rows.map((r) => r.gross_salary) }, { label: 'Net', data: rows.map((r) => r.net_salary) }],
    },
  };
}
