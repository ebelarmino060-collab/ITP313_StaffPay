/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
import { DataTypes } from 'sequelize';
import { sequelize } from './db.js';
import { base } from './types.js';

export const ROLES = ['admin', 'hr', 'employee'];

export const User = sequelize.define('User', {
  name: { type: DataTypes.STRING(120), allowNull: false },
  email: { type: DataTypes.STRING(150), allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM(...ROLES), allowNull: false, defaultValue: 'employee' },
  is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  last_login_at: { type: DataTypes.DATE, allowNull: true },
}, base('users', {
  defaultScope: { attributes: { exclude: ['password'] } },
  scopes: { withPassword: { attributes: { include: ['password'] } } },
}));

export { sequelize };
