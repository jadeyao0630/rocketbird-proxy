require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 4000,
  TARGET_BASE: process.env.TARGET_BASE || 'https://wx.rocketbird.cn',
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  UPSTREAM: {
    login: `${process.env.TARGET_BASE || 'https://wx.rocketbird.cn'}/Web/Public/check_login`,
    staffs: `${process.env.TARGET_BASE || 'https://wx.rocketbird.cn'}/Web/SalaryRule/get_salary_rule_list`,
    swimmingClass: `${process.env.TARGET_BASE || 'https://wx.rocketbird.cn'}/Web/Class/swimming_class_statistics_excel`,
    newClass: `${process.env.TARGET_BASE || 'https://wx.rocketbird.cn'}/Web/Class/new_class_statistics_excel`,
  },
};
