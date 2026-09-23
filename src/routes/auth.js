const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.body);
    const response = await http.post(UPSTREAM.login, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://vip.rocketbird.cn',
        Origin: 'https://vip.rocketbird.cn',
      },
    });

    // 透传 Set-Cookie
    (response.headers['set-cookie'] || []).forEach((c) => {
      const [pair, ...attrs] = c.split(';').map((v) => v.trim());
      const [name, value] = pair.split('=');
      const opts = {};
      attrs.forEach((a) => {
        const [k, v] = a.split('=');
        const lk = k.toLowerCase();
        if (lk === 'path') opts.path = v;
        else if (lk === 'max-age') opts.maxAge = parseInt(v, 10) * 1000;
        else if (lk === 'expires') opts.expires = new Date(v);
        else if (lk === 'httponly') opts.httpOnly = true;
        else if (lk === 'secure') opts.secure = true;
        else if (lk === 'samesite') opts.sameSite = v;
      });
      res.cookie(name, value, opts);
    });

    res.status(response.status).json({ success: response.status < 400 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;