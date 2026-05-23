import { pgPool } from '../connections.js';
import { getNeo4jDriver } from './neo4jDriver.js';
import { runMigrations } from './migrate.js';

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
