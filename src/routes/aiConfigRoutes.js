const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const aiConfig = require('../services/aiConfig');
const storeConfig = require('../services/storeConfig');
const router = express.Router();

function requireLogin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  console.log('[AI Config][auth]', req.method, req.originalUrl, { hasAuthorization: !!auth, hasBearerToken: !!token });
  if (!token) return res.status(401).json({ errorcode: 401, errormsg: '未登录' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'change_this_secret_in_production');
    next();
  } catch {
    res.status(401).json({ errorcode: 401, errormsg: '登录已过期' });
  }
}
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const [users] = await pool.query('SELECT role FROM admin_user WHERE id = ?', [req.user.uid]);
      if (!users.length) return res.status(401).json({ errorcode: 401, errormsg: '用户不存在' });
      if (users[0].role === 'admin') return next();
      const [rows] = await pool.query(
        'SELECT permission FROM user_permission WHERE user_id = ? AND permission = ? LIMIT 1',
        [req.user.uid, permission]
      );
      if (!rows.length) return res.status(403).json({ errorcode: 403, errormsg: `无权限：${permission}` });
      next();
    } catch (e) { next(e); }
  };
}
router.get('/ai/config', requireLogin, requirePermission('store:view'), async (req, res) => {
  try {
    const [prompt, profiles, stores] = await Promise.all([
      aiConfig.getPrompt(), aiConfig.getProfiles(), storeConfig.listStores(),
    ]);
    // 只返回有权限门店的画像，防止越权查看其他门店信息。
    let allowed = stores;
    const [users] = await pool.query('SELECT role FROM admin_user WHERE id = ?', [req.user.uid]);
    if (users[0]?.role !== 'admin') {
      const [rows] = await pool.query('SELECT store_ids FROM user_permission WHERE user_id = ? AND permission = ? LIMIT 1', [req.user.uid, 'store:view']);
      let ids = [];
      try { ids = JSON.parse(rows[0]?.store_ids || '[]'); } catch {}
      if (Array.isArray(ids) && ids.length) allowed = stores.filter(s => ids.map(String).includes(String(s.id)));
    }
    const visible = {};
    for (const s of allowed) {
      visible[String(s.id)] = profiles[String(s.id)] || await aiConfig.getProfile(s.id, s.name);
    }
    res.json({ errorcode: 0, data: { prompt, profiles: visible, defaultPrompt: aiConfig.DEFAULT_SYSTEM_PROMPT, defaultProfiles: Object.fromEntries(allowed.map(s => [String(s.id), aiConfig.getDefaultProfile(s.id, s.name)])) } });
  } catch (e) { res.status(500).json({ errorcode: 500, errormsg: e.message }); }
});
router.put('/ai/config/prompt', requireLogin, requirePermission('store:edit'), async (req, res) => {
  try {
    await aiConfig.savePrompt(req.body?.prompt);
    res.json({ errorcode: 0, data: { prompt: await aiConfig.getPrompt() } });
  } catch (e) { res.status(400).json({ errorcode: 400, errormsg: e.message }); }
});
router.put('/ai/config/profiles/:storeId', requireLogin, requirePermission('store:edit'), async (req, res) => {
  try {
    const id = String(req.params.storeId);
    const stores = await storeConfig.listStores();
    const store = stores.find(s => String(s.id) === id);
    if (!store) return res.status(404).json({ errorcode: 404, errormsg: '门店不存在' });
    const [users] = await pool.query('SELECT role FROM admin_user WHERE id = ?', [req.user.uid]);
    if (users[0]?.role !== 'admin') {
      const [rows] = await pool.query('SELECT store_ids FROM user_permission WHERE user_id = ? AND permission = ? LIMIT 1', [req.user.uid, 'store:edit']);
      let ids = [];
      try { ids = JSON.parse(rows[0]?.store_ids || '[]'); } catch {}
      if (Array.isArray(ids) && ids.length && !ids.map(String).includes(id))
        return res.status(403).json({ errorcode: 403, errormsg: '无该门店编辑权限' });
    }
    const profile = await aiConfig.saveProfile(id, req.body?.profile, store.name);
    res.json({ errorcode: 0, data: { profile } });
  } catch (e) { res.status(400).json({ errorcode: 400, errormsg: e.message }); }
});
module.exports = router;
