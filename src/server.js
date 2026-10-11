require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const { PORT, FRONTEND_ORIGIN } = require('./config');
const { initDatabase } = require('./db');

const authRoutes = require('./routes/auth');
const classStatsRoutes = require('./routes/classStats');
const cutoverRoutes = require('./routes/cutover');
const coachRoutes = require('./routes/coach');
const marketersRoutes = require('./routes/marketers');
const compensationRoutes = require('./routes/compensation');
const adminAuthRoutes = require('./routes/adminAuth');
const cardRoutes = require('./routes/card');
const adminPermissionsRoutes = require('./routes/adminPermissions');
const payrollStatusRoutes = require('./routes/payrollStatus');
const dingtalkRoutes = require('./routes/dingtalk');
const aiRoutes = require('./routes/ai');
const monthlySummaryRoutes = require('./routes/monthlySummary');
const dingtalkSyncConfigRoutes = require('./routes/dingtalkSyncConfig');

/* ⭐ 钉钉定时同步 */
const { startDingTalkSync } = require('./services/dingtalkSync');

console.log('[boot] 路由模块加载情况：');
console.log('  authRoutes               :', typeof authRoutes, authRoutes?.stack?.length);
console.log('  dingtalkRoutes           :', typeof dingtalkRoutes, dingtalkRoutes?.stack?.length);
console.log('  aiRoutes                 :', typeof aiRoutes, aiRoutes?.stack?.length);
console.log('  monthlySummaryRoutes     :', typeof monthlySummaryRoutes, monthlySummaryRoutes?.stack?.length);
console.log('  dingtalkSyncConfigRoutes :', typeof dingtalkSyncConfigRoutes, dingtalkSyncConfigRoutes?.stack?.length);

const app = express();

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    optionsSuccessStatus: 200,
  })
);

/* ⭐ 放宽 body 限制，避免 413 Payload Too Large */
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(cookieParser());

/* 日志 */
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

/* 路由 */
app.use('/api', authRoutes);
app.use('/api', classStatsRoutes);
app.use('/api', cutoverRoutes);
app.use('/api', coachRoutes);
app.use('/api', marketersRoutes);
app.use('/api', compensationRoutes);
app.use('/api', adminAuthRoutes);
app.use('/api', cardRoutes);
app.use('/api', adminPermissionsRoutes);
app.use('/api', payrollStatusRoutes);
app.use('/api', dingtalkRoutes);
app.use('/api', aiRoutes);
app.use('/api', monthlySummaryRoutes);
app.use('/api', dingtalkSyncConfigRoutes);

/* 健康检查 */
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* 404 */
app.use((req, res) => {
  console.log('[404] 未匹配任何路由：', req.method, req.originalUrl);
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
      console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);

      const routeCount = app._router?.stack?.filter((l) => l.route).length || 0;
      console.log(`   Express 直接注册路由数：${routeCount}`);

      /* ⭐ 启动钉钉定时同步 */
      try {
        startDingTalkSync();
        console.log('   [DingTalkSync] 定时同步已启动');
      } catch (e) {
        console.error('   [DingTalkSync] 启动失败：', e.message);
      }
    });
  })
  .catch((err) => {
    console.error('❌ 数据库初始化失败:', err);
    process.exit(1);
  });