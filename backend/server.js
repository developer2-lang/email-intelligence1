process.on('uncaughtException', (err) => {
  console.error('═══════════════════════════════════════');
  console.error('[FATAL] Uncaught Exception:');
  console.error('  Message:', err.message);
  console.error('  Stack:', err.stack);
  console.error('═══════════════════════════════════════');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('═══════════════════════════════════════');
  console.error('[FATAL] Unhandled Promise Rejection:');
  console.error('  Reason:', reason);
  console.error('  Promise:', promise);
  console.error('═══════════════════════════════════════');
});

process.on('exit', (code) => {
  console.log('[Exit] Process exiting with code:', code);
});

process.on('SIGTERM', () => {
  console.log('[Signal] SIGTERM received');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[Signal] SIGINT received');
  process.exit(0);
});

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });
console.log('[Startup 1/6] dotenv loaded');

console.log('[Env] CWD:', process.cwd());
console.log('[Env] APIFY_TOKEN present:', !!process.env.APIFY_TOKEN);
console.log('[Env] APIFY_TOKEN prefix:', process.env.APIFY_TOKEN?.slice(0, 15) || 'MISSING');
console.log('[Env] APIFY_ACTOR_ID:', process.env.APIFY_ACTOR_ID || 'MISSING');

import express from 'express';
console.log('[Startup 2/6] express imported');

import cors from 'cors';
console.log('[Startup 3/6] cors imported');

import leadRoutes from './routes/leadRoutes.js';
console.log('[Startup 4/6] leadRoutes imported');

const app = express();
app.use(cors());
app.use(express.json());
console.log('[Startup 5/6] middleware configured');

// Health check — responds strictly with JSON
app.get('/api/health', (req, res) => {
  console.log('✅ Health check hit');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Lead routes
app.use('/api/leads', leadRoutes);

// Heartbeat every 5 seconds
setInterval(() => {
  console.log('[Heartbeat] PID', process.pid, 'alive at', new Date().toISOString());
}, 5000);

// Ports 5000 and 5001 are occupied/hijacked by ASUS GlideXService on this machine. Using 5002 to avoid conflict.
const PORT = process.env.PORT || 5002;
const server = app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log('[Startup 6/6] server listening');
});

server.on('error', (err) => {
  console.error('═══════════════════════════════════════');
  console.error('[Server Error]:', err.message);
  console.error('  Code:', err.code);
  console.error('  Stack:', err.stack);
  console.error('═══════════════════════════════════════');
});

server.on('close', () => {
  console.log('[Server Close] Server has closed');
});
