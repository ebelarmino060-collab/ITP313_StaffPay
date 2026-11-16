/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
import '../config.js';
import { Sequelize } from 'sequelize';
import { config } from '../config.js';

const { db } = config;

export const sequelize = db.dialect === 'sqlite'
  ? new Sequelize({ dialect: 'sqlite', storage: db.storage, logging: db.logging ? console.log : false })
  : new Sequelize(db.name, db.user, db.password, {
    host: db.host,
    port: db.port,
    dialect: db.dialect,
    timezone: '+08:00', // store DATETIME values in hotel (Asia/Manila) time
    logging: db.logging ? console.log : false,
    define: { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' },
  });
