const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

/* ============================================================
 * ⭐ 唯一 cookieJar：整个进程共享
 * ============================================================ */
const cookieJar = new tough.CookieJar();

/* ============================================================
 * ⭐ 唯一 http 实例：所有上游请求都通过它发出
 * ============================================================ */
const http = wrapper(
  axios.create({
    withCredentials: true,
    jar: cookieJar,
    timeout: 15000,
    validateStatus: () => true,
  })
);

module.exports = { http, cookieJar };