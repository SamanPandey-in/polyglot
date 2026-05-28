-- Migration 011: create directories table for repository hierarchy
CREATE TABLE IF NOT EXISTS directories (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id       UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  parent_directory_id UUID REFERENCES directories(id) ON DELETE CASCADE,
  directory_name      TEXT NOT NULL,
  path                TEXT NOT NULL,
  depth_level         INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, path)
);

CREATE INDEX IF NOT EXISTS idx_dirs_repo_parent
  ON directories (repository_id, parent_directory_id);
