const express = require('express');
const { http, cookieJar } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

/* ============================================================
 * POST /api/login
 * body: { username, password }
 * ============================================================ */
router.post('/login', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.body);

    console.log('[login] 请求上游:', UPSTREAM.login, '账号:', req.body?.username);

    const response = await http.post(UPSTREAM.login, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://vip.rocketbird.cn',
        Origin: 'https://vip.rocketbird.cn',
      },
    });

    console.log(
      '[login] 上游返回:',
      response.data?.errorcode,
      response.data?.errormsg
    );

    /* ⭐ 打印 jar 里现在有哪些 Cookie */
    try {
      const cookies = await cookieJar.getCookies('https://vip.rocketbird.cn');
      console.log(
        '[login] jar(vip) cookie 数:',
        cookies.length,
        cookies.map((c) => c.key).join(', ')
      );
      const cookiesWx = await cookieJar.getCookies('https://wx.rocketbird.cn');
      console.log(
        '[login] jar(wx) cookie 数:',
        cookiesWx.length,
        cookiesWx.map((c) => c.key).join(', ')
      );
    } catch (e) {
      console.warn('[login] 读取 jar 失败:', e.message);
    }

    /* 透传 Set-Cookie 给浏览器（可选） */
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

    res.status(response.status).json(response.data || { success: response.status < 400 });
  } catch (err) {
    console.error('[login] 出错:', err.message);
    next(err);
  }
});

module.exports = router;