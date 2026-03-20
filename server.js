require('dotenv').config();

const express = require('express');
const cors    = require('cors');

// ─── Route imports ───────────────────────────────────────────────────────────
const authRoutes       = require('./routes/auth');
const userRoutes       = require('./routes/users');
const hubRoutes        = require('./routes/hubs');
const employeeRoutes   = require('./routes/employees');
const attendanceRoutes = require('./routes/attendance');
const dutyRoutes       = require('./routes/duty');
const exportRoutes     = require('./routes/export');

// ─── Cron jobs ───────────────────────────────────────────────────────────────
require('./utils/cron');

const app  = express();
const PORT = process.env.PORT || 4000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Large body limit — needed for base64 photo uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/users',      userRoutes);
app.use('/api/hubs',       hubRoutes);
app.use('/api/employees',  employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/duty',       dutyRoutes);
app.use('/api/export',     exportRoutes);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
