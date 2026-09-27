const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../server/db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const TOKEN_EXPIRES = '30d';

/* ============================================================
 * 中间件：校验 token
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

/* 仅超级管理员 */
async function adminOnly(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT role FROM admin_user WHERE id = ?`,
      [req.user.uid]
    );
    if (rows.length === 0 || rows[0].role !== 'admin') {
      return res.status(403).json({ errorcode: 403, errormsg: '无权限：仅超级管理员可操作' });
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
}

/* ============================================================
 * 登录
 * ============================================================ */
router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ errorcode: 400, errormsg: '请输入账号和密码' });
    }

    const [rows] = await pool.query(
      `SELECT id, username, password_hash, display_name, role
         FROM admin_user WHERE username = ?`,
      [username]
    );
    if (rows.length === 0) {
      return res.status(401).json({ errorcode: 401, errormsg: '账号或密码错误' });
    }
    const user = rows[0];

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ errorcode: 401, errormsg: '账号或密码错误' });
    }

    const token = jwt.sign(
      { uid: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES }
    );

    res.json({
      errorcode: 0,
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role || 'user',
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 校验 token
 * ============================================================ */
router.get('/admin/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) {
      return res.status(401).json({ errorcode: 401, errormsg: '未登录' });
    }

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ errorcode: 401, errormsg: '登录已过期' });
    }

    const [rows] = await pool.query(
      `SELECT id, username, display_name, role FROM admin_user WHERE id = ?`,
      [payload.uid]
    );
    if (rows.length === 0) {
      return res.status(401).json({ errorcode: 401, errormsg: '账号不存在' });
    }
    const user = rows[0];

    res.json({
      errorcode: 0,
      data: {
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          role: user.role || 'user',
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 修改自己的密码
 * ============================================================ */
router.post('/admin/change-password', authRequired, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ errorcode: 400, errormsg: '请输入原密码和新密码' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ errorcode: 400, errormsg: '新密码至少 6 位' });
    }

    const [rows] = await pool.query(
      `SELECT id, password_hash FROM admin_user WHERE id = ?`,
      [req.user.uid]
    );
    if (rows.length === 0) {
      return res.status(401).json({ errorcode: 401, errormsg: '账号不存在' });
    }
    const user = rows[0];

    const ok = await bcrypt.compare(oldPassword, user.password_hash);
    if (!ok) {
      return res.status(400).json({ errorcode: 400, errormsg: '原密码错误' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE admin_user SET password_hash = ? WHERE id = ?`, [
      newHash,
      user.id,
    ]);

    console.log(`[auth] 用户 ${req.user.username} 修改了密码`);
    res.json({ errorcode: 0, data: { ok: true } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 用户列表（仅超管）
 * ============================================================ */
router.get('/admin/users', authRequired, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, display_name AS displayName, role,
              created_at AS createdAt, updated_at AS updatedAt
         FROM admin_user
        ORDER BY id ASC`
    );
    res.json({ errorcode: 0, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 新增用户（仅超管，新增的是普通用户）
 * ============================================================ */
router.post('/admin/users', authRequired, adminOnly, async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ errorcode: 400, errormsg: '请输入账号和密码' });
    }
    const u = String(username).trim();
    if (u.length < 3) {
      return res.status(400).json({ errorcode: 400, errormsg: '账号至少 3 位' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ errorcode: 400, errormsg: '密码至少 6 位' });
    }

    const [exists] = await pool.query(
      `SELECT id FROM admin_user WHERE username = ?`,
      [u]
    );
    if (exists.length > 0) {
      return res.status(409).json({ errorcode: 409, errormsg: '该账号已存在' });
    }

    const hash = await bcrypt.hash(password, 10);
    const display = (displayName && String(displayName).trim()) || u;

    const [r] = await pool.query(
      `INSERT INTO admin_user (username, password_hash, display_name, role)
       VALUES (?, ?, ?, 'user')`,
      [u, hash, display]
    );

    console.log(`[auth] 管理员 ${req.user.username} 新增用户 ${u}`);
    res.json({
      errorcode: 0,
      data: {
        id: r.insertId,
        username: u,
        displayName: display,
        role: 'user',
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 删除用户（仅超管；不能删自己，不能删其他超管）
 * ============================================================ */
router.delete('/admin/users/:id', authRequired, adminOnly, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId)) {
      return res.status(400).json({ errorcode: 400, errormsg: '无效的用户 ID' });
    }
    if (targetId === req.user.uid) {
      return res.status(400).json({ errorcode: 400, errormsg: '不能删除自己' });
    }

    const [rows] = await pool.query(
      `SELECT id, username, role FROM admin_user WHERE id = ?`,
      [targetId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorcode: 404, errormsg: '用户不存在' });
    }

    if (rows[0].role === 'admin') {
      return res.status(400).json({ errorcode: 400, errormsg: '不能删除超级管理员' });
    }

    await pool.query(`DELETE FROM admin_user WHERE id = ?`, [targetId]);

    console.log(`[auth] 管理员 ${req.user.username} 删除了用户 ${rows[0].username}`);
    res.json({ errorcode: 0, data: { ok: true } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * ⭐ 重置用户密码（仅超管）
 * ============================================================ */
router.post(
  '/admin/users/:id/reset-password',
  authRequired,
  adminOnly,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId)) {
        return res.status(400).json({ errorcode: 400, errormsg: '无效的用户 ID' });
      }

      const { newPassword } = req.body || {};
      if (!newPassword) {
        return res.status(400).json({ errorcode: 400, errormsg: '请输入新密码' });
      }
      if (String(newPassword).length < 6) {
        return res.status(400).json({ errorcode: 400, errormsg: '新密码至少 6 位' });
      }

      const [rows] = await pool.query(
        `SELECT id, username, role FROM admin_user WHERE id = ?`,
        [targetId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ errorcode: 404, errormsg: '用户不存在' });
      }

      /* 不允许重置其他超管的密码（可以重置自己） */
      if (rows[0].role === 'admin' && targetId !== req.user.uid) {
        return res.status(400).json({ errorcode: 400, errormsg: '不能重置其他超级管理员的密码' });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query(`UPDATE admin_user SET password_hash = ? WHERE id = ?`, [
        hash,
        targetId,
      ]);

      console.log(
        `[auth] 管理员 ${req.user.username} 重置了用户 ${rows[0].username} 的密码`
      );
      res.json({ errorcode: 0, data: { ok: true } });
    } catch (e) {
      console.error(e);
      res.status(500).json({ errorcode: 500, errormsg: e.message });
    }
  }
);

/* ============================================================
 * 登出
 * ============================================================ */
router.post('/admin/logout', (req, res) => {
  res.json({ errorcode: 0 });
});

module.exports = router;