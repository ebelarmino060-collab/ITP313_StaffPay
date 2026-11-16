import { SystemSetting } from '../models/index.js';

/** Default system settings: [group, key, value, type, label] */
export const DEFAULT_SETTINGS = [
  ['hotel', 'hotel_name', 'Grand Navy Bay Hotel', 'string', 'Hotel name'],
  ['hotel', 'hotel_address', '123 Roxas Boulevard, Pasay City, Metro Manila', 'string', 'Hotel address'],
  ['hotel', 'hotel_contact', '(02) 8123-4567', 'string', 'Contact number'],
  ['hotel', 'hotel_email', 'hr@grandnavybay.com', 'string', 'Contact email'],
  ['hotel', 'hotel_logo', '', 'string', 'Hotel logo'],
  ['hotel', 'currency_symbol', '₱', 'string', 'Currency symbol'],

  ['attendance', 'grace_period_minutes', '10', 'number', 'Late grace period (minutes)'],
  ['attendance', 'overtime_min_minutes', '30', 'number', 'Minimum minutes counted as overtime'],
  ['attendance', 'overtime_requires_approval', '1', 'boolean', 'Overtime requires HR approval'],
  ['attendance', 'night_diff_start', '22:00', 'string', 'Night differential starts (HH:MM)'],
  ['attendance', 'night_diff_end', '06:00', 'string', 'Night differential ends (HH:MM)'],

  ['import', 'import_mark_absences', '1', 'boolean', 'After an import, mark scheduled employees with no punches as absent'],
  ['import', 'import_approve_overtime', '0', 'boolean', 'Approve overtime from imported files automatically'],
  ['import', 'import_max_shift_hours', '20', 'number', 'Longest allowed time between a time-in and its time-out (hours)'],

  ['payroll', 'pay_frequency', 'semi_monthly', 'string', 'Pay frequency'],
  ['payroll', 'working_days_per_month', '26', 'number', 'Working days per month (daily rate divisor)'],
  ['payroll', 'hours_per_day', '8', 'number', 'Hours per working day'],
  ['payroll', 'overtime_rate', '1.25', 'number', 'Overtime rate multiplier'],
  ['payroll', 'night_diff_rate', '0.10', 'number', 'Night differential rate (0.10 = 10%)'],

  ['contributions', 'enable_contributions', '1', 'boolean', 'Deduct government contributions'],
  ['contributions', 'sss_rate', '0.05', 'number', 'SSS employee share rate'],
  ['contributions', 'sss_min_msc', '5000', 'number', 'SSS minimum monthly salary credit'],
  ['contributions', 'sss_max_msc', '35000', 'number', 'SSS maximum monthly salary credit'],
  ['contributions', 'philhealth_rate', '0.025', 'number', 'PhilHealth employee share rate'],
  ['contributions', 'philhealth_floor', '10000', 'number', 'PhilHealth salary floor'],
  ['contributions', 'philhealth_ceiling', '100000', 'number', 'PhilHealth salary ceiling'],
  ['contributions', 'pagibig_rate', '0.02', 'number', 'Pag-IBIG employee rate'],
  ['contributions', 'pagibig_max', '200', 'number', 'Pag-IBIG maximum monthly contribution'],
  ['contributions', 'enable_withholding_tax', '1', 'boolean', 'Deduct withholding tax (BIR TRAIN table)'],

  ['leave', 'leave_vacation_days', '10', 'number', 'Vacation leave days per year'],
  ['leave', 'leave_sick_days', '10', 'number', 'Sick leave days per year'],
  ['leave', 'leave_emergency_days', '3', 'number', 'Emergency leave days per year'],
];

let cache = null;

export const castValue = (value, type) => {
  if (type === 'number') return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (type === 'boolean') return ['1', 'true', 'on', 'yes'].includes(String(value));
  return value ?? '';
};

/** All settings as { key: typedValue } (cached until changed). */
export async function allSettings() {
  if (!cache) {
    const rows = await SystemSetting.findAll();
    cache = Object.fromEntries(DEFAULT_SETTINGS.map(([, k, v, t]) => [k, castValue(v, t)]));
    for (const r of rows) cache[r.key] = castValue(r.value, r.type);
  }
  return cache;
}

export async function setting(key, fallback = null) {
  const all = await allSettings();
  return all[key] ?? fallback;
}

export async function setSetting(key, value) {
  const [row] = await SystemSetting.findOrCreate({ where: { key }, defaults: { value: String(value), group: 'general' } });
  await row.update({ value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value) });
  flushSettings();
}

export const flushSettings = () => { cache = null; };

export async function seedSettings() {
  for (const [group, key, value, type, label] of DEFAULT_SETTINGS) {
    const [row, created] = await SystemSetting.findOrCreate({ where: { key }, defaults: { group, value, type, label } });
    if (!created) await row.update({ group, type, label });
  }
  flushSettings();
}
