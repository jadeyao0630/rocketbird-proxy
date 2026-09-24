const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

/**
 * 通用 Excel 代理
 * @param {string} upstreamUrl 上游地址
 */
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

/* ---------- Excel 导出（原样保留） ---------- */
router.post(
  '/swimming_class_statistics_excel',
  makeExcelProxy(UPSTREAM.swimmingClassExcel)
);
router.post(
  '/new_class_statistics_excel',
  makeExcelProxy(UPSTREAM.coachClassExcel)
);

/* ---------- 统计接口（返回 JSON） ---------- */

/**
 * 通用 JSON 代理
 * @param {string} upstreamUrl
 */
function makeJsonProxy(upstreamUrl) {
  return async (req, res, next) => {
    try {
      const params = new URLSearchParams();
      Object.entries(req.body || {}).forEach(([k, v]) => {
        if (v !== undefined && v !== null) params.append(k, String(v));
      });

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
router.post(
  '/membership_statistics',
  makeJsonProxy(UPSTREAM.membership)
);
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
  makeJsonProxy(UPSTREAM.coachClass)
);

module.exports = router;