/*
 * Test helpers: boot StaffPay on an in-memory SQLite database and drive it with supertest.
 */
process.env.DB_DIALECT = 'sqlite';
process.env.DB_STORAGE = ':memory:';
process.env.NODE_ENV = 'test';
// Keep test uploads out of public/uploads.
const os = await import('os');
const path = await import('path');
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'staffpay-test-uploads');

const { default: request } = await import('supertest');
const { default: app } = await import('../index.js');
const models = await import('../models/index.js');
const { seedSettings, flushSettings } = await import('../services/settings.js');
const { ensureBalances } = await import('../services/leaveService.js');
const bcrypt = (await import('bcryptjs')).default;

export { app, request, models };

/** Fresh schema + settings + a morning shift, admin, HR and two employees (Mon-Sat schedule). */
export async function resetDatabase() {
  await models.sequelize.sync({ force: true });
  flushSettings();
  await seedSettings();
  const shift = await models.Shift.create({ name: 'Morning Shift', start_time: '06:00:00', end_time: '14:00:00' });
  const hash = (p) => bcrypt.hashSync(p, 4);
  const admin = await models.User.create({ name: 'Admin', email: 'admin@test.com', password: hash('Admin@123'), role: 'admin' });
  const hr = await models.User.create({ name: 'HR Officer', email: 'hr@test.com', password: hash('Hr@12345'), role: 'hr' });
  const mariaUser = await models.User.create({ name: 'Maria Santos', email: 'maria@test.com', password: hash('Staff@123'), role: 'employee' });
  const joseUser = await models.User.create({ name: 'Jose Cruz', email: 'jose@test.com', password: hash('Staff@123'), role: 'employee' });

  const make = (code, first, last, salary, user) => models.Employee.create({
    user_id: user.id, employee_code: code, first_name: first, last_name: last, email: user.email,
    employment_status: 'active', employment_type: 'full_time', date_hired: '2025-01-01', basic_salary: salary,
  });
  const maria = await make('EMP-0001', 'Maria', 'Santos', 22000, mariaUser);
  const jose = await make('EMP-0002', 'Jose', 'Cruz', 18000, joseUser);
  for (const e of [maria, jose]) {
    await models.WorkSchedule.create({ employee_id: e.id, shift_id: shift.id, working_days: [1, 2, 3, 4, 5, 6], effective_from: '2026-01-01' });
    await ensureBalances(e.id, 2026);
  }
  return { shift, admin, hr, mariaUser, joseUser, maria, jose };
}

const csrfFrom = (html) => /name="csrf-token" content="([^"]+)"/.exec(html)?.[1] || /name="_csrf" value="([^"]+)"/.exec(html)?.[1];

/** A logged-in supertest agent with a `csrf` token for POSTs. */
export async function loginAs(email, password) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(page.text), email, password });
  const after = await agent.get('/profile');
  agent.csrf = csrfFrom(after.text);
  agent.loginResponse = res;
  /** POST a urlencoded form with the CSRF token. */
  agent.form = (url, data = {}) => agent.post(url).type('form').send({ _csrf: agent.csrf, ...data });
  /** Flash messages shown on the page after a redirect. */
  agent.flash = async () => {
    const html = (await agent.get('/profile')).text;
    return [...html.matchAll(/class="toast toast-(success|error)"[^>]*>.*?<span>([^<]*)<\/span>/gs)].map((m) => `${m[1]}: ${m[2]}`);
  };
  return agent;
}

export const login = {
  admin: () => loginAs('admin@test.com', 'Admin@123'),
  hr: () => loginAs('hr@test.com', 'Hr@12345'),
  maria: () => loginAs('maria@test.com', 'Staff@123'),
  jose: () => loginAs('jose@test.com', 'Staff@123'),
};

/** Local Manila time. */
export const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
