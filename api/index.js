import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import serverless from 'serverless-http';
import campaignRoutes from '../backend/routes/campaignRoutes.js';
import trackingRoutes from '../backend/routes/trackingRoutes.js';
import followupRoutes from '../backend/routes/followupRoutes.js';
import sequenceRoutes from '../backend/routes/sequenceRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');

const app = express();

// Vercel routes `/api/*` requests to this function. Depending on the platform
// version, the leading `/api` prefix may be preserved or stripped from the
// incoming path. Normalize so the Express routes below always match.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && req.path !== '/') {
    req.url = '/api' + (req.path.startsWith('/') ? '' : '/') + req.path;
  }
  next();
});

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'email-intelligence-backend',
    time: new Date().toISOString(),
  });
});

// Health-check for the root path so `GET /` does not fall through to the
// 404 handler (which produces `Route not found: GET /` on Vercel).
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'IUOVA SIGN API is running',
  });
});

app.use('/api/campaigns', campaignRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/sequences', sequenceRoutes);

// Serve the built SPA (handles `/` and any non-API client-side route that
// reaches this function). In a correctly configured Vercel deploy, non-API
// GET requests are served as static files via the vercel.json rewrite, so this
// is a safety net.
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// API-only 404 handler.
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { status: 404, message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
});

export const handler = serverless(app);
