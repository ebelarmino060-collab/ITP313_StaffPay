/*
 * XianFire migration for StaffPay.
 *   node migrate.js            -> create the database (asks), then create missing tables
 *   node migrate.js --fresh    -> DROP and recreate every table (asks for confirmation)
 *   node migrate.js --fresh --yes   -> same, no prompts (used by `npm run setup`)
 */
import './config.js';
import { Sequelize } from 'sequelize';
import inquirer from 'inquirer';
import { config } from './config.js';
import { sequelize } from './models/index.js';

const fresh = process.argv.includes('--fresh');
const yes = process.argv.includes('--yes');
const { db } = config;

async function ask(message, def = true) {
  if (yes) return true;
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message, default: def }]);
  return ok;
}

try {
  if (db.dialect === 'mysql') {
    if (await ask(`Create database '${db.name}' if it does not exist?`)) {
      const root = new Sequelize('', db.user, db.password, { host: db.host, port: db.port, dialect: 'mysql', logging: false });
      await root.query(`CREATE DATABASE IF NOT EXISTS \`${db.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      await root.close();
      console.log(`✅ Database '${db.name}' is ready`);
    }
  }

  await sequelize.authenticate();
  console.log(`✅ Connected to ${db.dialect} database`);

  if (fresh) {
    if (!(await ask('This DROPS all StaffPay tables and data. Continue?', false))) {
      console.log('Cancelled.');
      process.exit(0);
    }
    if (db.dialect === 'mysql') await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    await sequelize.sync({ force: true });
    if (db.dialect === 'mysql') await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('✅ All tables dropped and recreated');
  } else {
    await sequelize.sync();
    console.log('✅ Tables created for all models (existing tables kept)');
  }
  console.log('   Next: npm run seed   (sample data and demo accounts)');
} catch (err) {
  console.error('❌ Migration failed:', err.message);
  if (db.dialect === 'mysql') console.error('   Is MySQL running and are DB_HOST / DB_USER / DB_PASSWORD in .env correct?');
  process.exitCode = 1;
} finally {
  await sequelize.close().catch(() => {});
}
