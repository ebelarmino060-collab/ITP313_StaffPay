import { REPORT_TYPES, generateReport } from '../services/reportService.js';
import { reportPdf, reportXlsx } from '../services/exportService.js';
import { audit } from '../services/audit.js';
import { wrap, AppError } from '../utils/errors.js';
import { addDays, endOfMonth, parseDate, startOfMonth, startOfWeek, toDateStr, today } from '../utils/time.js';
import { lookups, qs } from './shared.js';

const PRESETS = [
  { value: 'today', label: 'Daily (today)' },
  { value: 'week', label: 'Weekly (this week)' },
  { value: 'month', label: 'Monthly (this month)' },
  { value: 'last_month', label: 'Last month' },
  { value: 'custom', label: 'Custom range' },
];

function rangeFor(preset) {
  const now = new Date();
  switch (preset) {
    case 'today': return { from: today(), to: today() };
    case 'week': { const s = startOfWeek(now); return { from: toDateStr(s), to: toDateStr(addDays(s, 6)) }; }
    case 'last_month': { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); return { from: toDateStr(s), to: toDateStr(endOfMonth(s)) }; }
    default: return { from: toDateStr(startOfMonth(now)), to: toDateStr(endOfMonth(now)) };
  }
}

/** Normalise report filters from the query string. */
function filtersFrom(query) {
  const type = REPORT_TYPES[query.type] ? query.type : 'attendance';
  const preset = PRESETS.some((p) => p.value === query.preset) ? query.preset : (query.from || query.to ? 'custom' : 'month');
  let { from, to } = preset === 'custom' ? { from: query.from, to: query.to } : rangeFor(preset);
  from = parseDate(from) ? toDateStr(from) : rangeFor('month').from;
  to = parseDate(to) ? toDateStr(to) : rangeFor('month').to;
  if (to < from) [from, to] = [to, from];
  return {
    type, preset, from, to,
    year: Number(query.year) || new Date().getFullYear(),
    department_id: query.department_id || '',
    employee_id: query.employee_id || '',
    status: query.status || '',
  };
}

export const index = wrap(async (req, res) => {
  const f = filtersFrom(req.query);
  const report = await generateReport(f.type, f);
  const base = { preset: f.preset, from: f.from, to: f.to, year: f.year, department_id: f.department_id, employee_id: f.employee_id };
  const y = new Date().getFullYear();
  res.render('reports', {
    title: 'Reports & Analytics',
    useCharts: true,
    report,
    filters: f,
    isAnnual: f.type === 'payroll_annual',
    presets: PRESETS,
    years: [y - 3, y - 2, y - 1, y, y + 1].map((v) => ({ value: v, label: `Year ${v}` })),
    types: Object.entries(REPORT_TYPES).map(([key, t]) => ({ ...t, key, active: key === f.type, url: `/reports?${qs({ ...base, type: key })}` })),
    exportPdf: `/reports/export?${qs({ ...base, type: f.type, format: 'pdf' })}`,
    exportXlsx: `/reports/export?${qs({ ...base, type: f.type, format: 'xlsx' })}`,
    ...(await lookups({ allEmployees: true })),
  });
});

export const exportReport = wrap(async (req, res) => {
  const format = req.query.format;
  if (!['pdf', 'xlsx'].includes(format)) throw new AppError('Choose PDF or Excel.', 422);
  const f = filtersFrom(req.query);
  const report = await generateReport(f.type, f);
  await audit(req, 'report_export', `Exported ${report.title} (${report.subtitle}) as ${format.toUpperCase()}`);
  return format === 'pdf' ? reportPdf(res, report) : reportXlsx(res, report);
});
