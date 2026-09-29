const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { userHasPermission } = require('./adminPermissions');

const JWT_SECRET =
  process.env.JWT_SECRET || 'change_this_secret_in_production';

function tryAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

async function requirePlanEdit(req, storeId) {
  const user = tryAuth(req);
  if (!user) return true;
  return await userHasPermission(user.uid, 'plan:edit', storeId);
}

/* ============================================================
 * 工具
 * ============================================================ */
function toJson(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    try {
      JSON.parse(s);
      return s;
    } catch {
      return JSON.stringify(s);
    }
  }
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toNumOrZero(v) {
  const n = toNum(v);
  return n == null ? 0 : n;
}
function toStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toStrOr(v, fallback) {
  return toStr(v) || fallback;
}
function toBit(v) {
  return v ? 1 : 0;
}

/* ============================================================
 * 兜底：没有运营主管时动态补一个
 * ============================================================ */
function ensureOpsManager(positions) {
  if (!Array.isArray(positions)) return positions;
  if (positions.some((p) => p && p.title === '运营主管')) return positions;

  positions.push({
    id: 'virtual_运营主管',
    title: '运营主管',
    category: 'operations',
    headcount: 1,
    performanceTarget: 0,
    performanceSource: 'self',
    totalBaseSalary: 0,
    commissionTiers: [
      {
        id: 'virtual_ops_tier_0',
        threshold: 0,
        rate: 0.03,
        salesMode: 'percent',
        note: '店长销售 × 3%',
      },
    ],
    baseSalaryTiers: [
      {
        id: 'virtual_ops_base_0',
        threshold: 0,
        amount: 20000,
        note: '固定底薪',
      },
    ],
    extraNote: '佣金 = 店长销售 × 3%',
  });
  return positions;
}

/* ============================================================
 * 列表
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
 * 详情
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
        salesMode: x.sales_mode || undefined,
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

      p.disabled = !!p.disabled;
      p.managerAggregateByDept = !!p.manager_aggregate_by_dept;

      if (p.calc_flags != null) {
        if (typeof p.calc_flags === 'string') {
          try {
            p.calcFlags = JSON.parse(p.calc_flags);
          } catch {
            p.calcFlags = undefined;
          }
        } else {
          p.calcFlags = p.calc_flags;
        }
      } else {
        p.calcFlags = undefined;
      }
      delete p.calc_flags;
    }

    plan.positions = positions;
    plan.storeId = plan.store_id;
    plan.periodLabel = plan.period_label;
    plan.importedFrom = plan.imported_from;
    plan.importedAt = plan.imported_at;

    ensureOpsManager(plan.positions);

    res.json({ errorcode: 0, data: plan });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 保存
 * ============================================================ */
router.post('/compensation/plan', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { storeId, month, periodLabel, positions } = req.body;
    if (!storeId || !month || !Array.isArray(positions)) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/month/positions required' });
    }

    const ok = await requirePlanEdit(req, storeId);
    if (!ok) {
      conn.release();
      return res
        .status(403)
        .json({ errorcode: 403, errormsg: '无权限：设置方案' });
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
      if (String(p.id || '').startsWith('virtual_')) continue;

      const [pr] = await conn.query(
        `INSERT INTO position_config
          (plan_id, title, category, headcount, performance_target, performance_source,
           total_base_salary, extra_note, class_commission_mode, old_class_fee, calc_flags, disabled,
           manager_aggregate_by_dept)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          planId,
          toStrOr(p.title, '未命名职位'),
          toStr(p.category),
          toNumOrZero(p.headcount),
          toNumOrZero(p.performanceTarget),
          toStr(p.performanceSource) || 'self',
          toNumOrZero(p.totalBaseSalary),
          toStr(p.extraNote),
          toStr(p.classCommissionMode),
          toNum(p.oldClassFee),
          toJson(p.calcFlags),
          toBit(p.disabled),
          toBit(p.managerAggregateByDept),
        ]
      );
      const posId = pr.insertId;

      for (const t of p.commissionTiers || []) {
        await conn.query(
          `INSERT INTO commission_tier
            (position_id, threshold, rate, class_rate, class_mode, sales_mode, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            posId,
            toNumOrZero(t.threshold),
            toNumOrZero(t.rate),
            toNum(t.classRate),
            toStr(t.classMode),
            toStr(t.salesMode),
            toStr(t.note),
          ]
        );
      }

      for (const t of p.baseSalaryTiers || []) {
        await conn.query(
          `INSERT INTO base_salary_tier (position_id, threshold, amount, note) VALUES (?, ?, ?, ?)`,
          [posId, toNumOrZero(t.threshold), toNumOrZero(t.amount), toStr(t.note)]
        );
      }

      for (const t of p.genderSalaryTiers || []) {
        await conn.query(
          `INSERT INTO gender_salary_tier (position_id, threshold, male, female, newbie, base, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            posId,
            toNumOrZero(t.threshold),
            toNumOrZero(t.male),
            toNumOrZero(t.female),
            toNumOrZero(t.newbie),
            toNum(t.base),
            toStr(t.note),
          ]
        );
      }

      for (const c of p.courseCommissions || []) {
        const courseName = toStr(c.courseName) || toStr(c.course_name);
        if (!courseName) {
          console.warn(`[warn] 跳过空 course_name，position=${p.title}`);
          continue;
        }
        const mode = toStr(c.mode) || 'percent';
        await conn.query(
          `INSERT INTO course_commission (position_id, course_name, mode, value, note)
           VALUES (?, ?, ?, ?, ?)`,
          [posId, courseName, mode, toNumOrZero(c.value), toStr(c.note)]
        );
      }

      for (const o of p.oldClassFees || []) {
        await conn.query(
          `INSERT INTO old_class_fee_tier (position_id, threshold, fee, note) VALUES (?, ?, ?, ?)`,
          [posId, toNumOrZero(o.threshold), toNumOrZero(o.fee), toStr(o.note)]
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
 * 删除方案
 * ============================================================ */
router.delete('/compensation/plan', async (req, res) => {
  try {
    const { store_id, month } = req.query;
    if (!store_id || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: 'store_id & month required' });
    }

    const ok = await requirePlanEdit(req, store_id);
    if (!ok) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：设置方案' });
    }

    const [plans] = await pool.query(
      `SELECT id FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [store_id, month]
    );
    if (plans.length > 0) {
      await pool.query(`DELETE FROM position_config WHERE plan_id = ?`, [plans[0].id]);
      await pool.query(`DELETE FROM monthly_compensation_plan WHERE id = ?`, [plans[0].id]);
    }
    await pool.query(
      `DELETE FROM simulation_setting WHERE store_id = ? AND month = ?`,
      [store_id, month]
    );
    res.json({ errorcode: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 复制方案
 * ============================================================ */
router.post('/compensation/plan/copy', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { storeId, fromMonth, toMonth } = req.body;
    if (!storeId || !fromMonth || !toMonth) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/fromMonth/toMonth required' });
    }
    if (fromMonth === toMonth) {
      return res.status(400).json({ errorcode: 400, errormsg: 'fromMonth 不能等于 toMonth' });
    }

    const ok = await requirePlanEdit(req, storeId);
    if (!ok) {
      conn.release();
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：设置方案' });
    }

    const [src] = await conn.query(
      `SELECT * FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [storeId, fromMonth]
    );
    if (src.length === 0) {
      return res.status(404).json({ errorcode: 404, errormsg: '源月份方案不存在' });
    }
    const srcPlan = src[0];

    await conn.beginTransaction();

    const [dst] = await conn.query(
      `SELECT id FROM monthly_compensation_plan WHERE store_id = ? AND month = ?`,
      [storeId, toMonth]
    );
    if (dst.length > 0) {
      await conn.query(`DELETE FROM position_config WHERE plan_id = ?`, [dst[0].id]);
      await conn.query(`DELETE FROM monthly_compensation_plan WHERE id = ?`, [dst[0].id]);
    }

    const [newPlan] = await conn.query(
      `INSERT INTO monthly_compensation_plan
        (store_id, month, period_label, imported_from, imported_at, is_active)
       VALUES (?, ?, ?, ?, NOW(), 1)`,
      [storeId, toMonth, toMonth, `复制自 ${fromMonth}`]
    );
    const newPlanId = newPlan.insertId;

    const [positions] = await conn.query(
      `SELECT * FROM position_config WHERE plan_id = ? ORDER BY id ASC`,
      [srcPlan.id]
    );

    for (const p of positions) {
      const [newPos] = await conn.query(
        `INSERT INTO position_config
          (plan_id, title, category, headcount, performance_target, performance_source,
           total_base_salary, extra_note, class_commission_mode, old_class_fee, calc_flags, disabled,
           manager_aggregate_by_dept)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newPlanId,
          toStrOr(p.title, '未命名职位'),
          toStr(p.category),
          toNumOrZero(p.headcount),
          toNumOrZero(p.performance_target),
          toStr(p.performance_source) || 'self',
          toNumOrZero(p.total_base_salary),
          toStr(p.extra_note),
          toStr(p.class_commission_mode),
          toNum(p.old_class_fee),
          toJson(p.calc_flags),
          toBit(p.disabled),
          toBit(p.manager_aggregate_by_dept),
        ]
      );
      const newPosId = newPos.insertId;

      const [ct] = await conn.query(`SELECT * FROM commission_tier WHERE position_id = ?`, [p.id]);
      for (const t of ct) {
        await conn.query(
          `INSERT INTO commission_tier
            (position_id, threshold, rate, class_rate, class_mode, sales_mode, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            newPosId,
            toNumOrZero(t.threshold),
            toNumOrZero(t.rate),
            toNum(t.class_rate),
            toStr(t.class_mode),
            toStr(t.sales_mode),
            toStr(t.note),
          ]
        );
      }

      const [bt] = await conn.query(`SELECT * FROM base_salary_tier WHERE position_id = ?`, [p.id]);
      for (const t of bt) {
        await conn.query(
          `INSERT INTO base_salary_tier (position_id, threshold, amount, note) VALUES (?, ?, ?, ?)`,
          [newPosId, toNumOrZero(t.threshold), toNumOrZero(t.amount), toStr(t.note)]
        );
      }

      const [gt] = await conn.query(`SELECT * FROM gender_salary_tier WHERE position_id = ?`, [p.id]);
      for (const t of gt) {
        await conn.query(
          `INSERT INTO gender_salary_tier (position_id, threshold, male, female, newbie, base, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            newPosId,
            toNumOrZero(t.threshold),
            toNumOrZero(t.male),
            toNumOrZero(t.female),
            toNumOrZero(t.newbie),
            toNum(t.base),
            toStr(t.note),
          ]
        );
      }

      const [cc] = await conn.query(`SELECT * FROM course_commission WHERE position_id = ?`, [p.id]);
      for (const c of cc) {
        const courseName = toStr(c.course_name) || toStr(c.courseName);
        if (!courseName) {
          console.warn(`[warn] copy 跳过空 course_name，position=${p.title}`);
          continue;
        }
        const mode = toStr(c.mode) || 'percent';
        await conn.query(
          `INSERT INTO course_commission (position_id, course_name, mode, value, note)
           VALUES (?, ?, ?, ?, ?)`,
          [newPosId, courseName, mode, toNumOrZero(c.value), toStr(c.note)]
        );
      }

      const [of] = await conn.query(`SELECT * FROM old_class_fee_tier WHERE position_id = ?`, [p.id]);
      for (const o of of) {
        await conn.query(
          `INSERT INTO old_class_fee_tier (position_id, threshold, fee, note) VALUES (?, ?, ?, ?)`,
          [newPosId, toNumOrZero(o.threshold), toNumOrZero(o.fee), toStr(o.note)]
        );
      }
    }

    await conn.commit();
    console.log(`[copy] ${storeId}: ${fromMonth} → ${toMonth}, 岗位数 ${positions.length}`);
    res.json({ errorcode: 0, data: { id: newPlanId, positionCount: positions.length } });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  } finally {
    conn.release();
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

    const ok = await requirePlanEdit(req, storeId);
    if (!ok) {
      conn.release();
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：设置方案' });
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
 * 测算设置：读取
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
 * 测算设置：保存
 * ============================================================ */
router.post('/simulation/setting', async (req, res) => {
  try {
    const { storeId, month, input } = req.body;
    if (!storeId || !month || !input) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/month/input required' });
    }

    const user = tryAuth(req);
    if (user) {
      const ok = await userHasPermission(user.uid, 'simulation:access', storeId);
      if (!ok) {
        return res
          .status(403)
          .json({ errorcode: 403, errormsg: '无权限：测算' });
      }
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
      [
        storeId,
        month,
        toNumOrZero(propertyFee),
        toNumOrZero(electricityFee),
        toNumOrZero(rent),
        toNumOrZero(waterFee),
        toNumOrZero(networkFee),
        toNumOrZero(otherFee),
      ]
    );

    res.json({ errorcode: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 复制测算设置
 * ============================================================ */
router.post('/simulation/setting/copy', async (req, res) => {
  try {
    const { storeId, fromMonth, toMonth } = req.body;
    if (!storeId || !fromMonth || !toMonth) {
      return res.status(400).json({ errorcode: 400, errormsg: 'storeId/fromMonth/toMonth required' });
    }

    const user = tryAuth(req);
    if (user) {
      const ok = await userHasPermission(user.uid, 'simulation:access', storeId);
      if (!ok) {
        return res
          .status(403)
          .json({ errorcode: 403, errormsg: '无权限：测算' });
      }
    }

    const [src] = await pool.query(
      `SELECT property_fee, electricity_fee, rent, water_fee, network_fee, other_fee
         FROM simulation_setting
        WHERE store_id = ? AND month = ?`,
      [storeId, fromMonth]
    );

    if (src.length === 0) {
      return res.json({ errorcode: 0, data: { copied: false, reason: 'no_source' } });
    }
    const s = src[0];

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
      [
        storeId,
        toMonth,
        toNumOrZero(s.property_fee),
        toNumOrZero(s.electricity_fee),
        toNumOrZero(s.rent),
        toNumOrZero(s.water_fee),
        toNumOrZero(s.network_fee),
        toNumOrZero(s.other_fee),
      ]
    );

    console.log(`[copy-sim] ${storeId}: ${fromMonth} → ${toMonth}`);
    res.json({ errorcode: 0, data: { copied: true } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;