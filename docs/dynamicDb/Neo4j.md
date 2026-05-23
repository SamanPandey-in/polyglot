# Neo4j Migrations Guide

This document explains how Neo4j migrations work in this repository and how to run them safely.

Location
- Migration runner: `server/src/infrastructure/db/migrate.js`
- Neo4j driver: `server/src/infrastructure/db/neo4jDriver.js`
- Migration files directory: `server/src/infrastructure/db/migrations/`

Prerequisites
- Set Neo4j connection environment variables in `server/.env` (or system env):
  - `NEO4J_URI` (e.g. `neo4j+s://<your-instance>.databases.neo4j.io`)
  - `NEO4J_USERNAME` (e.g. `neo4j`)
  - `NEO4J_PASSWORD`
- Ensure `neo4j-driver` is installed (it's listed in `server/package.json`).
- If running inside Docker Compose, the backend container must have network access to the Neo4j host.

Migration file conventions
- Files live in `server/src/infrastructure/db/migrations/`.
- File name format: `V001__description.cypher` (version prefix, two underscores, human description).
- Version token is the portion before the first `__` and must be unique (e.g. `V001`, `V002`).
- Files must contain valid Cypher statements. Multiple statements may be separated by one or more blank lines.
- The runner will:
  1. Create a uniqueness constraint on `:__Neo4jMigration.version` (if missing).
  2. Read `.cypher` files sorted by filename.
  3. Skip versions already recorded in the database.
  4. Apply new files and record them as applied by creating `(:__Neo4jMigration { version, filename, appliedAt })` nodes.

Creating a migration example
- Path: `server/src/infrastructure/db/migrations/V001__create_constraints.cypher`

Example contents:

```
CREATE CONSTRAINT IF NOT EXISTS FOR (f:CodeFile) REQUIRE (f.jobId, f.path) IS NODE KEY

CREATE CONSTRAINT IF NOT EXISTS FOR (m:__Neo4jMigration) REQUIRE m.version IS UNIQUE
```

Running migrations locally (Node)
1. From the repository root run (Esm dynamic import):

```bash
node -e "import('./server/src/infrastructure/db/migrate.js').then(m => m.runMigrations()).catch(e=>{console.error(e); process.exit(1)})"
```

2. Or create an npm script in `server/package.json` (example):

```json
"scripts": {
  "neo4j:migrate": "node -e \"import('./src/infrastructure/db/migrate.js').then(m=>m.runMigrations())\""
}
```

Running migrations inside Docker Compose
- If using `docker compose` (backend service name `backend` or `codegraph-backend`), run:

```bash
# run migrations inside the backend container
docker compose exec backend node -e "import('./src/infrastructure/db/migrate.js').then(m=>m.runMigrations()).catch(e=>{console.error(e); process.exit(1)})"

# or using the built image/container name
docker exec -it codegraph-backend node -e "import('./src/infrastructure/db/migrate.js').then(m=>m.runMigrations()).catch(e=>{console.error(e); process.exit(1)})"
```

Automatic migrations at runtime
- The `SupervisorAgent` calls `runMigrations()` automatically when a job selects Neo4j as the repository backend. This means migrations are applied before seeding large graphs when required.

Verifying applied migrations
- Use Cypher to inspect the `__Neo4jMigration` records:

```cypher
MATCH (m:__Neo4jMigration) RETURN m.version AS version, m.filename AS file, m.appliedAt ORDER BY m.appliedAt;
```

Troubleshooting
- **Connection failed with encryption error**: The migration runner now automatically loads `.env` via `dotenv`. Ensure environment variables are set correctly.
- **"Comment-only statements" parsing error**: Comment lines (`//` and `/*`) are automatically filtered by the runner. No action needed.
- Unauthorized / authentication failure: verify `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` and network access.
- Statement failure: the runner logs which statement failed and throws; fix the Cypher and re-run. Applied migrations are recorded; fix the failing migration file and re-run (runner will skip applied versions).
- If you need to re-apply a migration for testing, you can delete the corresponding `__Neo4jMigration` node first (use with caution):

```cypher
MATCH (m:__Neo4jMigration { version: 'V001' }) DETACH DELETE m;
```

## Status ✅

**Migration System**: OPERATIONAL
- Environment variables properly loaded via `dotenv`
- Comment lines automatically filtered from Cypher files
- Schema successfully created in Neo4j Aura
- All constraints and indexes in place
- Integration tests passing (4/4)

Best practices
- Keep migrations small and idempotent where possible (`CREATE CONSTRAINT IF NOT EXISTS`, `MERGE` instead of `CREATE`).
- Use explicit version prefixes and increment strictly.
- Test Cypher statements in the Neo4j Browser or Aura Console before adding them to migration files.

Change Log
- 2026-04-29: Migrations system operational. Fixed dotenv loading in migrate.js. Added comment filtering for .cypher files. Schema successfully created with 4 constraints and 10 indexes.

