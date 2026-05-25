CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_job
  ON conversations (user_id, job_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  source_files JSONB,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv
  ON conversation_messages (conversation_id, created_at ASC);

CREATE OR REPLACE FUNCTION fn_touch_conversation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversations SET updated_at = now() WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_conversation ON conversation_messages;
CREATE TRIGGER trg_touch_conversation
  AFTER INSERT ON conversation_messages
  FOR EACH ROW EXECUTE FUNCTION fn_touch_conversation();

CREATE TABLE IF NOT EXISTS function_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  function_name TEXT NOT NULL,
  embedding vector(1536),
  body_summary TEXT,
  UNIQUE (job_id, file_path, function_name)
);

CREATE INDEX IF NOT EXISTS idx_fn_embeddings_job ON function_embeddings(job_id);
CREATE INDEX IF NOT EXISTS idx_fn_embeddings_ivfflat ON function_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);