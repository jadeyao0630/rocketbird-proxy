const express = require('express');
const router = express.Router();
const { http, cookieJar } = require('../http');
const { UPSTREAM } = require('../config');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ============================================================
 * ⭐ 从 jar 里提取 Cookie 字符串
 *   关键：登录域名是 vip.rocketbird.cn，
 *        后续请求是 wx.rocketbird.cn，
 *        跨子域 Cookie 需手动传递。
 * ============================================================ */
async function extractCookieHeader() {
  const domains = [
    'https://vip.rocketbird.cn',
    'https://wx.rocketbird.cn',
    'https://rocketbird.cn',
  ];

  const map = new Map(); // key → value（后写覆盖）
  for (const d of domains) {
    try {
      const cookies = await cookieJar.getCookies(d);
      cookies.forEach((c) => map.set(c.key, c.value));
    } catch {}
  }

  try {
    const all = await cookieJar.getCookies('https://wx.rocketbird.cn');
    all.forEach((c) => map.set(c.key, c.value));
  } catch {}

  const header = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  console.log(
    '[card] 提取 Cookie:',
    Array.from(map.keys()).join(', ') || '(空)'
  );
  return header;
}

/* ============================================================
 * 登录上游
 * ============================================================ */
async function loginUpstream(username, password) {
  if (!username || !password) {
    throw new Error('缺少登录凭据（username / password）');
  }
  if (!UPSTREAM.login) {
    throw new Error('UPSTREAM.login 未配置');
  }

  console.log('[card] 登录上游，账号:', username);

  const params = new URLSearchParams();
  params.append('username', username);
  params.append('password', password);

  const resp = await http.post(UPSTREAM.login, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://vip.rocketbird.cn',
      Origin: 'https://vip.rocketbird.cn',
      'User-Agent': UA,
    },
  });

  console.log(
    '[card] 登录返回:',
    resp.data?.errorcode,
    resp.data?.errormsg,
    'status:',
    resp.status
  );

  if (resp.data?.errorcode !== 0 && resp.status >= 400) {
    throw new Error(`登录失败：${resp.data?.errormsg || '未知错误'}`);
  }

  return true;
}

/* ============================================================
 * 切场馆（如果上游要求）
 * ============================================================ */
async function cutoverUpstream(busId, cookieHeader) {
  if (!UPSTREAM.cutover) return;
  const params = new URLSearchParams();
  params.append('bus_id', busId);

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    Referer: 'https://vip.rocketbird.cn',
    Origin: 'https://vip.rocketbird.cn',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  console.log('[card] 切换场馆 bus_id =', busId);
  try {
    const resp = await http.post(UPSTREAM.cutover, params, { headers });
    console.log(
      '[card] cutover 返回:',
      resp.status,
      resp.data?.errorcode,
      resp.data?.errormsg
    );
  } catch (e) {
    console.warn('[card] cutover 失败:', e.message);
  }
}

/* ============================================================
 * 拉课程列表
 * ============================================================ */
async function fetchCardsFromUpstream(busId, cardType, cookieHeader) {
  const params = {
    bus_id: busId,
    card_type: cardType,
    page_no: 1,
    page_size: 1000,
    sale_status: 1,
  };

  const headers = {
    'User-Agent': UA,
    Referer: 'https://vip.rocketbird.cn',
    Origin: 'https://vip.rocketbird.cn',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  console.log('[card] 请求上游:', UPSTREAM.cardList, params);
  const resp = await http.get(UPSTREAM.cardList, { params, headers });
  console.log(
    '[card] 上游返回:',
    resp.data?.errorcode,
    resp.data?.errormsg
  );
  return resp;
}

/* ============================================================
 * ⭐ 拉销售订单明细（card-order-list）
 * ============================================================ */
async function fetchCardOrderListFromUpstream(params, cookieHeader) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    Referer: 'https://vip.rocketbird.cn',
    Origin: 'https://vip.rocketbird.cn',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  console.log('[card-order] 请求上游:', UPSTREAM.cardOrderList, params);

  /* ⭐ 注意：上游接口是 POST，参数 x-www-form-urlencoded */
  const form = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) form.append(k, String(v));
  });

  const resp = await http.post(UPSTREAM.cardOrderList, form, { headers });
  console.log(
    '[card-order] 上游返回:',
    resp.data?.errorcode,
    resp.data?.errormsg,
    'count:',
    resp.data?.data?.count
  );
  return resp;
}

/* ============================================================
 * POST /api/card/list
 * body: { bus_id, card_type, username, password }
 * ============================================================ */
router.post('/card/list', async (req, res) => {
  try {
    const { bus_id, card_type, username, password } = req.body || {};

    if (!bus_id || !card_type) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'bus_id & card_type required' });
    }
    if (!username || !password) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺少登录凭据' });
    }

    try {
      await loginUpstream(username, password);
    } catch (e) {
      console.error('[card/list] 登录失败:', e.message);
      return res.status(500).json({ errorcode: 500, errormsg: e.message });
    }

    let cookieHeader = await extractCookieHeader();
    await cutoverUpstream(bus_id, cookieHeader);
    cookieHeader = await extractCookieHeader();

    let resp = await fetchCardsFromUpstream(bus_id, card_type, cookieHeader);

    if (resp.data?.errorcode === 40025 || resp.data?.errorcode === 40026) {
      console.warn('[card/list] 会话失效，重新登录…');
      try {
        await loginUpstream(username, password);
        cookieHeader = await extractCookieHeader();
        await cutoverUpstream(bus_id, cookieHeader);
        cookieHeader = await extractCookieHeader();
        resp = await fetchCardsFromUpstream(bus_id, card_type, cookieHeader);
      } catch (e) {
        console.error('[card/list] 重登失败:', e.message);
      }
    }

    res.json(resp.data);
  } catch (e) {
    console.error('[card/list] 请求失败:', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * ⭐ POST /api/card-order-list
 * body: { bus_id, sale_id, begin_date, end_date, page_no?, page_size?, username?, password? }
 *
 * 说明：
 *  - 前端调用此接口时，不需要传 username / password
 *  - 后端会用 .env 里的账号自动登录 + 拿 Cookie + 切场馆 + 拉订单
 * ============================================================ */
router.post('/card-order-list', async (req, res) => {
  try {
    const {
      bus_id,
      sale_id,
      begin_date,
      end_date,
      page_no = 1,
      page_size = 1000,
    } = req.body || {};

    if (!bus_id) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'bus_id 必填' });
    }
    if (!begin_date || !end_date) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'begin_date & end_date 必填' });
    }

    /* ⭐ 从环境变量取账号（前端不用传） */
    const username =
      req.body?.username ||
      process.env.VITE_TEST_USERNAME ||
      process.env.UPSTREAM_USERNAME ||
      '';
    const password =
      req.body?.password ||
      process.env.VITE_TEST_PASSWORD ||
      process.env.UPSTREAM_PASSWORD ||
      '';

    if (!username || !password) {
      return res.status(500).json({
        errorcode: 500,
        errormsg: '后端未配置上游账号（UPSTREAM_USERNAME / UPSTREAM_PASSWORD）',
      });
    }

    /* 1) 登录 */
    try {
      await loginUpstream(username, password);
    } catch (e) {
      console.error('[card-order] 登录失败:', e.message);
      return res.status(500).json({ errorcode: 500, errormsg: e.message });
    }

    /* 2) 提取 Cookie */
    let cookieHeader = await extractCookieHeader();

    /* 3) 切场馆 */
    await cutoverUpstream(bus_id, cookieHeader);

    /* 4) 重新提取 Cookie（切场馆可能又写了） */
    cookieHeader = await extractCookieHeader();

    /* 5) 拉订单（sale_id 留空则拉全店） */
    const params = {
      bus_id,
      sale_id: sale_id || '',
      begin_date,
      end_date,
      page_no,
      page_size,
    };

    let resp = await fetchCardOrderListFromUpstream(params, cookieHeader);

    /* 6) 会话失效 → 重登并重试 */
    if (resp.data?.errorcode === 40025 || resp.data?.errorcode === 40026) {
      console.warn('[card-order] 会话失效，重新登录…');
      try {
        await loginUpstream(username, password);
        cookieHeader = await extractCookieHeader();
        await cutoverUpstream(bus_id, cookieHeader);
        cookieHeader = await extractCookieHeader();
        resp = await fetchCardOrderListFromUpstream(params, cookieHeader);
        console.log(
          '[card-order] 重试后返回:',
          resp.data?.errorcode,
          resp.data?.errormsg
        );
      } catch (e) {
        console.error('[card-order] 重登失败:', e.message);
      }
    }

    res.json(resp.data);
  } catch (e) {
    console.error('[card-order] 请求失败:', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;