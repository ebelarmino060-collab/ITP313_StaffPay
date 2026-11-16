import crypto from 'crypto';
import { AppError } from '../utils/errors.js';

/** Issue a per-session CSRF token and verify it on state-changing requests. */
export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) return next(); // verified by verifyCsrf after multer parses the body
  return verifyCsrf(req, res, next);
}

export function verifyCsrf(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  if (token && token === req.session.csrf) return next();
  return next(new AppError('Your session expired or the form was invalid. Please try again.', 419));
}
