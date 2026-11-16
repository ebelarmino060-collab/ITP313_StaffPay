/*
 * StaffPay models and relationships (Sequelize / MySQL).
 */
import { sequelize } from './db.js';
import { User, ROLES } from './userModel.js';
import {
  Department, Position, Shift, Employee, WorkSchedule,
  EMPLOYMENT_STATUSES, ACTIVE_STATUSES, EMPLOYMENT_TYPES, DAY_NAMES,
} from './organizationModels.js';
import {
  Holiday, Attendance, AttendanceCorrection, OvertimeRequest, AttendanceImport, AttendanceImportError, AttendanceImportFormat,
  ATTENDANCE_STATUSES, ATTENDANCE_SOURCES,
} from './attendanceModels.js';
import { LeaveRequest, LeaveBalance, LEAVE_TYPES, PAID_LEAVE_TYPES } from './leaveModels.js';
import {
  Allowance, SalaryDeduction, Payroll, PayrollDetail, PayrollEarning, PayrollDeduction, Payslip,
  DEDUCTION_TYPES, PAYROLL_STATUSES, ALLOWANCE_CATEGORIES,
} from './payrollModels.js';
import { SystemSetting, AuditLog, Notification } from './systemModels.js';

const cascade = { onDelete: 'CASCADE', hooks: true };

// Accounts
User.hasOne(Employee, { foreignKey: 'user_id', as: 'employee', onDelete: 'SET NULL' });
Employee.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Organisation
Department.hasMany(Position, { foreignKey: 'department_id', as: 'positions', ...cascade });
Position.belongsTo(Department, { foreignKey: 'department_id', as: 'department' });
Department.hasMany(Employee, { foreignKey: 'department_id', as: 'employees', onDelete: 'SET NULL' });
Employee.belongsTo(Department, { foreignKey: 'department_id', as: 'department' });
Position.hasMany(Employee, { foreignKey: 'position_id', as: 'employees', onDelete: 'SET NULL' });
Employee.belongsTo(Position, { foreignKey: 'position_id', as: 'position' });

// Scheduling
Employee.hasMany(WorkSchedule, { foreignKey: 'employee_id', as: 'schedules', ...cascade });
WorkSchedule.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
Shift.hasMany(WorkSchedule, { foreignKey: 'shift_id', as: 'schedules', onDelete: 'RESTRICT' });
WorkSchedule.belongsTo(Shift, { foreignKey: 'shift_id', as: 'shift' });

// Attendance
Employee.hasMany(Attendance, { foreignKey: 'employee_id', as: 'attendance', ...cascade });
Attendance.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
Attendance.belongsTo(Shift, { foreignKey: 'shift_id', as: 'shift', onDelete: 'SET NULL' });
Employee.hasMany(AttendanceCorrection, { foreignKey: 'employee_id', as: 'corrections', ...cascade });
AttendanceCorrection.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
AttendanceCorrection.belongsTo(Attendance, { foreignKey: 'attendance_id', as: 'attendance', onDelete: 'SET NULL' });
AttendanceCorrection.belongsTo(User, { foreignKey: 'reviewed_by', as: 'reviewer', onDelete: 'SET NULL' });
Attendance.hasOne(OvertimeRequest, { foreignKey: 'attendance_id', as: 'overtimeRequest', ...cascade });
OvertimeRequest.belongsTo(Attendance, { foreignKey: 'attendance_id', as: 'attendance' });
OvertimeRequest.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
OvertimeRequest.belongsTo(User, { foreignKey: 'reviewed_by', as: 'reviewer', onDelete: 'SET NULL' });

// Attendance TXT imports
AttendanceImport.belongsTo(User, { foreignKey: 'uploaded_by', as: 'uploader', onDelete: 'SET NULL' });
AttendanceImport.belongsTo(AttendanceImportFormat, { foreignKey: 'format_id', as: 'format', onDelete: 'SET NULL' });
AttendanceImport.hasMany(AttendanceImportError, { foreignKey: 'import_id', as: 'errors', ...cascade });
AttendanceImportError.belongsTo(AttendanceImport, { foreignKey: 'import_id', as: 'import' });
AttendanceImport.hasMany(Attendance, { foreignKey: 'import_id', as: 'records', onDelete: 'SET NULL' });
Attendance.belongsTo(AttendanceImport, { foreignKey: 'import_id', as: 'import' });

// Leave
Employee.hasMany(LeaveRequest, { foreignKey: 'employee_id', as: 'leaveRequests', ...cascade });
LeaveRequest.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
LeaveRequest.belongsTo(User, { foreignKey: 'reviewed_by', as: 'reviewer', onDelete: 'SET NULL' });
Employee.hasMany(LeaveBalance, { foreignKey: 'employee_id', as: 'leaveBalances', ...cascade });
LeaveBalance.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// Payroll
Employee.hasMany(Allowance, { foreignKey: 'employee_id', as: 'allowances', ...cascade });
Allowance.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
Employee.hasMany(SalaryDeduction, { foreignKey: 'employee_id', as: 'deductions', ...cascade });
SalaryDeduction.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
Payroll.hasMany(PayrollDetail, { foreignKey: 'payroll_id', as: 'details', ...cascade });
PayrollDetail.belongsTo(Payroll, { foreignKey: 'payroll_id', as: 'payroll' });
Employee.hasMany(PayrollDetail, { foreignKey: 'employee_id', as: 'payrollDetails', ...cascade });
PayrollDetail.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });
Payroll.belongsTo(User, { foreignKey: 'created_by', as: 'creator', onDelete: 'SET NULL' });
Payroll.belongsTo(User, { foreignKey: 'approved_by', as: 'approver', onDelete: 'SET NULL' });
PayrollDetail.hasMany(PayrollEarning, { foreignKey: 'payroll_record_id', as: 'earnings', ...cascade });
PayrollEarning.belongsTo(PayrollDetail, { foreignKey: 'payroll_record_id', as: 'record' });
PayrollDetail.hasMany(PayrollDeduction, { foreignKey: 'payroll_record_id', as: 'deductionLines', ...cascade });
PayrollDeduction.belongsTo(PayrollDetail, { foreignKey: 'payroll_record_id', as: 'record' });
PayrollDetail.hasOne(Payslip, { foreignKey: 'payroll_record_id', as: 'payslip', ...cascade });
Payslip.belongsTo(PayrollDetail, { foreignKey: 'payroll_record_id', as: 'record' });
Payslip.belongsTo(Payroll, { foreignKey: 'payroll_id', as: 'payroll' });
Payslip.belongsTo(Employee, { foreignKey: 'employee_id', as: 'employee' });

// System
AuditLog.belongsTo(User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
User.hasMany(Notification, { foreignKey: 'user_id', as: 'notifications', ...cascade });
Notification.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

/** Convert model instances (or arrays of them) to plain objects for Handlebars. */
export const plain = (x) => {
  if (Array.isArray(x)) return x.map(plain);
  return x && typeof x.get === 'function' ? x.get({ plain: true }) : x;
};

export {
  sequelize, User, Department, Position, Shift, Employee, WorkSchedule, Holiday, Attendance, AttendanceCorrection,
  OvertimeRequest, AttendanceImport, AttendanceImportError, AttendanceImportFormat,
  LeaveRequest, LeaveBalance, Allowance, SalaryDeduction, Payroll, PayrollDetail, PayrollEarning, PayrollDeduction, Payslip,
  SystemSetting, AuditLog, Notification,
  ROLES, EMPLOYMENT_STATUSES, ACTIVE_STATUSES, EMPLOYMENT_TYPES, DAY_NAMES, ATTENDANCE_STATUSES, ATTENDANCE_SOURCES, LEAVE_TYPES,
  PAID_LEAVE_TYPES, DEDUCTION_TYPES, PAYROLL_STATUSES, ALLOWANCE_CATEGORIES,
};
