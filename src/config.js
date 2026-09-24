require('dotenv').config();

const TARGET = process.env.TARGET_BASE || 'https://wx.rocketbird.cn';

module.exports = {
  PORT: process.env.PORT || 4000,
  TARGET_BASE: TARGET,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  UPSTREAM: {
    login: `${TARGET}/Web/Public/check_login`,
    staffs: `${TARGET}/Web/SalaryRule/get_salary_rule_list`,

    /* 售卡售课 */
    membership: `${TARGET}/Web/Statistics/membership_statistics`,
    swimmingCoach: `${TARGET}/Web/Statistics/swimming_coach_statistics`,
    privateCoach: `${TARGET}/Web/Statistics/private_coach_statistics`,

    /* 消课 */
    swimmingClass: `${TARGET}/Web/Class/swimming_class_statistics`,
    coachClass: `${TARGET}/Web/Statistics/coach_class_statistics`,

    /* Excel */
    swimmingClassExcel: `${TARGET}/Web/Class/swimming_class_statistics_excel`,
    coachClassExcel: `${TARGET}/Web/Class/new_class_statistics_excel`,
  },
};