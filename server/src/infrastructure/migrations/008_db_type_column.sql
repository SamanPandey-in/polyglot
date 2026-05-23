-- 008_db_type_column.sql
-- Adds a db_type column to analysis_jobs so the application can determine
-- which graph storage backend (postgres | neo4j) backs each job at retrieval
-- time without having to probe both databases.
--
-- Required by:
--   - ImpactAnalysisAgent  (routes BFS to correct backend, avoids wasted Neo4j attempts)
--   - graph.routes.js      (can serve graph payload from the right backend)
--   - Future: UI badge showing "Backed by Neo4j" vs "Backed by Postgres"

ALTER TABLE analysis_jobs
  ADD COLUMN IF NOT EXISTS db_type TEXT NOT NULL DEFAULT 'postgres';

COMMENT ON COLUMN analysis_jobs.db_type IS
  'Graph storage backend for this job: postgres | neo4j. '
  'Set by SupervisorAgent immediately after createGraphRepository() runs.';

-- Index for filtering/monitoring queries ("how many jobs use Neo4j?")
CREATE INDEX IF NOT EXISTS idx_jobs_db_type
  ON analysis_jobs (db_type);

-- Backfill: existing jobs were all on Postgres (Neo4j was not active before this migration)
UPDATE analysis_jobs
  SET db_type = 'postgres'
  WHERE db_type IS NULL OR db_type = '';
