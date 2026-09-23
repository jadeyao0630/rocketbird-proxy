const express = require('express');
const { http } = require('../http');
const { UPSTREAM } = require('../config');

const router = express.Router();

router.post('/getStaffs', async (req, res, next) => {
  try {
    const params = new URLSearchParams(req.body);
    const response = await http.post(UPSTREAM.staffs, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;