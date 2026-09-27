require('dotenv').config();
const mysql = require('mysql2/promise');

/* ============================================================
 * 1) 先连 MySQL（不指定 database），用于 CREATE DATABASE
 * ============================================================ */
async function ensureDatabase() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });
  const dbName = process.env.DB_NAME || 'gym_payroll';
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\`
     DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();
  console.log(`[db] database ready: ${dbName}`);
}

/* ============================================================
 * 2) 连接池
 * ============================================================ */
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'gym_payroll',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: '+08:00',
});

/* ============================================================
 * 3) 建表
 * ============================================================ */
async function ensureTables() {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS monthly_compensation_plan (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      store_id      VARCHAR(64)  NOT NULL,
      month         VARCHAR(7)   NOT NULL,
      period_label  VARCHAR(32),
      imported_from VARCHAR(255),
      imported_at   DATETIME,
      created_by    VARCHAR(64),
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      is_active     TINYINT      NOT NULL DEFAULT 1,
      UNIQUE KEY uk_store_month (store_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS position_config (
      id                    BIGINT PRIMARY KEY AUTO_INCREMENT,
      plan_id               BIGINT       NOT NULL,
      title                 VARCHAR(64)  NOT NULL,
      category              VARCHAR(32),
      headcount             INT          DEFAULT 0,
      performance_target    DECIMAL(12,2) DEFAULT 0,
      performance_source    VARCHAR(16),
      total_base_salary     DECIMAL(12,2) DEFAULT 0,
      extra_note            TEXT,
      class_commission_mode VARCHAR(16),
      old_class_fee         DECIMAL(10,2),
      calc_flags            JSON,
      FOREIGN KEY (plan_id) REFERENCES monthly_compensation_plan(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS commission_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      rate        DECIMAL(8,4)  NOT NULL,
      class_rate  DECIMAL(8,4),
      class_mode  VARCHAR(16),
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS base_salary_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      amount      DECIMAL(12,2) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS gender_salary_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      male        DECIMAL(12,2) DEFAULT 0,
      female      DECIMAL(12,2) DEFAULT 0,
      newbie      DECIMAL(12,2) DEFAULT 0,
      base        DECIMAL(12,2),
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS course_commission (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      course_name VARCHAR(64) NOT NULL,
      mode        VARCHAR(16) NOT NULL,
      value       DECIMAL(10,4) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS old_class_fee_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      fee         DECIMAL(10,2) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ⭐ 测算设置（独立表） */
    `CREATE TABLE IF NOT EXISTS simulation_setting (
      id              BIGINT PRIMARY KEY AUTO_INCREMENT,
      store_id        VARCHAR(64)  NOT NULL,
      month           VARCHAR(7)   NOT NULL,
      property_fee    DECIMAL(12,2) DEFAULT 0,
      electricity_fee DECIMAL(12,2) DEFAULT 0,
      rent            DECIMAL(12,2) DEFAULT 0,
      water_fee       DECIMAL(12,2) DEFAULT 0,
      network_fee     DECIMAL(12,2) DEFAULT 0,
      other_fee       DECIMAL(12,2) DEFAULT 0,
      updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_store_month (store_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of sqls) {
    await pool.query(sql);
  }
  console.log('[db] tables ready');
}

/* ============================================================
 * 4) 一键初始化
 * ============================================================ */
async function initDatabase() {
  await ensureDatabase();
  await ensureTables();
}

module.exports = { pool, initDatabase };