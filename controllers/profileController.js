import bcrypt from 'bcryptjs';
import { LeaveBalance, User, plain } from '../models/index.js';
import { audit } from '../services/audit.js';
import { ensureBalances } from '../services/leaveService.js';
import { ScheduleService } from '../services/scheduleService.js';
import { removeUpload, storedPath } from '../middleware/upload.js';
import { validate } from '../utils/validate.js';
import { wrap, AppError } from '../utils/errors.js';
import { done, invalid } from '../utils/respond.js';
import { today } from '../utils/time.js';

export const show = wrap(async (req, res) => {
  const employee = req.user.employee;
  let schedule = null;
  let balances = [];
  if (employee) {
    const year = new Date().getFullYear();
    await ensureBalances(employee.id, year);
    balances = plain(await LeaveBalance.findAll({ where: { employee_id: employee.id, year } }));
    const s = await new ScheduleService().scheduleOn(employee.id, today());
    schedule = s ? plain(s) : null;
  }
  res.render('profile', { title: 'My Profile', employee: employee ? plain(employee) : null, schedule, balances });
});

export const update = wrap(async (req, res) => {
  const employee = req.user.employee;
  const { data, errors } = validate(req.body, { name: 'nullable|string|max:120', contact_number: 'nullable|phone', address: 'nullable|string|max:500' });
  if (!employee && !data.name) errors.name = 'Name is required.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { to: '/profile' });
  if (employee) await employee.update({ contact_number: data.contact_number, address: data.address });
  else await req.user.update({ name: data.name });
  return done(req, res, 'Profile updated.', '/profile');
});

export const photo = wrap(async (req, res) => {
  const employee = req.user.employee;
  if (!employee) throw new AppError('Only employees can upload a profile photo.');
  if (!req.file) throw new AppError('Choose an image to upload.');
  removeUpload(employee.photo_path);
  await employee.update({ photo_path: storedPath(req.file, 'photos') });
  return done(req, res, 'Photo updated.', '/profile');
});

export const password = wrap(async (req, res) => {
  const { data, errors } = validate(req.body, { current_password: 'required|string', password: 'required|string|min:8', password_confirmation: 'required|string' },
    { current_password: 'Current password', password: 'New password', password_confirmation: 'Password confirmation' });
  if (!errors.password && data.password !== data.password_confirmation) errors.password_confirmation = 'The password confirmation does not match.';
  const user = await User.scope('withPassword').findByPk(req.user.id);
  if (!errors.current_password && !(await bcrypt.compare(data.current_password, user.password))) errors.current_password = 'The current password is incorrect.';
  if (Object.keys(errors).length) return invalid(req, res, errors, { to: '/profile#password' });
  await user.update({ password: await bcrypt.hash(data.password, 10) });
  await audit(req, 'password_change', `${user.name} changed their password`, user);
  return done(req, res, 'Password changed successfully.', '/profile');
});
