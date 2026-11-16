import { DataTypes } from 'sequelize';

/** DECIMAL column that reads back as a JavaScript number. */
export const decimal = (name, precision = 12, scale = 2, defaultValue = 0) => ({
  type: DataTypes.DECIMAL(precision, scale),
  allowNull: false,
  defaultValue,
  get() {
    const v = this.getDataValue(name);
    return v === null || v === undefined ? v : Number(v);
  },
});

/** Integer counter column. */
export const counter = () => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });

/** JSON column (stored as TEXT so it works the same on MySQL and SQLite). */
export const json = (name, fallback = null, size = undefined) => ({
  type: size ? DataTypes.TEXT(size) : DataTypes.TEXT,
  allowNull: true,
  get() {
    const raw = this.getDataValue(name);
    if (raw === null || raw === undefined || raw === '') return fallback;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fallback; }
  },
  set(value) {
    this.setDataValue(name, value === null || value === undefined ? null : JSON.stringify(value));
  },
});

export const base = (tableName, extra = {}) => ({ tableName, underscored: true, ...extra });
