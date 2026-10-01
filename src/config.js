require('dotenv').config();

const TARGET = process.env.TARGET_BASE || 'https://wx.rocketbird.cn';

module.exports = {
  PORT: process.env.PORT || 4000,
  TARGET_BASE: TARGET,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  UPSTREAM: {
    /* 登录 */
    login: `${TARGET}/Web/Public/check_login`,

    /* 薪酬规则 */
    staffs: `${TARGET}/Web/SalaryRule/get_salary_rule_list`,

    /* 场馆切换 */
    cutover: `${TARGET}/Admin/Cutover/ajax_cutover`,

    /* 运营团队 */
    marketers: `${TARGET}/Web/Marketers/get_marketers_list`,

    /* 教练列表 */
    busCoachList: `${TARGET}/Web/Coach/get_bus_coach_list`,

    /* 售卡售课 */
    membership: `${TARGET}/Web/Statistics/membership_statistics`,
    swimmingCoach: `${TARGET}/Web/Statistics/swimming_coach_statistics`,
    privateCoach: `${TARGET}/Web/Statistics/private_coach_statistics`,
    cardOrderList: `${TARGET}/Web/Statistics/getFinancialFlowNew`,

    /* 消课 */
    swimmingClass: `${TARGET}/Web/Class/swimming_class_statistics`,
    coachClass: `${TARGET}/Web/Class/new_class_statistics`,

    /* Excel */
    swimmingClassExcel: `${TARGET}/Web/Class/swimming_class_statistics_excel`,
    coachClassExcel: `${TARGET}/Web/Class/new_class_statistics_excel`,

    /* ⭐ 课程列表
     *   card_type: 1=会籍卡 2=私教课 3=泳教课
     */
    cardList: `${TARGET}/Web/Card/get_card_list`,
    frontMoneyList: `${TARGET}/Web/FrontMoney/front_money_list`,
  },
};