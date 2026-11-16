import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base, json } from './types.js';

export const SystemSetting = sequelize.define('SystemSetting', {
  key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  value: { type: DataTypes.TEXT, allowNull: true },
  group: { type: DataTypes.STRING(50), allowNull: false, defaultValue: 'general' },
  type: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'string' }, // string | number | boolean
  label: { type: DataTypes.STRING, allowNull: true },
}, base('system_settings'));

export const AuditLog = sequelize.define('AuditLog', {
  user_id: { type: DataTypes.INTEGER, allowNull: true },
  action: { type: DataTypes.STRING(60), allowNull: false },
  entity_type: { type: DataTypes.STRING(60), allowNull: true },
  entity_id: { type: DataTypes.INTEGER, allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: false },
  changes: json('changes'),
  ip_address: { type: DataTypes.STRING(45), allowNull: true },
}, base('audit_logs', { updatedAt: false, indexes: [{ fields: ['entity_type', 'entity_id'] }] }));

export const Notification = sequelize.define('Notification', {
  user_id: { type: DataTypes.INTEGER, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'info' },
  link: { type: DataTypes.STRING, allowNull: true },
  read_at: { type: DataTypes.DATE, allowNull: true },
}, base('user_notifications', { indexes: [{ fields: ['user_id', 'read_at'] }] }));
