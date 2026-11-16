/*
 * Load StaffPay sample data:  node seed.js   (run `node migrate.js --fresh --yes` first)
 */
import './config.js';
import { sequelize, User } from './models/index.js';
import { runSeeder } from './database/seeder.js';

try {
  await sequelize.authenticate();
  if (await User.count()) {
    console.error('❌ The database already has data. Run `npm run setup` to reset it and reseed.');
    process.exitCode = 1;
  } else {
    console.log('🌱 Seeding StaffPay sample data…');
    await runSeeder();
    console.log('✅ Done. Sign in with admin@staffpay.com / Admin@123');
  }
} catch (err) {
  console.error('❌ Seeding failed:', err);
  process.exitCode = 1;
} finally {
  await sequelize.close().catch(() => {});
}
