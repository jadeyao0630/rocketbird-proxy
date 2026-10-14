const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { userHasPermission } = require('./adminPermissions');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

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

function authRequired(req, res, next) {
  const user = tryAuth(req);
  if (!user) {
    return res.status(401).json({ errorcode: 401, errormsg: '未登录' });
  }
  req.user = user;
  next();
}

/* ⭐ 计算方案 hash，用于检测方案变更 */
function hashPlan(plan) {
  if (!plan) return null;
  try {
    const s = JSON.stringify({
      positions: plan.positions,
      departmentRewards: plan.departmentRewards,
      tempRewards: plan.tempRewards,
    });
    return crypto.createHash('md5').update(s).digest('hex');
  } catch {
    return null;
  }
}

/* ============================================================
 * 提交结算
 * POST /api/payroll/settlement
 * body: { bus_id, month, results, summary, plan }
 * ============================================================ */
router.post('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const busId = String(req.body?.bus_id || '').trim();
    const month = String(req.body?.month || '').trim();
    const results = req.body?.results;
    const summary = req.body?.summary || null;
    const plan = req.body?.plan || null;

    if (!busId || !month || !Array.isArray(results)) {
      return res.status(400).json({
        errorcode: 400,
        errormsg: '缺参数 bus_id / month / results',
      });
    }

    /* ⭐ 权限校验 */
    const ok = await userHasPermission(req.user.uid, 'payroll:settle', busId);
    if (!ok) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：薪酬结算' });
    }

    const planHash = hashPlan(plan);

    await pool.query(
      `INSERT INTO payroll_settlement
        (bus_id, month, status, plan_hash, results_json, summary_json, settled_by)
       VALUES (?, ?, 'settled', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = 'settled',
         plan_hash = VALUES(plan_hash),
         results_json = VALUES(results_json),
         summary_json = VALUES(summary_json),
         settled_by = VALUES(settled_by),
         settled_at = NOW()`,
      [
        busId,
        month,
        planHash,
        JSON.stringify(results),
        summary ? JSON.stringify(summary) : null,
        String(req.user.uid || ''),
      ]
    );

    console.log(
      `[settlement.post] 门店=${busId} 月份=${month} 结算 ${results.length} 人`
    );

    res.json({ errorcode: 0, data: { settled: results.length } });
  } catch (e) {
    console.error('[settlement.post] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 读取结算
 * GET /api/payroll/settlement?bus_id=&month=
 * ============================================================ */
router.get('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();

    if (!busId || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const [rows] = await pool.query(
      `SELECT status, plan_hash, results_json, summary_json,
              settled_by, settled_at, updated_at
         FROM payroll_settlement
        WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );

    if (rows.length === 0) {
      return res.json({ errorcode: 0, data: null });
    }

    const r = rows[0];
    let results = [];
    let summary = null;
    try {
      results = r.results_json ? JSON.parse(r.results_json) : [];
    } catch {
      results = [];
    }
    try {
      summary = r.summary_json ? JSON.parse(r.summary_json) : null;
    } catch {
      summary = null;
    }

    res.json({
      errorcode: 0,
      data: {
        status: r.status,
        planHash: r.plan_hash,
        results,
        summary,
        settledBy: r.settled_by || '',
        settledAt: r.settled_at,
        updatedAt: r.updated_at,
      },
    });
  } catch (e) {
    console.error('[settlement.get] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 删除结算（重新计算时可选调用）
 * DELETE /api/payroll/settlement?bus_id=&month=
 * ============================================================ */
router.delete('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();

    if (!busId || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const ok = await userHasPermission(req.user.uid, 'payroll:settle', busId);
    if (!ok) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：薪酬结算' });
    }

    await pool.query(
      `DELETE FROM payroll_settlement WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );

    res.json({ errorcode: 0, data: { deleted: true } });
  } catch (e) {
    console.error('[settlement.delete] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 检测方案是否变更（用于"标记过期"）
 * GET /api/payroll/settlement/check?bus_id=&month=
 * ============================================================ */
router.get('/payroll/settlement/check', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();

    if (!busId || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const [rows] = await pool.query(
      `SELECT plan_hash FROM payroll_settlement WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );
    if (rows.length === 0) {
      return res.json({ errorcode: 0, data: { hasSettlement: false } });
    }

    res.json({
      errorcode: 0,
      data: {
        hasSettlement: true,
        planHash: rows[0].plan_hash || null,
      },
    });
  } catch (e) {
    console.error('[settlement.check] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;