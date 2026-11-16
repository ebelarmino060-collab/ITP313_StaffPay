/*
 * Spec features: TXT attendance import, payroll lock, payslip ZIP, analytics and account control.
 * Run: npm test
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { models, resetDatabase, login, at } from './helpers.js';

const { seedImportFormats } = await import('../services/importService.js');
const { Attendance, AttendanceImport, AttendanceImportError, OvertimeRequest, Payroll, PayrollDetail, PayrollEarning, PayrollDeduction, Payslip, AuditLog } = models;
let fx;

beforeEach(async () => {
  mock.timers.enable({ apis: ['Date'], now: at(2026, 11, 16, 9, 0) }); // Monday 9:00 AM
  fx = await resetDatabase();
  await seedImportFormats();
});
afterEach(() => mock.timers.reset());

/** Fixtures: Maria = EMP-0001, Jose = EMP-0002, both 06:00-14:00 Mon-Sat. */
const FILE = [
  'EMPLOYEE_ID,DATE,TIME,STATUS',
  'EMP001,2026-11-09,05:55:00,IN',
  'EMP001,2026-11-09,16:00:00,OUT', // 2 h overtime
  'EMP-0002,2026-11-09,06:20:00,IN', // 20 min late
  'EMP-0002,2026-11-09,14:00:00,OUT',
  'EMP001,2026-11-10,06:00:00,IN',
  'EMP001,2026-11-10,06:00:00,IN', // duplicate line
  'EMP001,2026-11-10,14:05:00,OUT',
  'EMP-0002,2026-11-10,06:01:00,IN', // no OUT
  'EMP999,2026-11-10,06:00:00,IN', // unknown employee
  'EMP001,2026-13-40,06:00:00,IN', // invalid date
  'EMP001,2026-11-10,25:99,OUT', // invalid time
].join('\n');

const upload = (agent, content, name = 'clock.txt', extra = {}) => {
  let req = agent.post('/attendance/import').field('_csrf', agent.csrf);
  for (const [k, v] of Object.entries(extra)) req = req.field(k, v);
  return req.attach('file', Buffer.from(content), name);
};

describe('TXT attendance import', () => {
  test('preview flags every problem, commit saves ready rows in one transaction', async () => {
    const hr = await login.hr();
    const res = await upload(hr, FILE, 'clock.txt', { mark_absences: '1' });
    assert.equal(res.status, 302);
    const imp = await AttendanceImport.findOne();
    assert.match(res.headers.location, new RegExp(`/attendance/import/${imp.id}$`));
    assert.equal(imp.status, 'preview');
    assert.equal(await Attendance.count(), 0, 'nothing saved before commit');

    const types = imp.preview.errors.map((e) => e.type);
    for (const t of ['unknown_employee', 'duplicate_line', 'invalid_date', 'invalid_time', 'missing_time_out']) assert.ok(types.includes(t), `${t} reported (${types})`);
    assert.equal(imp.unrecognized_ids, 1);
    assert.equal(imp.identified_employees, 2);
    assert.equal(imp.records_ready, 3);

    const page = await hr.get(`/attendance/import/${imp.id}`);
    assert.equal(page.status, 200);
    for (const s of ['Maria Santos', 'Jose Cruz', 'EMP999', 'Total Hours', 'OT Hours']) assert.ok(page.text.includes(s), s);
    for (const tab of ['ready', 'error', 'lines', 'missing', 'duplicate']) assert.equal((await hr.get(`/attendance/import/${imp.id}?tab=${tab}`)).status, 200, tab);

    await hr.form(`/attendance/import/${imp.id}/commit`);
    await imp.reload();
    assert.equal(imp.status, 'completed');
    const saved = await Attendance.findAll({ where: { source: 'import' } });
    assert.equal(saved.length, 3);
    assert.ok(saved.every((a) => a.import_id === imp.id));
    const mariaDay = saved.find((a) => a.employee_id === fx.maria.id && a.date === '2026-11-09');
    assert.equal(mariaDay.overtime_minutes, 120);
    assert.equal(mariaDay.overtime_status, 'pending');
    assert.ok(await OvertimeRequest.findOne({ where: { attendance_id: mariaDay.id, status: 'pending', minutes: 120 } }));
    const joseDay = saved.find((a) => a.employee_id === fx.jose.id && a.date === '2026-11-09');
    assert.equal(joseDay.late_minutes, 20);
    assert.equal(joseDay.status, 'late');
    assert.ok((await AttendanceImportError.count({ where: { import_id: imp.id } })) >= 5, 'errors kept, never discarded');
    assert.ok(await AuditLog.findOne({ where: { action: 'attendance_import_commit' } }));

    // The exact same file cannot be imported twice.
    await upload(hr, FILE);
    assert.equal(await AttendanceImport.count(), 1);
    assert.ok((await hr.flash()).some((m) => m.includes('already imported')));

    // A new file for a day that already has a record shows it as a duplicate.
    await upload(hr, 'EMP001,2026-11-09,06:00,IN\nEMP001,2026-11-09,14:00,OUT');
    const again = await AttendanceImport.findOne({ order: [['id', 'DESC']] });
    assert.equal(again.records_ready, 0);
    assert.equal(again.duplicate_count, 1);
  });

  test('finalized payroll periods are locked against imports and edits', async () => {
    const hr = await login.hr();
    await hr.form('/payroll', { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' });
    const p = await Payroll.findOne();
    await hr.form(`/payroll/${p.id}/calculate`);
    await hr.form(`/payroll/${p.id}/approve`);
    assert.equal((await p.reload()).status, 'approved');

    await upload(hr, 'EMP001,2026-11-11,06:00,IN\nEMP001,2026-11-11,14:00,OUT');
    const imp = await AttendanceImport.findOne();
    assert.equal(imp.records_ready, 0);
    assert.ok(imp.preview.errors.some((e) => e.type === 'locked'));

    await hr.form('/attendance', { employee_id: fx.maria.id, date: '2026-11-12', status: 'present', time_in: '06:00', time_out: '14:00' });
    assert.equal(await Attendance.count({ where: { date: '2026-11-12', employee_id: fx.maria.id, source: 'manual' } }), 0, 'manual entry refused');
    assert.ok((await hr.flash()).some((m) => /finali[sz]ed|locked/i.test(m)));
  });

  test('employees cannot reach the importer; non-text uploads are rejected', async () => {
    const maria = await login.maria();
    assert.equal((await maria.get('/attendance/import')).status, 403);
    const hr = await login.hr();
    assert.equal((await hr.get('/attendance/import')).status, 200);
    await hr.post('/attendance/import').field('_csrf', hr.csrf).attach('file', Buffer.from('MZ\u0000\u0000binary'), 'evil.exe');
    assert.equal(await AttendanceImport.count(), 0);
    const sample = await hr.get('/attendance/import/sample.txt?days=2&problems=1');
    assert.equal(sample.status, 200);
    assert.match(sample.text, /EMPLOYEE_ID,DATE,TIME,STATUS/);
  });
});

describe('payroll connected to attendance', () => {
  test('imported attendance drives deductions, OT and payslip ZIP', async () => {
    const hr = await login.hr();
    // Maria works Nov 2 with 2 h approved OT; the rest of her scheduled days are absences.
    const lines = ['EMPLOYEE_ID,DATE,TIME,STATUS', 'EMP001,2026-11-02,06:00,IN', 'EMP001,2026-11-02,16:00,OUT', 'EMP002,2026-11-02,06:00,IN', 'EMP002,2026-11-02,14:00,OUT'];
    await upload(hr, lines.join('\n'), 'nov2.txt', { approve_overtime: '1' });
    const imp = await AttendanceImport.findOne();
    await hr.form(`/attendance/import/${imp.id}/commit`);
    assert.equal((await Attendance.findOne({ where: { employee_id: fx.maria.id, date: '2026-11-02' } })).overtime_status, 'approved');

    await hr.form('/payroll', { period_start: '2026-11-01', period_end: '2026-11-15', pay_date: '2026-11-20' });
    const p = await Payroll.findOne();
    await hr.form(`/payroll/${p.id}/calculate`);
    const d = await PayrollDetail.findOne({ where: { payroll_id: p.id, employee_id: fx.maria.id } });
    const daily = 22000 / 26;
    const hourly = daily / 8;
    assert.equal(d.days_worked, 1);
    assert.equal(d.days_absent, 11);
    assert.ok(Math.abs(d.absence_deduction - 11 * daily) < 0.01);
    assert.ok(Math.abs(d.overtime_pay - 2 * hourly * 1.25) < 0.01, `OT pay ${d.overtime_pay}`);
    const earn = await PayrollEarning.findAll({ where: { payroll_record_id: d.id } });
    const ded = await PayrollDeduction.findAll({ where: { payroll_record_id: d.id } });
    const sum = (rows) => rows.reduce((n, r) => n + Number(r.amount), 0);
    assert.ok(Math.abs(sum(earn) - d.gross_salary) < 0.02, 'earning lines add up to gross');
    assert.ok(Math.abs(sum(ded) - d.total_deductions) < 0.02, 'deduction lines add up to total deductions');

    await hr.form(`/payroll/${p.id}/approve`);
    assert.equal(await Payslip.count({ where: { payroll_id: p.id } }), 2);
    const slip = await Payslip.findOne({ where: { employee_id: fx.maria.id } });
    assert.equal(slip.payment_status, 'unpaid');

    const zip = await hr.get(`/payslips/zip/${p.id}`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(zip.status, 200);
    assert.match(zip.headers['content-type'], /application\/zip/);
    const files = Object.keys((await JSZip.loadAsync(zip.body)).files).filter((f) => f.endsWith('.pdf'));
    assert.equal(files.length, 2);

    assert.equal((await hr.get('/payslips')).status, 200);
    const maria = await login.maria();
    assert.equal((await maria.get(`/payslips/zip/${p.id}`)).status, 403);
    assert.equal((await maria.get('/payslips')).status, 403);
    assert.equal((await maria.get(`/payslips/${d.id}/pdf`)).status, 200);
    assert.equal((await slip.reload()).download_count, 2, 'ZIP + own PDF download counted');

    await hr.form(`/payroll/${p.id}/mark-paid`);
    assert.equal((await slip.reload()).payment_status, 'paid');
  });
});

describe('downloadable attendance file', () => {
  test('the generated TXT uses real IDs and schedules and imports without errors', async () => {
    const hr = await login.hr();
    const tpl = await hr.get('/attendance/import/template.txt');
    assert.equal(tpl.status, 200);
    assert.match(tpl.headers['content-disposition'], /attendance-template\.txt/);
    assert.match(tpl.text, /EMPLOYEE_ID,DATE,TIME,STATUS/);

    const dl = await hr.get('/attendance/import/sample.txt?from=2026-11-09&to=2026-11-11');
    assert.equal(dl.status, 200);
    assert.match(dl.headers['content-disposition'], /attendance-2026-11-09_to_2026-11-11\.txt/);
    assert.match(dl.text, /^EMP-0001,2026-11-09,\d\d:\d\d:\d\d,IN$/m);
    assert.equal((await hr.get('/attendance/import/sample.txt?from=2026-12-01&to=2026-12-02')).status, 422, 'no future dates');

    await upload(hr, dl.text, 'downloaded.txt');
    const imp = await AttendanceImport.findOne();
    assert.equal(imp.preview.errors.length, 0);
    assert.ok(imp.records_ready >= 5);
    await hr.form(`/attendance/import/${imp.id}/commit`);
    assert.equal(await Attendance.count({ where: { source: 'import' } }), (await imp.reload()).records_imported);

    const after = await hr.get('/attendance/import/sample.txt?from=2026-11-09&to=2026-11-11');
    assert.ok(!/,(IN|OUT)$/m.test(after.text), 'days already recorded are left out');
    assert.equal((await (await login.maria()).get('/attendance/import/template.txt')).status, 403);
  });
});

describe('analytics and accounts', () => {
  test('weekly, monthly, yearly and custom analytics render and export', async () => {
    await Attendance.create({ employee_id: fx.maria.id, date: '2026-11-09', status: 'present', worked_minutes: 480 });
    await Attendance.create({ employee_id: fx.jose.id, date: '2026-11-09', status: 'absent' });
    const hr = await login.hr();
    for (const q of ['view=weekly&date=2026-11-09', 'view=monthly&month=2026-11', 'view=yearly&year=2026', 'view=custom&from=2026-11-01&to=2026-11-15', `view=monthly&employee_id=${fx.maria.id}`]) {
      const page = await hr.get(`/attendance/analytics?${q}`);
      assert.equal(page.status, 200, q);
    }
    const monthly = await hr.get('/attendance/analytics?view=monthly&month=2026-11');
    assert.match(monthly.text, /Maria Santos/);
    const pdf = await hr.get('/attendance/analytics/export?view=monthly&month=2026-11&table=employees&format=pdf').buffer(true);
    assert.match(pdf.headers['content-type'], /application\/pdf/);
    const xlsx = await hr.get('/attendance/analytics/export?view=yearly&year=2026&table=departments&format=xlsx').buffer(true);
    assert.match(xlsx.headers['content-type'], /spreadsheetml/);
    const maria = await login.maria();
    assert.equal((await maria.get('/attendance/analytics')).status, 403);
  });

  test('admin can deactivate and reactivate an employee login', async () => {
    const admin = await login.admin();
    await admin.form(`/employees/${fx.maria.id}/account`);
    assert.equal((await fx.mariaUser.reload()).is_active, false);
    const blocked = await login.maria();
    assert.notEqual((await blocked.get('/')).status, 200, 'deactivated user cannot sign in');
    await admin.form(`/employees/${fx.maria.id}/account`);
    assert.equal((await fx.mariaUser.reload()).is_active, true);
    const hr = await login.hr();
    await hr.form(`/employees/${fx.jose.id}/account`);
    assert.equal((await fx.joseUser.reload()).is_active, true, 'HR cannot toggle accounts');
  });
});
