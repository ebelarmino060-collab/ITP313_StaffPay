/*
    MIT License

    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */

/*
 * StaffPay – Hotel Staff Attendance & Payroll Management System, built on XianFire.
 */
import './config.js';
import express from "express";
import path from "path";
import session from "express-session";
import flash from "connect-flash";
import fs from 'fs';
import hbs from "hbs";
import { fileURLToPath, pathToFileURL } from "url";
import { dirname } from "path";
import { config } from './config.js';
import router from "./routes/index.js";
import { sequelize } from './models/index.js';
import { registerHelpers } from './utils/viewHelpers.js';
import { loadUser, wantsJson } from './middleware/auth.js';
import { csrf } from './middleware/csrf.js';
import { AppError } from './utils/errors.js';
import { back } from './utils/respond.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = config.port;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: config.env === 'production' ? '1d' : 0 }));
app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));

// Basic security headers.
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});

app.use(session({
  name: 'staffpay.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 10 },
}));
app.use(flash());

// XianFire ".xian" view engine (Handlebars).
app.engine("xian", async (filePath, options, callback) => {
  try {
    const originalPartialsDir = hbs.partialsDir;
    hbs.partialsDir = path.join(__dirname, 'views');

    const result = await new Promise((resolve, reject) => {
      hbs.__express(filePath, options, (err, html) => {
        if (err) return reject(err);
        resolve(html);
      });
    });

    hbs.partialsDir = originalPartialsDir;
    callback(null, result);
  } catch (err) {
    callback(err);
  }
});
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "xian");

registerHelpers(hbs);

// Register every views/partials/**/*.xian file as a partial ("sidebar", "attendance/modal", ...).
const partialsDir = path.join(__dirname, "views/partials");
const registerPartials = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) registerPartials(full, `${prefix}${entry.name}/`);
    else if (entry.name.endsWith('.xian')) hbs.registerPartial(`${prefix}${entry.name.replace('.xian', '')}`, fs.readFileSync(full, 'utf8'));
  }
};
registerPartials(partialsDir);

app.use((req, res, next) => {
  res.locals.success_msg = req.flash("success_msg");
  res.locals.error_msg = req.flash("error_msg");
  res.locals.formState = req.flash("form")[0] || null;
  next();
});
app.use(csrf);
app.use(loadUser);

app.use("/", router);

// 404
app.use((req, res) => {
  if (wantsJson(req)) return res.status(404).json({ message: 'Not found.' });
  res.status(404).render('errors/error', { title: 'Page not found', code: 404, message: 'The page you are looking for does not exist.' });
});

// Errors: user-facing AppErrors become flash messages (or JSON); anything else is a 500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const known = err instanceof AppError;
  const status = known ? err.status : 500;
  if (!known) console.error(err);
  const message = known ? err.message : 'Something went wrong. Please try again.';

  if (wantsJson(req)) return res.status(status).json({ message, errors: err.fields || undefined });
  if (known && status !== 403 && status !== 404 && req.method !== 'GET') {
    req.flash('error_msg', message);
    return res.redirect(back(req));
  }
  return res.status(status).render('errors/error', { title: known ? 'Request failed' : 'Server error', code: status, message });
});

export default app;

// Start the HTTP server; resolves once the server is listening.
// Exported so the Electron main process can control startup itself.
export const startServer = async (port = PORT) => {
  try {
    await sequelize.authenticate();
  } catch (err) {
    console.error(`❌ Cannot connect to the ${config.db.dialect} database "${config.db.name}": ${err.message}`);
    console.error('   Start MySQL, check the DB_* values in .env, then run: npm run setup');
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`🔥 StaffPay (XianFire) running at http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
};

// Auto-start only when executed directly (node index.js).
// When imported by electron/main.js, Electron manages the server lifecycle.
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun && !process.env.XIAN_ELECTRON) {
  startServer();
}
