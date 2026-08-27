/**
 * Email Intelligence — Backend entry point.
 *
 * Boots the Express server, wires middleware, mounts the campaign workflow
 * routes, starts the cron scheduler, and installs centralized error handling.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import campaignRoutes from './routes/campaignRoutes.js';
import trackingRoutes from './routes/trackingRoutes.js';
import followupRoutes from './routes/followupRoutes.js';
import sequenceRoutes from './routes/sequenceRoutes.js';
import { startEmailWorker } from './workers/emailWorker.js';
import { startSequenceWorker } from './workers/sequenceWorker.js';
import { startCampaignScheduler } from './services/campaignScheduler.js';
import { verifyConnection, sendEmail } from './services/emailService.js';
import trackingConfig from './config/tracking.js';

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Global middleware ────────────────────────────────────────────────────

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

// ─── Routes ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'email-intelligence-backend',
    time: new Date().toISOString(),
  });
});

app.use('/api/campaigns', campaignRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/followups', followupRoutes);
app.use('/api/sequences', sequenceRoutes);

function printRegisteredRoutes() {
  const routes = [];
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods).map((method) => method.toUpperCase()).join(',');
      routes.push(`${methods} ${middleware.route.path}`);
    } else if (middleware.name === 'router' && middleware.handle && middleware.handle.stack) {
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          const methods = Object.keys(handler.route.methods).map((method) => method.toUpperCase()).join(',');
          const prefix = middleware.regexp && middleware.regexp.fast_slash ? '' : (middleware.regexp && middleware.regexp.source ? middleware.regexp.source.replace('^\\', '').replace('\\/?(?=\/|$)', '') : '');
          routes.push(`${methods} ${prefix}${handler.route.path}`);
        }
      });
    }
  });
  console.log('Registered routes:');
  routes.forEach((route) => console.log(`  ${route}`));
}

app.get("/api/test-email", async (req, res) => {
  try {
    const verify = await verifyConnection();

    if (!verify.success) {
      return res.status(500).json({
        success: false,
        message: "SMTP verification failed",
        error: verify.error,
      });
    }

    await sendEmail({
      to: "santararoshni89@gmail.com",
      subject: "Email Intelligence Test",
      html: "<h2>Congratulations!</h2><p>Your Gmail SMTP is working successfully.</p>",
    });

    res.json({
      success: true,
      message: "Test email sent successfully!",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Root health-check so `GET /` does not fall through to the 404 handler.
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'IUOVA SIGN API is running',
  });
});

// ─── 404 handler ──────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { status: 404, message: `Route not found: ${req.method} ${req.originalUrl}` },
  });
});

// ─── Central error handler ────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error.status || 500;

  console.error(`[Error] ${req.method} ${req.originalUrl} — Status: ${status}`);
  console.error(`[Error] Message: ${error.message}`);
  if (error.stack) {
    console.error(`[Error] Stack: ${error.stack}`);
  }

  res.status(status).json({
    success: false,
    error: {
      status,
      message: error.message || 'Internal server error',
    },
  });
});

app.listen(PORT, () => {
  console.log(`✅ Email Intelligence backend running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health`);
  console.log(`   Test email:   http://localhost:${PORT}/api/test-email`);
  console.log('   Campaign workflow routes mounted at /api/campaigns');
  console.log('   Tracking routes mounted at /api/tracking (and /api/track)');
  console.log('   Sequence routes mounted at /api/sequences');
  console.log(`   Tracking base URL (embedded in emails): ${trackingConfig.baseUrl}`);
  printRegisteredRoutes();

  // Start both background services on boot so they always run.
  startEmailWorker();
  startSequenceWorker();
  startCampaignScheduler();
});
