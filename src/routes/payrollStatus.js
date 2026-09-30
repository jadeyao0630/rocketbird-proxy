const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

/* ============================================================
 * 鉴权中间件
 * ============================================================ */
function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    return res.status(401).json({ errorcode: 401, errormsg: '未登录' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ errorcode: 401, errormsg: '登录已过期' });
  }
}

/* ============================================================
 * ⭐ 注意：路径不带 /api
 * server.js 里是 app.use('/api', payrollStatusRoutes)
 * 所以这里的 '/payroll/staff-status' 最终拼成 '/api/payroll/staff-status'
 * ============================================================ */

/* GET /api/payroll/staff-status?bus_id=xxx&month=xxx */
router.get('/payroll/staff-status', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();

    if (!busId || !month) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const [rows] = await pool.query(
      `SELECT staff_id, staff_name, is_newbie, is_excluded
         FROM payroll_staff_status
        WHERE bus_id = ? AND month = ?
        ORDER BY id ASC`,
      [busId, month]
    );

    res.json({
      errorcode: 0,
      data: rows.map((r) => ({
        staffId: String(r.staff_id),
        staffName: r.staff_name || '',
        isNewbie: !!r.is_newbie,
        isExcluded: !!r.is_excluded,
      })),
    });
  } catch (e) {
    console.error('[payrollStatus.get] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* POST /api/payroll/staff-status */
router.post('/payroll/staff-status', authRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const busId = String(req.body?.bus_id || '').trim();
    const month = String(req.body?.month || '').trim();
    const statuses = Array.isArray(req.body?.statuses)
      ? req.body.statuses
      : [];

    if (!busId || !month) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const payload = statuses
      .map((s) => ({
        staffId: String(s?.staffId || '').trim(),
        staffName: String(s?.staffName || '').trim(),
        isNewbie: !!s?.isNewbie,
        isExcluded: !!s?.isExcluded,
      }))
      .filter((s) => s.staffId && (s.isNewbie || s.isExcluded));

    await conn.beginTransaction();

    await conn.query(
      `DELETE FROM payroll_staff_status WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );

    if (payload.length > 0) {
      const values = payload.map((s) => [
        busId,
        month,
        s.staffId,
        s.staffName || null,
        s.isNewbie ? 1 : 0,
        s.isExcluded ? 1 : 0,
        req.user?.uid || null,
      ]);

      await conn.query(
        `INSERT INTO payroll_staff_status
           (bus_id, month, staff_id, staff_name, is_newbie, is_excluded, updated_by)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();

    console.log(
      `[payrollStatus.post] 门店=${busId} 月份=${month} 保存 ${payload.length} 条`
    );

    res.json({ errorcode: 0, data: { saved: payload.length } });
  } catch (e) {
    await conn.rollback();
    console.error('[payrollStatus.post] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  } finally {
    conn.release();
  }
});

module.exports = router;