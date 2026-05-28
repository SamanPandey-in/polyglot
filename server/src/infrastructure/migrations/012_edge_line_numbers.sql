-- Migration 012: add source_lines and target_lines to graph_edges for fine-grained impact tracking
ALTER TABLE graph_edges
  ADD COLUMN IF NOT EXISTS source_lines JSONB,
  ADD COLUMN IF NOT EXISTS target_lines JSONB;
