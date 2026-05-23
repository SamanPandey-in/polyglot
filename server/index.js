/**
 * BUG 5 FIX: dotenv must be loaded BEFORE any other import.
 *
 * In the original index.js, dotenv.config() was called AFTER several imports
 * including app.js. Because ES modules evaluate top-level code at import time,
 * app.js read process.env.CLIENT_URL, GITHUB_CLIENT_ID etc. while still undefined.
 * CORS and passport were configured with undefined values silently.
 *
 * Fix: call dotenv.config() as the very first statement before any other import.
 */

// ── Step 1: load env vars FIRST ───────────────────────────────────────────
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// ── Step 2: now safe to import modules that read process.env ───────────────
import * as Sentry from '@sentry/node';
import { startAnalysisWorker } from './src/queue/analysisQueue.js';
import { startCacheMetricsPersistence } from './src/infrastructure/cache.js';
import { bootstrapGraphInfrastructure } from './src/infrastructure/db/startup.js';
import { pgPool, redisClient } from './src/infrastructure/connections.js';
import { closeNeo4jDriver } from './src/infrastructure/db/neo4jDriver.js';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    environment:      process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  });
}

// Dynamic import of app.js — env vars are loaded first so CORS and passport
// are configured with correct values
const { default: app } = await import('./app.js');

const PORT = process.env.PORT || 5000;

// ── Graceful shutdown ─────────────────────────────────────────────────────
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal} — closing connections...`);
  await Promise.allSettled([
    pgPool.end().then(() => console.log('[Shutdown] Postgres pool closed')),
    redisClient.quit().then(() => console.log('[Shutdown] Redis client closed')),
    closeNeo4jDriver().then(() => console.log('[Shutdown] Neo4j driver closed')),
  ]);
  console.log('[Shutdown] Done.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Startup ───────────────────────────────────────────────────────────────
await bootstrapGraphInfrastructure();

startAnalysisWorker();
startCacheMetricsPersistence();

// Listen on 0.0.0.0 so Render's internal proxy can reach the service
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
});
