# StaffPay – Hotel Staff Attendance & Payroll Management System

StaffPay manages hotel employees' attendance, shifts, leave and payroll. It is built on the **XianFire framework**:
Express + Sequelize (MySQL) + Handlebars `.xian` views, with session login.

```
StaffPay/
├── index.js            XianFire app (".xian" view engine, sessions, flash, CSRF, error pages)
├── config.js           settings from .env (DB, port, timezone, session secret)
├── migrate.js          creates the database and tables          (npm run migrate)
├── seed.js             sample data + demo accounts                 (npm run seed)
├── models/             Sequelize models and relationships
├── controllers/        route handlers (one per module)
├── routes/index.js     every URL and its role guard
├── services/           attendance, TXT import, analytics, payroll, schedule, leave, reports, PDF/Excel/ZIP export
├── middleware/         auth + roles, CSRF, image and TXT uploads, rate limiting
├── views/              .xian pages (layout.xian, partials/, one folder per module)
├── public/             css/ (external stylesheets), js/app.js, uploads/
├── database/seeder.js  the sample data
├── samples/            ready-to-import attendance TXT files (written by the seed)
├── assets/fonts/       DejaVu Sans, so PDFs print the ₱ sign
├── scripts/            mark-absent.js (schedule hourly)
└── tests/              automated tests (node:test + supertest)
```

---

## 1. Requirements

| Tool | Version |
|------|---------|
| Node.js | 20.12 or newer (tested on 24) |
| MySQL | 8.x (or MariaDB 10.6+) |

## 2. Setup

```bash
npm install
copy .env.example .env          # Linux/macOS: cp .env.example .env
```

Edit `.env` if your MySQL user or password are different:

```
DB_HOST=localhost
DB_PORT=3306
DB_NAME=staffpay
DB_USER=root
DB_PASSWORD=
SESSION_SECRET=replace-with-a-long-random-string
```

Start MySQL (on Windows: *Services → MySQL80 → Start*, or `net start MySQL80` in an **administrator** terminal), then:

```bash
npm run setup     # creates the "staffpay" database, all tables, and the sample data
npm start         # http://localhost:3000
```

`npm run dev` starts it with nodemon (auto-restart on changes).

| Command | What it does |
|---------|--------------|
| `npm run migrate` | Create the database (asks first) and any missing tables |
| `npm run migrate:fresh` | **Drop** and recreate all tables (no prompt) |
| `npm run seed` | Load sample data into an empty database |
| `npm run setup` | `migrate:fresh` + `seed` (full reset) |
| `npm run mark-absent` | Mark absences for yesterday/today's finished shifts (schedule it hourly in Task Scheduler / cron) |
| `npm test` | Run the automated tests (in-memory SQLite, does not touch MySQL) |
| `npm run route:list` | XianFire: list every registered route |

## 3. Demo accounts

| Role | Email | Password |
|------|-------|----------|
| Administrator | admin@staffpay.com | Admin@123 |
| HR / Payroll | hr@staffpay.com | Hr@12345 |
| Employee | employee@staffpay.com | Staff@123 |

Every other seeded employee signs in as `firstname.lastname@staffpay.com` / `Staff@123` (e.g. `paolo.mendoza@staffpay.com`).
The login page has one-click buttons that fill these in.

The seed creates 7 departments, 19 positions, 4 shifts (Morning 6–2, Afternoon 2–10, Night 10–6, Office 8–5), 17 employees,
three months of attendance (lates, undertime, overtime, absences, leaves), Philippine holidays, allowances, incentives and deductions,
paid and finalized payroll runs with issued payslips, and the current pay period as a **draft** ready to calculate.
Last week's attendance arrives through a real **TXT import** (import #1), and `samples/attendance-latest.txt` holds the
last three days, with a few deliberate problems, ready for you to import.

---

## Features by role

**Administrator**: everything below, plus user accounts, adding, editing and deleting employees (photo, login account, first schedule),
departments and positions, holidays, salary configuration (allowances and deductions), system settings (hotel profile and logo,
attendance rules, payroll rates, contribution rates, leave allocations), reopening approved payrolls, and audit logs.

**HR / Payroll**: dashboard, employee directory, daily attendance monitor, attendance records (manual entry and editing), monthly summary,
overtime approval, correction requests, schedules and shifts (weekly and monthly roster, bulk assignment), leave approval and balances,
payroll (create → calculate → adjust → approve → mark paid), payslips, reports with PDF/Excel export.

**Employee**: personal dashboard, time in / time out, attendance calendar and list, correction requests, own schedule,
leave filing (working-day preview, balance check, cancel), payslip history, payslip view, print and PDF download,
and profile (contact info, photo, password).

Users with a linked employee record (for example the HR officer) also get the *My Workspace* menu.

## Attendance TXT import (Attendance → Import TXT)

File format (one punch per line, header optional):

```
EMPLOYEE_ID,DATE,TIME,STATUS
EMP001,2026-11-01,08:00:00,IN
EMP001,2026-11-01,17:00:00,OUT
```

1. **Upload** a `.txt` / `.csv` / `.dat` / `.log` file (max 5 MB) and choose a format. Built-in formats: Standard CSV,
   biometric device log (tab-separated, 0 = in / 1 = out), punches-only (first = in, last = out) and US dates (MM/DD/YYYY).
   HR can add their own (delimiter, column positions or names, date order, IN/OUT codes) and test them against sample lines.
2. **Preview**: nothing is saved yet. Employee IDs are matched to employees (`EMP001`, `EMP-0001` and `emp1` are the same person),
   punches are grouped by employee and work date, IN/OUT are paired (night shifts that end the next morning stay on the start date),
   and hours, late, undertime and overtime are calculated from the employee's schedule. The preview shows Employee ID, Name, Date,
   Time In, Time Out, Total Hours, OT Hours and Import Status, plus tabs for errors, duplicates, every file line, and scheduled
   employees with no punches.
3. **Problems are reported, never silently dropped**: unknown employee IDs, duplicate lines, invalid dates or times, future dates,
   dates before hiring, missing time-in or time-out, extra punches, days that already have attendance, and dates inside a
   finalized payroll period. Each one is stored in `attendance_import_errors` with its line number and raw text.
4. **Import** saves all ready rows in **one database transaction** (`source = import`). Overtime becomes a pending overtime request
   (or is approved automatically if you tick that option), and scheduled employees with no punches can be marked absent.
   Approved leave, rest days and holidays are never marked absent.
5. **Duplicate protection**: the SHA-256 hash of each committed file is stored, so the same file is refused a second time.
   Records that already exist are shown as duplicates and are not overwritten.

**Getting a file:** the import page has a *Download an Attendance TXT File* panel. Pick a date range and it builds a
ready-to-import file from your real employees and schedules, skipping days that already have attendance. You can also tick
the option to add a few bad lines and see how errors are reported. *Blank template* downloads the format with instructions.

The seed also writes these to `samples/`: `attendance-ready-to-import.txt` (clean), `attendance-latest.txt` (same days with errors),
`attendance-template.txt`, `attendance-format-example.txt` and `attendance-biometric-device.txt` (tab-separated device log).

## Attendance analytics (Attendance → Analytics)

Weekly (by day of week), monthly (per employee and department comparison), yearly (monthly trend, employee and department
performance) and custom-range views, filtered by department and employee. Summary cards show total employees, present,
absent, late, on leave, total OT hours and average working hours. Bar, line and pie charts use Chart.js. Every table exports to PDF and Excel.

## Payroll workflow

Select period → **Calculate** (reads only finished attendance) → review each employee → **Approve & Finalize** (locks the period,
issues payslips) → **Mark paid**. Once finalized, the period's attendance cannot be added, edited, deleted, imported or corrected
by anyone. Changes need an administrator to **Reopen** the payroll with a written reason, which is recorded in the audit log.
Per-employee adjustments (bonus, correction, deduction) are also audited and survive recalculation.

**Payslips** (Payroll → Payslips): a PDF per employee with hotel name, logo and payroll contact, payslip number, employee info,
earnings and deductions breakdown, net salary and payment status. Each payslip can be viewed, printed or downloaded. HR can download
a whole period as a **ZIP**. Employees only see and download their own finalized payslips.

## Security

* Passwords hashed with bcrypt. Sessions use an httpOnly cookie, and the session id is regenerated at login.
* Every POST form carries a CSRF token. Login and time-clock posts are rate-limited.
* Role middleware (`requireRole('admin','hr')`, `requireRole('admin')`, `requireEmployee`) guards every route.
  Employees only reach `/my/*` and their own **released** payslips; ownership is checked in the controller.
* Image uploads accept images only, up to 2 MB. Attendance uploads accept text files only (.txt/.csv/.dat/.log, 5 MB, no binary content),
  are kept in memory (never written to the web root), and are restricted to Admin/HR.
* Attendance imports and payroll calculation run inside database transactions. Finalized payroll locks its attendance.
* Important administrative and payroll actions are written to the audit log, including imports, payroll approval, reopen reasons, adjustments and bulk payslip downloads.
* Admins can deactivate an employee's login (Employees list → lock icon), which keeps all of their records.

## Attendance rules

* **Late**: time in after scheduled start + grace period (default 10 min). Minutes are counted from the scheduled start.
* **Undertime / early time-out**: time out before the scheduled end.
* **Half-day**: worked less than half of the scheduled hours.
* **Overtime**: time out at least 30 min (configurable) after the shift ends. It needs HR approval before it is paid.
* **Night differential**: hours worked between 10 PM and 6 AM inside the scheduled shift.
* **Overnight shifts** belong to the date they start, so a 5:50 AM time out closes the previous night's record.
* **Absent**: a scheduled shift ended with no time in. Absences come from `npm run mark-absent`, the *Mark absences* button,
  or automatically when payroll is calculated. Holidays and approved leave are never marked absent.

## Payroll formula

```
Daily rate   = Monthly basic ÷ working days per month (26, configurable)
Hourly rate  = Daily rate ÷ 8
Basic pay    = Monthly basic ÷ 2  (semi-monthly)

Gross Salary = Basic + Overtime Pay + Holiday Pay + Night Differential + Allowances + Incentives (+ adjustments)
Total Deductions = Late + Undertime + Absences (incl. unpaid leave) + SSS + PhilHealth + Pag-IBIG
                   + Withholding Tax + Other deductions (+ adjustments)
Net Salary   = Gross Salary − Total Deductions
```

Absence deduction = daily rate × absent days. Overtime pay = approved OT hours × hourly × 1.25 (configurable).
Example: ₱26,000 / 26 = ₱1,000 daily, so 2 absences = ₱2,000 deducted. Holiday pay = hours worked × hourly × (rate − 1). Night differential = night hours × hourly × 10%.
Government contributions are employee shares: SSS 5% of the monthly salary credit (₱5k–₱35k), PhilHealth 2.5% (₱10k–₱100k base),
Pag-IBIG 2% (max ₱200). Withholding tax uses the BIR TRAIN monthly table. All rates can be changed in **Settings → Contributions & Tax**.
They are simplified defaults, so check them against current government circulars before real use.

## Database tables

`users`, `employees`, `departments`, `positions`, `shifts`, `work_schedules`, `holidays`, `attendance_records`, `overtime_requests`,
`attendance_corrections`, `attendance_imports`, `attendance_import_errors`, `attendance_import_formats`, `leave_requests`,
`leave_balances`, `payroll_periods`, `payroll_records`, `payroll_earnings`, `payroll_deductions`, `payslips`, `allowances`
(allowances and incentives), `salary_deductions`, `system_settings`, `audit_logs`, `user_notifications`.
Foreign keys cascade from an employee to their records. After upgrading from an older StaffPay version, run `npm run setup` (full reset).

## Troubleshooting

* **"Cannot connect to the mysql database"**: MySQL is not running, or the `DB_*` values in `.env` are wrong.
* **Login keeps returning to the sign-in page**: if you serve the app over plain HTTP behind a proxy, keep the default cookie settings.
* **Wrong times**: check `APP_TIMEZONE` in `.env` (default `Asia/Manila`).
* **"This exact file was already imported"**: the file was committed before. Export a new file from the time clock.
* **Import shows "Unknown employee ID"**: the ID in the file does not match any employee code. Fix the code in Employees or in the file.
* **Hotel logo missing from PDFs**: PDF exports support PNG and JPG logos only.
