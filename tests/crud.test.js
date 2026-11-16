/*
 * Create / edit / delete flows for every StaffPay form.   Run: npm test
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { models, resetDatabase, login, loginAs, at } from './helpers.js';

const {
  Attendance, AttendanceCorrection, Department, Employee, Holiday, Payroll, PayrollDetail, Position, Shift,
  SystemSetting, User, WorkSchedule, Allowance, SalaryDeduction, Notification,
} = models;
let fx;

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: at(2026, 11, 4, 9, 0) });
  fx = await resetDatabase();
});
afterEach(() => mock.timers.reset());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

test('departments and positions', async () => {
  const admin = await login.admin();
  await admin.form('/organization/departments', { name: 'Spa & Wellness', code: 'spa' });
  const d = await Department.findOne({ where: { code: 'SPA' } });
  assert.ok(d, 'code is upper-cased');
  await admin.form('/organization/departments', { name: 'Spa & Wellness', code: 'SPA2' });
  assert.equal(await Department.count({ where: { name: 'Spa & Wellness' } }), 1, 'duplicate name refused');
  await admin.form(`/organization/departments/${d.id}/update`, { name: 'Spa and Wellness', code: 'SPA' });
  assert.equal((await d.reload()).name, 'Spa and Wellness');

  await admin.form('/organization/positions', { department_id: d.id, title: 'Massage Therapist', default_salary: 17000 });
  const p = await Position.findOne({ where: { title: 'Massage Therapist' } });
  await admin.form(`/organization/positions/${p.id}/update`, { department_id: d.id, title: 'Senior Therapist', default_salary: 21000 });
  assert.equal((await p.reload()).default_salary, 21000);

  await Employee.update({ department_id: d.id }, { where: { id: fx.maria.id } });
  await admin.form(`/organization/departments/${d.id}/delete`);
  assert.ok(await Department.findByPk(d.id), 'department with employees is kept');
  await Employee.update({ department_id: null }, { where: { id: fx.maria.id } });
  await admin.form(`/organization/positions/${p.id}/delete`);
  await admin.form(`/organization/departments/${d.id}/delete`);
  assert.equal(await Department.findByPk(d.id), null);
  assert.equal((await admin.get('/organization')).status, 200);
});

test('employees: update, photo, account reset, delete', async () => {
  const admin = await login.admin();
  const res = await admin.post(`/employees/${fx.jose.id}/update`)
    .field('_csrf', admin.csrf).field('employee_code', 'EMP-0002').field('first_name', 'Jose').field('last_name', 'Cruz')
    .field('email', 'jose@test.com').field('employment_status', 'active').field('employment_type', 'part_time')
    .field('date_hired', '2025-01-01').field('basic_salary', '19500').field('new_password', 'NewPass@123')
    .attach('photo', PNG, { filename: 'jose.png', contentType: 'image/png' });
  assert.equal(res.status, 302);
  const jose = await fx.jose.reload();
  assert.equal(jose.basic_salary, 19500);
  assert.equal(jose.employment_type, 'part_time');
  assert.match(jose.photo_path, /^photos\/.+\.png$/);
  assert.equal((await (await loginAs('jose@test.com', 'NewPass@123')).get('/')).status, 200);

  await admin.form(`/employees/${fx.jose.id}/delete`);
  assert.equal(await Employee.findByPk(fx.jose.id), null);
  assert.equal(await User.findByPk(fx.joseUser.id), null, 'employee login removed with the record');
  assert.equal((await admin.get(`/employees/${fx.maria.id}`)).status, 200);
});

test('shifts, schedules and holidays', async () => {
  const hr = await login.hr();
  await hr.form('/schedules/shifts', { name: 'Night Shift', start_time: '22:00', end_time: '06:00', break_minutes: 0, color: '#4f46e5' });
  const night = await Shift.findOne({ where: { name: 'Night Shift' } });
  assert.equal(night.is_overnight, true);
  assert.equal(night.duration_minutes, 480);
  await hr.form(`/schedules/shifts/${night.id}/update`, { name: 'Graveyard Shift', start_time: '22:00', end_time: '06:00' });
  assert.equal((await night.reload()).name, 'Graveyard Shift');

  await hr.form('/schedules', { shift_id: night.id, 'working_days[]': ['1', '2', '3'], effective_from: '2026-11-09', 'employee_ids[]': [String(fx.maria.id), String(fx.jose.id)] });
  const old = await WorkSchedule.findOne({ where: { employee_id: fx.maria.id, shift_id: fx.shift.id } });
  assert.equal(old.effective_to, '2026-11-08', 'previous schedule closed');
  const s = await WorkSchedule.findOne({ where: { employee_id: fx.maria.id, shift_id: night.id } });
  assert.deepEqual(s.working_days, [1, 2, 3]);
  assert.ok(await Notification.findOne({ where: { user_id: fx.mariaUser.id, title: 'Work schedule updated' } }));

  await hr.form(`/schedules/${s.id}/update`, { shift_id: night.id, 'working_days[]': ['1', '2', '3', '4'], effective_from: '2026-11-09' });
  assert.deepEqual((await s.reload()).working_days, [1, 2, 3, 4]);
  await hr.form(`/schedules/shifts/${night.id}/delete`);
  assert.ok(await Shift.findByPk(night.id), 'shift in use is kept');
  await hr.form(`/schedules/${s.id}/delete`);
  assert.equal(await WorkSchedule.findByPk(s.id), null);
  for (const p of ['/schedules', '/schedules?view=month', '/schedules/assignments', '/schedules/shifts', '/schedules/holidays']) assert.equal((await hr.get(p)).status, 200, p);

  // Holidays: admin only
  await hr.form('/schedules/holidays', { name: 'Test Day', date: '2026-11-20', type: 'special' });
  assert.equal(await Holiday.count(), 0);
  const admin = await login.admin();
  await Attendance.create({ employee_id: fx.maria.id, date: '2026-11-20', status: 'present' });
  await admin.form('/schedules/holidays', { name: 'Test Day', date: '2026-11-20', type: 'special' });
  const h = await Holiday.findOne();
  assert.equal(h.rate, 1.3);
  assert.equal((await Attendance.findOne({ where: { date: '2026-11-20' } })).is_holiday, true);
  await admin.form(`/schedules/holidays/${h.id}/update`, { name: 'Test Day', date: '2026-11-20', type: 'regular', rate: 2 });
  assert.equal((await h.reload()).type, 'regular');
  await admin.form(`/schedules/holidays/${h.id}/delete`);
  assert.equal(await Holiday.count(), 0);
});

test('manual attendance and correction requests', async () => {
  const hr = await login.hr();
  await hr.form('/attendance', { employee_id: fx.jose.id, date: '2026-11-03', time_in: '2026-11-03T06:20', time_out: '2026-11-03T14:00' });
  const a = await Attendance.findOne({ where: { employee_id: fx.jose.id, date: '2026-11-03' } });
  assert.equal(a.status, 'late');
  assert.equal(a.late_minutes, 20);
  await hr.form('/attendance', { employee_id: fx.jose.id, date: '2026-11-03', time_in: '2026-11-03T06:00' });
  assert.equal(await Attendance.count({ where: { employee_id: fx.jose.id } }), 1, 'duplicate date refused');
  await hr.form(`/attendance/${a.id}/update`, { time_in: '2026-11-03T05:58', time_out: '2026-11-03T14:00' });
  assert.equal((await a.reload()).status, 'present');
  await hr.form(`/attendance/${a.id}/delete`);
  assert.equal(await Attendance.findByPk(a.id), null);

  const maria = await login.maria();
  await maria.form('/my/corrections', { date: '2026-11-03', requested_time_in: '2026-11-03T06:00', requested_time_out: '2026-11-03T14:00', reason: 'Forgot to time in at the front desk' });
  const c = await AttendanceCorrection.findOne();
  assert.equal(c.status, 'pending');
  assert.ok(await Notification.findOne({ where: { user_id: fx.hr.id, title: 'Attendance correction request' } }));
  await hr.form(`/attendance/corrections/${c.id}/review`, { status: 'approved', remarks: 'OK' });
  assert.equal((await c.reload()).status, 'approved');
  const fixed = await Attendance.findOne({ where: { employee_id: fx.maria.id, date: '2026-11-03' } });
  assert.equal(fixed.status, 'present');
  assert.equal(fixed.worked_minutes, 480);
  for (const p of ['/attendance', '/attendance/records', '/attendance/summary', '/attendance/overtime', '/attendance/corrections']) assert.equal((await hr.get(p)).status, 200, p);
});

test('leave cancel, reject and balance adjustment', async () => {
  const maria = await login.maria();
  await maria.form('/my/leaves', { leave_type: 'sick', start_date: '2026-11-05', end_date: '2026-11-05', reason: 'Fever and cough' });
  await maria.form('/my/leaves', { leave_type: 'vacation', start_date: '2026-11-16', end_date: '2026-11-17', reason: 'Short vacation' });
  const [sick, vac] = await models.LeaveRequest.findAll({ order: [['id', 'ASC']] });
  await maria.form(`/my/leaves/${sick.id}/cancel`);
  assert.equal((await sick.reload()).status, 'cancelled');
  const preview = await maria.get('/my/leaves/preview.json?start_date=2026-11-16&end_date=2026-11-22&leave_type=vacation').set('Accept', 'application/json');
  assert.equal(preview.body.days, 6);

  const hr = await login.hr();
  await hr.form(`/leaves/${vac.id}/review`, { status: 'rejected', remarks: 'Peak season' });
  assert.equal((await vac.reload()).status, 'rejected');
  const bal = await models.LeaveBalance.findOne({ where: { employee_id: fx.maria.id, leave_type: 'vacation' } });
  await hr.form(`/leaves/balances/${bal.id}/update`, { allocated: 15, used: 1 });
  assert.equal((await bal.reload()).allocated, 15);
  for (const p of ['/leaves', '/leaves/balances', `/leaves/history/${fx.maria.id}`]) assert.equal((await hr.get(p)).status, 200, p);
});

test('payroll edit, adjustments, reopen, delete and salary components', async () => {
  mock.timers.setTime(at(2026, 11, 16, 9, 0).getTime());
  const admin = await login.admin();
  await admin.form('/payroll/salary/allowances', { name: 'Meal Allowance', amount: 1000, is_active: '1', 'employee_ids[]': [String(fx.maria.id), String(fx.jose.id)] });
  assert.equal(await Allowance.count(), 2);
  const al = await Allowance.findOne({ where: { employee_id: fx.maria.id } });
  await admin.form(`/payroll/salary/allowances/${al.id}/update`, { name: 'Meal Allowance', amount: 1200, is_active: '1', is_taxable: '1' });
  assert.equal((await al.reload()).amount, 1200);
  await admin.form('/payroll/salary/deductions', { name: 'Uniform', type: 'uniform', amount: 300, is_active: '1', 'employee_ids[]': String(fx.maria.id) });
  const ded = await SalaryDeduction.findOne();
  assert.equal(ded.type, 'uniform');

  await admin.form('/payroll', { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' });
  const p = await Payroll.findOne();
  await admin.form(`/payroll/${p.id}/update`, { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-21', notes: 'First half' });
  assert.equal((await p.reload()).pay_date, '2026-11-21');
  await admin.form(`/payroll/${p.id}/calculate`);
  const d = await PayrollDetail.findOne({ where: { employee_id: fx.maria.id } });
  assert.equal(d.allowances, 1200);
  assert.equal(d.other_deductions, 300);
  const before = d.net_salary;
  await admin.form(`/payroll/details/${d.id}/update`, { adjustment_additions: 500, adjustment_deductions: 100, adjustment_notes: 'Bonus' });
  assert.ok(Math.abs((await d.reload()).net_salary - (before + 400)) < 0.01);
  assert.ok(await models.PayrollEarning.findOne({ where: { payroll_record_id: d.id, code: 'adjustment', amount: 500 } }), 'adjustment earning line');
  assert.ok(await models.PayrollDeduction.findOne({ where: { payroll_record_id: d.id, code: 'adjustment', amount: 100 } }), 'adjustment deduction line');

  await admin.form(`/payroll/${p.id}/approve`);
  await admin.form(`/payroll/${p.id}/reopen`, { reason: 'x' });
  assert.equal((await p.reload()).status, 'approved', 'reopen needs a reason');
  await admin.form(`/payroll/${p.id}/reopen`, { reason: 'Correct late deductions' });
  assert.equal((await p.reload()).status, 'calculated');
  await admin.form(`/payroll/${p.id}/calculate`);
  assert.equal((await d.reload()).adjustment_additions, 500, 'adjustments survive recalculation');
  for (const u of ['/payroll', `/payroll/${p.id}`, '/payroll/salary', '/payroll/salary?kind=deductions', `/payslips/${d.id}`]) assert.equal((await admin.get(u)).status, 200, u);

  await admin.form(`/payroll/salary/deductions/${ded.id}/delete`);
  assert.equal(await SalaryDeduction.count(), 0);
  await admin.form(`/payroll/${p.id}/delete`);
  assert.equal(await Payroll.count(), 0);
  assert.equal(await PayrollDetail.count(), 0);
});

test('users, settings, logo, profile and notifications', async () => {
  const admin = await login.admin();
  await admin.form('/users', { name: 'New HR', email: 'newhr@test.com', password: 'Welcome@123', role: 'hr', is_active: '1' });
  const u = await User.findOne({ where: { email: 'newhr@test.com' } });
  assert.equal(u.role, 'hr');
  await admin.form(`/users/${u.id}/update`, { name: 'New HR', email: 'newhr@test.com', role: 'hr', is_active: '' });
  assert.equal((await u.reload()).is_active, false);
  await admin.form(`/users/${fx.admin.id}/update`, { name: 'Admin', email: 'admin@test.com', role: 'employee', is_active: '1' });
  assert.equal((await fx.admin.reload()).role, 'admin', 'cannot demote yourself');
  await admin.form(`/users/${u.id}/delete`);
  assert.equal(await User.findByPk(u.id), null);

  await admin.form('/settings', { _tab: 'attendance', grace_period_minutes: '15', overtime_min_minutes: '30', overtime_requires_approval: '1', night_diff_start: '22:00', night_diff_end: '06:00' });
  assert.equal((await SystemSetting.findOne({ where: { key: 'grace_period_minutes' } })).value, '15');
  await admin.form('/settings', { _tab: 'attendance', grace_period_minutes: 'abc', overtime_min_minutes: '30', night_diff_start: '22:00', night_diff_end: '06:00' });
  assert.equal((await SystemSetting.findOne({ where: { key: 'grace_period_minutes' } })).value, '15', 'invalid number rejected');

  const logo = await admin.post('/settings/logo').field('_csrf', admin.csrf).attach('logo', PNG, { filename: 'logo.png', contentType: 'image/png' });
  assert.equal(logo.status, 302);
  assert.match((await SystemSetting.findOne({ where: { key: 'hotel_logo' } })).value, /^branding\//);
  assert.equal((await admin.get('/audit-logs')).status, 200);

  const maria = await login.maria();
  await maria.form('/profile', { contact_number: '0917 555 1234', address: 'Pasay City' });
  assert.equal((await fx.maria.reload()).contact_number, '0917 555 1234');
  await maria.form('/profile/password', { current_password: 'wrong', password: 'Changed@123', password_confirmation: 'Changed@123' });
  assert.equal((await (await loginAs('maria@test.com', 'Changed@123')).get('/')).status, 302, 'wrong current password refused');
  await maria.form('/profile/password', { current_password: 'Staff@123', password: 'Changed@123', password_confirmation: 'Changed@123' });
  assert.equal((await (await loginAs('maria@test.com', 'Changed@123')).get('/')).status, 200);

  await Notification.create({ user_id: fx.mariaUser.id, title: 'Hello', message: 'Test' });
  const list = await maria.get('/notifications.json').set('Accept', 'application/json');
  assert.equal(list.body.unread, 1);
  await maria.post('/notifications/read-all').set('X-CSRF-Token', maria.csrf).set('Accept', 'application/json');
  assert.equal((await maria.get('/notifications.json').set('Accept', 'application/json')).body.unread, 0);
});
