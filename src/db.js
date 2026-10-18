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
    `CREATE TABLE IF NOT EXISTS admin_user (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      username      VARCHAR(64)  NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(64),
      role          VARCHAR(16)  NOT NULL DEFAULT 'user',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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
      disabled              TINYINT(1)   NOT NULL DEFAULT 0,
      manager_aggregate_by_dept TINYINT(1) NOT NULL DEFAULT 0,
      manager_include_self  TINYINT(1)   NOT NULL DEFAULT 0,
      commission_tiered     TINYINT(1)   NOT NULL DEFAULT 1,
      base_salary_tiered    TINYINT(1)   NOT NULL DEFAULT 1,
      FOREIGN KEY (plan_id) REFERENCES monthly_compensation_plan(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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

    `CREATE TABLE IF NOT EXISTS position_reward (
      id              BIGINT PRIMARY KEY AUTO_INCREMENT,
      position_id     BIGINT       NOT NULL,
      reward_id       VARCHAR(64)  NOT NULL,
      amount_override DECIMAL(12,2) DEFAULT NULL,
      enabled         TINYINT(1)   NOT NULL DEFAULT 1,
      note            VARCHAR(255) DEFAULT NULL,
      created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_position (position_id),
      FOREIGN KEY (position_id) REFERENCES position_config(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS department_reward (
      id              BIGINT PRIMARY KEY AUTO_INCREMENT,
      plan_id         BIGINT       NOT NULL,
      department      VARCHAR(32)  NOT NULL,
      reward_id       VARCHAR(64)  NOT NULL,
      amount_override DECIMAL(12,2) DEFAULT NULL,
      enabled         TINYINT(1)   NOT NULL DEFAULT 1,
      note            VARCHAR(255) DEFAULT NULL,
      created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_plan_dept (plan_id, department),
      FOREIGN KEY (plan_id) REFERENCES monthly_compensation_plan(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS temp_reward (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      plan_id     BIGINT       NOT NULL,
      staff_id    VARCHAR(64)  NOT NULL,
      name        VARCHAR(64)  NOT NULL,
      amount      DECIMAL(12,2) NOT NULL,
      note        VARCHAR(255) DEFAULT NULL,
      reward_id   VARCHAR(64)  DEFAULT NULL,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_plan_staff (plan_id, staff_id),
      FOREIGN KEY (plan_id) REFERENCES monthly_compensation_plan(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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

    `CREATE TABLE IF NOT EXISTS payroll_staff_status (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      bus_id      VARCHAR(64) NOT NULL,
      month       VARCHAR(7)  NOT NULL,
      staff_id    VARCHAR(64) NOT NULL,
      staff_name  VARCHAR(64) DEFAULT NULL,
      is_newbie   TINYINT(1)  NOT NULL DEFAULT 0,
      is_excluded TINYINT(1)  NOT NULL DEFAULT 0,
      updated_by  VARCHAR(64) DEFAULT NULL,
      updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_bus_month_staff (bus_id, month, staff_id),
      KEY idx_bus_month (bus_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS dingtalk_sync_config (
      id                  INT          NOT NULL PRIMARY KEY DEFAULT 1,
      enabled             TINYINT(1)   NOT NULL DEFAULT 1,
      schedule_mode       VARCHAR(16)  NOT NULL DEFAULT 'daily',
      daily_hour          INT          NOT NULL DEFAULT 3,
      interval_hours      INT          NOT NULL DEFAULT 6,
      lookback_days       INT          NOT NULL DEFAULT 30,
      last_run_at         DATETIME     DEFAULT NULL,
      last_run_status     VARCHAR(16)  DEFAULT NULL,
      last_run_message    VARCHAR(512) DEFAULT NULL,
      updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `INSERT IGNORE INTO dingtalk_sync_config (id) VALUES (1)`,

    `CREATE TABLE IF NOT EXISTS dingtalk_process_cache (
      process_instance_id VARCHAR(64)  NOT NULL PRIMARY KEY,
      template_name       VARCHAR(128) DEFAULT NULL,
      process_code        VARCHAR(64)  DEFAULT NULL,
      title               VARCHAR(512) DEFAULT NULL,
      status              VARCHAR(32)  DEFAULT NULL,
      result              VARCHAR(32)  DEFAULT NULL,
      create_time         DATETIME     DEFAULT NULL,
      finish_time         DATETIME     DEFAULT NULL,
      payment_unit        VARCHAR(255) DEFAULT NULL,
      payee_account       VARCHAR(255) DEFAULT NULL,
      amount              DECIMAL(12,2) DEFAULT NULL,
      payload             LONGTEXT     DEFAULT NULL,
      is_final            TINYINT(1)   NOT NULL DEFAULT 0,
      last_synced_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_template_time (process_code, create_time),
      KEY idx_create_time   (create_time),
      KEY idx_is_final      (is_final),
      KEY idx_status        (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS gym_store_config (
      id            VARCHAR(64) NOT NULL,
      name          VARCHAR(64) NOT NULL,
      short_name    VARCHAR(64) NOT NULL DEFAULT '',
      payment_units LONGTEXT    NOT NULL,
      keywords      LONGTEXT    NOT NULL,
      is_default    TINYINT(1)  NOT NULL DEFAULT 0,
      sort_order    INT         NOT NULL DEFAULT 0,
      created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sort_order (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ⭐ 手动归属门店 */
    `CREATE TABLE IF NOT EXISTS dingtalk_manual_store (
      process_instance_id VARCHAR(64) NOT NULL PRIMARY KEY,
      store_name          VARCHAR(64) NOT NULL,
      updated_by          VARCHAR(64) DEFAULT NULL,
      updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_store (store_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* 兼容旧表 */
    `CREATE TABLE IF NOT EXISTS admin_user (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      username      VARCHAR(64)  NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(64),
      role          VARCHAR(16)  NOT NULL DEFAULT 'user',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    
    /* ⭐ 销售明细自定义提点 */
    `CREATE TABLE IF NOT EXISTS payroll_sales_detail (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      bus_id      VARCHAR(64)  NOT NULL,
      month       VARCHAR(7)   NOT NULL,
      staff_id    VARCHAR(64)  NOT NULL,
      order_id    VARCHAR(64)  NOT NULL,
      mode        VARCHAR(16)  DEFAULT NULL,
      value       DECIMAL(12,4) DEFAULT NULL,
      updated_by  VARCHAR(64)  DEFAULT NULL,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_bus_month_staff_order (bus_id, month, staff_id, order_id),
      KEY idx_bus_month (bus_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ⭐ 消课明细自定义课提 */
    `CREATE TABLE IF NOT EXISTS payroll_class_detail (
      id          BIGINT PRIMARY KEY AUTO_INCREMENT,
      bus_id      VARCHAR(64)  NOT NULL,
      month       VARCHAR(7)   NOT NULL,
      staff_id    VARCHAR(64)  NOT NULL,
      course_name VARCHAR(64)  NOT NULL,
      member_id   VARCHAR(64)  NOT NULL DEFAULT '',
      mode        VARCHAR(16)  DEFAULT NULL,
      value       DECIMAL(12,4) DEFAULT NULL,
      updated_by  VARCHAR(64)  DEFAULT NULL,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_bus_month_staff_class (bus_id, month, staff_id, course_name, member_id),
      KEY idx_bus_month (bus_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
     
    /* 未结算草稿：按门店和月份保存可恢复的计算结果及职位调整 */
    `CREATE TABLE IF NOT EXISTS payroll_draft (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      bus_id VARCHAR(64) NOT NULL,
      month VARCHAR(7) NOT NULL,
      results_json LONGTEXT NOT NULL,
      overrides_json LONGTEXT DEFAULT NULL,
      updated_by VARCHAR(64) DEFAULT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_bus_month (bus_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ⭐ 薪酬结算快照 */
    `CREATE TABLE IF NOT EXISTS payroll_settlement (
      id            BIGINT PRIMARY KEY AUTO_INCREMENT,
      bus_id        VARCHAR(64)  NOT NULL,
      month         VARCHAR(7)   NOT NULL,
      status        VARCHAR(16)  NOT NULL DEFAULT 'settled',
      plan_hash     VARCHAR(64)  DEFAULT NULL,
      results_json  LONGTEXT     NOT NULL,
      summary_json  LONGTEXT     DEFAULT NULL,
      settled_by    VARCHAR(64)  DEFAULT NULL,
      settled_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_bus_month (bus_id, month),
      KEY idx_bus_month (bus_id, month)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    
    /* ============================================================
     * 豆包 AI：全局月报分析提示词
     * ============================================================ */
    `CREATE TABLE IF NOT EXISTS gym_ai_prompt_config (
      id          TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      prompt_text LONGTEXT NOT NULL,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci`,

    /* ============================================================
     * 豆包 AI：各门店独立经营画像
     * ============================================================ */
    `CREATE TABLE IF NOT EXISTS gym_ai_store_profile (
      store_id     VARCHAR(128) NOT NULL PRIMARY KEY,
      profile_json JSON NOT NULL,
      updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci`,
  ];

  for (const sql of sqls) {
    try {
      await pool.query(sql);
    } catch (e) {
      /* 忽略重复建表错误 */
    }
  }

  await ensureColumn('position_config', 'disabled', `TINYINT(1) NOT NULL DEFAULT 0`);
  await ensureColumn('admin_user', 'role', `VARCHAR(16) NOT NULL DEFAULT 'user'`);
  await ensureColumn('position_config', 'manager_aggregate_by_dept', `TINYINT(1) NOT NULL DEFAULT 0`);
  await ensureColumn('position_config', 'manager_include_self', `TINYINT(1) NOT NULL DEFAULT 0`);
  await ensureColumn('position_config', 'commission_tiered', `TINYINT(1) NOT NULL DEFAULT 1`);
  await ensureColumn('position_config', 'base_salary_tiered', `TINYINT(1) NOT NULL DEFAULT 1`);

  console.log('[db] tables ready');
}

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
 * 5) 门店配置初始数据
 * ============================================================ */
async function seedStoreConfig() {
  const [rows] = await pool.query(`SELECT COUNT(*) AS c FROM gym_store_config`);
  if (rows[0].c > 0) return;

  const defaults = [
    {
      id: '12279',
      name: '富贵园',
      shortName: '富贵园',
      paymentUnits: [
        '北京林朗韵动体育管理有限公司',
        '北京林朗体育管理有限公司东花市大街分公司',
      ],
      keywords: ['富贵园', '富贵', '东花市'],
      isDefault: 1,
      sortOrder: 1,
    },
    {
      id: '11536',
      name: '哈德门',
      shortName: '哈德门',
      paymentUnits: [
        '北京林朗悦动体育管理有限公司',
        '北京林朗体育管理有限公司',
      ],
      keywords: ['哈德门', '哈德'],
      isDefault: 0,
      sortOrder: 2,
    },
  ];

  for (const s of defaults) {
    await pool.query(
      `INSERT INTO gym_store_config
         (id, name, short_name, payment_units, keywords, is_default, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        s.id,
        s.name,
        s.shortName,
        JSON.stringify(s.paymentUnits),
        JSON.stringify(s.keywords),
        s.isDefault,
        s.sortOrder,
      ]
    );
  }
  console.log('[db] gym_store_config 已写入初始门店（富贵园 / 哈德门）');
}

/* ============================================================
 * 6) 一键初始化
 * ============================================================ */
async function initDatabase() {
  await ensureDatabase();
  await ensureTables();
  await seedAdmin();
  await seedStoreConfig();
}

module.exports = { pool, initDatabase };