import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base, decimal, json } from './types.js';

export const Department = sequelize.define('Department', {
  name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  code: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  description: { type: DataTypes.TEXT, allowNull: true },
}, base('departments'));

export const Position = sequelize.define('Position', {
  department_id: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING(100), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  default_salary: decimal('default_salary'),
}, base('positions', { indexes: [{ unique: true, fields: ['department_id', 'title'] }] }));

const fmtClock = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export const Shift = sequelize.define('Shift', {
  name: { type: DataTypes.STRING(60), allowNull: false, unique: true },
  start_time: { type: DataTypes.STRING(8), allowNull: false }, // HH:MM:SS
  end_time: { type: DataTypes.STRING(8), allowNull: false },
  break_minutes: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  color: { type: DataTypes.STRING(20), allowNull: false, defaultValue: '#1e3a5f' },
  description: { type: DataTypes.TEXT, allowNull: true },
  is_overnight: {
    type: DataTypes.VIRTUAL,
    get() {
      const s = this.getDataValue('start_time'); const e = this.getDataValue('end_time');
      return s && e ? e.slice(0, 5) <= s.slice(0, 5) : null;
    },
  },
  duration_minutes: {
    type: DataTypes.VIRTUAL,
    get() {
      const s = this.getDataValue('start_time'); const e = this.getDataValue('end_time');
      if (!s || !e) return null;
      const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      let d = toMin(e) - toMin(s);
      if (d <= 0) d += 1440;
      return d;
    },
  },
  label: {
    type: DataTypes.VIRTUAL,
    get() {
      const s = this.getDataValue('start_time'); const e = this.getDataValue('end_time');
      return s && e ? `${this.getDataValue('name')} (${fmtClock(s)} - ${fmtClock(e)})` : this.getDataValue('name');
    },
  },
}, base('shifts'));

export const EMPLOYMENT_STATUSES = ['active', 'probationary', 'on_leave', 'resigned', 'terminated'];
export const ACTIVE_STATUSES = ['active', 'probationary', 'on_leave'];
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractual', 'seasonal'];

export const Employee = sequelize.define('Employee', {
  user_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
  employee_code: { type: DataTypes.STRING(30), allowNull: false, unique: true },
  first_name: { type: DataTypes.STRING(80), allowNull: false },
  middle_name: { type: DataTypes.STRING(80), allowNull: true },
  last_name: { type: DataTypes.STRING(80), allowNull: false },
  photo_path: { type: DataTypes.STRING, allowNull: true },
  gender: { type: DataTypes.ENUM('male', 'female', 'other'), allowNull: true },
  birth_date: { type: DataTypes.DATEONLY, allowNull: true },
  contact_number: { type: DataTypes.STRING(30), allowNull: true },
  email: { type: DataTypes.STRING(150), allowNull: true, unique: true },
  address: { type: DataTypes.TEXT, allowNull: true },
  department_id: { type: DataTypes.INTEGER, allowNull: true },
  position_id: { type: DataTypes.INTEGER, allowNull: true },
  employment_status: { type: DataTypes.ENUM(...EMPLOYMENT_STATUSES), allowNull: false, defaultValue: 'active' },
  employment_type: { type: DataTypes.ENUM(...EMPLOYMENT_TYPES), allowNull: false, defaultValue: 'full_time' },
  date_hired: { type: DataTypes.DATEONLY, allowNull: false },
  basic_salary: decimal('basic_salary'), // monthly
  full_name: {
    type: DataTypes.VIRTUAL,
    get() {
      const m = this.getDataValue('middle_name');
      return [this.getDataValue('first_name'), m ? `${m[0]}.` : null, this.getDataValue('last_name')].filter(Boolean).join(' ');
    },
  },
  photo_url: {
    type: DataTypes.VIRTUAL,
    get() {
      const p = this.getDataValue('photo_path');
      return p ? `/uploads/${p}` : null;
    },
  },
}, base('employees', { indexes: [{ fields: ['last_name', 'first_name'] }] }));

export const DAY_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

export const WorkSchedule = sequelize.define('WorkSchedule', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  shift_id: { type: DataTypes.INTEGER, allowNull: false },
  working_days: json('working_days', []), // ISO weekdays 1 = Mon ... 7 = Sun
  effective_from: { type: DataTypes.DATEONLY, allowNull: false },
  effective_to: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  created_by: { type: DataTypes.INTEGER, allowNull: true },
  rest_days: {
    type: DataTypes.VIRTUAL,
    get() {
      const w = (this.working_days || []).map(Number);
      return [1, 2, 3, 4, 5, 6, 7].filter((d) => !w.includes(d));
    },
  },
}, base('work_schedules', { indexes: [{ fields: ['employee_id', 'effective_from'] }] }));
