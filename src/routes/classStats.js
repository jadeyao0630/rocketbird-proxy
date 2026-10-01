const express = require('express');
const { http, cookieJar } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

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

  const map = new Map();
  for (const d of domains) {
    try {
      const cookies = await cookieJar.getCookies(d);
      cookies.forEach((c) => map.set(c.key, c.value));
    } catch {}
  }

  /* 兜底 */
  try {
    const all = await cookieJar.getCookies('https://wx.rocketbird.cn');
    all.forEach((c) => map.set(c.key, c.value));
  } catch {}

  const header = Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  console.log(
    '[stats] 提取 Cookie:',
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

  console.log('[stats] 登录上游，账号:', username);

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
    '[stats] 登录返回:',
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

  console.log('[stats] 切换场馆 bus_id =', busId);
  try {
    const resp = await http.post(UPSTREAM.cutover, params, { headers });
    console.log(
      '[stats] cutover 返回:',
      resp.status,
      resp.data?.errorcode,
      resp.data?.errormsg
    );
  } catch (e) {
    console.warn('[stats] cutover 失败:', e.message);
  }
}

/* ============================================================
 * Excel 代理
 * ============================================================ */
function makeExcelProxy(upstreamUrl) {
  return async (req, res, next) => {
    try {
      const params = new URLSearchParams();
      Object.entries(req.body || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null) params.append(k, String(v));
      });

      const response = await http.post(upstreamUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        responseType: 'arraybuffer',
      });

      res.set('Content-Type', 'application/vnd.ms-excel');
      res.set(
        'Content-Disposition',
        `attachment; filename="export_${Date.now()}.xlsx"`
      );
      res.send(response.data);
    } catch (err) {
      next(err);
    }
  };
}

router.post(
  '/swimming_class_statistics_excel',
  makeExcelProxy(UPSTREAM.swimmingClassExcel)
);
router.post(
  '/new_class_statistics_excel',
  makeExcelProxy(UPSTREAM.coachClassExcel)
);

/* ============================================================
 * 普通 JSON 代理（无需登录）
 * ============================================================ */
function makeJsonProxy(upstreamUrl, extraParams) {
  return async (req, res, next) => {
    try {
      const params = new URLSearchParams();
      Object.entries(req.body || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null) params.append(k, String(v));
      });

      if (extraParams) {
        Object.entries(extraParams).forEach(([k, v]) => {
          if (v !== undefined && v !== null) {
            params.set(k, String(v));
          }
        });
      }

      const response = await http.post(upstreamUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      res.json(response.data);
    } catch (err) {
      next(err);
    }
  };
}

/* 售卡售课业绩 */
router.post('/membership_statistics', makeJsonProxy(UPSTREAM.membership));
router.post(
  '/swimmingCoach_statistics',
  makeJsonProxy(UPSTREAM.swimmingCoach)
);
router.post(
  '/privateCoach_statistics',
  makeJsonProxy(UPSTREAM.privateCoach)
);

/* 消课统计 */
router.post(
  '/swimming_class_statistics',
  makeJsonProxy(UPSTREAM.swimmingClass)
);
router.post(
  '/coach_class_statistic',
  makeJsonProxy(UPSTREAM.coachClass, { type: 2 })
);

/* ============================================================
 * ⭐ card-order-list：需要先登录 + 带 Cookie
 * body: { bus_id, sale_id, begin_date, end_date, page_no, page_size, username, password }
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
      username,
      password,
    } = req.body || {};

    if (!bus_id || !begin_date || !end_date) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'bus_id / begin_date / end_date 必填' });
    }
    if (!username || !password) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺少登录凭据（username / password）' });
    }

    /* 1) 登录 */
    try {
      await loginUpstream(username, password);
    } catch (e) {
      console.error('[card-order-list] 登录失败:', e.message);
      return res.status(500).json({ errorcode: 500, errormsg: e.message });
    }

    /* 2) 提取 Cookie */
    let cookieHeader = await extractCookieHeader();

    /* 3) 切场馆 */
    await cutoverUpstream(bus_id, cookieHeader);

    /* 4) 重新提取 Cookie */
    cookieHeader = await extractCookieHeader();

    /* 5) 构造表单参数 */
    const buildParams = () => {
      const params = new URLSearchParams();
      params.append('bus_id', String(bus_id));
      params.append('sale_id', String(sale_id ?? ''));
      params.append('begin_date', String(begin_date));
      params.append('end_date', String(end_date));
      params.append('page_no', String(page_no));
      params.append('page_size', String(page_size));
      return params;
    };

    const buildHeaders = (cookie) => {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: 'https://vip.rocketbird.cn',
        Origin: 'https://vip.rocketbird.cn',
      };
      if (cookie) headers.Cookie = cookie;
      return headers;
    };

    /* 6) 请求上游 */
    const doFetch = async (cookie) => {
      console.log('[card-order-list] 请求上游:', UPSTREAM.cardOrderList, {
        bus_id,
        sale_id,
        begin_date,
        end_date,
      });
      const resp = await http.post(
        UPSTREAM.cardOrderList,
        buildParams(),
        { headers: buildHeaders(cookie) }
      );
      console.log(
        '[card-order-list] 上游返回:',
        resp.data?.errorcode,
        resp.data?.errormsg
      );
      return resp;
    };

    let resp = await doFetch(cookieHeader);

    /* 7) 会话失效 → 重登重试 */
    if (resp.data?.errorcode === 40025 || resp.data?.errorcode === 40026) {
      console.warn('[card-order-list] 会话失效，重新登录…');
      try {
        await loginUpstream(username, password);
        cookieHeader = await extractCookieHeader();
        await cutoverUpstream(bus_id, cookieHeader);
        cookieHeader = await extractCookieHeader();
        resp = await doFetch(cookieHeader);
        console.log(
          '[card-order-list] 重试后返回:',
          resp.data?.errorcode,
          resp.data?.errormsg
        );
      } catch (e) {
        console.error('[card-order-list] 重登失败:', e.message);
      }
    }

    res.json(resp.data);
  } catch (e) {
    console.error('[card-order-list] 请求失败:', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * ⭐ front-money-list：定金/押金列表
 * 需先登录 + 携带 Cookie
 * ============================================================ */
router.post('/front-money-list', async (req, res) => {
  try {
    const {
      bus_id,
      s_date,
      e_date,
      page_no = 1,
      page_size = 1000,
      username,
      password,
    } = req.body || {};

    if (!bus_id || !s_date || !e_date) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: 'bus_id / s_date / e_date 必填' });
    }
    if (!username || !password) {
      return res
        .status(400)
        .json({ errorcode: 400, errormsg: '缺少登录凭据（username / password）' });
    }

    /* 1) 登录 */
    try {
      await loginUpstream(username, password);
    } catch (e) {
      console.error('[front-money-list] 登录失败:', e.message);
      return res.status(500).json({ errorcode: 500, errormsg: e.message });
    }

    /* 2) 提取 Cookie */
    let cookieHeader = await extractCookieHeader();

    /* 3) 切场馆 */
    await cutoverUpstream(bus_id, cookieHeader);

    /* 4) 重新提取 Cookie */
    cookieHeader = await extractCookieHeader();

    /* 5) 构造表单参数 */
    const buildParams = () => {
      const params = new URLSearchParams();
      params.append('bus_id', String(bus_id));
      params.append('s_date', String(s_date));
      params.append('e_date', String(e_date));
      params.append('page_no', String(page_no));
      params.append('page_size', String(page_size));
      return params;
    };

    const buildHeaders = (cookie) => {
      const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: 'https://vip.rocketbird.cn',
        Origin: 'https://vip.rocketbird.cn',
      };
      if (cookie) headers.Cookie = cookie;
      return headers;
    };

    /* 6) 请求上游 */
    const doFetch = async (cookie) => {
      console.log('[front-money-list] 请求上游:', UPSTREAM.frontMoneyList, {
        bus_id,
        s_date,
        e_date,
      });
      const resp = await http.post(
        UPSTREAM.frontMoneyList,
        buildParams(),
        { headers: buildHeaders(cookie) }
      );
      console.log(
        '[front-money-list] 上游返回:',
        resp.data?.errorcode,
        resp.data?.errormsg
      );
      return resp;
    };

    let resp = await doFetch(cookieHeader);

    /* 7) 会话失效 → 重登重试 */
    if (resp.data?.errorcode === 40025 || resp.data?.errorcode === 40026) {
      console.warn('[front-money-list] 会话失效，重新登录…');
      try {
        await loginUpstream(username, password);
        cookieHeader = await extractCookieHeader();
        await cutoverUpstream(bus_id, cookieHeader);
        cookieHeader = await extractCookieHeader();
        resp = await doFetch(cookieHeader);
      } catch (e) {
        console.error('[front-money-list] 重登失败:', e.message);
      }
    }

    res.json(resp.data);
  } catch (e) {
    console.error('[front-money-list] 请求失败:', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;