require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

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
    /* 管理员账号 */
    `CREATE TABLE IF NOT EXISTS admin_user (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      username      VARCHAR(64)  NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(64),
      role          VARCHAR(16)  NOT NULL DEFAULT 'user',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 每月薪酬方案 */
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

    /* 岗位配置 */
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
      disabled              TINYINT(1)   NOT NULL DEFAULT 0,
      manager_aggregate_by_dept TINYINT(1) NOT NULL DEFAULT 0,
      manager_include_self  TINYINT(1)   NOT NULL DEFAULT 0,
      commission_tiered     TINYINT(1)   NOT NULL DEFAULT 1,
      base_salary_tiered    TINYINT(1)   NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES monthly_compensation_plan(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 佣金阶梯 */
    `CREATE TABLE IF NOT EXISTS commission_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      rate        DECIMAL(12,4) NOT NULL,
      class_rate  DECIMAL(8,4),
      class_mode  VARCHAR(16),
      sales_mode  VARCHAR(16),
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 底薪阶梯 */
    `CREATE TABLE IF NOT EXISTS base_salary_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      amount      DECIMAL(12,2) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 性别底薪阶梯 */
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

    /* 课程提成 */
    `CREATE TABLE IF NOT EXISTS course_commission (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      course_name VARCHAR(64) NOT NULL,
      mode        VARCHAR(16) NOT NULL,
      value       DECIMAL(10,4) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 老课费用阶梯 */
    `CREATE TABLE IF NOT EXISTS old_class_fee_tier (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id BIGINT NOT NULL,
      threshold   DECIMAL(12,2) NOT NULL,
      fee         DECIMAL(10,2) NOT NULL,
      note        VARCHAR(255),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 测算设置 */
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

    /* 用户权限 */
    `CREATE TABLE IF NOT EXISTS user_permission (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id     BIGINT       NOT NULL,
      permission  VARCHAR(64)  NOT NULL,
      store_ids   JSON         NOT NULL,
      granted_by  BIGINT,
      granted_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_permission (user_id, permission),
      FOREIGN KEY (user_id)    REFERENCES admin_user(id) ON DELETE CASCADE,
      FOREIGN KEY (granted_by) REFERENCES admin_user(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of sqls) {
    await pool.query(sql);
  }

    /* ⭐ 兼容旧表：如果某些列不存在，自动加 */
  await ensureColumn('position_config', 'disabled', `TINYINT(1) NOT NULL DEFAULT 0`);
  await ensureColumn('admin_user', 'role', `VARCHAR(16) NOT NULL DEFAULT 'user'`);
  await ensureColumn(
    'position_config',
    'manager_aggregate_by_dept',
    `TINYINT(1) NOT NULL DEFAULT 0`
  );
  await ensureColumn(
    'position_config',
    'manager_include_self',
    `TINYINT(1) NOT NULL DEFAULT 0`
  );
  await ensureColumn(
    'position_config',
    'commission_tiered',
    `TINYINT(1) NOT NULL DEFAULT 1`
  );
  await ensureColumn(
    'position_config',
    'base_salary_tiered',
    `TINYINT(1) NOT NULL DEFAULT 1`
  );

  console.log('[db] tables ready');
}

/* ============================================================
 * ⭐ 工具：如果列不存在则 ALTER TABLE 加列
 * ============================================================ */
async function ensureColumn(table, column, definition) {
  const dbName = process.env.DB_NAME || 'gym_payroll';
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [dbName, table, column]
  );
  if (cols.length === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[db] 已为 ${table} 添加列 ${column}`);
  }
}

/* ============================================================
 * 4) 默认超管
 * ============================================================ */
async function seedAdmin() {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM admin_user`);
  if (rows[0].c > 0) {
    await pool.query(
      `UPDATE admin_user SET role = 'admin' WHERE username = ?`,
      [process.env.ADMIN_USERNAME || 'admin']
    );
    return;
  }

  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await bcrypt.hash(defaultPassword, 10);

  await pool.query(
    `INSERT INTO admin_user (username, password_hash, display_name, role)
     VALUES (?, ?, ?, 'admin')`,
    [defaultUsername, hash, '超级管理员']
  );
  console.log(
    `[db] 已创建默认超级管理员 ${defaultUsername} / ${defaultPassword}（请登录后修改）`
  );
}

/* ============================================================
 * 5) 一键初始化
 * ============================================================ */
async function initDatabase() {
  await ensureDatabase();
  await ensureTables();
  await seedAdmin();
}

module.exports = { pool, initDatabase };