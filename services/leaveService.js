import { LeaveBalance, PAID_LEAVE_TYPES } from '../models/index.js';
import { allSettings } from './settings.js';

/** Fetch (or create with the yearly default allocation) one leave balance row. */
export async function balanceFor(employeeId, year, leaveType) {
  const s = await allSettings();
  const [row] = await LeaveBalance.findOrCreate({
    where: { employee_id: employeeId, year, leave_type: leaveType },
    defaults: { allocated: Number(s[`leave_${leaveType}_days`] || 0), used: 0 },
  });
  return row;
}

/** Make sure an employee has every paid-leave balance row for a year. */
export async function ensureBalances(employeeId, year) {
  for (const t of PAID_LEAVE_TYPES) await balanceFor(employeeId, year, t);
}
