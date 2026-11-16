import { Op } from 'sequelize';
import {
  Department, Employee, Payroll, PayrollDeduction, PayrollDetail, PayrollEarning, Payslip, Position, plain,
} from '../models/index.js';
import { hotelInfo, payslipPdf, payslipsZip } from '../services/exportService.js';
import { audit } from '../services/audit.js';
import { wrap, AppError } from '../utils/errors.js';

const payslipInclude = [
  { model: Payroll, as: 'payroll' },
  { model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }] },
  { model: PayrollEarning, as: 'earnings' },
  { model: PayrollDeduction, as: 'deductionLines' },
  { model: Payslip, as: 'payslip' },
];
const lineOrder = [[{ model: PayrollEarning, as: 'earnings' }, 'sort_order', 'ASC'], [{ model: PayrollDeduction, as: 'deductionLines' }, 'sort_order', 'ASC']];

/** Load a payslip and enforce access: management sees all, employees only their own finalized payslips. */
async function loadPayslip(req) {
  const detail = await PayrollDetail.findByPk(req.params.id, { include: payslipInclude, order: lineOrder });
  if (!detail) throw new AppError('Payslip not found.', 404);
  const isManagement = ['admin', 'hr'].includes(req.user.role);
  const isOwner = req.user.employee && detail.employee_id === req.user.employee.id;
  if (!isManagement && (!isOwner || !detail.payroll.is_released)) throw new AppError('You are not allowed to view this payslip.', 403);
  return detail;
}

/** Payslips page for HR: pick a finalized payroll period, download one or all (ZIP). */
export const index = wrap(async (req, res) => {
  const periods = plain(await Payroll.findAll({ where: { status: ['approved', 'paid'] }, order: [['period_start', 'DESC']] }));
  const selected = periods.find((p) => String(p.id) === String(req.query.payroll_id)) || periods[0] || null;
  let records = [];
  if (selected) {
    const where = { payroll_id: selected.id };
    const search = String(req.query.search || '').trim();
    records = plain(await PayrollDetail.findAll({
      where,
      include: [
        { model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }] },
        { model: Payslip, as: 'payslip' },
      ],
    })).filter((d) => !search || `${d.employee?.full_name} ${d.employee?.employee_code}`.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => (a.employee?.employee_code || '').localeCompare(b.employee?.employee_code || ''));
  }
  res.render('payroll/payslips', {
    title: 'Payslips',
    periods: periods.map((p) => ({ value: p.id, label: `${p.reference} (${p.period_start} to ${p.period_end}) – ${p.status === 'paid' ? 'Paid' : 'Finalized'}` })),
    selected,
    records,
    filters: req.query,
    totals: { net: records.reduce((t, r) => t + r.net_salary, 0), gross: records.reduce((t, r) => t + r.gross_salary, 0) },
  });
});

export const show = wrap(async (req, res) => {
  const detail = await loadPayslip(req);
  res.render('payroll/payslip', {
    title: `Payslip – ${detail.employee.full_name}`,
    slip: plain(detail),
    hotelInfo: await hotelInfo(),
    pdfUrl: `/payslips/${detail.id}/pdf`,
    backUrl: req.path.startsWith('/my/') ? '/my/payslips' : `/payslips?payroll_id=${detail.payroll_id}`,
  });
});

export const pdf = wrap(async (req, res) => {
  const detail = await loadPayslip(req);
  if (detail.payslip) await detail.payslip.update({ download_count: detail.payslip.download_count + 1, last_downloaded_at: new Date() });
  await payslipPdf(res, plain(detail));
});

/** All payslips of a finalized payroll period in one ZIP file (management only). */
export const zip = wrap(async (req, res) => {
  const payroll = await Payroll.findByPk(req.params.payrollId);
  if (!payroll) throw new AppError('Payroll not found.', 404);
  if (!payroll.is_released) throw new AppError('Payslips are available after the payroll is finalized.');
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  const details = plain(await PayrollDetail.findAll({
    where: { payroll_id: payroll.id, ...(ids.length ? { id: { [Op.in]: ids } } : {}) },
    include: payslipInclude,
    order: lineOrder,
  }));
  if (!details.length) throw new AppError('No payslips to download.');
  const buffer = await payslipsZip(details, `payslips-${payroll.reference}`);
  await Payslip.increment('download_count', { where: { payroll_id: payroll.id, ...(ids.length ? { payroll_record_id: ids } : {}) } });
  await audit(req, 'payslip_bulk_download', `Downloaded ${details.length} payslip(s) of ${payroll.reference} as ZIP`, payroll);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="payslips-${payroll.reference}.zip"`);
  res.send(buffer);
});
