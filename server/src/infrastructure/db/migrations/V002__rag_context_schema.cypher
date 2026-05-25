// V002__rag_context_schema.cypher
// CodeGraph AI - RAG context schema for Neo4j Aura
// Supports ChatAgent / GraphRagExpander context retrieval over typed relationships.
// Safe to run repeatedly. Every statement is semicolon-terminated for migrate.js.

// ---------------------------------------------------------------------------
// Path-based target node constraints
// ---------------------------------------------------------------------------
// The persistence layer MERGEs typed targets by { jobId, path }. V001 already
// has several name-based constraints, but RAG retrieval reads target paths.

CREATE CONSTRAINT apiendpoint_path_composite IF NOT EXISTS
FOR (a:ApiEndpoint) REQUIRE (a.jobId, a.path) IS UNIQUE;

CREATE CONSTRAINT dbtable_path_composite IF NOT EXISTS
FOR (t:DatabaseTable) REQUIRE (t.jobId, t.path) IS UNIQUE;

CREATE CONSTRAINT dbfield_path_composite IF NOT EXISTS
FOR (f:DatabaseField) REQUIRE (f.jobId, f.path) IS UNIQUE;

CREATE CONSTRAINT eventchannel_path_composite IF NOT EXISTS
FOR (e:EventChannel) REQUIRE (e.jobId, e.path) IS UNIQUE;

// ---------------------------------------------------------------------------
// Lookup indexes for RAG expansion
// ---------------------------------------------------------------------------
// ChatAgent starts from CodeFile seeds and expands to typed neighbours.

CREATE INDEX apiendpoint_jobId IF NOT EXISTS
FOR (a:ApiEndpoint) ON (a.jobId);

CREATE INDEX dbtable_jobId IF NOT EXISTS
FOR (t:DatabaseTable) ON (t.jobId);

CREATE INDEX dbfield_jobId IF NOT EXISTS
FOR (f:DatabaseField) ON (f.jobId);

CREATE INDEX eventchannel_jobId IF NOT EXISTS
FOR (e:EventChannel) ON (e.jobId);

CREATE INDEX symbol_jobId IF NOT EXISTS
FOR (s:Symbol) ON (s.jobId);

CREATE INDEX apiendpoint_path IF NOT EXISTS
FOR (a:ApiEndpoint) ON (a.path);

CREATE INDEX dbtable_path IF NOT EXISTS
FOR (t:DatabaseTable) ON (t.path);

CREATE INDEX dbfield_path IF NOT EXISTS
FOR (f:DatabaseField) ON (f.path);

CREATE INDEX eventchannel_path IF NOT EXISTS
FOR (e:EventChannel) ON (e.path);

// ---------------------------------------------------------------------------
// Relationship indexes
// ---------------------------------------------------------------------------
// Relationships created by Neo4jGraphRepository carry jobId. These indexes
// help Aura prune relationship scans on large multi-job graphs.

CREATE INDEX imports_rel_jobId IF NOT EXISTS
FOR ()-[r:IMPORTS]-() ON (r.jobId);

CREATE INDEX calls_rel_jobId IF NOT EXISTS
FOR ()-[r:CALLS]-() ON (r.jobId);

CREATE INDEX exposes_api_rel_jobId IF NOT EXISTS
FOR ()-[r:EXPOSES_API]-() ON (r.jobId);

CREATE INDEX consumes_api_rel_jobId IF NOT EXISTS
FOR ()-[r:CONSUMES_API]-() ON (r.jobId);

CREATE INDEX uses_table_rel_jobId IF NOT EXISTS
FOR ()-[r:USES_TABLE]-() ON (r.jobId);

CREATE INDEX uses_field_rel_jobId IF NOT EXISTS
FOR ()-[r:USES_FIELD]-() ON (r.jobId);

CREATE INDEX emits_event_rel_jobId IF NOT EXISTS
FOR ()-[r:EMITS_EVENT]-() ON (r.jobId);

CREATE INDEX listens_event_rel_jobId IF NOT EXISTS
FOR ()-[r:LISTENS_EVENT]-() ON (r.jobId);

// ---------------------------------------------------------------------------
// Display-property backfill for existing Aura data
// ---------------------------------------------------------------------------
// Existing typed target nodes may only have "path" values such as api:/users,
// table:users, field:users.email, or event:user.created. Add friendlier fields
// for future UI/RAG use while preserving the canonical path property.

MATCH (a:ApiEndpoint)
WHERE a.path IS NOT NULL AND a.route IS NULL
SET a.route = CASE
  WHEN a.path STARTS WITH 'api:' THEN substring(a.path, 4)
  ELSE a.path
END;

MATCH (t:DatabaseTable)
WHERE t.path IS NOT NULL AND t.name IS NULL
SET t.name = CASE
  WHEN t.path STARTS WITH 'table:' THEN substring(t.path, 6)
  ELSE t.path
END;

MATCH (f:DatabaseField)
WHERE f.path IS NOT NULL AND f.name IS NULL
SET f.name = CASE
  WHEN f.path STARTS WITH 'field:' THEN substring(f.path, 6)
  ELSE f.path
END;

MATCH (e:EventChannel)
WHERE e.path IS NOT NULL AND e.name IS NULL
SET e.name = CASE
  WHEN e.path STARTS WITH 'event:' THEN substring(e.path, 6)
  ELSE e.path
END;

// ---------------------------------------------------------------------------
// Migration marker for manual Aura runs
// ---------------------------------------------------------------------------
// The Node migration runner also writes this marker after successful execution.
// Keeping it here lets you paste the file into Aura and still avoid reruns.

MERGE (m:__Neo4jMigration { version: 'V002' })
SET m.filename = 'V002__rag_context_schema.cypher',
    m.appliedAt = datetime(),
    m.description = 'RAG context schema for typed relationship retrieval';
