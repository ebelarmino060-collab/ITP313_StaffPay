import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base, counter, decimal, json } from './types.js';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day', 'on_leave', 'rest_day'];
/** Where an attendance record came from. */
export const ATTENDANCE_SOURCES = ['import', 'time_clock', 'manual', 'correction', 'system'];

export const Holiday = sequelize.define('Holiday', {
  name: { type: DataTypes.STRING(120), allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false, unique: true },
  type: { type: DataTypes.ENUM('regular', 'special'), allowNull: false, defaultValue: 'regular' },
  rate: decimal('rate', 4, 2, 2), // pay multiplier for hours worked, 2.00 = 200%
}, base('holidays'));

export const Attendance = sequelize.define('Attendance', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  shift_id: { type: DataTypes.INTEGER, allowNull: true },
  scheduled_in: { type: DataTypes.DATE, allowNull: true },
  scheduled_out: { type: DataTypes.DATE, allowNull: true },
  time_in: { type: DataTypes.DATE, allowNull: true },
  time_out: { type: DataTypes.DATE, allowNull: true },
  status: { type: DataTypes.ENUM(...ATTENDANCE_STATUSES), allowNull: false, defaultValue: 'present' },
  worked_minutes: counter(),
  late_minutes: counter(),
  undertime_minutes: counter(),
  overtime_minutes: counter(),
  overtime_status: { type: DataTypes.ENUM('none', 'pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'none' },
  night_diff_minutes: counter(),
  is_holiday: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  is_paid_leave: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  leave_request_id: { type: DataTypes.INTEGER, allowNull: true },
  source: { type: DataTypes.ENUM(...ATTENDANCE_SOURCES), allowNull: false, defaultValue: 'manual' },
  import_id: { type: DataTypes.INTEGER, allowNull: true },
  punch_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  time_in_ip: { type: DataTypes.STRING(45), allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
}, base('attendance_records', {
  indexes: [{ unique: true, fields: ['employee_id', 'date'] }, { fields: ['date', 'status'] }, { fields: ['import_id'] }],
}));

/** One row per attendance record with overtime; HR approves or rejects it before payroll pays it. */
export const OvertimeRequest = sequelize.define('OvertimeRequest', {
  attendance_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_at: { type: DataTypes.DATE, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
}, base('overtime_requests', { indexes: [{ fields: ['status', 'date'] }] }));

export const AttendanceCorrection = sequelize.define('AttendanceCorrection', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  attendance_id: { type: DataTypes.INTEGER, allowNull: true },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  requested_time_in: { type: DataTypes.DATE, allowNull: true },
  requested_time_out: { type: DataTypes.DATE, allowNull: true },
  reason: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_at: { type: DataTypes.DATE, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
}, base('attendance_corrections'));

/**
 * A TXT layout exported by a time clock / biometric device.
 * options: { delimiter, header, col_employee, col_date, col_time, col_status, date_format, in_values, out_values }
 */
export const AttendanceImportFormat = sequelize.define('AttendanceImportFormat', {
  name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  description: { type: DataTypes.STRING, allowNull: true },
  options: json('options', {}),
  is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, base('attendance_import_formats'));

export const IMPORT_STATUSES = ['preview', 'completed', 'cancelled'];

/** One uploaded attendance TXT file (kept with its content and results). */
export const AttendanceImport = sequelize.define('AttendanceImport', {
  file_name: { type: DataTypes.STRING, allowNull: false },
  file_hash: { type: DataTypes.STRING(64), allowNull: false },
  file_size: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  content: { type: DataTypes.TEXT('medium'), allowNull: false },
  format_id: { type: DataTypes.INTEGER, allowNull: true },
  format_options: json('format_options', {}),
  status: { type: DataTypes.ENUM(...IMPORT_STATUSES), allowNull: false, defaultValue: 'preview' },
  date_from: { type: DataTypes.DATEONLY, allowNull: true },
  date_to: { type: DataTypes.DATEONLY, allowNull: true },
  total_lines: counter(),
  identified_employees: counter(),
  unrecognized_ids: counter(),
  records_ready: counter(),
  records_imported: counter(),
  duplicate_count: counter(),
  invalid_count: counter(),
  absences_marked: counter(),
  preview: json('preview', null, 'long'), // parsed rows shown before committing
  options: json('options', {}), // { mark_absences, approve_overtime }
  uploaded_by: { type: DataTypes.INTEGER, allowNull: true },
  committed_at: { type: DataTypes.DATE, allowNull: true },
}, base('attendance_imports', { indexes: [{ fields: ['file_hash'] }, { fields: ['status'] }] }));

/** Lines of an import that could not be imported (kept for review). */
export const AttendanceImportError = sequelize.define('AttendanceImportError', {
  import_id: { type: DataTypes.INTEGER, allowNull: false },
  line_no: { type: DataTypes.INTEGER, allowNull: true },
  employee_code: { type: DataTypes.STRING(60), allowNull: true },
  date: { type: DataTypes.STRING(20), allowNull: true },
  error_type: { type: DataTypes.STRING(40), allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  raw_line: { type: DataTypes.TEXT, allowNull: true },
}, base('attendance_import_errors', { indexes: [{ fields: ['import_id'] }] }));
