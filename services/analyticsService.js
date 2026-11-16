/*
 * Attendance analytics (weekly / monthly / yearly / custom range), computed from the
 * attendance records stored in the database. Every table can be exported to PDF / Excel.
 *
 *   Attendance % = attended days / (attended days + absent days) x 100
 *   attended: present or late = 1, half-day = 0.5 ;  absent = 1 (half-day adds 0.5)
 *   approved leave, rest days and holidays are excluded from the percentage.
 */
import { Op } from 'sequelize';
import { Attendance, Department, Employee, ACTIVE_STATUSES } from '../models/index.js';
import { addDays, dateRange, endOfMonth, parseDate, startOfWeek, toDateStr, today } from '../utils/time.js';
import { formatDate } from '../utils/format.js';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** Totals for a list of attendance records. */
export function stats(records) {
  let attended = 0; let absent = 0; let late = 0; let leave = 0; let halfDay = 0;
  let worked = 0; let ot = 0; let workedDays = 0;
  for (const r of records) {
    if (r.status === 'present' || r.status === 'late') { attended += 1; workedDays += 1; }
    if (r.status === 'late') late += 1;
    if (r.status === 'half_day') { attended += 0.5; absent += 0.5; halfDay += 1; workedDays += 1; }
    if (r.status === 'absent') absent += 1;
    if (r.status === 'on_leave') leave += 1;
    worked += r.worked_minutes || 0;
    ot += r.overtime_minutes || 0;
  }
  const base = attended + absent;
  return {
    present: attended, absent, late, leave, half_day: halfDay,
    overtime_hours: r2(ot / 60),
    hours_worked: r2(worked / 60),
    avg_hours: workedDays ? r2(worked / 60 / workedDays) : 0,
    rate: base ? r1((attended / base) * 100) : null,
  };
}

const groupBy = (rows, fn) => rows.reduce((m, r) => { const k = fn(r); (m.get(k) || m.set(k, []).get(k)).push(r); return m; }, new Map());

/** Resolve the date range for a view. */
export function rangeFor(view, q = {}) {
  const now = new Date();
  if (view === 'weekly') {
    const start = startOfWeek(parseDate(q.date) || now);
    const from = toDateStr(start);
    return { from, to: toDateStr(addDays(start, 6)), label: `Week of ${formatDate(from, 'short')} – ${formatDate(addDays(start, 6))}`, anchor: from };
  }
  if (view === 'yearly') {
    const y = Number(q.year) || now.getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31`, label: `Year ${y}`, year: y };
  }
  if (view === 'custom' && parseDate(q.from) && parseDate(q.to)) {
    let [from, to] = [toDateStr(q.from), toDateStr(q.to)];
    if (to < from) [from, to] = [to, from];
    return { from, to, label: `${formatDate(from)} – ${formatDate(to)}` };
  }
  const m = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : toDateStr(now).slice(0, 7);
  const from = `${m}-01`;
  return { from, to: toDateStr(endOfMonth(from)), label: formatDate(from, 'month'), month: m };
}

export async function attendanceAnalytics(view, q = {}) {
  const range = rangeFor(view, q);
  const empWhere = { employment_status: ACTIVE_STATUSES };
  if (q.department_id) empWhere.department_id = q.department_id;
  if (q.employee_id) empWhere.id = q.employee_id;
  const employees = await Employee.findAll({ where: empWhere, include: [{ model: Department, as: 'department' }], order: [['employee_code', 'ASC']] });
  const ids = employees.map((e) => e.id);
  const records = ids.length ? await Attendance.findAll({ where: { employee_id: ids, date: { [Op.between]: [range.from, range.to] } }, attributes: ['employee_id', 'date', 'status', 'worked_minutes', 'overtime_minutes', 'late_minutes'] }) : [];
  const total = stats(records);
  const byEmp = groupBy(records, (r) => r.employee_id);
  const empMap = new Map(employees.map((e) => [e.id, e]));

  const cards = [
    { label: 'Total Employees', value: employees.length, icon: 'users', tone: 'navy' },
    { label: 'Present (days)', value: total.present, icon: 'user-check', tone: 'green' },
    { label: 'Absent (days)', value: total.absent, icon: 'user-x', tone: 'red' },
    { label: 'Late Arrivals', value: total.late, icon: 'clock', tone: 'amber' },
    { label: 'On Leave (days)', value: total.leave, icon: 'plane-takeoff', tone: 'sky' },
    { label: 'Total Overtime Hours', value: total.overtime_hours, icon: 'timer', tone: 'blue' },
    { label: 'Average Working Hours', value: `${total.avg_hours} h/day`, icon: 'hourglass', tone: 'navy' },
    { label: 'Attendance Rate', value: total.rate === null ? '—' : `${total.rate}%`, icon: 'chart-column', tone: 'green' },
  ];

  // Per-employee table (all views).
  const employeeRows = employees.map((e) => {
    const s = stats(byEmp.get(e.id) || []);
    return { employee_code: e.employee_code, name: e.full_name, department: e.department?.name || '—', ...s, rate: s.rate ?? '' };
  });
  const employeeColumns = [
    { key: 'employee_code', label: 'Emp. ID' }, { key: 'name', label: 'Employee' }, { key: 'department', label: 'Department' },
    { key: 'present', label: 'Present', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' }, { key: 'late', label: 'Late', type: 'number' },
    { key: 'leave', label: 'On Leave', type: 'number' }, { key: 'overtime_hours', label: 'OT Hours', type: 'number' },
    { key: 'hours_worked', label: 'Hours Worked', type: 'number' }, { key: 'rate', label: 'Attendance %', type: 'percent' },
  ];

  // Department comparison.
  const deptGroups = groupBy(employees, (e) => e.department?.name || 'Unassigned');
  const deptRows = [...deptGroups.entries()].map(([name, list]) => {
    const s = stats(list.flatMap((e) => byEmp.get(e.id) || []));
    return { department: name, employees: list.length, ...s, rate: s.rate ?? '' };
  }).sort((a, b) => a.department.localeCompare(b.department));
  const deptColumns = [
    { key: 'department', label: 'Department' }, { key: 'employees', label: 'Employees', type: 'number' },
    { key: 'present', label: 'Present', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' }, { key: 'late', label: 'Late', type: 'number' },
    { key: 'overtime_hours', label: 'OT Hours', type: 'number' }, { key: 'rate', label: 'Attendance %', type: 'percent' },
  ];
  const deptChart = {
    type: 'bar', labels: deptRows.map((d) => d.department),
    datasets: [{ label: 'Attendance %', data: deptRows.map((d) => d.rate || 0) }], colors: ['#1e3a5f'],
  };

  let periodRows; let periodColumns; let trend;
  if (view === 'weekly') {
    const byDate = groupBy(records, (r) => r.date);
    periodRows = dateRange(range.from, range.to).map((d, i) => {
      const s = stats(byDate.get(d) || []);
      return { day: WEEKDAYS[i], date: d, ...s, rate: s.rate ?? '', future: d > today() };
    });
    periodColumns = [
      { key: 'day', label: 'Day' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'present', label: 'Present', type: 'number' },
      { key: 'absent', label: 'Absent', type: 'number' }, { key: 'late', label: 'Late', type: 'number' }, { key: 'leave', label: 'On Leave', type: 'number' },
      { key: 'overtime_hours', label: 'OT Hours', type: 'number' }, { key: 'rate', label: 'Attendance %', type: 'percent' },
    ];
    trend = {
      type: 'bar', labels: periodRows.map((r) => r.day.slice(0, 3)),
      datasets: [
        { label: 'Present', data: periodRows.map((r) => r.present) }, { label: 'Late', data: periodRows.map((r) => r.late) },
        { label: 'Absent', data: periodRows.map((r) => r.absent) }, { label: 'OT hours', data: periodRows.map((r) => r.overtime_hours) },
      ],
      colors: ['#1e3a5f', '#f59e0b', '#ef4444', '#0ea5e9'],
    };
  } else if (view === 'yearly') {
    const byMonth = groupBy(records, (r) => Number(r.date.slice(5, 7)));
    periodRows = MONTHS.map((name, i) => {
      const s = stats(byMonth.get(i + 1) || []);
      return { month: name, ...s, rate: s.rate ?? '' };
    });
    periodColumns = [
      { key: 'month', label: 'Month' }, { key: 'present', label: 'Present', type: 'number' }, { key: 'absent', label: 'Absent', type: 'number' },
      { key: 'late', label: 'Late', type: 'number' }, { key: 'leave', label: 'On Leave', type: 'number' },
      { key: 'overtime_hours', label: 'OT Hours', type: 'number' }, { key: 'hours_worked', label: 'Hours Worked', type: 'number' },
      { key: 'rate', label: 'Attendance %', type: 'percent' },
    ];
    trend = {
      type: 'line', labels: MONTHS,
      datasets: [{ label: 'Present', data: periodRows.map((r) => r.present) }, { label: 'Absent', data: periodRows.map((r) => r.absent) }, { label: 'Late', data: periodRows.map((r) => r.late) }],
      colors: ['#1e3a5f', '#ef4444', '#f59e0b'],
    };
  } else {
    const byDate = groupBy(records, (r) => r.date);
    periodRows = dateRange(range.from, range.to).filter((d) => d <= today()).map((d) => {
      const s = stats(byDate.get(d) || []);
      return { date: d, day: formatDate(d, 'weekday'), ...s, rate: s.rate ?? '' };
    });
    periodColumns = [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'day', label: 'Day' }, { key: 'present', label: 'Present', type: 'number' },
      { key: 'absent', label: 'Absent', type: 'number' }, { key: 'late', label: 'Late', type: 'number' },
      { key: 'overtime_hours', label: 'OT Hours', type: 'number' }, { key: 'rate', label: 'Attendance %', type: 'percent' },
    ];
    trend = {
      type: 'line', labels: periodRows.map((r) => formatDate(r.date, 'short')),
      datasets: [{ label: 'Present', data: periodRows.map((r) => r.present) }, { label: 'Absent', data: periodRows.map((r) => r.absent) }, { label: 'Late', data: periodRows.map((r) => r.late) }],
      colors: ['#1e3a5f', '#ef4444', '#f59e0b'],
    };
  }

  const statusPie = {
    type: 'doughnut', labels: ['Present', 'Late', 'Half-day', 'Absent', 'On Leave'],
    datasets: [{ label: 'Days', data: [total.present - total.late - total.half_day * 0.5, total.late, total.half_day, total.absent - total.half_day * 0.5, total.leave].map((v) => Math.max(0, r1(v))) }],
    colors: ['#1e3a5f', '#f59e0b', '#d9620f', '#ef4444', '#0ea5e9'],
  };
  const topOvertime = employeeRows.filter((r) => r.overtime_hours > 0).sort((a, b) => b.overtime_hours - a.overtime_hours).slice(0, 10);
  const otChart = { type: 'bar', labels: topOvertime.map((r) => r.name), datasets: [{ label: 'Overtime hours', data: topOvertime.map((r) => r.overtime_hours) }], colors: ['#0ea5e9'] };

  return {
    view, range, cards, total,
    charts: { trend, statusPie, departments: deptChart, overtime: otChart },
    tables: {
      period: { title: view === 'weekly' ? 'By Day of the Week' : view === 'yearly' ? 'By Month' : 'By Date', columns: periodColumns, rows: periodRows },
      employees: { title: 'Employee Attendance Performance', columns: employeeColumns, rows: employeeRows },
      departments: { title: 'Department Attendance Comparison', columns: deptColumns, rows: deptRows },
    },
    empMap,
  };
}

/** Turn one analytics table into the report structure used by the PDF / Excel exporters. */
export function analyticsReport(result, table) {
  const t = result.tables[table] || result.tables.employees;
  const viewLabel = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly', custom: 'Custom Range' }[result.view] || '';
  return {
    type: `attendance_${result.view}_${table}`,
    title: `${viewLabel} Attendance – ${t.title}`,
    subtitle: result.range.label,
    generated_at: new Date(),
    columns: t.columns,
    rows: t.rows,
    summary: [
      { label: 'Employees', value: result.cards[0].value },
      { label: 'Present days', value: result.total.present },
      { label: 'Absent days', value: result.total.absent },
      { label: 'Late arrivals', value: result.total.late },
      { label: 'Overtime hours', value: result.total.overtime_hours },
      { label: 'Attendance rate', value: result.total.rate ?? 0, type: 'percent' },
    ],
  };
}

/** Week / month / year summaries for one employee (employee self-service). */
export async function employeeSummaries(employeeId) {
  const now = new Date();
  const weekFrom = toDateStr(startOfWeek(now));
  const monthFrom = toDateStr(now).slice(0, 8) + '01';
  const yearFrom = `${now.getFullYear()}-01-01`;
  const t = today();
  const records = await Attendance.findAll({ where: { employee_id: employeeId, date: { [Op.between]: [yearFrom, t] } } });
  return [
    { label: 'This Week', ...stats(records.filter((r) => r.date >= weekFrom)) },
    { label: 'This Month', ...stats(records.filter((r) => r.date >= monthFrom)) },
    { label: `Year ${now.getFullYear()}`, ...stats(records) },
  ];
}
