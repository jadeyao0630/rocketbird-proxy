const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';

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
 * 销售明细
 * ============================================================ */

/* GET /api/payroll/sales-detail?bus_id=xxx&month=xxx */
router.get('/payroll/sales-detail', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();
    if (!busId || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const [rows] = await pool.query(
      `SELECT staff_id, order_id, mode, value
         FROM payroll_sales_detail
        WHERE bus_id = ? AND month = ?`,
      [busId, month]
    );

    res.json({
      errorcode: 0,
      data: rows.map((r) => ({
        staffId: String(r.staff_id),
        orderId: String(r.order_id),
        mode: r.mode || null,
        value: r.value != null ? Number(r.value) : null,
      })),
    });
  } catch (e) {
    console.error('[payrollDetail.sales.get] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* POST /api/payroll/sales-detail
 * body: { bus_id, month, staff_id, order_id, mode, value }
 * mode/value 都为 null 时表示"删除该条自定义" */
router.post('/payroll/sales-detail', authRequired, async (req, res) => {
  try {
    const busId = String(req.body?.bus_id || '').trim();
    const month = String(req.body?.month || '').trim();
    const staffId = String(req.body?.staff_id || '').trim();
    const orderId = String(req.body?.order_id || '').trim();
    const mode = req.body?.mode ?? null;
    const value = req.body?.value ?? null;

    if (!busId || !month || !staffId || !orderId) {
      return res.status(400).json({
        errorcode: 400,
        errormsg: '缺参数 bus_id / month / staff_id / order_id',
      });
    }

    /* ⭐ mode/value 都为空 → 删除（恢复默认） */
    if (mode == null && value == null) {
      await pool.query(
        `DELETE FROM payroll_sales_detail
          WHERE bus_id = ? AND month = ? AND staff_id = ? AND order_id = ?`,
        [busId, month, staffId, orderId]
      );
      return res.json({ errorcode: 0, data: { deleted: true } });
    }

    await pool.query(
      `INSERT INTO payroll_sales_detail
        (bus_id, month, staff_id, order_id, mode, value, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         value = VALUES(value),
         updated_by = VALUES(updated_by)`,
      [busId, month, staffId, orderId, mode, value, req.user?.uid || null]
    );

    res.json({ errorcode: 0, data: { saved: true } });
  } catch (e) {
    console.error('[payrollDetail.sales.post] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 消课明细
 * ============================================================ */

/* GET /api/payroll/class-detail?bus_id=xxx&month=xxx */
router.get('/payroll/class-detail', authRequired, async (req, res) => {
  try {
    const busId = String(req.query.bus_id || '').trim();
    const month = String(req.query.month || '').trim();
    if (!busId || !month) {
      return res.status(400).json({ errorcode: 400, errormsg: '缺参数 bus_id / month' });
    }

    const [rows] = await pool.query(
      `SELECT staff_id, course_name, member_id, mode, value
         FROM payroll_class_detail
        WHERE bus_id = ? AND month = ?
        ORDER BY id ASC`,
      [busId, month]
    );

    res.json({
      errorcode: 0,
      data: rows.map((r) => ({
        staffId: String(r.staff_id),
        courseName: r.course_name,
        memberId: r.member_id || '',
        mode: r.mode || null,
        value: r.value != null ? Number(r.value) : null,
      })),
    });
  } catch (e) {
    console.error('[payrollDetail.class.get] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* POST /api/payroll/class-detail
 * body: { bus_id, month, staff_id, course_name, member_id, mode, value }
 * mode/value 都为 null 时删除 */
router.post('/payroll/class-detail', authRequired, async (req, res) => {
  try {
    const busId = String(req.body?.bus_id || '').trim();
    const month = String(req.body?.month || '').trim();
    const staffId = String(req.body?.staff_id || '').trim();
    const courseName = String(req.body?.course_name || '').trim();
    const memberId = String(req.body?.member_id || '').trim();
    const mode = req.body?.mode ?? null;
    const value = req.body?.value ?? null;

    if (!busId || !month || !staffId || !courseName) {
      return res.status(400).json({
        errorcode: 400,
        errormsg: '缺参数 bus_id / month / staff_id / course_name',
      });
    }

    if (mode == null && value == null) {
      await pool.query(
        `DELETE FROM payroll_class_detail
          WHERE bus_id = ? AND month = ? AND staff_id = ?
            AND course_name = ? AND member_id = ?`,
        [busId, month, staffId, courseName, memberId]
      );
      return res.json({ errorcode: 0, data: { deleted: true } });
    }

    await pool.query(
      `INSERT INTO payroll_class_detail
        (bus_id, month, staff_id, course_name, member_id, mode, value, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         mode = VALUES(mode),
         value = VALUES(value),
         updated_by = VALUES(updated_by)`,
      [busId, month, staffId, courseName, memberId, mode, value, req.user?.uid || null]
    );

    res.json({ errorcode: 0, data: { saved: true } });
  } catch (e) {
    console.error('[payrollDetail.class.post] 出错', e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;