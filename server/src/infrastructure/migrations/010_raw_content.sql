-- Migration 010: add raw_content to graph_nodes and body_source to function_nodes
-- Runs safely: columns nullable to avoid breaking existing rows

ALTER TABLE graph_nodes
  ADD COLUMN IF NOT EXISTS raw_content TEXT;

ALTER TABLE function_nodes
  ADD COLUMN IF NOT EXISTS body_source TEXT;

-- Optional index to speed queries by job/file/name when retrieving function bodies
CREATE INDEX IF NOT EXISTS idx_fn_nodes_job_file_name
  ON function_nodes(job_id, file_path, name);
