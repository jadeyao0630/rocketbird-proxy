const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

/**
 * POST /api/get_marketers_list
 * body: { group_id: "23560", page_no: 1, page_size: 1000 }
 */
router.post('/get_marketers_list', async (req, res) => {
  try {
    console.log('[marketers] body:', req.body);

    const params = new URLSearchParams();
    Object.entries(req.body || {}).forEach(([k, v]) => {
      if (v !== undefined && v !== null) params.append(k, String(v));
    });

    const response = await http.post(UPSTREAM.marketers, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    console.log('[marketers] status:', response.status);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('[marketers] error:', err.message);
    res.status(502).json({ error: 'Marketers proxy failed', message: err.message });
  }
});

module.exports = router;