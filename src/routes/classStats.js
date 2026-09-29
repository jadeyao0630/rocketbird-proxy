const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

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

/* ⭐ 业务流水：POST，参数走 body */
router.post(
  '/card-order-list',
  makeJsonProxy(UPSTREAM.cardOrderList)
);

module.exports = router;