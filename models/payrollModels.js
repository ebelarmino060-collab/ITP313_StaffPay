import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base, counter, decimal } from './types.js';

export const DEDUCTION_TYPES = ['loan', 'cash_advance', 'uniform', 'meal', 'other'];
export const PAYROLL_STATUSES = ['draft', 'calculated', 'approved', 'paid'];
/** Recurring additions: an allowance (e.g. meal) or an incentive (e.g. perfect attendance). */
export const ALLOWANCE_CATEGORIES = ['allowance', 'incentive'];

export const Allowance = sequelize.define('Allowance', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(100), allowNull: false },
  category: { type: DataTypes.ENUM(...ALLOWANCE_CATEGORIES), allowNull: false, defaultValue: 'allowance' },
  amount: decimal('amount'), // per pay period
  is_taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, base('allowances'));

export const SalaryDeduction = sequelize.define('SalaryDeduction', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  name: { type: DataTypes.STRING(100), allowNull: false },
  type: { type: DataTypes.ENUM(...DEDUCTION_TYPES), allowNull: false, defaultValue: 'other' },
  amount: decimal('amount'), // per pay period
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  start_date: { type: DataTypes.DATEONLY, allowNull: true },
  end_date: { type: DataTypes.DATEONLY, allowNull: true },
}, base('salary_deductions'));

/** A payroll period (status: draft -> calculated -> approved/finalized -> paid). */
export const Payroll = sequelize.define('Payroll', {
  reference: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  period_start: { type: DataTypes.DATEONLY, allowNull: false },
  period_end: { type: DataTypes.DATEONLY, allowNull: false },
  pay_date: { type: DataTypes.DATEONLY, allowNull: false },
  status: { type: DataTypes.ENUM(...PAYROLL_STATUSES), allowNull: false, defaultValue: 'draft' },
  total_gross: decimal('total_gross', 14),
  total_deductions: decimal('total_deductions', 14),
  total_net: decimal('total_net', 14),
  employee_count: counter(),
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
  approved_by: { type: DataTypes.INTEGER, allowNull: true },
  calculated_at: { type: DataTypes.DATE, allowNull: true },
  approved_at: { type: DataTypes.DATE, allowNull: true },
  paid_at: { type: DataTypes.DATE, allowNull: true },
  is_editable: { type: DataTypes.VIRTUAL, get() { return ['draft', 'calculated'].includes(this.getDataValue('status')); } },
  is_released: { type: DataTypes.VIRTUAL, get() { return ['approved', 'paid'].includes(this.getDataValue('status')); } },
}, base('payroll_periods'));

const money = (n) => decimal(n);

/** One employee's payroll for a period. */
export const PayrollDetail = sequelize.define('PayrollDetail', {
  payroll_id: { type: DataTypes.INTEGER, allowNull: false },
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  monthly_salary: money('monthly_salary'),
  basic_salary: money('basic_salary'), // regular earnings for this period
  daily_rate: money('daily_rate'),
  hourly_rate: decimal('hourly_rate', 12, 4),
  scheduled_days: decimal('scheduled_days', 5, 1),
  days_worked: decimal('days_worked', 5, 1),
  days_absent: decimal('days_absent', 5, 1),
  paid_leave_days: decimal('paid_leave_days', 5, 1),
  late_minutes: counter(),
  undertime_minutes: counter(),
  overtime_hours: decimal('overtime_hours', 8, 2),
  night_diff_hours: decimal('night_diff_hours', 8, 2),
  holiday_hours: decimal('holiday_hours', 8, 2),
  overtime_pay: money('overtime_pay'),
  holiday_pay: money('holiday_pay'),
  night_differential: money('night_differential'),
  allowances: money('allowances'),
  incentives: money('incentives'),
  adjustment_additions: money('adjustment_additions'),
  late_deduction: money('late_deduction'),
  undertime_deduction: money('undertime_deduction'),
  absence_deduction: money('absence_deduction'),
  sss: money('sss'),
  philhealth: money('philhealth'),
  pagibig: money('pagibig'),
  withholding_tax: money('withholding_tax'),
  other_deductions: money('other_deductions'),
  adjustment_deductions: money('adjustment_deductions'),
  gross_salary: money('gross_salary'),
  total_deductions: money('total_deductions'),
  net_salary: money('net_salary'),
  adjustment_notes: { type: DataTypes.TEXT, allowNull: true },
}, base('payroll_records', { indexes: [{ unique: true, fields: ['payroll_id', 'employee_id'] }] }));

/** Itemised earnings of a payroll record (basic, overtime, allowances, incentives...). */
export const PayrollEarning = sequelize.define('PayrollEarning', {
  payroll_record_id: { type: DataTypes.INTEGER, allowNull: false },
  code: { type: DataTypes.STRING(40), allowNull: false },
  label: { type: DataTypes.STRING(120), allowNull: false },
  quantity: { type: DataTypes.STRING(40), allowNull: true }, // e.g. "5.00 hrs"
  amount: money('amount'),
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, base('payroll_earnings', { indexes: [{ fields: ['payroll_record_id'] }] }));

/** Itemised deductions of a payroll record (absences, late, SSS, tax...). */
export const PayrollDeduction = sequelize.define('PayrollDeduction', {
  payroll_record_id: { type: DataTypes.INTEGER, allowNull: false },
  code: { type: DataTypes.STRING(40), allowNull: false },
  label: { type: DataTypes.STRING(120), allowNull: false },
  quantity: { type: DataTypes.STRING(40), allowNull: true }, // e.g. "2 days"
  amount: money('amount'),
  sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
}, base('payroll_deductions', { indexes: [{ fields: ['payroll_record_id'] }] }));

/** Issued payslip (created when a payroll is finalized). */
export const Payslip = sequelize.define('Payslip', {
  payroll_record_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  payroll_id: { type: DataTypes.INTEGER, allowNull: false },
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  payslip_no: { type: DataTypes.STRING(60), allowNull: false, unique: true },
  issued_at: { type: DataTypes.DATE, allowNull: false },
  payment_status: { type: DataTypes.ENUM('unpaid', 'paid'), allowNull: false, defaultValue: 'unpaid' },
  paid_at: { type: DataTypes.DATE, allowNull: true },
  download_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_downloaded_at: { type: DataTypes.DATE, allowNull: true },
}, base('payslips', { indexes: [{ fields: ['payroll_id'] }, { fields: ['employee_id'] }] }));
