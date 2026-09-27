const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../server/db');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const TOKEN_EXPIRES = '30d';

/* ============================================================
 * 登录
 * POST /api/admin/login
 * ============================================================ */
router.post('/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ errorcode: 400, errormsg: '请输入账号和密码' });
    }

    const [rows] = await pool.query(
      `SELECT id, username, password_hash, display_name FROM admin_user WHERE username = ?`,
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
 * GET /api/admin/me
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
      `SELECT id, username, display_name FROM admin_user WHERE id = ?`,
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
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 修改密码
 * POST /api/admin/change-password
 * Header: Authorization: Bearer xxx
 * body: { oldPassword, newPassword }
 * ============================================================ */
router.post('/admin/change-password', async (req, res) => {
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

    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ errorcode: 400, errormsg: '请输入原密码和新密码' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ errorcode: 400, errormsg: '新密码至少 6 位' });
    }

    const [rows] = await pool.query(
      `SELECT id, password_hash FROM admin_user WHERE id = ?`,
      [payload.uid]
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

    console.log(`[auth] 用户 ${payload.username} 修改了密码`);
    res.json({ errorcode: 0, data: { ok: true } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * 登出（前端清 token 即可）
 * POST /api/admin/logout
 * ============================================================ */
router.post('/admin/logout', (req, res) => {
  res.json({ errorcode: 0 });
});

module.exports = router;