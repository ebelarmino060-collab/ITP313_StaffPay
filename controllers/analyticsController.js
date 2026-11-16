import { analyticsReport, attendanceAnalytics } from '../services/analyticsService.js';
import { reportPdf, reportXlsx } from '../services/exportService.js';
import { audit } from '../services/audit.js';
import { wrap, AppError } from '../utils/errors.js';
import { addDaysStr, toDateStr } from '../utils/time.js';
import { lookups, qs } from './shared.js';

const VIEWS = ['weekly', 'monthly', 'yearly', 'custom'];

export const index = wrap(async (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'monthly';
  const result = await attendanceAnalytics(view, req.query);
  const r = result.range;
  const filters = { department_id: req.query.department_id || '', employee_id: req.query.employee_id || '' };

  // Previous / next period links.
  let prev; let next;
  if (view === 'weekly') { prev = { date: addDaysStr(r.from, -7) }; next = { date: addDaysStr(r.from, 7) }; }
  else if (view === 'yearly') { prev = { year: r.year - 1 }; next = { year: r.year + 1 }; }
  else if (view === 'monthly') {
    const [y, m] = r.month.split('-').map(Number);
    prev = { month: toDateStr(new Date(y, m - 2, 1)).slice(0, 7) };
    next = { month: toDateStr(new Date(y, m, 1)).slice(0, 7) };
  }
  const link = (extra) => `/attendance/analytics?${qs({ view, ...filters, ...extra })}`;
  const current = view === 'weekly' ? { date: r.from } : view === 'yearly' ? { year: r.year } : view === 'monthly' ? { month: r.month } : { from: r.from, to: r.to };
  const y = new Date().getFullYear();

  res.render('attendance/analytics', {
    title: 'Attendance Analytics',
    tab: 'analytics',
    useCharts: true,
    view,
    result: { ...result, empMap: undefined },
    views: VIEWS.map((v) => ({ key: v, label: v === 'custom' ? 'Custom range' : v[0].toUpperCase() + v.slice(1), url: `/attendance/analytics?${qs({ view: v, ...filters })}`, active: v === view })),
    prevUrl: prev ? link(prev) : null,
    nextUrl: next ? link(next) : null,
    filters: { ...filters, ...req.query, from: r.from, to: r.to, month: r.month, year: r.year, date: r.from },
    years: [y - 3, y - 2, y - 1, y].map((v) => ({ value: v, label: v })),
    exportLinks: ['period', 'employees', 'departments'].map((table) => ({
      table,
      title: result.tables[table].title,
      pdf: `/attendance/analytics/export?${qs({ view, ...filters, ...current, table, format: 'pdf' })}`,
      xlsx: `/attendance/analytics/export?${qs({ view, ...filters, ...current, table, format: 'xlsx' })}`,
    })),
    ...(await lookups({ employees: true })),
  });
});

export const exportAnalytics = wrap(async (req, res) => {
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'monthly';
  const format = req.query.format;
  if (!['pdf', 'xlsx'].includes(format)) throw new AppError('Choose PDF or Excel.');
  const result = await attendanceAnalytics(view, req.query);
  const report = analyticsReport(result, req.query.table);
  await audit(req, 'report_export', `Exported ${report.title} (${report.subtitle}) as ${format.toUpperCase()}`);
  return format === 'pdf' ? reportPdf(res, report) : reportXlsx(res, report);
});
