/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
import bcrypt from 'bcryptjs';
import { User } from '../models/index.js';
import { audit } from '../services/audit.js';
import { wrap } from '../utils/errors.js';

const DEMO_ACCOUNTS = [
  { role: 'Administrator', email: 'admin@staffpay.com', password: 'Admin@123' },
  { role: 'HR / Payroll', email: 'hr@staffpay.com', password: 'Hr@12345' },
  { role: 'Employee', email: 'employee@staffpay.com', password: 'Staff@123' },
];

export const loginPage = (req, res) => {
  if (req.user) return res.redirect('/');
  return res.render('auth/login', { title: 'Sign in', layout: 'layouts/auth', next: req.query.next || '', demo: DEMO_ACCOUNTS, email: req.flash('email')[0] || '' });
};

export const loginUser = wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/';
  const failBack = (msg) => {
    req.flash('error_msg', msg);
    req.flash('email', email);
    return res.redirect(`/login${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`);
  };

  if (!email || !password) return failBack('Please enter your email and password.');
  const user = await User.scope('withPassword').findOne({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) return failBack('These credentials do not match our records.');
  if (!user.is_active) return failBack('Your account has been deactivated. Please contact the administrator.');

  // New session id on login (prevents session fixation).
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.id;
  await user.update({ last_login_at: new Date() });
  req.user = user;
  await audit(req, 'login', `${user.name} signed in`, user);
  req.flash('success_msg', `Welcome back, ${user.name.split(' ')[0]}!`);
  return res.redirect(next);
});

export const logoutUser = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('staffpay.sid');
    res.redirect('/login');
  });
};
