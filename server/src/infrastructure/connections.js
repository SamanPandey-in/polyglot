import { Pool } from 'pg';
import Redis from 'ioredis';

const databaseUrl =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@localhost:5433/codegraph';

const pgPoolMax = Number.parseInt(process.env.PG_POOL_MAX || '10', 10);

/**
 * BUG 2 FIX: Supabase requires SSL on all connections.
 * Without ssl:{rejectUnauthorized:false}, the pg driver throws:
 *   "SSL SYSCALL error: EOF detected" or "ECONNRESET"
 * and every DB query fails immediately.
 *
 * Also: Supabase recommends pool max of 5 on the Session pooler to avoid
 * exhausting PgBouncer connection slots.
 */
const isSupabase = databaseUrl.includes('supabase.com');

export const pgPool = new Pool({
  connectionString: databaseUrl,
  max:              isSupabase ? 5 : (Number.isFinite(pgPoolMax) ? pgPoolMax : 10),
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 10_000,
  // Supabase requires SSL; local Docker does not
  ssl: isSupabase ? { rejectUnauthorized: false } : false,
});

pgPool.on('connect', () => {
  console.log('[Postgres] Connected');
});

pgPool.on('error', (err) => {
  console.error('[Postgres] Pool error:', err.message);
});

// ── Redis ──────────────────────────────────────────────────────────────────
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = Number(process.env.REDIS_PORT || 6379);

const isTestRuntime =
  process.argv.includes('--test') || Boolean(process.env.VITEST);

const redisOptions = {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  ...(isTestRuntime ? { retryStrategy: () => null } : {}),
};

export const redisClient = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, redisOptions)
  : new Redis({ host: redisHost, port: redisPort, ...redisOptions });

redisClient.on('connect', () => {
  console.log('[Redis] Connected');
});

redisClient.on('error', (err) => {
  console.error('[Redis] Error:', err.message);
});

export default { pgPool, redisClient };
