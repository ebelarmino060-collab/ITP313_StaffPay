import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base, decimal } from './types.js';

export const LEAVE_TYPES = ['vacation', 'sick', 'emergency', 'unpaid'];
export const PAID_LEAVE_TYPES = ['vacation', 'sick', 'emergency'];

export const LeaveRequest = sequelize.define('LeaveRequest', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  leave_type: { type: DataTypes.ENUM(...LEAVE_TYPES), allowNull: false },
  start_date: { type: DataTypes.DATEONLY, allowNull: false },
  end_date: { type: DataTypes.DATEONLY, allowNull: false },
  days: decimal('days', 5, 1),
  reason: { type: DataTypes.TEXT, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'approved', 'rejected', 'cancelled'), allowNull: false, defaultValue: 'pending' },
  reviewed_by: { type: DataTypes.INTEGER, allowNull: true },
  reviewed_at: { type: DataTypes.DATE, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  is_paid: {
    type: DataTypes.VIRTUAL,
    get() { return PAID_LEAVE_TYPES.includes(this.getDataValue('leave_type')); },
  },
}, base('leave_requests', { indexes: [{ fields: ['status', 'start_date'] }] }));

export const LeaveBalance = sequelize.define('LeaveBalance', {
  employee_id: { type: DataTypes.INTEGER, allowNull: false },
  year: { type: DataTypes.INTEGER, allowNull: false },
  leave_type: { type: DataTypes.ENUM(...PAID_LEAVE_TYPES), allowNull: false },
  allocated: decimal('allocated', 5, 1),
  used: decimal('used', 5, 1),
  remaining: {
    type: DataTypes.VIRTUAL,
    get() { return Math.round((Number(this.getDataValue('allocated')) - Number(this.getDataValue('used'))) * 10) / 10; },
  },
}, base('leave_balances', { indexes: [{ unique: true, fields: ['employee_id', 'year', 'leave_type'] }] }));
