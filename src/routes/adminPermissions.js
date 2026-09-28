const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET =
  process.env.JWT_SECRET || 'change_this_secret_in_production';

const VALID_PERMISSIONS = new Set([
  'plan:view',
  'plan:edit',
  'target:edit',
  'payroll:calc',
  'user:add',
  'user:resetPwd',
  'simulation:access',
  'simulation:cost:property',
  'simulation:cost:electricity',
  'simulation:cost:rent',
  'simulation:cost:water',
  'simulation:cost:network',
  'simulation:cost:other',
  'simulation:share',
  'simulation:gender',
  'simulation:course',
  'ops:view',
  'export:payroll',
  'export:personal',
]);

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

async function adminOnly(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT role FROM admin_user WHERE id = ?`,
      [req.user.uid]
    );
    if (rows.length === 0 || rows[0].role !== 'admin') {
      return res
        .status(403)
        .json({ errorcode: 403, errormsg: '无权限：仅超级管理员可操作' });
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
}

function parseStoreIds(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function buildConfig(rows) {
  let storeIds = [];
  const permissions = [];
  const seen = new Set();

  rows.forEach((r) => {
    if (r.permission === 'store:access') {
      storeIds = parseStoreIds(r.store_ids);
      return;
    }
    if (!seen.has(r.permission)) {
      seen.add(r.permission);
      permissions.push({ permission: r.permission });
    }
    if (storeIds.length === 0 && rows.length > 0) {
      const first = parseStoreIds(rows[0].store_ids);
      if (first.length > 0) storeIds = first;
    }
  });

  return { storeIds, permissions };
}

router.get('/admin/me/permissions', authRequired, async (req, res) => {
  try {
    const [u] = await pool.query(
      `SELECT role FROM admin_user WHERE id = ?`,
      [req.user.uid]
    );
    if (u.length === 0) {
      return res.status(401).json({ errorcode: 401, errormsg: '账号不存在' });
    }
    if (u[0].role === 'admin') {
      return res.json({
        errorcode: 0,
        data: { storeIds: [], permissions: [] },
      });
    }

    const [rows] = await pool.query(
      `SELECT permission, store_ids FROM user_permission
        WHERE user_id = ? ORDER BY id ASC`,
      [req.user.uid]
    );

    res.json({ errorcode: 0, data: buildConfig(rows) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

router.get(
  '/admin/users/:id/permissions',
  authRequired,
  adminOnly,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ errorcode: 400, errormsg: '无效的用户 ID' });
      }

      const [rows0] = await pool.query(
        `SELECT id, role FROM admin_user WHERE id = ?`,
        [targetId]
      );
      if (rows0.length === 0) {
        return res.status(404).json({ errorcode: 404, errormsg: '用户不存在' });
      }
      if (rows0[0].role === 'admin') {
        return res.json({
          errorcode: 0,
          data: { storeIds: [], permissions: [] },
        });
      }

      const [rows] = await pool.query(
        `SELECT permission, store_ids FROM user_permission
          WHERE user_id = ? ORDER BY id ASC`,
        [targetId]
      );

      res.json({ errorcode: 0, data: buildConfig(rows) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ errorcode: 500, errormsg: e.message });
    }
  }
);

router.put(
  '/admin/users/:id/permissions',
  authRequired,
  adminOnly,
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ errorcode: 400, errormsg: '无效的用户 ID' });
      }

      const [rows0] = await conn.query(
        `SELECT id, role FROM admin_user WHERE id = ?`,
        [targetId]
      );
      if (rows0.length === 0) {
        return res.status(404).json({ errorcode: 404, errormsg: '用户不存在' });
      }
      if (rows0[0].role === 'admin') {
        return res.status(400).json({
          errorcode: 400,
          errormsg: '超级管理员无需配置权限',
        });
      }

      const storeIds = Array.isArray(req.body?.storeIds)
        ? req.body.storeIds.map(String).filter(Boolean)
        : [];
      const rawPerms = Array.isArray(req.body?.permissions)
        ? req.body.permissions
        : [];

      const normalized = [];
      const seen = new Set();
      for (const p of rawPerms) {
        const key = typeof p === 'string' ? p : p?.permission;
        const k = String(key || '').trim();
        if (!k) continue;
        if (!VALID_PERMISSIONS.has(k)) {
          return res.status(400).json({
            errorcode: 400,
            errormsg: `非法权限：${k}`,
          });
        }
        if (seen.has(k)) continue;
        seen.add(k);
        normalized.push(k);
      }

      await conn.beginTransaction();
      await conn.query(`DELETE FROM user_permission WHERE user_id = ?`, [targetId]);
      for (const perm of normalized) {
        await conn.query(
          `INSERT INTO user_permission (user_id, permission, store_ids, granted_by)
           VALUES (?, ?, ?, ?)`,
          [targetId, perm, JSON.stringify(storeIds), req.user.uid]
        );
      }
      await conn.commit();

      console.log(
        `[perm] 管理员 ${req.user.username} 更新了用户 ${targetId} 的权限（门店 ${
          storeIds.length || '全部'
        }，权限 ${normalized.length} 项）`
      );

      res.json({
        errorcode: 0,
        data: { storeIds, permissions: normalized },
      });
    } catch (e) {
      await conn.rollback();
      console.error(e);
      res.status(500).json({ errorcode: 500, errormsg: e.message });
    } finally {
      conn.release();
    }
  }
);

async function userHasPermission(userId, permission, storeId) {
  const [u] = await pool.query(
    `SELECT role FROM admin_user WHERE id = ?`,
    [userId]
  );
  if (u.length === 0) return false;
  if (u[0].role === 'admin') return true;

  const [rows] = await pool.query(
    `SELECT permission, store_ids FROM user_permission WHERE user_id = ?`,
    [userId]
  );
  if (rows.length === 0) return false;

  const hasPermission = rows.some((r) => r.permission === permission);
  if (!hasPermission) return false;

  const storeIds = parseStoreIds(rows[0].store_ids);
  if (storeIds.length === 0) return true;
  if (!storeId) return true;
  return storeIds.includes(String(storeId));
}

module.exports = router;
module.exports.userHasPermission = userHasPermission;
module.exports.parseStoreIds = parseStoreIds;