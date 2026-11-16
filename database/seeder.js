/*
 * StaffPay sample data.
 *
 * Demo accounts:
 *   admin@staffpay.com     / Admin@123   (Administrator)
 *   hr@staffpay.com        / Hr@12345    (HR / Payroll)
 *   employee@staffpay.com  / Staff@123   (Employee)
 *   every other employee   / Staff@123   (firstname.lastname@staffpay.com)
 */
import bcrypt from 'bcryptjs';
import {
  Allowance, Attendance, AttendanceCorrection, Department, Employee, Holiday, LeaveBalance, LeaveRequest,
  Payroll, Position, SalaryDeduction, Shift, User, WorkSchedule,
} from '../models/index.js';
import { seedSettings } from '../services/settings.js';
import { ensureBalances, balanceFor } from '../services/leaveService.js';
import { ScheduleService } from '../services/scheduleService.js';
import { AttendanceService } from '../services/attendanceService.js';
import { PayrollService } from '../services/payrollService.js';
import { ATTENDANCE_TEMPLATE, buildSampleFile, commitImport, createPreview, seedImportFormats } from '../services/importService.js';
import { addDays, addMinutes, dateRange, endOfMonth, toDateStr, today } from '../utils/time.js';
import fs from 'fs';
import path from 'path';

// Deterministic pseudo-random numbers so the demo data is the same every time.
let seed = 20261106;
const rand = (min, max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return min + (seed % (max - min + 1)); };

export async function runSeeder({ log = console.log } = {}) {
  await seedSettings();
  await seedImportFormats();

  const structure = [
    ['Front Office', 'FO', 'Reception, reservations, concierge and guest services', [['Front Office Manager', 42000], ['Front Desk Agent', 18500], ['Concierge', 19000], ['Night Auditor', 21000]]],
    ['Housekeeping', 'HK', 'Room attendants, laundry and public area cleaning', [['Executive Housekeeper', 38000], ['Room Attendant', 16000], ['Laundry Attendant', 15500]]],
    ['Food & Beverage', 'FB', 'Restaurant, bar, banquets and room service', [['F&B Supervisor', 28000], ['Waiter / Waitress', 16500], ['Bartender', 18000]]],
    ['Kitchen', 'KIT', 'Culinary operations', [['Executive Chef', 55000], ['Line Cook', 19500], ['Kitchen Steward', 15500]]],
    ['Engineering', 'ENG', 'Maintenance and facilities', [['Chief Engineer', 45000], ['Maintenance Technician', 20000]]],
    ['Security', 'SEC', 'Guest and property safety', [['Security Supervisor', 26000], ['Security Officer', 17000]]],
    ['Human Resources', 'HR', 'People, payroll and administration', [['HR & Payroll Officer', 32000], ['HR Assistant', 20000]]],
  ];
  const positions = {};
  for (const [name, code, description, titles] of structure) {
    const dept = await Department.create({ name, code, description });
    for (const [title, salary] of titles) positions[title] = await Position.create({ department_id: dept.id, title, default_salary: salary });
  }

  const morning = await Shift.create({ name: 'Morning Shift', start_time: '06:00:00', end_time: '14:00:00', color: '#2563eb', description: '6:00 AM to 2:00 PM' });
  const afternoon = await Shift.create({ name: 'Afternoon Shift', start_time: '14:00:00', end_time: '22:00:00', color: '#d97706', description: '2:00 PM to 10:00 PM' });
  const night = await Shift.create({ name: 'Night Shift', start_time: '22:00:00', end_time: '06:00:00', color: '#4f46e5', description: '10:00 PM to 6:00 AM' });
  const office = await Shift.create({ name: 'Office Hours', start_time: '08:00:00', end_time: '17:00:00', break_minutes: 60, color: '#0f766e', description: '8:00 AM to 5:00 PM with 1-hour lunch' });

  const hash = (p) => bcrypt.hashSync(p, 10);
  const admin = await User.create({ name: 'System Administrator', email: 'admin@staffpay.com', password: hash('Admin@123'), role: 'admin' });
  const staffHash = hash('Staff@123');

  const now = new Date();
  const seedStart = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const hiredBefore = toDateStr(new Date(seedStart.getFullYear(), seedStart.getMonth() - 2, 1));

  // [first, middle, last, gender, position, shift, working days, email, role, hired]
  const people = [
    ['Andrea', 'Lopez', 'Reyes', 'female', 'HR & Payroll Officer', office, [1, 2, 3, 4, 5], 'hr@staffpay.com', 'hr', '2021-03-15'],
    ['Maria', 'Cruz', 'Santos', 'female', 'Front Desk Agent', morning, [1, 2, 3, 4, 5, 6], 'employee@staffpay.com', 'employee', '2022-06-01'],
    ['Jose', 'Ramos', 'Dela Cruz', 'male', 'Front Office Manager', office, [1, 2, 3, 4, 5], null, 'employee', '2019-01-10'],
    ['Kristine', 'Mae', 'Villanueva', 'female', 'Concierge', afternoon, [2, 3, 4, 5, 6, 7], null, 'employee', '2023-02-20'],
    ['Paolo', 'Garcia', 'Mendoza', 'male', 'Night Auditor', night, [1, 2, 3, 4, 5, 6], null, 'employee', '2022-09-05'],
    ['Liza', 'Torres', 'Bautista', 'female', 'Executive Housekeeper', morning, [1, 2, 3, 4, 5, 6], null, 'employee', '2018-11-12'],
    ['Ramon', 'Diaz', 'Aquino', 'male', 'Room Attendant', morning, [1, 2, 3, 4, 6, 7], null, 'employee', '2024-01-08'],
    ['Grace', 'Flores', 'Navarro', 'female', 'Room Attendant', afternoon, [1, 2, 3, 4, 5, 6], null, 'employee', '2023-07-17'],
    ['Mark', 'Aguilar', 'Castillo', 'male', 'Laundry Attendant', morning, [2, 3, 4, 5, 6, 7], null, 'employee', '2024-04-01'],
    ['Carlo', 'Santiago', 'Fernandez', 'male', 'F&B Supervisor', afternoon, [1, 2, 3, 4, 5, 6], null, 'employee', '2020-05-25'],
    ['Jasmine', 'Lim', 'Tan', 'female', 'Waiter / Waitress', afternoon, [1, 3, 4, 5, 6, 7], null, 'employee', '2024-03-11'],
    ['Miguel', 'Ortiz', 'Ramirez', 'male', 'Bartender', night, [1, 2, 3, 4, 5, 6], null, 'employee', '2023-10-02'],
    ['Antonio', 'Chua', 'Gonzales', 'male', 'Executive Chef', morning, [1, 2, 3, 4, 5, 6], null, 'employee', '2017-08-14'],
    ['Rosa', 'Marquez', 'Pascual', 'female', 'Line Cook', afternoon, [2, 3, 4, 5, 6, 7], null, 'employee', '2022-12-01'],
    ['Daniel', 'Cortez', 'Salazar', 'male', 'Maintenance Technician', morning, [1, 2, 3, 4, 5, 6], null, 'employee', '2021-07-19'],
    ['Eduardo', 'Valdez', 'Domingo', 'male', 'Security Officer', night, [1, 2, 3, 5, 6, 7], null, 'employee', '2020-02-03'],
    ['Patricia', 'Reyes', 'Morales', 'female', 'HR Assistant', office, [1, 2, 3, 4, 5], null, 'employee', '2025-01-06'],
  ];

  const employees = [];
  const cities = ['Pasay City', 'Makati City', 'Parañaque City', 'Manila', 'Taguig City'];
  for (const [i, [first, middle, last, gender, title, shift, days, email0, role, hired]] of people.entries()) {
    const position = positions[title];
    const email = email0 || `${first.toLowerCase().replace(/\s/g, '')}.${last.toLowerCase().replace(/\s/g, '')}@staffpay.com`;
    const user = await User.create({ name: `${first} ${last}`, email, password: role === 'hr' ? hash('Hr@12345') : staffHash, role });
    const employee = await Employee.create({
      user_id: user.id,
      employee_code: `EMP${String(i + 1).padStart(3, '0')}`,
      first_name: first, middle_name: middle, last_name: last, gender,
      birth_date: toDateStr(new Date(1985 + (i % 15), i % 12, 10 + i)),
      contact_number: `0917${String(1234567 + i * 7919).padStart(7, '0')}`,
      email,
      address: `${cities[i % 5]}, Metro Manila`,
      department_id: position.department_id,
      position_id: position.id,
      employment_status: hired >= '2025-01-01' ? 'probationary' : 'active',
      employment_type: i % 7 === 6 ? 'contractual' : 'full_time',
      date_hired: hired < hiredBefore ? hired : hiredBefore,
      basic_salary: position.default_salary,
    });
    await WorkSchedule.create({ employee_id: employee.id, shift_id: shift.id, working_days: days, effective_from: hiredBefore, notes: 'Regular schedule' });
    await ensureBalances(employee.id, now.getFullYear());
    employees.push(employee);
  }
  log(`  employees: ${employees.length}`);

  // Philippine holidays
  const y = now.getFullYear();
  for (const [date, name, type] of [
    [`${y}-01-01`, "New Year's Day", 'regular'], [`${y}-04-09`, 'Araw ng Kagitingan', 'regular'], [`${y}-05-01`, 'Labor Day', 'regular'],
    [`${y}-06-12`, 'Independence Day', 'regular'], [`${y}-08-21`, 'Ninoy Aquino Day', 'special'], [`${y}-08-31`, 'National Heroes Day', 'regular'],
    [`${y}-11-01`, "All Saints' Day", 'special'], [`${y}-11-30`, 'Bonifacio Day', 'regular'], [`${y}-12-08`, 'Feast of the Immaculate Conception', 'special'],
    [`${y}-12-25`, 'Christmas Day', 'regular'], [`${y}-12-30`, 'Rizal Day', 'regular'], [`${y}-12-31`, 'Last Day of the Year', 'special'],
  ]) await Holiday.create({ date, name, type, rate: type === 'regular' ? 2 : 1.3 });

  // Allowances & deductions
  for (const e of employees) {
    await Allowance.create({ employee_id: e.id, name: 'Meal Allowance', amount: 1000 });
    await Allowance.create({ employee_id: e.id, name: 'Transportation Allowance', amount: 750 });
  }
  await Allowance.create({ employee_id: employees[2].id, name: 'Managerial Allowance', amount: 2500, is_taxable: true });
  await Allowance.create({ employee_id: employees[12].id, name: 'Managerial Allowance', amount: 3000, is_taxable: true });
  for (const i of [1, 5, 14]) {
    await Allowance.create({ employee_id: employees[i].id, name: 'Perfect Attendance Incentive', category: 'incentive', amount: 500, is_taxable: true });
  }
  await SalaryDeduction.create({ employee_id: employees[1].id, name: 'SSS Salary Loan', type: 'loan', amount: 850 });
  await SalaryDeduction.create({ employee_id: employees[6].id, name: 'Cash Advance', type: 'cash_advance', amount: 500, start_date: toDateStr(seedStart), end_date: toDateStr(addDays(now, 60)) });
  await SalaryDeduction.create({ employee_id: employees[10].id, name: 'Uniform', type: 'uniform', amount: 300 });

  // Leave requests
  const hr = await User.findOne({ where: { email: 'hr@staffpay.com' } });
  const schedules = new ScheduleService();
  const attendance = new AttendanceService(schedules);
  const d = (offset) => toDateStr(addDays(seedStart, offset));

  const approvedLeave = async (e, leave_type, start_date, end_date, reason) => {
    const days = await schedules.workingDaysBetween(e.id, start_date, end_date);
    const leave = await LeaveRequest.create({ employee_id: e.id, leave_type, start_date, end_date, days, reason, status: 'approved', reviewed_by: hr.id, reviewed_at: addDays(start_date, -3) });
    if (leave.is_paid) await (await balanceFor(e.id, Number(start_date.slice(0, 4)), leave_type)).increment('used', { by: days });
    await attendance.applyLeave(leave);
  };
  await approvedLeave(employees[3], 'vacation', d(10), d(12), 'Family trip to Baguio');
  await approvedLeave(employees[7], 'sick', d(40), d(41), 'Flu and fever, with medical certificate');
  await approvedLeave(employees[13], 'emergency', d(55), d(55), 'Family emergency');
  await approvedLeave(employees[9], 'unpaid', d(70), d(71), 'Personal matters');

  const ahead = (n) => toDateStr(addDays(now, n));
  await LeaveRequest.create({ employee_id: employees[1].id, leave_type: 'vacation', start_date: ahead(10), end_date: ahead(12), days: await schedules.workingDaysBetween(employees[1].id, ahead(10), ahead(12)), reason: "Attending my sister's wedding in Cebu" });
  await LeaveRequest.create({ employee_id: employees[10].id, leave_type: 'sick', start_date: ahead(-1), end_date: ahead(-1), days: 1, reason: 'Dental surgery recovery' });
  await LeaveRequest.create({ employee_id: employees[5].id, leave_type: 'vacation', start_date: ahead(20), end_date: ahead(24), days: await schedules.workingDaysBetween(employees[5].id, ahead(20), ahead(24)), reason: 'Holiday vacation with family', status: 'rejected', reviewed_by: hr.id, reviewed_at: addDays(now, -1), remarks: 'Peak season - please choose another week.' });

  // Attendance history. The last 7 days before today are NOT generated here:
  //   days -7..-4 are loaded through the real TXT import (see below) and
  //   days -3..-1 are left for you to import from samples/attendance-latest.txt.
  const todayStr = today();
  const historyEnd = toDateStr(addDays(now, -8));
  const importedFrom = toDateStr(addDays(now, -7));
  const importedTo = toDateStr(addDays(now, -4));
  const pendingFrom = toDateStr(addDays(now, -3));
  const pendingTo = toDateStr(addDays(now, -1));
  const generated = [...dateRange(toDateStr(seedStart), historyEnd), todayStr];
  for (const date of generated) {
    for (const [idx, e] of employees.entries()) {
      const w = await schedules.windowFor(e.id, date);
      if (!w) continue;
      if ((await schedules.holidayOn(date)) && rand(1, 100) <= 50) continue; // half the staff off on holidays
      if (await Attendance.findOne({ where: { employee_id: e.id, date } })) continue; // on leave
      if (w.in > now) continue; // shift not started yet
      if (date === todayStr && idx % 4 === 0) continue; // some "not yet in" today
      const roll = rand(1, 100);
      if (roll <= 4 && date !== todayStr) continue; // absent (marked below)

      let tin = addMinutes(w.in, -rand(0, 20));
      if (roll <= 16) tin = addMinutes(w.in, rand(11, 50)); // late
      let tout = addMinutes(w.out, rand(0, 12));
      const roll2 = rand(1, 100);
      if (roll2 <= 10) tout = addMinutes(w.out, rand(30, 150)); // overtime
      else if (roll2 <= 14) tout = addMinutes(w.out, -rand(15, 90)); // early out
      else if (roll2 === 15) tout = addMinutes(w.in, rand(180, 220)); // half day

      const record = Attendance.build({
        employee_id: e.id, date, shift_id: w.shift.id, scheduled_in: w.in, scheduled_out: w.out, time_in: tin, time_out: tout <= now ? tout : null,
        source: 'time_clock', punch_count: tout <= now ? 2 : 1,
      });
      await attendance.recompute(record);
      if (record.overtime_status === 'pending' && date < toDateStr(addDays(now, -10))) {
        await record.update({ overtime_status: rand(1, 100) <= 85 ? 'approved' : 'rejected' });
      }
    }
  }
  await attendance.markAbsencesBetween(toDateStr(seedStart), historyEnd);

  // A real TXT import for days -7..-4 (shows up in Import History).
  const hrUser = await User.findOne({ where: { email: 'hr@staffpay.com' } });
  const importContent = await buildSampleFile(dateRange(importedFrom, importedTo));
  const preview = await createPreview({
    fileName: `biometric-${importedFrom}-to-${importedTo}.txt`, content: importContent, user: hrUser,
    options: { mark_absences: true, approve_overtime: false },
  });
  const committed = await commitImport(preview.id, hrUser);
  log(`  TXT import #${committed.id}: ${committed.records_imported} records, ${committed.absences_marked} absences`);

  // Sample files for you to try the import (days -3..-1 are not in the database yet).
  const samplesDir = path.join(process.cwd(), 'samples');
  fs.mkdirSync(samplesDir, { recursive: true });
  fs.writeFileSync(path.join(samplesDir, 'attendance-latest.txt'), await buildSampleFile(dateRange(pendingFrom, pendingTo), { withProblems: true }));
  fs.writeFileSync(path.join(samplesDir, 'attendance-ready-to-import.txt'), await buildSampleFile(dateRange(pendingFrom, pendingTo), { skipExisting: true, comments: true }));
  fs.writeFileSync(path.join(samplesDir, 'attendance-template.txt'), ATTENDANCE_TEMPLATE);
  fs.writeFileSync(path.join(samplesDir, 'attendance-format-example.txt'), [
    '# StaffPay attendance TXT format (header row is optional; lines starting with # are ignored)',
    'EMPLOYEE_ID,DATE,TIME,STATUS',
    `EMP001,${pendingTo},08:00:00,IN`,
    `EMP001,${pendingTo},17:30:00,OUT`,
    `EMP002,${pendingTo},08:15:00,IN`,
    `EMP002,${pendingTo},18:00:00,OUT`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(samplesDir, 'attendance-biometric-device.txt'), (await buildSampleFile([pendingTo]))
    .split('\n').slice(1).filter(Boolean)
    .map((l) => { const [id, d, t, st] = l.split(','); return `${id}\t${d} ${t}\t1\t${st === 'IN' ? 0 : 1}\t1\t0`; })
    .join('\n') + '\n');
  log(`  sample files written to samples/ (dates ${pendingFrom} to ${pendingTo} are ready to import)`);
  log(`  attendance records: ${await Attendance.count()}`);

  const absent = await Attendance.findOne({ where: { employee_id: employees[1].id, status: 'absent' }, order: [['date', 'DESC']] });
  if (absent) {
    await AttendanceCorrection.create({
      employee_id: employees[1].id, attendance_id: absent.id, date: absent.date, requested_time_in: absent.scheduled_in, requested_time_out: absent.scheduled_out,
      reason: 'Biometric/time clock did not register my time in; I was on duty at the front desk.',
    });
  }

  // Payroll runs: semi-monthly periods; the current one is left as a draft.
  const payrollService = new PayrollService(schedules);
  for (let cursor = new Date(seedStart); cursor <= now; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
    const periods = [
      [new Date(cursor.getFullYear(), cursor.getMonth(), 1), new Date(cursor.getFullYear(), cursor.getMonth(), 15)],
      [new Date(cursor.getFullYear(), cursor.getMonth(), 16), endOfMonth(cursor)],
    ];
    for (const [start, end] of periods) {
      if (start > now) break;
      // Periods that include the not-yet-imported days stay as drafts (calculate them after importing).
      const open = toDateStr(end) >= pendingFrom;
      const payroll = await Payroll.create({
        reference: `PR-${toDateStr(start).replace(/-/g, '')}-${toDateStr(end).slice(5).replace('-', '')}`,
        period_start: toDateStr(start), period_end: toDateStr(end), pay_date: toDateStr(addDays(end, 5)),
        status: 'draft', created_by: hr.id, notes: open ? 'Import the latest attendance TXT, then calculate' : null,
      });
      if (open) continue;
      await payrollService.calculate(payroll);
      const lastClosed = addDays(end, 16) > now;
      await payroll.update({
        status: lastClosed ? 'approved' : 'paid', approved_by: admin.id, approved_at: addDays(end, 3), paid_at: lastClosed ? null : addDays(end, 5),
      });
      await payrollService.issuePayslips(payroll);
    }
  }
  log(`  payroll runs: ${await Payroll.count()}`);
}
