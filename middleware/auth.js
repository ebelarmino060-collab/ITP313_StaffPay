import { Department, Employee, Notification, Position, User, plain } from '../models/index.js';
import { allSettings } from '../services/settings.js';
import { OPTIONS, ROLE_LABELS } from '../utils/constants.js';
import { wrap } from '../utils/errors.js';
import { today } from '../utils/time.js';

/** Sidebar menu: `roles` limits who sees an item; `employeeOnly` needs a linked employee record. */
const NAV = [
  { title: 'Overview', items: [{ href: '/', label: 'Dashboard', icon: 'layout-dashboard', exact: true }] },
  {
    title: 'Management', roles: ['admin', 'hr'], items: [
      { href: '/employees', label: 'Employees', icon: 'users' },
      { href: '/attendance', label: 'Attendance', icon: 'clock', exclude: ['/attendance/import', '/attendance/analytics'] },
      { href: '/attendance/import', label: 'Import Attendance', icon: 'upload' },
      { href: '/attendance/analytics', label: 'Attendance Analytics', icon: 'trending-up' },
      { href: '/payroll', label: 'Payroll', icon: 'wallet' },
      { href: '/payslips', label: 'Payslips', icon: 'receipt' },
      { href: '/reports', label: 'Reports', icon: 'chart-column' },
    ],
  },
  {
    title: 'Workforce', roles: ['admin', 'hr'], items: [
      { href: '/schedules', label: 'Schedules & Shifts', icon: 'calendar-days' },
      { href: '/leaves', label: 'Leave Management', icon: 'plane-takeoff' },
      { href: '/organization', label: 'Departments & Positions', icon: 'building-2', roles: ['admin'] },
    ],
  },
  {
    title: 'My Workspace', employeeOnly: true, items: [
      { href: '/my/attendance', label: 'Time Clock & Attendance', icon: 'fingerprint' },
      { href: '/my/schedule', label: 'My Schedule', icon: 'calendar-clock' },
      { href: '/my/leaves', label: 'My Leave Requests', icon: 'plane-takeoff' },
      { href: '/my/payslips', label: 'My Payslips', icon: 'receipt' },
    ],
  },
  {
    title: 'System', roles: ['admin'], items: [
      { href: '/users', label: 'User Management', icon: 'user-cog' },
      { href: '/settings', label: 'Settings', icon: 'settings' },
      { href: '/audit-logs', label: 'Audit Logs', icon: 'history' },
    ],
  },
  { title: 'Account', items: [{ href: '/profile', label: 'My Profile', icon: 'circle-user' }] },
];

function buildNav(user, path) {
  return NAV
    .filter((s) => (!s.roles || s.roles.includes(user.role)) && (!s.employeeOnly || user.employee))
    .map((s) => ({
      title: s.title,
      items: s.items.filter((i) => !i.roles || i.roles.includes(user.role)).map((i) => ({
        ...i,
        active: i.exact ? path === i.href
          : (path === i.href || path.startsWith(`${i.href}/`)) && !(i.exclude || []).some((x) => path === x || path.startsWith(`${x}/`)),
      })),
    }))
    .filter((s) => s.items.length);
}

export const wantsJson = (req) => req.xhr || (req.get('accept') || '').includes('application/json') || req.path.endsWith('.json');

/** Loads the logged-in user (if any) and shared view data. */
export const loadUser = wrap(async (req, res, next) => {
  const s = await allSettings();
  res.locals.opts = OPTIONS;
  res.locals.hotel = { name: s.hotel_name, logoUrl: s.hotel_logo ? `/uploads/${s.hotel_logo}` : null, currency: s.currency_symbol };
  res.locals.currentPath = req.path;
  res.locals.today = today();

  if (req.session.userId) {
    const user = await User.findByPk(req.session.userId, {
      include: [{ model: Employee, as: 'employee', include: [{ model: Department, as: 'department' }, { model: Position, as: 'position' }] }],
    });
    if (!user || !user.is_active) {
      delete req.session.userId;
    } else {
      req.user = user;
      const me = plain(user);
      res.locals.me = {
        ...me,
        roleLabel: ROLE_LABELS[me.role],
        isAdmin: me.role === 'admin',
        isHr: me.role === 'hr',
        isManagement: ['admin', 'hr'].includes(me.role),
        hasEmployee: Boolean(me.employee),
      };
      res.locals.nav = buildNav(me, req.path);
      res.locals.unreadCount = await Notification.count({ where: { user_id: user.id, read_at: null } });
    }
  }
  next();
});

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ message: 'Your session has ended. Please sign in again.' });
  req.flash('error_msg', 'Please sign in to continue.');
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

export const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) return next();
  if (wantsJson(req)) return res.status(403).json({ message: 'You are not authorized to perform this action.' });
  return res.status(403).render('errors/error', { title: 'Access denied', code: 403, message: 'Your account does not have permission to open this page.' });
};

export function requireEmployee(req, res, next) {
  if (req.user?.employee) return next();
  if (wantsJson(req)) return res.status(403).json({ message: 'No employee profile is linked to your account.' });
  return res.status(403).render('errors/error', {
    title: 'No employee profile', code: 403, message: 'Your account is not linked to an employee record. Ask the administrator to link it.',
  });
}
