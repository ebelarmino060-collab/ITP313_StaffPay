/*
 * StaffPay configuration. Values come from environment variables or the .env file.
 * Import this module first: it also sets the process timezone used for attendance.
 */
try {
  process.loadEnvFile?.(new URL('./.env', import.meta.url));
} catch {
  // no .env file: rely on real environment variables / defaults
}

process.env.TZ = process.env.APP_TIMEZONE || 'Asia/Manila';

export const config = {
  appName: 'StaffPay',
  port: Number(process.env.PORT || 3000),
  env: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'change-this-staffpay-secret',
  timezone: process.env.TZ,
  db: {
    dialect: process.env.DB_DIALECT || 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    name: process.env.DB_NAME || 'staffpay',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    storage: process.env.DB_STORAGE || ':memory:', // sqlite only (tests)
    logging: process.env.DB_LOGGING === 'true',
  },
}
