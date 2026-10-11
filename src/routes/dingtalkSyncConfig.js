const express = require('express');
const router = express.Router();
const sync = require('../services/dingtalkSync');

/* ============================================================
 * GET /api/dingtalk/sync-config
 * ============================================================ */
router.get('/dingtalk/sync-config', async (req, res) => {
  try {
    const cfg = await sync.getConfig();
    res.json({ errorcode: 0, errormsg: '获取成功', data: cfg });
  } catch (e) {
    console.error('[DingTalkSyncConfig] 读取失败', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * POST /api/dingtalk/sync-config
 * body: { enabled, schedule_mode, daily_hour, interval_hours, lookback_days }
 * ============================================================ */
router.post('/dingtalk/sync-config', async (req, res) => {
  try {
    const body = req.body || {};

    /* 简单校验 */
    if (body.daily_hour !== undefined) {
      const h = Number(body.daily_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return res.status(400).json({ errorcode: 400, errormsg: 'daily_hour 必须是 0~23' });
      }
    }
    if (body.interval_hours !== undefined) {
      const v = Number(body.interval_hours);
      if (!Number.isFinite(v) || v < 1 || v > 24) {
        return res.status(400).json({ errorcode: 400, errormsg: 'interval_hours 必须是 1~24' });
      }
    }
    if (body.lookback_days !== undefined) {
      const v = Number(body.lookback_days);
      if (!Number.isFinite(v) || v < 1 || v > 365) {
        return res.status(400).json({ errorcode: 400, errormsg: 'lookback_days 必须是 1~365' });
      }
    }
    if (body.schedule_mode !== undefined) {
      if (!['daily', 'interval'].includes(body.schedule_mode)) {
        return res.status(400).json({ errorcode: 400, errormsg: 'schedule_mode 必须是 daily / interval' });
      }
    }

    await sync.updateConfig(body);
    await sync.restartSchedule();

    const cfg = await sync.getConfig();
    res.json({ errorcode: 0, errormsg: '保存成功', data: cfg });
  } catch (e) {
    console.error('[DingTalkSyncConfig] 保存失败', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

/* ============================================================
 * POST /api/dingtalk/sync-now
 * 立即同步一次
 * ============================================================ */
router.post('/dingtalk/sync-now', async (req, res) => {
  try {
    const result = await sync.runSyncOnce('manual');
    if (!result.ok) {
      return res.status(409).json({ errorcode: 409, errormsg: result.message });
    }
    res.json({ errorcode: 0, errormsg: '同步完成', data: result });
  } catch (e) {
    console.error('[DingTalkSyncConfig] 立即同步失败', e.message);
    res.status(500).json({ errorcode: 500, errormsg: e.message });
  }
});

module.exports = router;