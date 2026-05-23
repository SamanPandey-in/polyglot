import path from 'path';
import { promises as fs } from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { getNeo4jDriver } from './neo4jDriver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const MIGRATIONS_DIR = path.join(process.cwd(), 'src/infrastructure/db/migrations');

/**
 * Ensures the migration tracking constraint exists.
 */
async function ensureMigrationConstraint(session) {
  await session.run(`
    CREATE CONSTRAINT neo4j_migration_version IF NOT EXISTS
    FOR (m:__Neo4jMigration) REQUIRE m.version IS UNIQUE
  `);
}

/**
 * Returns a Set of already-applied migration version strings (e.g. "V001").
 */
async function getAppliedMigrations(session) {
  const result = await session.run(`
    MATCH (m:__Neo4jMigration)
    RETURN m.version AS version
  `);
  return new Set(result.records.map((r) => r.get('version')));
}

/**
 * Marks a migration version as applied in Neo4j.
 */
async function markApplied(session, version, filename) {
  await session.run(
    `MERGE (m:__Neo4jMigration { version: $version })
     SET m.filename = $filename, m.appliedAt = datetime()`,
    { version, filename },
  );
}

/**
 * Splits a Cypher migration file into individual executable statements.
 *
 * Strategy:
 *  1. Strip // and /* line comments per line.
 *  2. Split on semicolons (with optional trailing whitespace/newline).
 *  3. Fall back to splitting on two-or-more consecutive blank lines.
 *  4. Trim and discard empty fragments.
 *
 * This handles both semicolon-terminated files AND the legacy blank-line style.
 */
function splitStatements(cypher) {
  // Strip single-line comments (// ...) — preserve the newline
  const stripped = cypher
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        return '';
      }
      return line;
    })
    .join('\n');

  // Try semicolon splitting first (preferred)
  if (stripped.includes(';')) {
    return stripped
      .split(/;\s*\n?/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Fall back to double-newline splitting (legacy format)
  return stripped
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Runs all pending Neo4j migrations from MIGRATIONS_DIR.
 * Only .cypher files matching V###__*.cypher are considered.
 * Already-applied migrations (tracked in :__Neo4jMigration nodes) are skipped.
 */
export async function runMigrations() {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    console.log('[Neo4jMigration] Starting migration run...');
    await ensureMigrationConstraint(session);

    const applied = await getAppliedMigrations(session);

    // Ensure the directory exists (first-run safety)
    try {
      await fs.mkdir(MIGRATIONS_DIR, { recursive: true });
    } catch {
      // Directory already exists — ignore
    }

    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.cypher'))
      .sort(); // lexicographic sort preserves V001 < V002 < V003 order

    if (files.length === 0) {
      console.log('[Neo4jMigration] No .cypher migration files found.');
      return;
    }

    for (const filename of files) {
      const version = filename.split('__')[0]; // "V001" from "V001__initial_schema.cypher"

      if (applied.has(version)) {
        console.log(`[Neo4jMigration] Skipping ${filename} (already applied)`);
        continue;
      }

      console.log(`[Neo4jMigration] Applying ${filename}...`);
      const cypher = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const stmts = splitStatements(cypher);

      if (stmts.length === 0) {
        console.warn(`[Neo4jMigration] ${filename} produced no executable statements — skipping`);
        continue;
      }

      for (const stmt of stmts) {
        try {
          await session.run(stmt);
        } catch (err) {
          // "already exists" errors are safe to ignore (idempotent migrations)
          if (
            err.message?.includes('already exists') ||
            err.message?.includes('EquivalentSchemaRuleAlreadyExists')
          ) {
            console.log(`[Neo4jMigration]   (idempotent skip) ${err.message.split('\n')[0]}`);
          } else {
            console.error(`[Neo4jMigration] Failed statement in ${filename}:`, err.message);
            throw err;
          }
        }
      }

      await markApplied(session, version, filename);
      console.log(`[Neo4jMigration] Successfully applied ${filename}`);
    }

    console.log('[Neo4jMigration] All migrations completed.');
  } catch (err) {
    console.error('[Neo4jMigration] Migration run failed:', err.message);
    throw err;
  } finally {
    await session.close();
  }
}