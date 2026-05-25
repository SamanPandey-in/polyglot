import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { pgPool } from '../connections.js';
import { getNeo4jDriver } from './neo4jDriver.js';
import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PG_MIGRATIONS_DIR = path.join(__dirname, '../migrations');

async function runPostgresMigrations() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS _pg_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  let files;
  try {
    files = (await fs.readdir(PG_MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
  } catch {
    console.log('[PostgresMigration] No migrations directory found; skipping.');
    return;
  }

  for (const filename of files) {
    const check = await pgPool.query(
      `SELECT 1 FROM _pg_migrations WHERE filename = $1`,
      [filename],
    );
    if (check.rowCount > 0) {
      console.log(`[PostgresMigration] Skipping ${filename} (already applied)`);
      continue;
    }

    console.log(`[PostgresMigration] Applying ${filename}...`);
    const sql = await fs.readFile(path.join(PG_MIGRATIONS_DIR, filename), 'utf8');

    try {
      await pgPool.query(sql);
      await pgPool.query(
        `INSERT INTO _pg_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [filename],
      );
      console.log(`[PostgresMigration] Applied ${filename}`);
    } catch (error) {
      if (
        !error.message?.includes('already exists') &&
        !error.message?.includes('duplicate key')
      ) {
        console.error(`[PostgresMigration] Failed ${filename}:`, error.message);
        throw error;
      }

      console.log(`[PostgresMigration] Marking ${filename} applied after idempotent conflict: ${error.message.split('\n')[0]}`);
      await pgPool.query(
        `INSERT INTO _pg_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [filename],
      ).catch(() => {});
    }
  }

  console.log('[PostgresMigration] All SQL migrations complete.');
}

/**
 * Bootstraps all graph infrastructure at server startup.
 *
 * - Verifies Postgres connectivity
 * - If NEO4J_URI is configured:
 *     - Verifies Neo4j connectivity
 *     - Runs all pending .cypher migrations (idempotent — safe on every restart)
 *
 * Called once from index.js before the HTTP server starts accepting requests.
 */
export async function bootstrapGraphInfrastructure() {
  // ── Postgres ──────────────────────────────────────────────────────────────
  try {
    await pgPool.query('SELECT 1');
    console.log('[GraphInfrastructure] Postgres OK');
  } catch (error) {
    console.error('[GraphInfrastructure] Postgres check FAILED:', error.message);
    // This is fatal — throw so the process exits rather than silently proceeding
    throw error;
  }

  // ── Neo4j (optional) ──────────────────────────────────────────────────────
  try {
    await runPostgresMigrations();
  } catch (error) {
    console.error('[GraphInfrastructure] Postgres migration FAILED:', error.message);
    throw error;
  }

  if (!process.env.NEO4J_URI) {
    console.log('[GraphInfrastructure] NEO4J_URI not set — Neo4j disabled, using Postgres only');
    return;
  }

  try {
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    console.log('[GraphInfrastructure] Neo4j connected');
  } catch (error) {
    // Non-fatal: the dynamic selector will fall back to Postgres for all jobs
    console.warn(
      '[GraphInfrastructure] Neo4j unavailable — graph jobs will use Postgres:',
      error.message,
    );
    return;
  }

  // Run migrations only if Neo4j is reachable
  try {
    await runMigrations();
    console.log('[GraphInfrastructure] Neo4j migrations complete');
  } catch (error) {
    // Non-fatal: schema may already be applied from a previous run.
    // Log prominently but don't crash the server.
    console.error('[GraphInfrastructure] Neo4j migration FAILED (proceeding anyway):', error.message);
  }
}
