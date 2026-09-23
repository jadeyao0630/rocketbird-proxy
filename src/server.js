const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');

const { PORT, FRONTEND_ORIGIN } = require('./config');
const logger = require('./middleware/logger');
const errorHandler = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const staffRoutes = require('./routes/staff');
const classStatsRoutes = require('./routes/classStats');

const app = express();

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(logger);

app.use('/api', authRoutes);
app.use('/api', staffRoutes);
app.use('/api', classStatsRoutes);

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`✅ Proxy running at http://localhost:${PORT}`);
  console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);
});