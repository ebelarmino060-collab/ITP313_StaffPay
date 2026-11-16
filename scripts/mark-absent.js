/*
 * Create "absent" records for employees who missed a scheduled shift.
 *   node scripts/mark-absent.js              -> yesterday and today (finished shifts only)
 *   node scripts/mark-absent.js 2026-11-05   -> a specific date
 * Schedule it hourly with Windows Task Scheduler or cron.
 */
import '../config.js';
import { sequelize } from '../models/index.js';
import { AttendanceService } from '../services/attendanceService.js';
import { addDaysStr, today } from '../utils/time.js';

const service = new AttendanceService();
const dates = process.argv[2] ? [process.argv[2]] : [addDaysStr(today(), -1), today()];
for (const date of dates) console.log(`${date}: ${await service.markAbsences(date)} absence record(s) created`);
await sequelize.close();
