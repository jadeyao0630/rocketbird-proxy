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
const adminAuthRoutes = require('./routes/adminAuth');   // ⭐ 新增

const app = express();

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true, optionsSuccessStatus: 200 }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

app.use('/api', authRoutes);
app.use('/api', classStatsRoutes);
app.use('/api', cutoverRoutes);
app.use('/api', coachRoutes);
app.use('/api', marketersRoutes);
app.use('/api', compensationRoutes);
app.use('/api', adminAuthRoutes);   // ⭐ 新增

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

initDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server running at http://0.0.0.0:${PORT}`);
      console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);
    });
  })
  .catch((err) => {
    console.error('❌ 数据库初始化失败:', err);
    process.exit(1);
  });