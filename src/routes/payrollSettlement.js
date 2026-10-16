const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { userHasPermission } = require('./adminPermissions');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const validMonth = (month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

function tryAuth(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}
function authRequired(req, res, next) {
  const user = tryAuth(req);
  if (!user) return res.status(401).json({ errorcode: 401, errormsg: '未登录' });
  req.user = user;
  next();
}
function hashPlan(plan) {
  if (!plan) return null;
  try {
    const s = JSON.stringify({
      positions: plan.positions,
      departmentRewards: plan.departmentRewards,
      tempRewards: plan.tempRewards,
    });
    return crypto.createHash('md5').update(s).digest('hex');
  } catch { return null; }
}
function params(req, source) {
  const raw = source === 'body' ? req.body : req.query;
  return {
    busId: String(raw?.bus_id ?? '').trim(),
    month: String(raw?.month ?? '').trim(),
  };
}
function validateParams(res, busId, month) {
  if (!busId || !validMonth(month)) {
    res.status(400).json({ errorcode: 400, errormsg: 'bus_id 必填，month 必须为 YYYY-MM 格式' });
    return false;
  }
  return true;
}
function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
async function requireSettlementPermission(req, res, busId, permission = 'payroll:settle') {
  const ok = await userHasPermission(req.user.uid, permission, busId);
  if (!ok) {
    res.status(403).json({ errorcode: 403, errormsg: `无权限：${permission}` });
    return false;
  }
  return true;
}

// 提交或覆盖当前门店、月份的结算快照
router.post('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const { busId, month } = params(req, 'body');
    if (!validateParams(res, busId, month)) return;
    const { results, summary = null, plan = null } = req.body || {};
    if (!Array.isArray(results)) {
      return res.status(400).json({ errorcode: 400, errormsg: 'results 必须为数组' });
    }
    if (!await requireSettlementPermission(req, res, busId)) return;
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
      [busId, month, hashPlan(plan), JSON.stringify(results),
       summary == null ? null : JSON.stringify(summary), String(req.user.uid || '')]
    );
    console.log(`[settlement.post] 门店=${busId} 月份=${month} 结算 ${results.length} 人`);
    return res.json({ errorcode: 0, data: { settled: results.length } });
  } catch (e) {
    console.error('[settlement.post] 出错', e);
    return res.status(500).json({ errorcode: 500, errormsg: '保存结算失败' });
  }
});

// 读取结算快照
router.get('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const { busId, month } = params(req);
    if (!validateParams(res, busId, month)) return;
    if (!await requireSettlementPermission(req, res, busId, 'payroll:restore')) return;
    const [rows] = await pool.query(
      `SELECT status, plan_hash, results_json, summary_json,
              settled_by, settled_at, updated_at
         FROM payroll_settlement WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );
    if (!rows.length) return res.json({ errorcode: 0, data: null });
    const r = rows[0];
    return res.json({
      errorcode: 0,
      data: {
        status: r.status,
        planHash: r.plan_hash,
        results: parseJson(r.results_json, []),
        summary: parseJson(r.summary_json, null),
        settledBy: r.settled_by || '',
        settledAt: r.settled_at,
        updatedAt: r.updated_at,
      },
    });
  } catch (e) {
    console.error('[settlement.get] 出错', e);
    return res.status(500).json({ errorcode: 500, errormsg: '读取结算失败' });
  }
});

// 重新计算之前删除当前门店、月份的结算快照
router.delete('/payroll/settlement', authRequired, async (req, res) => {
  try {
    const { busId, month } = params(req);
    if (!validateParams(res, busId, month)) return;
    if (!await requireSettlementPermission(req, res, busId, 'payroll:reverse')) return;
    const [result] = await pool.query(
      'DELETE FROM payroll_settlement WHERE bus_id = ? AND month = ?',
      [busId, month]
    );
    const affectedRows = Number(result.affectedRows || 0);
    console.log(`[settlement.delete] 门店=${busId} 月份=${month} 删除=${affectedRows}`);
    return res.json({ errorcode: 0, data: { deleted: affectedRows > 0, affectedRows } });
  } catch (e) {
    console.error('[settlement.delete] 出错', e);
    return res.status(500).json({ errorcode: 500, errormsg: '删除结算失败' });
  }
});

// 检查后台是否存在结算快照
router.get('/payroll/settlement/check', authRequired, async (req, res) => {
  try {
    const { busId, month } = params(req);
    if (!validateParams(res, busId, month)) return;
    const permissions = ['payroll:settle', 'payroll:restore', 'payroll:reverse'];
    let allowed = false;
    for (const permission of permissions) {
      if (await userHasPermission(req.user.uid, permission, busId)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return res.status(403).json({ errorcode: 403, errormsg: '无权限：查看结算状态' });
    const [rows] = await pool.query(
      'SELECT plan_hash FROM payroll_settlement WHERE bus_id = ? AND month = ?',
      [busId, month]
    );
    if (!rows.length) {
      return res.json({ errorcode: 0, data: { hasSettlement: false, planHash: null } });
    }
    return res.json({ errorcode: 0, data: {
      hasSettlement: true, planHash: rows[0].plan_hash || null,
    } });
  } catch (e) {
    console.error('[settlement.check] 出错', e);
    return res.status(500).json({ errorcode: 500, errormsg: '检查结算失败' });
  }
});


/* ============================================================
 * 未结算草稿：不与正式结算混用
 * GET  /api/payroll/draft?bus_id=&month=
 * PUT  /api/payroll/draft  body: {bus_id, month, results, overrides}
 * DELETE /api/payroll/draft?bus_id=&month=
 * ============================================================ */
router.get('/payroll/draft', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();
    if (!busId || !validMonth(month)) {
      return res.status(400).json({ errorcode: 400, errormsg: 'bus_id 或 month 无效' });
    }
    if (!await userHasPermission(req.user.uid, 'payroll:settle', busId)) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：薪酬草稿' });
    }
    const [rows] = await pool.query(
      'SELECT results_json, overrides_json, updated_at FROM payroll_draft WHERE bus_id = ? AND month = ? LIMIT 1',
      [busId, month]
    );
    if (!rows.length) return res.json({ errorcode: 0, data: null });
    const parse = (v, fallback) => {
      if (v == null) return fallback;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch { return fallback; }
    };
    return res.json({ errorcode: 0, data: {
      results: parse(rows[0].results_json, []),
      overrides: parse(rows[0].overrides_json, {}),
      updatedAt: rows[0].updated_at,
    } });
  } catch (e) {
    console.error('[payroll.draft.get]', e);
    return res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

router.put('/payroll/draft', authRequired, async (req, res) => {
  try {
    const busId = String(req.body?.bus_id || '').trim();
    const month = String(req.body?.month || '').trim();
    const results = req.body?.results;
    const overrides = req.body?.overrides ?? {};
    if (!busId || !validMonth(month) || !Array.isArray(results) ||
        !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return res.status(400).json({ errorcode: 400, errormsg: '草稿参数无效' });
    }
    if (!await userHasPermission(req.user.uid, 'payroll:settle', busId)) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：保存薪酬草稿' });
    }
    // 结算已存在时禁止迟到的自动保存覆盖草稿状态
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [settled] = await conn.query(
        'SELECT id FROM payroll_settlement WHERE bus_id = ? AND month = ? LIMIT 1 FOR UPDATE',
        [busId, month]
      );
      if (settled.length) {
        await conn.rollback();
        return res.status(409).json({ errorcode: 409, errormsg: '该月份已结算，不再接受草稿' });
      }
      await conn.query(
        `INSERT INTO payroll_draft (bus_id, month, results_json, overrides_json, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE results_json = VALUES(results_json),
           overrides_json = VALUES(overrides_json), updated_by = VALUES(updated_by)`,
        [busId, month, JSON.stringify(results), JSON.stringify(overrides), String(req.user.uid || '')]
      );
      await conn.commit();
      return res.json({ errorcode: 0, data: { saved: true } });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally { conn.release(); }
  } catch (e) {
    console.error('[payroll.draft.put]', e);
    return res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

router.delete('/payroll/draft', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();
    if (!busId || !validMonth(month)) {
      return res.status(400).json({ errorcode: 400, errormsg: 'bus_id 或 month 无效' });
    }
    if (!await userHasPermission(req.user.uid, 'payroll:settle', busId)) {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：删除薪酬草稿' });
    }
    const [r] = await pool.query('DELETE FROM payroll_draft WHERE bus_id = ? AND month = ?', [busId, month]);
    return res.json({ errorcode: 0, data: { deleted: r.affectedRows > 0 } });
  } catch (e) {
    console.error('[payroll.draft.delete]', e);
    return res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;
