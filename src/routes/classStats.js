const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

router.post('/swimming_class_statistics_excel', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.body);
    const response = await http.post(UPSTREAM.swimmingClass, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      responseType: 'arraybuffer', // Excel 二进制
    });
    res.set('Content-Type', 'application/vnd.ms-excel');
    res.send(response.data);
  } catch (err) {
    next(err);
  }
});

router.post('/new_class_statistics_excel', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.body);
    const response = await http.post(UPSTREAM.newClass, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      responseType: 'arraybuffer',
    });
    res.set('Content-Type', 'application/vnd.ms-excel');
    res.send(response.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;