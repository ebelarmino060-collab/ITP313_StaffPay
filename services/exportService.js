import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { allSettings } from './settings.js';
import { formatDate, formatDateTime, formatTime, number } from '../utils/format.js';
import { toDateStr } from '../utils/time.js';

const NAVY = '#1e3a5f';
const MUTED = '#6b7280';
const UPLOADS = process.env.UPLOAD_DIR || path.join(process.cwd(), 'public', 'uploads');

// DejaVu Sans is bundled so PDFs can print the peso sign (₱); the built-in PDF fonts cannot.
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const HAS_FONTS = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);

function useFonts(doc) {
  if (HAS_FONTS) {
    doc.registerFont('Sans', FONT_REGULAR);
    doc.registerFont('Sans-Bold', FONT_BOLD);
  }
  return { regular: HAS_FONTS ? 'Sans' : 'Helvetica', bold: HAS_FONTS ? 'Sans-Bold' : 'Helvetica-Bold', peso: HAS_FONTS ? '₱' : 'PHP ' };
}

export async function hotelInfo() {
  const s = await allSettings();
  const logoPath = s.hotel_logo ? path.join(UPLOADS, s.hotel_logo) : null;
  return {
    name: s.hotel_name || 'StaffPay Hotel',
    address: s.hotel_address || '',
    contact: s.hotel_contact || '',
    email: s.hotel_email || '',
    logoPath: logoPath && fs.existsSync(logoPath) && /\.(png|jpe?g)$/i.test(logoPath) ? logoPath : null,
    logoUrl: s.hotel_logo ? `/uploads/${s.hotel_logo}` : null,
    currency: s.currency_symbol || '₱',
  };
}

export function formatCell(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'money') return number(value, 2);
  if (type === 'date') return formatDate(value);
  if (type === 'time') return formatDateTime(value);
  if (type === 'percent') return `${number(value, 1)}%`;
  return String(value);
}

const filename = (report, ext) => `staffpay-${report.type.replace(/_/g, '-')}-${toDateStr(new Date())}.${ext}`;

/** Collect a PDFKit document into a Buffer. */
const toBuffer = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

/** Stream a report as a PDF download. */
export async function reportPdf(res, report) {
  const hotel = await hotelInfo();
  const landscape = report.columns.length > 7;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
  const f = useFonts(doc);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename(report, 'pdf')}"`);
  doc.pipe(res);

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;

  const header = () => {
    let x = left;
    if (hotel.logoPath) { doc.image(hotel.logoPath, left, 30, { fit: [40, 40] }); x += 50; }
    doc.fillColor(NAVY).font(f.bold).fontSize(13).text(hotel.name, x, 32);
    doc.fillColor(MUTED).font(f.regular).fontSize(7.5).text([hotel.address, hotel.contact].filter(Boolean).join(' | '), x, 50);
    doc.fillColor(NAVY).font(f.bold).fontSize(11.5).text(report.title, left, 32, { width, align: 'right' });
    doc.fillColor(MUTED).font(f.regular).fontSize(7.5).text(report.subtitle, left, 48, { width, align: 'right' });
    doc.moveTo(left, 72).lineTo(left + width, 72).lineWidth(2).strokeColor(NAVY).stroke();
    return 82;
  };

  const numeric = (c) => ['money', 'number', 'percent'].includes(c.type);
  const weights = report.columns.map((c) => (numeric(c) ? 1 : c.key === 'name' || c.key === 'remarks' ? 1.8 : 1.3));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const colW = weights.map((w) => (w / totalW) * width);

  const headRow = (y) => {
    doc.rect(left, y, width, 18).fill(NAVY);
    let x = left;
    doc.fillColor('#ffffff').font(f.bold).fontSize(7);
    report.columns.forEach((c, i) => { doc.text(c.label, x + 3, y + 5, { width: colW[i] - 6, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true }); x += colW[i]; });
    return y + 18;
  };

  let y = headRow(header());
  const bottom = doc.page.height - doc.page.margins.bottom - 20;
  doc.font(f.regular).fontSize(7);

  if (!report.rows.length) {
    doc.fillColor(MUTED).text('No records found for the selected filters.', left, y + 10, { width, align: 'center' });
    y += 30;
  }
  report.rows.forEach((row, idx) => {
    if (y + 16 > bottom) { doc.addPage(); y = headRow(header()); doc.font(f.regular).fontSize(7); }
    if (idx % 2 === 1) doc.rect(left, y, width, 16).fill('#f3f4f6');
    let x = left;
    doc.fillColor('#1f2937');
    report.columns.forEach((c, i) => {
      doc.text(formatCell(row[c.key], c.type), x + 3, y + 4, { width: colW[i] - 6, align: numeric(c) ? 'right' : 'left', lineBreak: false, ellipsis: true });
      x += colW[i];
    });
    y += 16;
  });

  if (report.summary?.length) {
    if (y + 20 + report.summary.length * 13 > bottom) { doc.addPage(); y = header(); }
    y += 14;
    report.summary.forEach((s) => {
      const value = s.type === 'money' ? `${f.peso}${number(s.value, 2)}` : s.type === 'percent' ? `${number(s.value, 1)}%` : s.value;
      doc.font(f.bold).fontSize(8.5).fillColor(NAVY).text(`${s.label}:`, left, y, { continued: true })
        .font(f.regular).fillColor('#1f2937').text(`  ${value}`);
      y += 13;
    });
  }

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    doc.font(f.regular).fontSize(6.5).fillColor('#9ca3af')
      .text(`Generated by StaffPay on ${formatDateTime(report.generated_at)}  -  Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
  }
  doc.end();
}

/** Stream a report as an Excel (.xlsx) download. */
export async function reportXlsx(res, report) {
  const hotel = await hotelInfo();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'StaffPay';
  const ws = wb.addWorksheet(report.title.slice(0, 30));
  const n = report.columns.length;

  ws.mergeCells(1, 1, 1, n);
  ws.getCell(1, 1).value = hotel.name;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF1E3A5F' } };
  ws.mergeCells(2, 1, 2, n);
  ws.getCell(2, 1).value = `${report.title} - ${report.subtitle}`;
  ws.getCell(2, 1).font = { bold: true };
  ws.getCell(3, 1).value = `Generated ${formatDateTime(report.generated_at)}`;

  const head = ws.getRow(5);
  report.columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  });

  report.rows.forEach((row, r) => {
    const xr = ws.getRow(6 + r);
    report.columns.forEach((c, i) => {
      const v = row[c.key];
      const cell = xr.getCell(i + 1);
      if (['money', 'number', 'percent'].includes(c.type) && v !== null && v !== undefined && v !== '') {
        cell.value = Number(v);
        if (c.type === 'money') cell.numFmt = '"₱"#,##0.00';
        if (c.type === 'percent') cell.numFmt = '0.0"%"';
      } else {
        cell.value = formatCell(v, c.type);
      }
    });
  });

  let r = 6 + report.rows.length + 1;
  for (const s of report.summary || []) {
    ws.getCell(r, 1).value = s.label;
    ws.getCell(r, 1).font = { bold: true };
    ws.getCell(r, 2).value = s.value;
    if (s.type === 'money') ws.getCell(r, 2).numFmt = '"₱"#,##0.00';
    r++;
  }
  report.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(12, c.label.length + 4, c.key === 'name' ? 24 : 0); });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename(report, 'xlsx')}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------------------------------------------------------------- payslips

export const payslipFileName = (detail) => `payslip-${detail.employee.employee_code}-${detail.payroll.period_end}.pdf`;

/**
 * Draw one payslip. detail = plain PayrollDetail with payroll, employee (department, position),
 * earnings[], deductionLines[] and payslip.
 */
function drawPayslip(doc, detail, hotel, f) {
  const e = detail.employee;
  const p = detail.payroll;
  const m = (v) => `${f.peso}${number(v, 2)}`;
  const left = 40;
  const width = doc.page.width - 80;
  let y = 36;

  if (hotel.logoPath) { doc.image(hotel.logoPath, left + width / 2 - 25, y, { fit: [50, 50] }); y += 56; }
  doc.fillColor(NAVY).font(f.bold).fontSize(16).text(hotel.name, left, y, { width, align: 'center' });
  y = doc.y + 2;
  doc.fillColor(MUTED).font(f.regular).fontSize(8.5).text(hotel.address, left, y, { width, align: 'center' });
  doc.text(`Payroll contact: ${[hotel.contact, hotel.email].filter(Boolean).join(' | ')}`, { width, align: 'center' });
  y = doc.y + 8;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(2.5).strokeColor(NAVY).stroke();
  y += 10;
  doc.rect(left, y, width, 22).fill(NAVY);
  doc.fillColor('#fff').font(f.bold).fontSize(10.5).text('P A Y S L I P', left, y + 6, { width, align: 'center' });
  y += 32;

  const paid = p.status === 'paid' || detail.payslip?.payment_status === 'paid';
  const info = [
    ['Employee ID', e.employee_code, 'Payslip No.', detail.payslip?.payslip_no || '—'],
    ['Employee', e.full_name, 'Payroll Period', `${formatDate(p.period_start)} - ${formatDate(p.period_end)}`],
    ['Department', e.department?.name || '—', 'Pay Date', formatDate(p.pay_date)],
    ['Position', e.position?.title || '—', 'Payment Status', paid ? 'PAID' : 'UNPAID (finalized)'],
    ['Monthly Basic', m(detail.monthly_salary), 'Daily / Hourly Rate', `${m(detail.daily_rate)} / ${m(detail.hourly_rate)}`],
  ];
  doc.fontSize(8.5);
  for (const [l1, v1, l2, v2] of info) {
    doc.fillColor(MUTED).font(f.regular).text(l1, left, y);
    doc.fillColor('#111827').font(f.bold).text(String(v1), left + 80, y, { width: 175 });
    doc.fillColor(MUTED).font(f.regular).text(l2, left + 265, y);
    doc.fillColor(l2 === 'Payment Status' ? (paid ? '#0f9f6e' : '#c27c0e') : '#111827').font(f.bold).text(String(v2), left + 365, y, { width: 150 });
    y += 15;
  }
  y += 6;

  const att = [['Scheduled Days', detail.scheduled_days], ['Days Worked', detail.days_worked], ['Absence Days', detail.days_absent], ['Paid Leave', detail.paid_leave_days],
    ['Late (min)', detail.late_minutes], ['Undertime (min)', detail.undertime_minutes], ['Overtime (hrs)', detail.overtime_hours], ['Night Diff (hrs)', detail.night_diff_hours]];
  const cw = width / att.length;
  doc.rect(left, y, width, 34).fillAndStroke('#f1f5fa', '#e3e7ed');
  att.forEach(([label, value], i) => {
    doc.fillColor(MUTED).font(f.regular).fontSize(6.5).text(label, left + i * cw, y + 5, { width: cw, align: 'center' });
    doc.fillColor('#111827').font(f.bold).fontSize(9.5).text(String(value), left + i * cw, y + 17, { width: cw, align: 'center' });
  });
  y += 46;

  const colW = (width - 16) / 2;
  const table = (x, title, items, totalLabel, total) => {
    let ty = y;
    doc.rect(x, ty, colW, 20).fill('#e5e7eb');
    doc.fillColor(NAVY).font(f.bold).fontSize(8.5).text(title, x + 6, ty + 6).text('Amount', x, ty + 6, { width: colW - 6, align: 'right' });
    ty += 24;
    doc.font(f.regular).fontSize(8.5);
    if (!items.length) { doc.fillColor(MUTED).text('None', x + 6, ty); ty += 16; }
    for (const it of items) {
      doc.fillColor('#1f2937').text(it.label, x + 6, ty, { width: colW - 100 });
      if (it.quantity) doc.fillColor(MUTED).fontSize(7).text(it.quantity, x + 6, doc.y, { width: colW - 100 }).fontSize(8.5);
      const rowEnd = doc.y;
      doc.fillColor('#1f2937').text(m(it.amount), x, ty, { width: colW - 6, align: 'right' });
      ty = Math.max(rowEnd, ty + 12) + 4;
      doc.moveTo(x, ty - 2).lineTo(x + colW, ty - 2).lineWidth(0.5).strokeColor('#eef0f3').stroke();
    }
    doc.moveTo(x, ty).lineTo(x + colW, ty).lineWidth(1.5).strokeColor(NAVY).stroke();
    doc.font(f.bold).fillColor('#111827').text(totalLabel, x + 6, ty + 5).text(m(total), x, ty + 5, { width: colW - 6, align: 'right' });
    return ty + 22;
  };
  const y1 = table(left, 'Earnings', detail.earnings || [], 'Gross Salary', detail.gross_salary);
  const y2 = table(left + colW + 16, 'Deductions', detail.deductionLines || [], 'Total Deductions', detail.total_deductions);
  y = Math.max(y1, y2) + 8;

  doc.rect(left, y, width, 46).lineWidth(2).fillAndStroke('#eef2f7', NAVY);
  doc.fillColor(NAVY).font(f.bold).fontSize(11).text('NET SALARY', left + 12, y + 10);
  doc.fillColor(MUTED).font(f.regular).fontSize(8).text(`Gross ${m(detail.gross_salary)} - Deductions ${m(detail.total_deductions)}`, left + 12, y + 27);
  doc.fillColor(NAVY).font(f.bold).fontSize(17).text(m(detail.net_salary), left, y + 13, { width: width - 12, align: 'right' });
  y += 58;

  if (detail.adjustment_notes) {
    doc.fillColor(MUTED).font(f.regular).fontSize(8.5).text(`Notes: ${detail.adjustment_notes}`, left, y, { width });
    y = doc.y + 8;
  }

  y += 30;
  const sw = width / 2;
  ['Prepared by (HR / Payroll)', `Received by (${e.full_name})`].forEach((label, i) => {
    const x = left + i * sw;
    doc.moveTo(x + 30, y).lineTo(x + sw - 30, y).lineWidth(0.8).strokeColor('#374151').stroke();
    doc.fillColor('#374151').font(f.regular).fontSize(8.5).text(label, x, y + 5, { width: sw, align: 'center' });
  });
  doc.fillColor('#9ca3af').fontSize(7).text(`System-generated payslip from StaffPay. Generated ${formatDate(new Date())} ${formatTime(new Date())}.`,
    left, y + 36, { width, align: 'center' });
}

async function newPayslipDoc(details) {
  const hotel = await hotelInfo();
  const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: false, info: { Title: 'Payslip', Author: hotel.name } });
  const f = useFonts(doc);
  for (const d of details) {
    doc.addPage();
    drawPayslip(doc, d, hotel, f);
  }
  return doc;
}

/** Stream one payslip PDF. */
export async function payslipPdf(res, detail) {
  const doc = await newPayslipDoc([detail]);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${payslipFileName(detail)}"`);
  doc.pipe(res);
  doc.end();
}

/** One payslip as a Buffer. */
export async function payslipBuffer(detail) {
  const doc = await newPayslipDoc([detail]);
  const done = toBuffer(doc);
  doc.end();
  return done;
}

/** ZIP archive (Buffer) with one PDF payslip per employee. */
export async function payslipsZip(details, folder = 'payslips') {
  const zip = new JSZip();
  const dir = zip.folder(folder);
  for (const d of details) dir.file(payslipFileName(d), await payslipBuffer(d));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
