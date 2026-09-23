const axios = require('axios');
const tough = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const cookieJar = new tough.CookieJar();
const http = wrapper(
  axios.create({
    withCredentials: true,
    jar: cookieJar,
    timeout: 15000,
    validateStatus: () => true,
  })
);

module.exports = { http };