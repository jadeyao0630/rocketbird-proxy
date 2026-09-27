const express = require('express');
const router = express.Router();
const { pool } = require('../db');

/* ============================================================
 * 列表：某门店所有方案
 * ============================================================ */
router.get('/compensation/plans', async (req, res) => {
  try {
    const { store_id } = req.query;
    if (!store_id) {
      return res.status(400).json({ errorcode: 400, errormsg: 'store_id required' });
    }
    const [rows] = await pool.query(
      `SELECT id, store_id AS storeId, month, period_label AS periodLabel,
              imported_from AS importedFrom, imported_at AS importedAt, is_active AS isActive
         FROM monthly_compensation_plan
        WHERE store_id = ?
        ORDER BY month DESC`,
      [store_id]
    );
    res.json({ errorcode: 0, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 详情：按门店 + 月份
 * ============================================================ */
router.get('/compensation/plan', async (req, res) => {
  try {
    const { store_id, month } = req.query;
    if (!store_id || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: 'store_id & month required' });
    }
    const [plans] = await pool.query(
      `SELECT * FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [store_id, month]
    );
    if (plans.length === 0) return res.json({ errorcode: 0, data: null });

    const plan = plans[0];
    const [positions] = await pool.query(
      `SELECT * FROM position_config WHERE plan_id = ? ORDER BY id ASC`,
      [plan.id]
    );

    for (const p of positions) {
      const [ct] = await pool.query(`SELECT * FROM commission_tier WHERE position_id = ?`, [p.id]);
      const [bt] = await pool.query(`SELECT * FROM base_salary_tier WHERE position_id = ?`, [p.id]);
      const [gt] = await pool.query(`SELECT * FROM gender_salary_tier WHERE position_id = ?`, [p.id]);
      const [cc] = await pool.query(`SELECT * FROM course_commission WHERE position_id = ?`, [p.id]);
      const [of] = await pool.query(`SELECT * FROM old_class_fee_tier WHERE position_id = ?`, [p.id]);

      p.commissionTiers = ct.map((x) => ({
        id: String(x.id),
        threshold: Number(x.threshold),
        rate: Number(x.rate),
        classRate: x.class_rate != null ? Number(x.class_rate) : undefined,
        classMode: x.class_mode || undefined,
        note: x.note || undefined,
      }));
      p.baseSalaryTiers = bt.map((x) => ({
        id: String(x.id),
        threshold: Number(x.threshold),
        amount: Number(x.amount),
        note: x.note || undefined,
      }));
      p.genderSalaryTiers = gt.map((x) => ({
        id: String(x.id),
        threshold: Number(x.threshold),
        male: Number(x.male),
        female: Number(x.female),
        newbie: Number(x.newbie),
        base: x.base != null ? Number(x.base) : undefined,
        note: x.note || undefined,
      }));
      p.courseCommissions = cc.map((x) => ({
        id: String(x.id),
        courseName: x.course_name,
        mode: x.mode,
        value: Number(x.value),
        note: x.note || undefined,
      }));
      p.oldClassFees = of.map((x) => ({
        id: String(x.id),
        threshold: Number(x.threshold),
        fee: Number(x.fee),
        note: x.note || undefined,
      }));

      p.oldClassFee = p.old_class_fee != null ? Number(p.old_class_fee) : undefined;
      p.headcount = Number(p.headcount);
      p.performanceTarget = Number(p.performance_target);
      p.totalBaseSalary = Number(p.total_base_salary);
    }

    plan.positions = positions;
    plan.storeId = plan.store_id;
    plan.periodLabel = plan.period_label;
    plan.importedFrom = plan.imported_from;
    plan.importedAt = plan.imported_at;

    res.json({ errorcode: 0, data: plan });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 保存（新增或覆盖）
 * ============================================================ */
router.post('/compensation/plan', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { storeId, month, periodLabel, positions } = req.body;
    if (!storeId || !month || !Array.isArray(positions)) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/month/positions required' });
    }

    await conn.beginTransaction();

    const [existing] = await conn.query(
      `SELECT id FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [storeId, month]
    );
    if (existing.length > 0) {
      await conn.query(`DELETE FROM position_config WHERE plan_id = ?`, [existing[0].id]);
      await conn.query(`DELETE FROM monthly_compensation_plan WHERE id = ?`, [existing[0].id]);
    }

    const [r] = await conn.query(
      `INSERT INTO monthly_compensation_plan
        (store_id, month, period_label, imported_at, is_active)
       VALUES (?, ?, ?, NOW(), 1)`,
      [storeId, month, periodLabel || month]
    );
    const planId = r.insertId;

    for (const p of positions) {
      const [pr] = await conn.query(
        `INSERT INTO position_config
          (plan_id, title, category, headcount, performance_target, performance_source,
           total_base_salary, extra_note, class_commission_mode, old_class_fee, calc_flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          p.title,
          p.category || null,
          p.headcount || 0,
          p.performanceTarget || 0,
          p.performanceSource || 'self',
          p.totalBaseSalary || 0,
          p.extraNote || null,
          p.classCommissionMode || null,
          p.oldClassFee != null ? p.oldClassFee : null,
          p.calcFlags ? JSON.stringify(p.calcFlags) : null,
        ]
      );
      const posId = pr.insertId;

      for (const t of p.commissionTiers || []) {
        await conn.query(
          `INSERT INTO commission_tier (position_id, threshold, rate, class_rate, class_mode, note)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [posId, t.threshold, t.rate, t.classRate ?? null, t.classMode ?? null, t.note ?? null]
        );
      }
      for (const t of p.baseSalaryTiers || []) {
        await conn.query(
          `INSERT INTO base_salary_tier (position_id, threshold, amount, note) VALUES (?, ?, ?, ?)`,
          [posId, t.threshold, t.amount, t.note ?? null]
        );
      }
      for (const t of p.genderSalaryTiers || []) {
        await conn.query(
          `INSERT INTO gender_salary_tier (position_id, threshold, male, female, newbie, base, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [posId, t.threshold, t.male || 0, t.female || 0, t.newbie || 0, t.base ?? null, t.note ?? null]
        );
      }
      for (const c of p.courseCommissions || []) {
        await conn.query(
          `INSERT INTO course_commission (position_id, course_name, mode, value, note)
           VALUES (?, ?, ?, ?, ?)`,
          [posId, c.courseName, c.mode, c.value, c.note ?? null]
        );
      }
      for (const o of p.oldClassFees || []) {
        await conn.query(
          `INSERT INTO old_class_fee_tier (position_id, threshold, fee, note) VALUES (?, ?, ?, ?)`,
          [posId, o.threshold, o.fee, o.note ?? null]
        );
      }
    }

    await conn.commit();
    res.json({ errorcode: 0, data: { id: planId } });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  } finally {
    conn.release();
  }
});

/* ============================================================
 * 删除
 * ============================================================ */
router.delete('/compensation/plan', async (req, res) => {
  try {
    const { store_id, month } = req.query;
    if (!store_id || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: 'store_id & month required' });
    }
    const [plans] = await pool.query(
      `SELECT id FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [store_id, month]
    );
    if (plans.length === 0) return res.json({ errorcode: 0, data: null });

    await pool.query(`DELETE FROM position_config WHERE plan_id = ?`, [plans[0].id]);
    await pool.query(`DELETE FROM monthly_compensation_plan WHERE id = ?`, [plans[0].id]);
    res.json({ errorcode: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 初始化门店
 * ============================================================ */
router.post('/compensation/init', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { storeId } = req.body;
    if (!storeId) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId required' });
    }
    const [existing] = await conn.query(
      `SELECT COUNT(*) AS c FROM monthly_compensation_plan WHERE store_id = ?`,
      [storeId]
    );
    if (existing[0].c > 0) {
      return res.json({
        errorcode: 0,
        data: { initialized: false, reason: 'has_plans' },
      });
    }

    const now = new Date();
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const curMonth = fmt(now);
    const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonth = fmt(lastMonthDate);

    await conn.beginTransaction();
    for (const month of [lastMonth, curMonth]) {
      await conn.query(
        `INSERT INTO monthly_compensation_plan
          (store_id, month, period_label, imported_at, is_active)
         VALUES (?, ?, ?, NOW(), 1)`,
        [storeId, month, month]
      );
    }
    await conn.commit();

    console.log(`[init] 门店 ${storeId} 初始化完成：${lastMonth}, ${curMonth}`);
    res.json({
      errorcode: 0,
      data: { initialized: true, months: [lastMonth, curMonth] },
    });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  } finally {
    conn.release();
  }
});

/* ============================================================
 * ⭐ 测算设置：读取
 * GET /api/simulation/setting?store_id=xxx&month=xxx
 * ============================================================ */
router.get('/simulation/setting', async (req, res) => {
  try {
    const { store_id, month } = req.query;
    if (!store_id || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: 'store_id & month required' });
    }
    const [rows] = await pool.query(
      `SELECT property_fee, electricity_fee, rent, water_fee, network_fee, other_fee
         FROM simulation_setting
        WHERE store_id = ? AND month = ?`,
      [store_id, month]
    );
    if (rows.length === 0) {
      return res.json({
        errorcode: 0,
        data: {
          propertyFee: 0,
          electricityFee: 0,
          rent: 0,
          waterFee: 0,
          networkFee: 0,
          otherFee: 0,
        },
      });
    }
    const r = rows[0];
    res.json({
      errorcode: 0,
      data: {
        propertyFee: Number(r.property_fee),
        electricityFee: Number(r.electricity_fee),
        rent: Number(r.rent),
        waterFee: Number(r.water_fee),
        networkFee: Number(r.network_fee),
        otherFee: Number(r.other_fee),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * ⭐ 测算设置：保存（upsert）
 * POST /api/simulation/setting
 * body: { storeId, month, input: { propertyFee, ... } }
 * ============================================================ */
router.post('/simulation/setting', async (req, res) => {
  try {
    const { storeId, month, input } = req.body;
    if (!storeId || !month || !input) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/month/input required' });
    }
    const {
      propertyFee = 0,
      electricityFee = 0,
      rent = 0,
      waterFee = 0,
      networkFee = 0,
      otherFee = 0,
    } = input;

    await pool.query(
      `INSERT INTO simulation_setting
        (store_id, month, property_fee, electricity_fee, rent, water_fee, network_fee, other_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         property_fee    = VALUES(property_fee),
         electricity_fee = VALUES(electricity_fee),
         rent            = VALUES(rent),
         water_fee       = VALUES(water_fee),
         network_fee     = VALUES(network_fee),
         other_fee       = VALUES(other_fee)`,
      [storeId, month, propertyFee, electricityFee, rent, waterFee, networkFee, otherFee]
    );

    res.json({ errorcode: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;