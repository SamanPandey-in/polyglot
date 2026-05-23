// V001__initial_schema.cypher
// CodeGraph AI — Initial Neo4j Schema
// Compatible with Neo4j Community Edition 5.x
// Each statement is terminated with a semicolon so migrate.js splits correctly.

// ── Migration tracking ────────────────────────────────────────────────────
CREATE CONSTRAINT neo4j_migration_version IF NOT EXISTS
FOR (m:__Neo4jMigration) REQUIRE m.version IS UNIQUE;

// ── AnalysisJob ───────────────────────────────────────────────────────────
CREATE CONSTRAINT job_unique IF NOT EXISTS
FOR (j:AnalysisJob) REQUIRE j.jobId IS UNIQUE;

// ── CodeFile: composite uniqueness (jobId + path) ────────────────────────
// NOTE: IS NODE KEY is Enterprise-only. We use IS UNIQUE (Community-compatible).
CREATE CONSTRAINT codefile_composite IF NOT EXISTS
FOR (f:CodeFile) REQUIRE (f.jobId, f.path) IS UNIQUE;

// ── Symbol (function / class / variable) ─────────────────────────────────
CREATE CONSTRAINT symbol_composite IF NOT EXISTS
FOR (s:Symbol) REQUIRE (s.jobId, s.filePath, s.name, s.kind) IS UNIQUE;

// ── ApiEndpoint ───────────────────────────────────────────────────────────
CREATE CONSTRAINT apiendpoint_composite IF NOT EXISTS
FOR (a:ApiEndpoint) REQUIRE (a.jobId, a.path) IS UNIQUE;

// ── DatabaseTable ─────────────────────────────────────────────────────────
CREATE CONSTRAINT dbtable_composite IF NOT EXISTS
FOR (t:DatabaseTable) REQUIRE (t.jobId, t.name) IS UNIQUE;

// ── EventChannel ──────────────────────────────────────────────────────────
CREATE CONSTRAINT eventchannel_composite IF NOT EXISTS
FOR (e:EventChannel) REQUIRE (e.jobId, e.name) IS UNIQUE;

// ── Performance indexes ───────────────────────────────────────────────────
// Most queries filter by jobId first — this is the most important index.
CREATE INDEX codefile_jobId IF NOT EXISTS
FOR (f:CodeFile) ON (f.jobId);

// File type filter (component | service | util | etc.)
CREATE INDEX codefile_type IF NOT EXISTS
FOR (f:CodeFile) ON (f.type);

// Dead code queries
CREATE INDEX codefile_dead IF NOT EXISTS
FOR (f:CodeFile) ON (f.isDead);

// Symbol lookup by name (used in impact analysis and CALLS traversal)
CREATE INDEX symbol_name IF NOT EXISTS
FOR (s:Symbol) ON (s.name);

// Symbol kind filter (function | class | variable)
CREATE INDEX symbol_kind IF NOT EXISTS
FOR (s:Symbol) ON (s.kind);

// Job status index (used in dashboard queries)
CREATE INDEX job_status IF NOT EXISTS
FOR (j:AnalysisJob) ON (j.status);
