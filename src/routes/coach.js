const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

/**
 * 内部工具：切换场馆
 * 返回 true 表示成功（或至少上游返回 2xx）
 */
async function doCutover(busId) {
  const params = new URLSearchParams();
  params.append('bus_id', String(busId));

  const response = await http.post(UPSTREAM.cutover, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  console.log(
    '[coach] 切换场馆 bus_id =',
    busId,
    '→ status',
    response.status,
    'data',
    response.data
  );

  return response.status >= 200 && response.status < 300;
}

/**
 * POST /api/get_bus_coach_list
 * body: { bus_id: "12279", page_no: 1, page_size: 1000 }
 *
 * 流程：
 *   1. 切换场馆
 *   2. 拉取教练列表
 */
router.post('/get_bus_coach_list', async (req, res) => {
  try {
    const busId = String(req.body?.bus_id ?? '12279').trim();
    const pageNo = String(req.body?.page_no ?? 1);
    const pageSize = String(req.body?.page_size ?? 1000);

    /* 1) 先切换场馆 */
    const ok = await doCutover(busId);
    if (!ok) {
      console.warn('[coach] 切换场馆失败，继续尝试拉取教练列表');
      // 视你的业务需求，如果 cutover 失败就不继续，则改成：
      // return res.status(502).json({ error: 'Cutover failed' });
    }

    /* 2) 拉取教练列表 */
    const params = new URLSearchParams();
    params.append('page_no', pageNo);
    params.append('page_size', pageSize);

    const response = await http.post(UPSTREAM.busCoachList, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    console.log('[coach] 教练列表 status =', response.status);
    res.status(response.status).json(response.data);
  } catch (err) {
    console.error('[coach] 出错:', err.message);
    res.status(502).json({ error: 'Coach proxy failed', message: err.message });
  }
});

module.exports = router;