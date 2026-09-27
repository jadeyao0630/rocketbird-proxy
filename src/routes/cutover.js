const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

/**
 * POST /api/cutover
 * 切换场馆
 * body: { bus_id: "12279" }
 */
router.post('/cutover', async (req, res) => {
  try {
    const busId = String(req.body?.bus_id ?? '').trim();
    if (!busId) {
      return res.status(400).json({ error: 'bus_id is required' });
    }

    console.log('[cutover] 切换场馆 bus_id =', busId);

    const params = new URLSearchParams();
    params.append('bus_id', busId);

    const response = await http.post(UPSTREAM.cutover, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    console.log('[cutover] 响应 status =', response.status, 'data =', response.data);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('[cutover] 出错:', err.message);
    res.status(502).json({ error: 'Cutover proxy failed', message: err.message });
  }
});

module.exports = router;