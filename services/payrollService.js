import { Op } from 'sequelize';
import {
  sequelize, Allowance, Attendance, Employee, Payroll, PayrollDeduction, PayrollDetail, PayrollEarning, Payslip, SalaryDeduction, ACTIVE_STATUSES,
} from '../models/index.js';
import { AttendanceService } from './attendanceService.js';
import { ScheduleService } from './scheduleService.js';
import { allSettings } from './settings.js';

const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * Automated payroll computation, driven by the validated attendance records.
 *
 *   Gross Salary     = Regular Earnings (basic) + Overtime Pay + Holiday Pay + Night Differential
 *                      + Allowances + Incentives (+ adjustments)
 *   Total Deductions = Absence + Late + Undertime + SSS + PhilHealth + Pag-IBIG + Withholding Tax
 *                      + Other Deductions (+ adjustments)
 *   Net Salary       = Gross Salary - Total Deductions
 *
 *   Daily rate  = monthly basic / working days per month (setting, default 26)
 *   Hourly rate = daily rate / hours per day (default 8)
 *   Absence     = daily rate x absent days   (approved paid leave, rest days and holidays are never absences)
 *   Overtime    = hourly rate x approved overtime hours x overtime multiplier (default 1.25)
 */
export class PayrollService {
  constructor(schedules = new ScheduleService()) {
    this.schedules = schedules;
    this.attendance = new AttendanceService(schedules);
  }

  async periodsPerMonth() {
    return (await allSettings()).pay_frequency === 'monthly' ? 1 : 2;
  }

  async refreshTotals(payroll) {
    const details = await PayrollDetail.findAll({ where: { payroll_id: payroll.id } });
    await payroll.update({
      total_gross: r2(details.reduce((t, d) => t + d.gross_salary, 0)),
      total_deductions: r2(details.reduce((t, d) => t + d.total_deductions, 0)),
      total_net: r2(details.reduce((t, d) => t + d.net_salary, 0)),
      employee_count: details.length,
    });
  }

  /** Save one record and its itemised earnings / deductions. */
  async saveRecord(payroll, employee, result, existing = null) {
    return sequelize.transaction(async (transaction) => {
      let record = existing;
      if (record) await record.update(result.data, { transaction });
      else record = await PayrollDetail.create({ ...result.data, payroll_id: payroll.id, employee_id: employee.id }, { transaction });
      await PayrollEarning.destroy({ where: { payroll_record_id: record.id }, transaction });
      await PayrollDeduction.destroy({ where: { payroll_record_id: record.id }, transaction });
      await PayrollEarning.bulkCreate(result.earnings.map((e, i) => ({ ...e, payroll_record_id: record.id, sort_order: i })), { transaction });
      await PayrollDeduction.bulkCreate(result.deductions.map((d, i) => ({ ...d, payroll_record_id: record.id, sort_order: i })), { transaction });
      return record;
    });
  }

  /** Calculate (or recalculate) every employee of a payroll period from attendance. Manual adjustments are kept. */
  async calculate(payroll) {
    // Scheduled shifts without any attendance become absences (leave, rest days and holidays are skipped).
    await this.attendance.markAbsencesBetween(payroll.period_start, payroll.period_end);

    const employees = await Employee.findAll({ where: { employment_status: ACTIVE_STATUSES, date_hired: { [Op.lte]: payroll.period_end } } });
    await this.schedules.preload(employees.map((e) => e.id));
    const existing = new Map((await PayrollDetail.findAll({ where: { payroll_id: payroll.id } })).map((d) => [d.employee_id, d]));
    const keep = [];

    for (const e of employees) {
      const prev = existing.get(e.id);
      const result = await this.computeFor(e, payroll.period_start, payroll.period_end, {
        adjustment_additions: prev?.adjustment_additions ?? 0,
        adjustment_deductions: prev?.adjustment_deductions ?? 0,
        adjustment_notes: prev?.adjustment_notes ?? null,
      });
      const record = await this.saveRecord(payroll, e, result, prev);
      keep.push(record.id);
    }
    await PayrollDetail.destroy({ where: { payroll_id: payroll.id, id: { [Op.notIn]: keep.length ? keep : [0] } } });

    await payroll.update({ status: 'calculated', calculated_at: new Date() });
    await this.refreshTotals(payroll);
    return payroll.reload();
  }

  async applyAdjustments(detail, additions, deductions, notes) {
    const payroll = await Payroll.findByPk(detail.payroll_id);
    const employee = await Employee.findByPk(detail.employee_id);
    const result = await this.computeFor(employee, payroll.period_start, payroll.period_end, {
      adjustment_additions: additions, adjustment_deductions: deductions, adjustment_notes: notes,
    });
    await this.saveRecord(payroll, employee, result, detail);
    await this.refreshTotals(payroll);
    return detail.reload();
  }

  /** Issue payslips when a payroll is finalized. */
  async issuePayslips(payroll) {
    const records = await PayrollDetail.findAll({ where: { payroll_id: payroll.id }, include: [{ model: Employee, as: 'employee', attributes: ['id', 'employee_code'] }] });
    for (const r of records) {
      await Payslip.findOrCreate({
        where: { payroll_record_id: r.id },
        defaults: {
          payroll_id: payroll.id, employee_id: r.employee_id, issued_at: new Date(), payment_status: payroll.status === 'paid' ? 'paid' : 'unpaid',
          payslip_no: `PS-${payroll.period_end.replace(/-/g, '')}-${r.employee?.employee_code || r.employee_id}`,
        },
      });
    }
    return records.length;
  }

  /** All payroll figures for one employee and period: { data, earnings, deductions }. */
  async computeFor(employee, from, to, adjustments = {}) {
    const s = await allSettings();
    const periods = await this.periodsPerMonth();
    const hoursPerDay = Number(s.hours_per_day) || 8;
    const workingDaysPerMonth = Number(s.working_days_per_month) || 26;

    const monthly = Number(employee.basic_salary);
    const dailyRate = monthly / workingDaysPerMonth;
    const hourlyRate = dailyRate / hoursPerDay;
    let basic = monthly / periods;

    // Pro-rate employees hired during the period.
    if (employee.date_hired > from) {
      const daysEmployed = await this.schedules.workingDaysBetween(employee.id, employee.date_hired, to);
      basic = Math.min(basic, daysEmployed * dailyRate);
    }

    const records = await Attendance.findAll({ where: { employee_id: employee.id, date: { [Op.between]: [from, to] } } });
    const otNeedsApproval = Boolean(s.overtime_requires_approval);

    let daysWorked = 0; let daysAbsent = 0; let paidLeave = 0;
    let late = 0; let undertime = 0; let otMinutes = 0; let ndMinutes = 0;
    let holidayPay = 0; let holidayHours = 0;

    for (const r of records) {
      switch (r.status) {
        case 'present':
        case 'late':
          if (r.time_in) daysWorked += 1;
          late += r.late_minutes;
          undertime += r.undertime_minutes;
          break;
        case 'half_day': // half a day deducted; late/undertime not double counted
          daysWorked += 0.5;
          daysAbsent += 0.5;
          break;
        case 'absent':
          daysAbsent += 1;
          break;
        case 'on_leave':
          if (r.is_paid_leave) paidLeave += 1;
          else daysAbsent += 1; // unpaid leave
          break;
        default:
          break;
      }
      if (r.overtime_minutes > 0 && (r.overtime_status === 'approved' || (!otNeedsApproval && r.overtime_status !== 'rejected'))) {
        otMinutes += r.overtime_minutes;
      }
      ndMinutes += r.night_diff_minutes;
      if (r.is_holiday && r.worked_minutes > 0) {
        const h = await this.schedules.holidayOn(r.date);
        const premium = Math.max(0, Number(h?.rate ?? 1) - 1);
        const hours = r.worked_minutes / 60;
        holidayHours += hours;
        holidayPay += hours * hourlyRate * premium;
      }
    }
    const scheduledDays = await this.schedules.workingDaysBetween(employee.id, employee.date_hired > from ? employee.date_hired : from, to);

    const otHours = otMinutes / 60;
    const ndHours = ndMinutes / 60;
    const otRate = Number(s.overtime_rate ?? 1.25);
    const overtimePay = otHours * hourlyRate * otRate;
    const nightDiffPay = ndHours * hourlyRate * Number(s.night_diff_rate ?? 0.1);

    // Recurring allowances / incentives and deductions (amounts are per pay period).
    const additions = await Allowance.findAll({ where: { employee_id: employee.id, is_active: true } });
    const allowances = additions.filter((a) => a.category !== 'incentive');
    const incentives = additions.filter((a) => a.category === 'incentive');
    const allowanceTotal = allowances.reduce((t, a) => t + a.amount, 0);
    const incentiveTotal = incentives.reduce((t, a) => t + a.amount, 0);
    const taxableAdditions = additions.filter((a) => a.is_taxable).reduce((t, a) => t + a.amount, 0);

    const otherItems = await SalaryDeduction.findAll({
      where: {
        employee_id: employee.id,
        is_active: true,
        [Op.and]: [
          { [Op.or]: [{ start_date: null }, { start_date: { [Op.lte]: to } }] },
          { [Op.or]: [{ end_date: null }, { end_date: { [Op.gte]: from } }] },
        ],
      },
    });
    const otherDeductions = otherItems.reduce((t, d) => t + d.amount, 0);

    const lateDeduction = (late / 60) * hourlyRate;
    const undertimeDeduction = (undertime / 60) * hourlyRate;
    const absenceDeduction = daysAbsent * dailyRate;
    const addAdj = Number(adjustments.adjustment_additions || 0);
    const dedAdj = Number(adjustments.adjustment_deductions || 0);

    const gross = basic + overtimePay + holidayPay + nightDiffPay + allowanceTotal + incentiveTotal + addAdj;

    // Government contributions (employee share), split across pay periods.
    let sss = 0; let philhealth = 0; let pagibig = 0; let tax = 0;
    if (s.enable_contributions) {
      const msc = Math.min(Math.max(monthly, Number(s.sss_min_msc)), Number(s.sss_max_msc));
      sss = (msc * Number(s.sss_rate)) / periods;
      const phBase = Math.min(Math.max(monthly, Number(s.philhealth_floor)), Number(s.philhealth_ceiling));
      philhealth = (phBase * Number(s.philhealth_rate)) / periods;
      pagibig = Math.min(monthly * Number(s.pagibig_rate), Number(s.pagibig_max)) / periods;
    }
    if (s.enable_withholding_tax) {
      const taxable = basic + overtimePay + holidayPay + nightDiffPay + taxableAdditions + addAdj
        - lateDeduction - undertimeDeduction - absenceDeduction - sss - philhealth - pagibig;
      tax = PayrollService.monthlyWithholdingTax(Math.max(0, taxable) * periods) / periods;
    }

    const totalDeductions = lateDeduction + undertimeDeduction + absenceDeduction + sss + philhealth + pagibig + tax + otherDeductions + dedAdj;
    const net = gross - totalDeductions;
    const hrs = (h) => `${h.toFixed(2)} hrs`;

    const earnings = [
      { code: 'basic', label: 'Regular Earnings (Basic Salary)', quantity: `${scheduledDays} day(s)`, amount: r2(basic) },
      { code: 'overtime', label: 'Overtime Pay', quantity: `${hrs(otHours)} × ${otRate}`, amount: r2(overtimePay) },
      { code: 'holiday', label: 'Holiday Pay', quantity: hrs(holidayHours), amount: r2(holidayPay) },
      { code: 'night_diff', label: 'Night Differential', quantity: hrs(ndHours), amount: r2(nightDiffPay) },
      ...allowances.map((a) => ({ code: 'allowance', label: a.name, quantity: 'Allowance', amount: r2(a.amount) })),
      ...incentives.map((a) => ({ code: 'incentive', label: a.name, quantity: 'Incentive', amount: r2(a.amount) })),
      { code: 'adjustment', label: 'Adjustments', quantity: null, amount: r2(addAdj) },
    ].filter((i) => i.amount !== 0 || ['basic', 'overtime'].includes(i.code));

    const deductions = [
      { code: 'absence', label: 'Absences', quantity: `${daysAbsent} day(s)`, amount: r2(absenceDeduction) },
      { code: 'late', label: 'Late', quantity: `${late} min`, amount: r2(lateDeduction) },
      { code: 'undertime', label: 'Undertime', quantity: `${undertime} min`, amount: r2(undertimeDeduction) },
      { code: 'sss', label: 'SSS Contribution', quantity: null, amount: r2(sss) },
      { code: 'philhealth', label: 'PhilHealth Contribution', quantity: null, amount: r2(philhealth) },
      { code: 'pagibig', label: 'Pag-IBIG Contribution', quantity: null, amount: r2(pagibig) },
      { code: 'tax', label: 'Withholding Tax', quantity: null, amount: r2(tax) },
      ...otherItems.map((d) => ({ code: 'other', label: d.name, quantity: null, amount: r2(d.amount) })),
      { code: 'adjustment', label: 'Adjustments', quantity: null, amount: r2(dedAdj) },
    ].filter((i) => i.amount !== 0 || i.code === 'absence');

    return {
      earnings,
      deductions,
      data: {
        monthly_salary: r2(monthly),
        basic_salary: r2(basic),
        daily_rate: r2(dailyRate),
        hourly_rate: Math.round(hourlyRate * 10000) / 10000,
        scheduled_days: scheduledDays,
        days_worked: daysWorked,
        days_absent: daysAbsent,
        paid_leave_days: paidLeave,
        late_minutes: late,
        undertime_minutes: undertime,
        overtime_hours: r2(otHours),
        night_diff_hours: r2(ndHours),
        holiday_hours: r2(holidayHours),
        overtime_pay: r2(overtimePay),
        holiday_pay: r2(holidayPay),
        night_differential: r2(nightDiffPay),
        allowances: r2(allowanceTotal),
        incentives: r2(incentiveTotal),
        adjustment_additions: r2(addAdj),
        late_deduction: r2(lateDeduction),
        undertime_deduction: r2(undertimeDeduction),
        absence_deduction: r2(absenceDeduction),
        sss: r2(sss),
        philhealth: r2(philhealth),
        pagibig: r2(pagibig),
        withholding_tax: r2(tax),
        other_deductions: r2(otherDeductions),
        adjustment_deductions: r2(dedAdj),
        adjustment_notes: adjustments.adjustment_notes ?? null,
        gross_salary: r2(gross),
        total_deductions: r2(totalDeductions),
        net_salary: r2(net),
      },
    };
  }

  /** Philippine BIR monthly withholding tax table (TRAIN law, 2023 onwards). */
  static monthlyWithholdingTax(taxable) {
    const brackets = [
      [666667, 183541.8, 0.35],
      [166667, 33541.8, 0.30],
      [66667, 8541.8, 0.25],
      [33333, 1875, 0.20],
      [20833, 0, 0.15],
    ];
    for (const [over, baseTax, rate] of brackets) if (taxable > over) return baseTax + (taxable - over) * rate;
    return 0;
  }
}
