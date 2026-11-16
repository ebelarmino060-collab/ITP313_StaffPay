/*
 * StaffPay workflow tests: authentication, role-based access, attendance,
 * leave, payroll and exports.   Run: npm test
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { app, request, models, resetDatabase, login, loginAs, at } from './helpers.js';

const { Attendance, Employee, LeaveBalance, Payroll, PayrollDetail, User, AuditLog, Notification } = models;
let fx;

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: at(2026, 11, 4, 7, 0) }); // Wednesday 7:00 AM
  fx = await resetDatabase();
});
afterEach(() => mock.timers.reset());

const setNow = (d) => mock.timers.setTime(d.getTime());

describe('authentication', () => {
  test('valid login opens the dashboard; wrong password does not', async () => {
    const ok = await login.maria();
    assert.equal(ok.loginResponse.status, 302);
    assert.equal(ok.loginResponse.headers.location, '/');
    const dash = await ok.get('/');
    assert.equal(dash.status, 200);
    assert.match(dash.text, /Welcome, Maria Santos/);

    const bad = await loginAs('maria@test.com', 'wrong-password');
    assert.equal((await bad.get('/')).headers.location, '/login?next=%2F');
  });

  test('deactivated accounts cannot sign in', async () => {
    await User.update({ is_active: false }, { where: { email: 'maria@test.com' } });
    const agent = await login.maria();
    assert.equal((await agent.get('/')).status, 302);
  });

  test('forms without a CSRF token are rejected', async () => {
    const agent = request.agent(app);
    await agent.get('/login');
    await agent.post('/login').type('form').send({ email: 'admin@test.com', password: 'Admin@123' });
    assert.equal((await agent.get('/')).status, 302, 'still signed out');
  });

  test('unauthenticated users are redirected to login; passwords are hashed', async () => {
    const res = await request(app).get('/employees');
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login/);
    const u = await User.scope('withPassword').findOne({ where: { email: 'maria@test.com' } });
    assert.notEqual(u.password, 'Staff@123');
    assert.match(u.password, /^\$2[aby]\$/);
  });
});

describe('role-based access', () => {
  test('employee, HR and admin see only what they are allowed to', async () => {
    const emp = await login.maria();
    for (const p of ['/employees', '/attendance', '/payroll', '/reports', '/users']) assert.equal((await emp.get(p)).status, 403, `employee ${p}`);
    assert.equal((await emp.get('/my/attendance')).status, 200);

    const hr = await login.hr();
    for (const p of ['/employees', '/attendance', '/payroll', '/leaves', '/reports']) assert.equal((await hr.get(p)).status, 200, `hr ${p}`);
    for (const p of ['/users', '/settings', '/audit-logs', '/organization']) assert.equal((await hr.get(p)).status, 403, `hr ${p}`);
    await hr.form(`/employees/${fx.jose.id}/delete`);
    assert.ok(await Employee.findByPk(fx.jose.id), 'HR cannot delete employees');

    const admin = await login.admin();
    for (const p of ['/users', '/settings', '/audit-logs', '/organization']) assert.equal((await admin.get(p)).status, 200, `admin ${p}`);
  });
});

describe('employees', () => {
  test('admin adds an employee with a login account (multipart form)', async () => {
    const admin = await login.admin();
    const res = await admin.post('/employees')
      .field('_csrf', admin.csrf).field('first_name', 'Ana').field('last_name', 'Reyes').field('email', 'ana@test.com')
      .field('employment_status', 'active').field('employment_type', 'full_time').field('date_hired', '2026-11-01')
      .field('basic_salary', '20000').field('create_account', '1').field('password', 'Secret@123');
    assert.equal(res.status, 302);
    const ana = await Employee.findOne({ where: { email: 'ana@test.com' } });
    assert.equal(ana.employee_code, 'EMP003');
    const anaLogin = await loginAs('ana@test.com', 'Secret@123');
    assert.equal((await anaLogin.get('/')).status, 200);
    assert.ok(await AuditLog.findOne({ where: { action: 'employee_create' } }));
  });

  test('invalid employee form is rejected with a message', async () => {
    const admin = await login.admin();
    await admin.post('/employees').field('_csrf', admin.csrf).field('first_name', '').field('basic_salary', '-5');
    assert.equal(await Employee.count(), 2);
    const flash = await admin.flash();
    assert.ok(flash.some((m) => m.startsWith('error:')), flash.join());
  });
});

describe('attendance', () => {
  test('late time in, double time in refused, overtime on time out', async () => {
    const maria = await login.maria();
    setNow(at(2026, 11, 4, 6, 25));
    await maria.form('/my/attendance/time-in');
    let rec = await Attendance.findOne({ where: { employee_id: fx.maria.id } });
    assert.equal(rec.status, 'late');
    assert.equal(rec.late_minutes, 25);

    await maria.form('/my/attendance/time-in');
    assert.equal(await Attendance.count({ where: { employee_id: fx.maria.id } }), 1);

    setNow(at(2026, 11, 4, 15, 10));
    await maria.form('/my/attendance/time-out');
    rec = await rec.reload();
    assert.equal(rec.overtime_minutes, 70);
    assert.equal(rec.overtime_status, 'pending');
    assert.equal(rec.undertime_minutes, 0);
  });

  test('early time out records undertime', async () => {
    const maria = await login.maria();
    setNow(at(2026, 11, 4, 5, 55));
    await maria.form('/my/attendance/time-in');
    setNow(at(2026, 11, 4, 13, 20));
    await maria.form('/my/attendance/time-out');
    const rec = await Attendance.findOne({ where: { employee_id: fx.maria.id } });
    assert.equal(rec.status, 'present');
    assert.equal(rec.undertime_minutes, 40);
  });

  test('HR marks absences for missed shifts and approves overtime', async () => {
    setNow(at(2026, 11, 5, 8, 0));
    const hr = await login.hr();
    await hr.form('/attendance/mark-absences', { date: '2026-11-04' });
    assert.equal(await Attendance.count({ where: { date: '2026-11-04', status: 'absent' } }), 2);

    const a = await Attendance.create({ employee_id: fx.jose.id, date: '2026-11-03', time_in: at(2026, 11, 3, 6, 0), time_out: at(2026, 11, 3, 15, 0), overtime_minutes: 60, overtime_status: 'pending' });
    await hr.form(`/attendance/${a.id}/overtime`, { status: 'approved' });
    assert.equal((await a.reload()).overtime_status, 'approved');
    assert.ok(await Notification.findOne({ where: { user_id: fx.joseUser.id, title: 'Overtime approved' } }));
  });

  test('employees cannot review or edit attendance', async () => {
    const a = await Attendance.create({ employee_id: fx.maria.id, date: '2026-11-03', status: 'absent' });
    const maria = await login.maria();
    const res = await maria.form(`/attendance/${a.id}/update`, { time_in: '2026-11-03T06:00', time_out: '2026-11-03T14:00' });
    assert.equal(res.status, 403);
    assert.equal((await a.reload()).status, 'absent');
  });
});

describe('leave', () => {
  test('approval deducts the balance, marks attendance and notifies the employee', async () => {
    const maria = await login.maria();
    await maria.form('/my/leaves', { leave_type: 'vacation', start_date: '2026-11-09', end_date: '2026-11-11', reason: 'Family trip' });
    const leave = await models.LeaveRequest.findOne({ where: { employee_id: fx.maria.id } });
    assert.equal(leave.days, 3);

    assert.equal((await maria.form(`/leaves/${leave.id}/review`, { status: 'approved' })).status, 403);

    const hr = await login.hr();
    await hr.form(`/leaves/${leave.id}/review`, { status: 'approved', remarks: 'Enjoy' });
    assert.equal((await leave.reload()).status, 'approved');
    const bal = await LeaveBalance.findOne({ where: { employee_id: fx.maria.id, leave_type: 'vacation' } });
    assert.equal(bal.used, 3);
    assert.equal(await Attendance.count({ where: { employee_id: fx.maria.id, status: 'on_leave' } }), 3);
    assert.ok(await Notification.findOne({ where: { user_id: fx.mariaUser.id, title: 'Leave request approved' } }));
  });

  test('a request larger than the balance is refused', async () => {
    const maria = await login.maria();
    await maria.form('/my/leaves', { leave_type: 'emergency', start_date: '2026-11-09', end_date: '2026-11-14', reason: 'Too many days' });
    assert.equal(await models.LeaveRequest.count(), 0);
    assert.ok((await maria.flash()).some((m) => m.includes('Insufficient emergency leave balance')));
  });
});

describe('payroll', () => {
  test('calculate, approve, lock, payslip privacy and payment', async () => {
    setNow(at(2026, 11, 16, 9, 0));
    // Maria: one full day, one day 30 minutes late; the rest of Nov 1-15 absent.
    const { AttendanceService } = await import('../services/attendanceService.js');
    const svc = new AttendanceService();
    await svc.recompute(Attendance.build({ employee_id: fx.maria.id, date: '2026-11-02', time_in: at(2026, 11, 2, 5, 55), time_out: at(2026, 11, 2, 14, 0) }));
    await svc.recompute(Attendance.build({ employee_id: fx.maria.id, date: '2026-11-03', time_in: at(2026, 11, 3, 6, 30), time_out: at(2026, 11, 3, 14, 0) }));

    const hr = await login.hr();
    await hr.form('/payroll', { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' });
    const payroll = await Payroll.findOne();
    assert.equal(payroll.status, 'draft');

    await hr.form('/payroll', { period_start: '2026-11-10', period_end: '2026-11-25', pay_date: '2026-11-26' });
    assert.equal(await Payroll.count(), 1, 'overlapping period refused');

    await hr.form(`/payroll/${payroll.id}/calculate`);
    assert.equal((await payroll.reload()).status, 'calculated');

    const d = await PayrollDetail.findOne({ where: { payroll_id: payroll.id, employee_id: fx.maria.id } });
    const daily = 22000 / 26; // working_days_per_month = 26
    assert.equal(d.basic_salary, 11000);
    assert.equal(d.days_worked, 2);
    assert.equal(d.late_minutes, 30);
    assert.equal(d.days_absent, 10); // 12 Mon-Sat working days in Nov 1-15, 2026
    assert.ok(Math.abs(d.absence_deduction - 10 * daily) < 0.01);
    assert.ok(Math.abs(d.late_deduction - (0.5 * daily) / 8) < 0.01);
    // Gross = Basic + OT + Holiday + ND + Allowances ; Net = Gross - Deductions
    assert.ok(Math.abs(d.gross_salary - (d.basic_salary + d.overtime_pay + d.holiday_pay + d.night_differential + d.allowances + d.incentives + d.adjustment_additions)) < 0.01);
    assert.ok(Math.abs(d.net_salary - (d.gross_salary - d.total_deductions)) < 0.01);

    const maria = await login.maria();
    assert.equal((await maria.get(`/payslips/${d.id}`)).status, 403, 'not released before approval');

    await hr.form(`/payroll/${payroll.id}/approve`);
    assert.equal((await payroll.reload()).status, 'approved');
    await hr.form(`/payroll/${payroll.id}/calculate`);
    assert.ok((await payroll.reload()).status === 'approved', 'approved payroll is locked');

    const slip = await maria.get(`/payslips/${d.id}`);
    assert.equal(slip.status, 200);
    assert.match(slip.text, /PAYSLIP/);
    const pdf = await maria.get(`/payslips/${d.id}/pdf`).buffer(true);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.match((await maria.get('/my/payslips')).text, /Nov 1 – Nov 15, 2026/);

    const other = await PayrollDetail.findOne({ where: { payroll_id: payroll.id, employee_id: fx.jose.id } });
    assert.equal((await maria.get(`/payslips/${other.id}`)).status, 403, 'cannot open a colleague payslip');

    await hr.form(`/payroll/${payroll.id}/mark-paid`);
    assert.equal((await payroll.reload()).status, 'paid');
    assert.ok(await AuditLog.findOne({ where: { action: 'payroll_approve' } }));
    assert.ok(await Notification.findOne({ where: { user_id: fx.mariaUser.id, title: 'Payslip available' } }));
  });
});

describe('reports', () => {
  test('reports render and export to PDF and Excel; employees are blocked', async () => {
    await Attendance.create({ employee_id: fx.maria.id, date: '2026-11-02', status: 'absent' });
    const hr = await login.hr();
    const page = await hr.get('/reports?type=absences&preset=custom&from=2026-11-01&to=2026-11-04');
    assert.equal(page.status, 200);
    assert.match(page.text, /Maria Santos/);

    const pdf = await hr.get('/reports/export?type=attendance&preset=custom&from=2026-11-01&to=2026-11-04&format=pdf').buffer(true);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    const xlsx = await hr.get('/reports/export?type=payroll_annual&year=2026&format=xlsx').buffer(true);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);

    const maria = await login.maria();
    assert.equal((await maria.get('/reports')).status, 403);
  });
});
