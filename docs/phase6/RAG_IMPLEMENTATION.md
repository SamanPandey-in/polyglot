# Polyglot — Complete RAG System Guide

> **Pre-read:** This guide assumes Phase 5 is fully deployed. The `EmbeddingAgent`,
> `QueryAgent`, pgvector schema, `/api/ai/query`, `/api/ai/explain/stream`, `AiPanel`,
> `QueryBar`, and `AskPage` are already working. This guide fills in the six gaps that
> prevent the current system from qualifying as "complete RAG":
>
> | Gap | What's missing |
> |---|---|
> | **1. Multi-turn conversation** | Every query is stateless — the next question has no memory of the last answer |
> | **2. Streaming Q&A** | `/api/ai/query` blocks until full completion; no progressive text |
> | **3. Source citations** | `highlightedFiles` is returned but never rendered as clickable citations |
> | **4. Chat thread UI** | `QueryBar` is a single-shot search box, not a conversation |
> | **5. Graph-RAG** | Retrieval is vector-only; graph relationships are never used to expand context |
> | **6. Function-level chunks** | Embeddings are file-level; targeted function questions get imprecise results |

---

## Table of Contents

1. [Architecture After This Guide](#1-architecture-after-this-guide)
2. [Database Migration — Conversations Table](#2-database-migration--conversations-table)
3. [Backend — `/api/ai/chat` Streaming Endpoint](#3-backend--apiaichat-streaming-endpoint)
4. [Graph-RAG Context Enrichment](#4-graph-rag-context-enrichment)
5. [Function-Level Chunk Embeddings](#5-function-level-chunk-embeddings)
6. [Frontend — Redux Conversation Slice](#6-frontend--redux-conversation-slice)
7. [Frontend — ChatThread Component](#7-frontend--chatthread-component)
8. [Frontend — SourceCitations Component](#8-frontend--sourcecitations-component)
9. [Frontend — Replace QueryBar on AskPage](#9-frontend--replace-querybar-on-askpage)
10. [Frontend — Inline AiPanel Chat Tab](#10-frontend--inline-aipanel-chat-tab)
11. [aiService Additions](#11-aiservice-additions)
12. [End-to-End Testing Checklist](#12-end-to-end-testing-checklist)

---

## 1. Architecture After This Guide

```
User types question
        │
        ▼
POST /api/ai/chat  (SSE stream)
        │
        ├─ 1. Embed question        → text-embedding-3-small
        │
        ├─ 2. Vector search         → file_embeddings (pgvector cosine)
        │       top-20 candidates
        │
        ├─ 3. Graph-RAG expansion   → graph_edges table
        │       for each top-5 file, fetch direct deps + dependents
        │       merge into context set (deduplicated, max 12 files)
        │
        ├─ 4. Keyword rerank        → existing logic in QueryAgent
        │
        ├─ 5. Build prompt          → system + conversation history
        │       + ranked context files + current question
        │
        ├─ 6. Stream LLM response   → SSE chunks → client
        │
        ├─ 7. On stream done:
        │       save to conversation_messages (PostgreSQL)
        │       save to Redis cache (1 h TTL)
        │
        └─ 8. Return source citations in final SSE event
```

**New files to create:**

```
server/src/api/ai/routes/ai.routes.js          ← ADD /chat route to existing file
server/src/infrastructure/migrations/009_conversations.sql  ← NEW
server/src/agents/query/GraphRagExpander.js    ← NEW
server/src/agents/parser/FunctionChunker.js    ← NEW

client/src/features/ai/slices/conversationSlice.js  ← NEW
client/src/features/ai/components/ChatThread.jsx    ← NEW
client/src/features/ai/components/SourceCitations.jsx ← NEW
client/src/features/ai/components/ChatInput.jsx     ← NEW
```

---

## 2. Database Migration — Conversations Table

Create **`server/src/infrastructure/migrations/009_conversations.sql`**:

```sql
-- ── Conversation sessions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id      UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  title       TEXT,                        -- auto-set from first question (truncated 80 chars)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_user_job
  ON conversations (user_id, job_id, updated_at DESC);

-- ── Individual turns within a conversation ────────────────────────────────
CREATE TABLE IF NOT EXISTS conversation_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  source_files    JSONB,    -- array of file paths used for this assistant turn
  confidence      TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  tokens_used     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_conv
  ON conversation_messages (conversation_id, created_at ASC);

-- ── Trigger: auto-update conversations.updated_at on new message ──────────
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
```

Run it:

```bash
# In your migrate.js script (same pattern as existing migrations):
node server/src/infrastructure/db/migrate.js
# OR directly:
psql $DATABASE_URL -f server/src/infrastructure/migrations/009_conversations.sql
```

---

## 3. Backend — `/api/ai/chat` Streaming Endpoint

### 3a. GraphRagExpander helper

Create **`server/src/agents/query/GraphRagExpander.js`**:

```js
/**
 * GraphRagExpander
 *
 * Given a set of seed file paths (top-K vector search results), fetches their
 * direct graph neighbours (deps + reverse-deps) from graph_edges and merges
 * them into an expanded context set.
 *
 * This is "Graph-RAG": we start from semantically similar files and then
 * walk one hop through the dependency graph to include closely related context
 * the vector search might have missed.
 */
export class GraphRagExpander {
  /**
   * @param {import('pg').Pool} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {string[]} seedPaths  - file paths from vector search
   * @param {string}   jobId
   * @param {object}   options
   * @param {number}   [options.maxExpanded=12]  - hard cap on returned set
   * @param {number}   [options.seedLimit=5]     - only expand the top N seeds
   * @returns {Promise<string[]>}  expanded + deduplicated file path list
   */
  async expand(seedPaths, jobId, { maxExpanded = 12, seedLimit = 5 } = {}) {
    if (!seedPaths.length || !jobId) return seedPaths;

    const seeds = seedPaths.slice(0, seedLimit);

    try {
      // Fetch forward edges (files that seeds import) and
      // backward edges (files that import seeds) in one query
      const { rows } = await this.db.query(
        `
        SELECT DISTINCT
          CASE
            WHEN source_path = ANY($1) THEN target_path
            ELSE source_path
          END AS neighbour
        FROM graph_edges
        WHERE job_id = $2
          AND (source_path = ANY($1) OR target_path = ANY($1))
        `,
        [seeds, jobId],
      );

      const neighbours = rows
        .map(r => r.neighbour)
        .filter(Boolean)
        .filter(p => !seedPaths.includes(p));   // don't duplicate seeds

      // Merge: seeds first (highest relevance), then neighbours
      const merged = [...seedPaths, ...neighbours];

      // Deduplicate while preserving order
      const seen = new Set();
      return merged.filter(p => {
        if (seen.has(p)) return false;
        seen.add(p);
        return true;
      }).slice(0, maxExpanded);

    } catch {
      // Graph expansion is best-effort — fall back to seeds only
      return seedPaths.slice(0, maxExpanded);
    }
  }
}
```

### 3b. Add `/chat` route to `ai.routes.js`

In **`server/src/api/ai/routes/ai.routes.js`**, add these imports at the top alongside the existing ones:

```js
import { GraphRagExpander } from '../../../agents/query/GraphRagExpander.js';
```

Then add the route after the existing `router.post('/snippet-impact', ...)` block:

```js
// ── POST /chat ──────────────────────────────────────────────────────────────
//
// Multi-turn streaming RAG chat. Returns an SSE stream.
// Each SSE event is one of:
//   { type: 'chunk',  text: '...' }        — incremental LLM token
//   { type: 'done',   sources: [...], conversationId: '...', confidence: '...' }
//   { type: 'error',  message: '...' }
//
router.post('/chat', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const question       = String(req.body?.question       || '').trim();
  const jobId          = String(req.body?.jobId          || '').trim();
  const conversationId = String(req.body?.conversationId || '').trim() || null;
  const historyLimit   = Math.min(10, Math.max(0, Number(req.body?.historyLimit ?? 6)));

  if (!question || !jobId) {
    return res.status(400).json({ error: 'question and jobId are required.' });
  }
  if (question.length > 2000) {
    return res.status(400).json({ error: 'Question must be 2000 characters or fewer.' });
  }
  if (!chatClient.isConfigured()) {
    return res.status(503).json({ error: 'AI provider is not configured.' });
  }

  // ── SSE setup ─────────────────────────────────────────────────────────
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  const writeEvent = (payload) => {
    if (clientClosed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  res.status(200);
  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    // ── Resolve user ───────────────────────────────────────────────────
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) {
      writeEvent({ type: 'error', message: 'Failed to resolve user.' });
      return res.end();
    }

    // ── Verify job ownership ───────────────────────────────────────────
    const ownership = await pgPool.query(
      `SELECT 1 FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    if (ownership.rowCount === 0) {
      writeEvent({ type: 'error', message: 'Analysis job not found.' });
      return res.end();
    }

    // ── Redis cache check ──────────────────────────────────────────────
    // Include conversationId so different threads don't collide
    const cacheKey = `chat:${jobId}:${conversationId || 'new'}:${
      crypto.createHash('sha256').update(question).digest('hex')
    }`;
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        writeEvent({ type: 'chunk', text: parsed.text });
        writeEvent({ type: 'done', sources: parsed.sources, conversationId: parsed.conversationId, confidence: parsed.confidence, cached: true });
        return res.end();
      }
    } catch { /* cache miss — proceed */ }

    // ── Resolve or create conversation ─────────────────────────────────
    let activeConvId = conversationId;
    if (!activeConvId) {
      const convResult = await pgPool.query(
        `INSERT INTO conversations (user_id, job_id, title)
         VALUES ($1, $2, $3) RETURNING id`,
        [userId, jobId, question.slice(0, 80)],
      );
      activeConvId = convResult.rows[0].id;
    }

    // ── Load conversation history ──────────────────────────────────────
    const historyResult = await pgPool.query(
      `SELECT role, content FROM conversation_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [activeConvId, historyLimit * 2],   // *2 because each turn = user + assistant
    );
    const history = historyResult.rows.map(r => ({ role: r.role, content: r.content }));

    // ── Embed question → vector search ────────────────────────────────
    const SEMANTIC_LIMIT = 20;
    const CONTEXT_LIMIT  = 12;

    const embeddingResp = await createEmbeddingClient().createEmbedding({
      model: DEFAULT_EMBEDDING_MODEL,
      input: question,
    });
    const queryVector = embeddingResp?.data?.[0]?.embedding;
    const vectorLiteral = queryVector
      ? `[${queryVector.map(Number).filter(Number.isFinite).join(',')}]`
      : null;

    let contextFiles = [];

    if (vectorLiteral) {
      const semanticResult = await pgPool.query(
        `SELECT
           fe.file_path,
           fe.embedding <=> $1::vector AS distance,
           gn.file_type,
           gn.declarations,
           gn.summary
         FROM file_embeddings fe
         JOIN graph_nodes gn
           ON gn.job_id = fe.job_id AND gn.file_path = fe.file_path
         WHERE fe.job_id = $2
         ORDER BY fe.embedding <=> $1::vector
         LIMIT $3`,
        [vectorLiteral, jobId, SEMANTIC_LIMIT],
      );

      const candidates = semanticResult.rows || [];

      // ── Graph-RAG: expand top-5 seeds via dependency edges ─────────
      const seedPaths    = candidates.slice(0, 5).map(r => r.file_path);
      const expander     = new GraphRagExpander(pgPool);
      const expandedPaths = await expander.expand(seedPaths, jobId, { maxExpanded: CONTEXT_LIMIT });

      // Re-fetch metadata for expanded paths that weren't in the original candidates
      const existingPaths = new Set(candidates.map(r => r.file_path));
      const newPaths      = expandedPaths.filter(p => !existingPaths.has(p));

      let expandedRows = [];
      if (newPaths.length > 0) {
        const expandedResult = await pgPool.query(
          `SELECT file_path, file_type, declarations, summary, 1.0 AS distance
           FROM graph_nodes WHERE job_id = $1 AND file_path = ANY($2)`,
          [jobId, newPaths],
        );
        expandedRows = expandedResult.rows;
      }

      // Merge candidates + expanded, keyed by file_path
      const allCandidates = [...candidates, ...expandedRows];
      const byPath = new Map();
      allCandidates.forEach(r => {
        if (!byPath.has(r.file_path)) byPath.set(r.file_path, r);
      });

      // Preserve expanded order (seeds first, then graph neighbours)
      const orderedCandidates = expandedPaths
        .map(p => byPath.get(p))
        .filter(Boolean);

      // Keyword rerank
      const queryTokens = question.toLowerCase().replace(/[^a-z0-9_\-/\s]+/g, ' ').split(/\s+/).filter(t => t.length >= 2);
      contextFiles = orderedCandidates
        .map((c, i) => {
          const haystack = [c.file_path, c.file_type, c.summary,
            (c.declarations || []).map(d => d?.name).join(' ')].filter(Boolean).join(' ').toLowerCase();
          const hits = queryTokens.filter(t => haystack.includes(t)).length;
          const keywordScore = queryTokens.length ? hits / queryTokens.length : 0;
          const semanticScore = 1 - Math.min(1, Math.max(0, Number(c.distance || 0)));
          const positionBoost = (SEMANTIC_LIMIT - i) / SEMANTIC_LIMIT;
          return { ...c, _score: keywordScore * 0.5 + semanticScore * 0.35 + positionBoost * 0.15 };
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, CONTEXT_LIMIT);
    }

    // ── Build LLM prompt ───────────────────────────────────────────────
    const contextBlock = contextFiles.length
      ? contextFiles.map((f, i) => {
          const exports = (f.declarations || []).map(d => d?.name).filter(Boolean).slice(0, 8).join(', ') || 'none';
          return `[Context ${i + 1}] ${f.file_path} (${f.file_type || 'module'})\nSummary: ${f.summary || 'N/A'}\nExports: ${exports}`;
        }).join('\n\n')
      : 'No relevant files found in the codebase for this question.';

    const systemPrompt = [
      'You are an expert codebase architect assistant with deep knowledge of software design.',
      'Answer the user\'s question using ONLY the provided codebase context.',
      'Be specific: reference actual file paths and function names from the context.',
      'If the context is insufficient to answer confidently, say so clearly.',
      'Format your response in plain text. Do not use markdown unless showing a short code snippet.',
      '',
      '=== CODEBASE CONTEXT ===',
      contextBlock,
    ].join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: question },
    ];

    // ── Stream LLM response ────────────────────────────────────────────
    let fullText    = '';
    let streamError = null;

    try {
      const streamSession = await chatClient.createStream({
        model:     defaultChatModel,
        maxTokens: 800,
        messages,
        onText: (text) => {
          if (!clientClosed) {
            writeEvent({ type: 'chunk', text });
            fullText += text;
          }
        },
      });
      await streamSession.consume();
    } catch (streamErr) {
      streamError = streamErr;
      writeEvent({ type: 'error', message: streamErr.message || 'Streaming failed.' });
    }

    if (!streamError && fullText && !clientClosed) {
      const sourcePaths = contextFiles.map(f => f.file_path);

      // Persist to database (non-blocking — don't await in the hot path)
      Promise.all([
        pgPool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
          [activeConvId, question],
        ),
        pgPool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content, source_files, confidence)
           VALUES ($1, 'assistant', $2, $3::jsonb, 'medium')`,
          [activeConvId, fullText, JSON.stringify(sourcePaths)],
        ),
        // Cache the response
        redisClient.setex(cacheKey, 3600, JSON.stringify({
          text: fullText,
          sources: sourcePaths,
          conversationId: activeConvId,
          confidence: 'medium',
        })).catch(() => {}),
      ]).catch(err => console.error('[chat] post-stream persistence error:', err));

      writeEvent({
        type:           'done',
        sources:         sourcePaths,
        conversationId:  activeConvId,
        confidence:      'medium',
      });
    }

    if (!res.writableEnded) res.end();

  } catch (error) {
    if (!res.headersSent) return next(error);
    writeEvent({ type: 'error', message: error.message || 'Chat failed.' });
    if (!res.writableEnded) res.end();
  }
});

// ── GET /conversations ───────────────────────────────────────────────────────
router.get('/conversations', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const jobId  = String(req.query?.jobId || '').trim();
  const limit  = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));

  if (!jobId) return res.status(400).json({ error: 'jobId is required.' });

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve user.' });

    const { rows } = await pgPool.query(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              COUNT(m.id)::int AS message_count
       FROM conversations c
       LEFT JOIN conversation_messages m ON m.conversation_id = c.id
       WHERE c.user_id = $1 AND c.job_id = $2
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT $3`,
      [userId, jobId, limit],
    );

    return res.json({ conversations: rows });
  } catch (error) {
    return next(error);
  }
});

// ── GET /conversations/:id/messages ────────────────────────────────────────
router.get('/conversations/:id/messages', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const convId = String(req.params.id || '').trim();
  if (!convId) return res.status(400).json({ error: 'Conversation ID is required.' });

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve user.' });

    // Ownership check via join
    const { rows } = await pgPool.query(
      `SELECT m.id, m.role, m.content, m.source_files, m.confidence, m.created_at
       FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.id = $1 AND c.user_id = $2
       ORDER BY m.created_at ASC`,
      [convId, userId],
    );

    return res.json({ messages: rows });
  } catch (error) {
    return next(error);
  }
});
```

Also add the missing import at the top of `ai.routes.js`:

```js
import { createEmbeddingClient } from '../../../services/ai/llmProvider.js';

// At the top near other constants:
const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
```

---

## 4. Graph-RAG Context Enrichment

The `GraphRagExpander` created in Section 3a handles this automatically. The key insight is:

```
Vector search finds: "src/auth/middleware.js"  (semantically similar)
Graph expansion adds: "src/auth/routes.js"      (imports middleware)
                      "src/auth/controller.js"  (also imports middleware)
```

The user asked "how does authentication work?" — vector search finds the middleware,
but the controller and routes are equally relevant. Graph traversal finds them without
needing a perfect semantic match.

**No additional code needed** — this is already wired into the `/chat` endpoint above.

---

## 5. Function-Level Chunk Embeddings

Currently `EmbeddingAgent` embeds one vector per file. This section adds a secondary
embedding pass that embeds individual functions, giving precise answers to questions
like *"what does the `createUser` function do?"*.

### 5a. New SQL column

Add to **`server/src/infrastructure/migrations/009_conversations.sql`** (append):

```sql
-- Function-level embeddings (stored separately from file-level)
CREATE TABLE IF NOT EXISTS function_embeddings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  function_name   TEXT NOT NULL,
  embedding       vector(1536),
  body_summary    TEXT,
  UNIQUE (job_id, file_path, function_name)
);

CREATE INDEX IF NOT EXISTS idx_fn_embeddings_job ON function_embeddings(job_id);
CREATE INDEX IF NOT EXISTS idx_fn_embeddings_ivfflat ON function_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
```

### 5b. FunctionChunker

Create **`server/src/agents/parser/FunctionChunker.js`**:

```js
import { pgPool } from '../../infrastructure/connections.js';
import { createEmbeddingClient } from '../../services/ai/llmProvider.js';

const BATCH_SIZE = 50;
const MODEL = process.env.AI_EMBEDDING_MODEL || 'text-embedding-3-small';

/**
 * FunctionChunker
 *
 * Reads function_nodes rows for a given job, generates embeddings for each
 * function's name + signature + file context, and writes them to function_embeddings.
 *
 * Called after EmbeddingAgent completes in the analysis pipeline.
 */
export class FunctionChunker {
  constructor({ db, embeddingClient } = {}) {
    this.db = db || pgPool;
    this.embeddingClient = embeddingClient || createEmbeddingClient();
  }

  /**
   * @param {string} jobId
   * @returns {Promise<{ attempted: number, succeeded: number, failed: number }>}
   */
  async run(jobId) {
    if (!jobId) throw new Error('jobId is required');
    if (!this.embeddingClient.isConfigured()) {
      console.warn('[FunctionChunker] Embedding client not configured — skipping.');
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    // Fetch function nodes with their parent file summaries
    const { rows: fnRows } = await this.db.query(
      `SELECT
         fn.job_id,
         fn.file_path,
         fn.function_name,
         fn.signature,
         fn.body_summary,
         gn.summary AS file_summary,
         gn.file_type
       FROM function_nodes fn
       LEFT JOIN graph_nodes gn
         ON gn.job_id = fn.job_id AND gn.file_path = fn.file_path
       WHERE fn.job_id = $1`,
      [jobId],
    );

    if (!fnRows.length) return { attempted: 0, succeeded: 0, failed: 0 };

    let attempted = fnRows.length, succeeded = 0, failed = 0;

    // Process in batches
    for (let i = 0; i < fnRows.length; i += BATCH_SIZE) {
      const batch = fnRows.slice(i, i + BATCH_SIZE);
      const texts = batch.map(fn => [
        `Function: ${fn.function_name}`,
        `File: ${fn.file_path} (${fn.file_type || 'module'})`,
        fn.signature ? `Signature: ${fn.signature}` : '',
        fn.body_summary ? `Body: ${fn.body_summary}` : '',
        fn.file_summary ? `File context: ${fn.file_summary}` : '',
      ].filter(Boolean).join('\n'));

      try {
        const response = await this.embeddingClient.createEmbedding({ model: MODEL, input: texts });
        const vectors = response?.data || [];

        // Bulk upsert
        const paths    = batch.map(fn => fn.file_path);
        const names    = batch.map(fn => fn.function_name);
        const summaries = batch.map(fn => fn.body_summary || null);
        const embStrings = vectors.map(v =>
          Array.isArray(v?.embedding) ? `[${v.embedding.join(',')}]` : null,
        );

        for (let j = 0; j < batch.length; j++) {
          if (!embStrings[j]) { failed++; continue; }
          await this.db.query(
            `INSERT INTO function_embeddings (job_id, file_path, function_name, embedding, body_summary)
             VALUES ($1, $2, $3, $4::vector, $5)
             ON CONFLICT (job_id, file_path, function_name) DO UPDATE
               SET embedding = EXCLUDED.embedding, body_summary = EXCLUDED.body_summary`,
            [jobId, paths[j], names[j], embStrings[j], summaries[j]],
          );
          succeeded++;
        }
      } catch (err) {
        console.error('[FunctionChunker] batch error:', err.message);
        failed += batch.length;
      }
    }

    return { attempted, succeeded, failed };
  }
}
```

### 5c. Wire into the analysis pipeline

In **`server/src/agents/core/SupervisorAgent.js`**, find the section that calls
`EmbeddingAgent` and add a call to `FunctionChunker` immediately after:

```js
// ADD this import at top of SupervisorAgent.js:
import { FunctionChunker } from '../parser/FunctionChunker.js';

// FIND the existing embedding step in runPipeline() — looks roughly like:
const embeddingResult = await this.embeddingAgent.process(embeddingInput, context);

// ADD these lines directly after:
try {
  const chunker = new FunctionChunker();
  const chunkStats = await chunker.run(context.jobId);
  this.logger?.info(`[SupervisorAgent] FunctionChunker: ${chunkStats.succeeded}/${chunkStats.attempted} functions embedded`);
} catch (chunkErr) {
  // Function chunking is non-critical — log and continue
  this.logger?.warn('[SupervisorAgent] FunctionChunker failed (non-fatal):', chunkErr.message);
}
```

### 5d. Use function embeddings in `/chat` retrieval (optional enhancement)

Inside the `/chat` route's retrieval block, after the file-level vector search,
add a secondary function-level search and merge:

```js
// After the file-level contextFiles is built, add this block:
if (vectorLiteral) {
  const fnResult = await pgPool.query(
    `SELECT file_path, function_name, body_summary, embedding <=> $1::vector AS distance
     FROM function_embeddings
     WHERE job_id = $2
     ORDER BY embedding <=> $1::vector
     LIMIT 6`,
    [vectorLiteral, jobId],
  );

  // Promote files whose functions scored high — they get a relevance boost
  const highScoringFiles = new Set(
    fnResult.rows
      .filter(r => Number(r.distance) < 0.35)   // cosine distance < 0.35 = strong match
      .map(r => r.file_path),
  );

  // Re-sort contextFiles: files with high-scoring functions float to the top
  contextFiles.sort((a, b) => {
    const aBoost = highScoringFiles.has(a.file_path) ? 1 : 0;
    const bBoost = highScoringFiles.has(b.file_path) ? 1 : 0;
    if (bBoost !== aBoost) return bBoost - aBoost;
    return b._score - a._score;
  });
}
```

---

## 6. Frontend — Redux Conversation Slice

Create **`client/src/features/ai/slices/conversationSlice.js`**:

```js
import { createSlice } from '@reduxjs/toolkit';

/**
 * Manages the active chat conversation for the current graph job.
 *
 * A "conversation" is a list of { role, content, sources, id } messages.
 * It is local to the session — on page refresh it reloads from the backend.
 */
const conversationSlice = createSlice({
  name: 'conversation',
  initialState: {
    // Active conversation
    conversationId:   null,    // UUID from backend once first message is sent
    messages:         [],      // { id, role, content, sources, isStreaming }
    jobId:            null,    // the jobId this conversation belongs to

    // Streaming state
    streamingText:    '',      // accumulated text for the in-flight assistant turn
    isStreaming:      false,
    streamError:      null,

    // Conversation list (sidebar)
    history:          [],      // [{ id, title, updatedAt, messageCount }]
    historyStatus:    'idle',  // 'idle'|'loading'|'succeeded'|'failed'
  },
  reducers: {
    // ── Session management ───────────────────────────────────────────────
    initConversation(state, action) {
      const { jobId } = action.payload;
      // Start fresh when switching to a new job
      if (state.jobId !== jobId) {
        state.conversationId = null;
        state.messages       = [];
        state.streamingText  = '';
        state.isStreaming    = false;
        state.streamError    = null;
        state.jobId          = jobId;
      }
    },
    clearConversation(state) {
      state.conversationId = null;
      state.messages       = [];
      state.streamingText  = '';
      state.isStreaming    = false;
      state.streamError    = null;
    },

    // ── User turn ────────────────────────────────────────────────────────
    addUserMessage(state, action) {
      state.messages.push({
        id:          `user-${Date.now()}`,
        role:        'user',
        content:     action.payload.content,
        sources:     [],
        isStreaming: false,
      });
    },

    // ── Streaming assistant turn ─────────────────────────────────────────
    beginStreaming(state) {
      state.isStreaming   = true;
      state.streamingText = '';
      state.streamError   = null;
    },
    appendStreamChunk(state, action) {
      state.streamingText += action.payload.text;
    },
    finalizeStream(state, action) {
      const { conversationId, sources } = action.payload;
      state.isStreaming    = false;
      state.conversationId = conversationId || state.conversationId;
      // Commit the streamed message into the messages array
      state.messages.push({
        id:          `assistant-${Date.now()}`,
        role:        'assistant',
        content:     state.streamingText,
        sources:     sources || [],
        isStreaming: false,
      });
      state.streamingText = '';
    },
    setStreamError(state, action) {
      state.isStreaming  = false;
      state.streamError  = action.payload.message;
      state.streamingText = '';
    },

    // ── History (sidebar) ────────────────────────────────────────────────
    setHistoryStatus(state, action) { state.historyStatus = action.payload; },
    setHistory(state, action)       { state.history = action.payload; },

    // ── Load a past conversation into the active thread ──────────────────
    loadConversationMessages(state, action) {
      const { conversationId, messages } = action.payload;
      state.conversationId = conversationId;
      state.messages = messages.map((m, i) => ({
        id:          m.id || `loaded-${i}`,
        role:        m.role,
        content:     m.content,
        sources:     Array.isArray(m.source_files) ? m.source_files : [],
        isStreaming: false,
      }));
      state.streamingText = '';
      state.isStreaming   = false;
      state.streamError   = null;
    },
  },
});

export const {
  initConversation,
  clearConversation,
  addUserMessage,
  beginStreaming,
  appendStreamChunk,
  finalizeStream,
  setStreamError,
  setHistoryStatus,
  setHistory,
  loadConversationMessages,
} = conversationSlice.actions;

// Selectors
export const selectConversationId   = s => s.conversation.conversationId;
export const selectMessages         = s => s.conversation.messages;
export const selectIsStreaming      = s => s.conversation.isStreaming;
export const selectStreamingText    = s => s.conversation.streamingText;
export const selectStreamError      = s => s.conversation.streamError;
export const selectConvHistory      = s => s.conversation.history;
export const selectHistoryStatus    = s => s.conversation.historyStatus;

export default conversationSlice.reducer;
```

Register in your Redux store. In **`client/src/store/index.js`** (or wherever your
root reducer is):

```js
import conversationReducer from '../features/ai/slices/conversationSlice';

export const store = configureStore({
  reducer: {
    // ... existing reducers ...
    conversation: conversationReducer,
  },
});
```

---

## 7. Frontend — ChatThread Component

Create **`client/src/features/ai/components/ChatThread.jsx`**:

```jsx
import React, { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { Bot, User, AlertCircle, Loader2 } from 'lucide-react';
import {
  selectMessages,
  selectIsStreaming,
  selectStreamingText,
  selectStreamError,
} from '../slices/conversationSlice';
import SourceCitations from './SourceCitations';

function UserBubble({ message }) {
  return (
    <div className="flex justify-end gap-2">
      <div
        className="max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm"
        style={{ background: '#3b82f6', color: '#fff' }}
      >
        {message.content}
      </div>
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
        style={{ background: 'rgba(59,130,246,0.15)' }}
      >
        <User size={14} style={{ color: '#3b82f6' }} />
      </div>
    </div>
  );
}

function AssistantBubble({ message, isStreaming = false }) {
  return (
    <div className="flex gap-2">
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center mt-0.5"
        style={{ background: 'rgba(168,85,247,0.12)' }}
      >
        {isStreaming
          ? <Loader2 size={14} className="animate-spin" style={{ color: '#a855f7' }} />
          : <Bot size={14} style={{ color: '#a855f7' }} />
        }
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div
          className="rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' }}
        >
          {message.content}
          {isStreaming && (
            <span
              className="ml-1 inline-block w-1.5 h-3.5 align-middle animate-pulse rounded-sm"
              style={{ background: '#a855f7' }}
            />
          )}
        </div>
        {/* Source citations — only show for committed messages */}
        {!isStreaming && message.sources?.length > 0 && (
          <SourceCitations sources={message.sources} />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 py-12 text-center">
      <div
        className="w-12 h-12 rounded-2xl flex items-center justify-center"
        style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)' }}
      >
        <Bot size={22} style={{ color: '#a855f7' }} />
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          Ask anything about your codebase
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
          Questions are answered using the scanned dependency graph
        </p>
      </div>
      <div className="flex flex-col gap-1.5 mt-2 w-full max-w-xs">
        {[
          'What are the most imported files?',
          'How does authentication flow through the app?',
          'Which files have the highest risk score?',
        ].map(hint => (
          <p
            key={hint}
            className="text-xs px-3 py-1.5 rounded-lg text-left"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            "{hint}"
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * ChatThread
 *
 * Renders the full conversation — committed messages + the in-flight streaming
 * assistant response. Auto-scrolls to the bottom on each new token.
 */
export default function ChatThread() {
  const messages      = useSelector(selectMessages);
  const isStreaming   = useSelector(selectIsStreaming);
  const streamingText = useSelector(selectStreamingText);
  const streamError   = useSelector(selectStreamError);
  const bottomRef     = useRef(null);

  // Auto-scroll to bottom whenever the thread grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streamingText]);

  if (!messages.length && !isStreaming) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-4 py-4 px-1 overflow-y-auto">
      {messages.map(msg =>
        msg.role === 'user'
          ? <UserBubble   key={msg.id} message={msg} />
          : <AssistantBubble key={msg.id} message={msg} />
      )}

      {/* In-flight streaming response */}
      {isStreaming && (
        <AssistantBubble
          message={{ content: streamingText || '', sources: [] }}
          isStreaming
        />
      )}

      {/* Stream error */}
      {streamError && !isStreaming && (
        <div
          className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444' }}
        >
          <AlertCircle size={15} className="shrink-0 mt-0.5" />
          {streamError}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
```

---

## 8. Frontend — SourceCitations Component

Create **`client/src/features/ai/components/SourceCitations.jsx`**:

```jsx
import React, { useState } from 'react';
import { FileCode2, ChevronDown, ChevronUp } from 'lucide-react';

function getFileLabel(path) {
  return path.split('/').pop() || path;
}

function getFileCluster(path) {
  const p = path.toLowerCase();
  if (/test|spec/.test(p))        return { label: 'Test',    color: '#94a3b8' };
  if (/component|page|view/.test(p)) return { label: 'UI',  color: '#38bdf8' };
  if (/controller|route/.test(p)) return { label: 'API',     color: '#4ade80' };
  if (/service|util|lib/.test(p)) return { label: 'Service', color: '#2dd4bf' };
  if (/db|model|schema/.test(p))  return { label: 'Data',    color: '#fbbf24' };
  return { label: 'File', color: '#94a3b8' };
}

/**
 * SourceCitations
 *
 * Renders the list of files the assistant used to answer the question.
 * Collapsible — shows the top 3 inline, rest behind a "show more" toggle.
 */
export default function SourceCitations({ sources = [] }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;

  const shown  = expanded ? sources : sources.slice(0, 3);
  const hidden = sources.length - 3;

  return (
    <div className="space-y-1">
      <p className="text-[10px] uppercase font-semibold tracking-widest" style={{ color: 'var(--text-muted)' }}>
        Sources ({sources.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map(path => {
          const cluster = getFileCluster(path);
          return (
            <span
              key={path}
              title={path}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono"
              style={{
                background: `${cluster.color}15`,
                border: `1px solid ${cluster.color}40`,
                color: cluster.color,
              }}
            >
              <FileCode2 size={10} />
              {getFileLabel(path)}
            </span>
          );
        })}

        {!expanded && hidden > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px]"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            +{hidden} more <ChevronDown size={10} />
          </button>
        )}
        {expanded && hidden > 0 && (
          <button
            onClick={() => setExpanded(false)}
            className="flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px]"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            Show less <ChevronUp size={10} />
          </button>
        )}
      </div>
    </div>
  );
}
```

---

## 9. Frontend — Replace QueryBar on AskPage

Create **`client/src/features/ai/components/ChatInput.jsx`**:

```jsx
import React, { useRef, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SendHorizonal, Square, Plus } from 'lucide-react';
import {
  addUserMessage,
  beginStreaming,
  appendStreamChunk,
  finalizeStream,
  setStreamError,
  clearConversation,
  selectIsStreaming,
  selectConversationId,
} from '../slices/conversationSlice';
import { aiService } from '../services/aiService';
import { selectGraphData } from '../../graph/slices/graphSlice';

const MAX_ROWS = 6;

/**
 * ChatInput
 *
 * Auto-resizing textarea + send button.
 * Dispatches the streaming chat flow against POST /api/ai/chat.
 */
export default function ChatInput() {
  const dispatch       = useDispatch();
  const isStreaming    = useSelector(selectIsStreaming);
  const convId         = useSelector(selectConversationId);
  const graphData      = useSelector(selectGraphData);
  const jobId          = graphData?.jobId || null;
  const abortRef       = useRef(null);
  const textareaRef    = useRef(null);

  const [text, setText] = React.useState('');

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * 24)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !!jobId && !isStreaming;

  const handleSend = async () => {
    if (!canSend) return;
    const question = text.trim();
    setText('');
    textareaRef.current?.focus();

    dispatch(addUserMessage({ content: question }));
    dispatch(beginStreaming());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await aiService.streamChat({
        question,
        jobId,
        conversationId: convId,
        signal: controller.signal,
        onChunk:  text  => dispatch(appendStreamChunk({ text })),
        onDone:   event => dispatch(finalizeStream({ conversationId: event.conversationId, sources: event.sources })),
        onError:  err   => dispatch(setStreamError({ message: err?.message || 'Chat failed.' })),
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        dispatch(setStreamError({ message: err.message || 'Chat failed.' }));
      }
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    dispatch(setStreamError({ message: 'Response cancelled.' }));
  };

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  return (
    <div
      className="flex items-end gap-2 rounded-2xl px-3 py-2"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      {/* New conversation button */}
      <button
        onClick={() => dispatch(clearConversation())}
        title="Start new conversation"
        className="shrink-0 p-1.5 rounded-lg transition-colors mb-0.5"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-muted)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <Plus size={15} />
      </button>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={jobId ? 'Ask about your codebase… (Shift+Enter for new line)' : 'Run an analysis first'}
        disabled={!jobId || isStreaming}
        rows={1}
        className="flex-1 bg-transparent outline-none resize-none text-sm py-1.5"
        style={{ color: 'var(--text)', maxHeight: `${MAX_ROWS * 24}px`, lineHeight: '24px' }}
      />

      {isStreaming ? (
        <button
          onClick={handleStop}
          className="shrink-0 p-2 rounded-xl mb-0.5 transition-colors"
          style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
          title="Stop generating"
        >
          <Square size={15} />
        </button>
      ) : (
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="shrink-0 p-2 rounded-xl mb-0.5 transition-all"
          style={{
            background: canSend ? '#3b82f6' : 'var(--bg-muted)',
            color:      canSend ? '#fff'    : 'var(--text-muted)',
          }}
          title="Send"
        >
          <SendHorizonal size={15} />
        </button>
      )}
    </div>
  );
}
```

### Update `AskPage.jsx`

Replace the `<QueryBar jobId={activeJobId} />` section with:

```jsx
// New imports at top of AskPage.jsx
import ChatThread from '../components/ChatThread';
import ChatInput  from '../components/ChatInput';
import { initConversation } from '../slices/conversationSlice';

// Inside the component, add this useEffect:
useEffect(() => {
  if (activeJobId) dispatch(initConversation({ jobId: activeJobId }));
}, [activeJobId, dispatch]);

// Replace the <article> that contained <QueryBar> with:
<article className="flex flex-col min-h-0 rounded-2xl border border-border/60 bg-card/40 shadow-sm">
  {/* Thread */}
  <div className="flex-1 overflow-y-auto min-h-0 px-4">
    <ChatThread />
  </div>
  {/* Input */}
  <div className="shrink-0 p-4 border-t border-border/40">
    <ChatInput />
  </div>
</article>
```

---

## 10. Frontend — Inline AiPanel Chat Tab

The existing `AiPanel` (shown when you click a node) should get a "Chat" tab
so users can ask follow-up questions scoped to the selected file without
leaving the graph view.

In **`client/src/features/ai/components/AiPanel.jsx`**, add at the top:

```jsx
import ChatThread from './ChatThread';
import ChatInput  from './ChatInput';
import { initConversation, addUserMessage, beginStreaming,
         appendStreamChunk, finalizeStream, setStreamError } from '../slices/conversationSlice';
```

Replace the header area to add tab buttons:

```jsx
// ADD this state at the top of AiPanel():
const [activeTab, setActiveTab] = React.useState('info'); // 'info' | 'chat'

// ADD this tab bar below the existing header row:
<div className="flex gap-1 mt-2 mb-3">
  {[['info','Info'],['chat','Chat']].map(([id, label]) => (
    <button
      key={id}
      onClick={() => setActiveTab(id)}
      className="px-3 py-1 rounded-lg text-xs font-medium transition-colors"
      style={{
        background: activeTab === id ? 'rgba(168,85,247,0.15)' : 'transparent',
        color:      activeTab === id ? '#a855f7' : 'var(--text-muted)',
        border: `1px solid ${activeTab === id ? 'rgba(168,85,247,0.3)' : 'transparent'}`,
      }}
    >
      {label}
    </button>
  ))}
</div>
```

Wrap the existing content in `{activeTab === 'info' && (...)}` and add the chat panel:

```jsx
{activeTab === 'info' && (
  <>
    {/* ALL existing AiPanel sections go here, unchanged */}
  </>
)}

{activeTab === 'chat' && (
  <div className="flex flex-col gap-2" style={{ height: '420px' }}>
    <div className="flex-1 overflow-y-auto min-h-0">
      <ChatThread />
    </div>
    <ChatInput />
  </div>
)}
```

---

## 11. aiService Additions

Add these methods to the existing `aiService` object in
**`client/src/features/ai/services/aiService.js`**:

```js
/**
 * Stream a multi-turn chat response.
 * Parses the SSE stream from POST /api/ai/chat.
 *
 * @param {{
 *   question:       string,
 *   jobId:          string,
 *   conversationId: string|null,
 *   signal:         AbortSignal,
 *   onChunk:        (text: string) => void,
 *   onDone:         (event: { conversationId, sources, confidence }) => void,
 *   onError:        (err: Error) => void,
 * }} params
 */
async streamChat({ question, jobId, conversationId, signal, onChunk, onDone, onError }) {
  const url = resolveApiUrl('/api/ai/chat');

  let response;
  try {
    response = await fetch(url, {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal,
      body: JSON.stringify({ question, jobId, conversationId }),
    });
  } catch (err) {
    onError?.(err);
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    onError?.(new Error(`Chat request failed: ${response.status} ${text}`));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    let done, value;
    try {
      ({ done, value } = await reader.read());
    } catch (err) {
      if (err.name !== 'AbortError') onError?.(err);
      break;
    }
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';   // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;

      let event;
      try { event = JSON.parse(raw); } catch { continue; }

      if (event.type === 'chunk') {
        onChunk?.(event.text ?? '');
      } else if (event.type === 'done') {
        onDone?.({ conversationId: event.conversationId, sources: event.sources ?? [], confidence: event.confidence });
      } else if (event.type === 'error') {
        onError?.(new Error(event.message || 'Stream error'));
      }
    }
  }
},

/**
 * Fetch conversation history list for a job.
 */
async getConversations({ jobId }) {
  const { data } = await aiClient.get('/api/ai/conversations', { params: { jobId } });
  return data;
},

/**
 * Fetch all messages for a specific conversation.
 */
async getConversationMessages({ conversationId }) {
  const { data } = await aiClient.get(`/api/ai/conversations/${conversationId}/messages`);
  return data;
},
```

---

## 12. End-to-End Testing Checklist

### Backend

- [ ] `009_conversations.sql` migrates without errors; `conversations` and `conversation_messages` tables exist.
- [ ] `function_embeddings` table exists with ivfflat index.
- [ ] `POST /api/ai/chat` returns `Content-Type: text/event-stream`.
- [ ] First message in a new conversation creates a row in `conversations` and two rows in `conversation_messages`.
- [ ] Second message in the same conversation (same `conversationId`) appends two more rows; the history is injected into the LLM prompt.
- [ ] Redis cache serves the same question+conversationId combo instantly (check `X-Cache: HIT` via curl).
- [ ] `GET /api/ai/conversations?jobId=...` returns the list of conversations.
- [ ] `GET /api/ai/conversations/:id/messages` returns the full thread.
- [ ] `GraphRagExpander.expand()` returns more files than the seed set when graph edges exist.
- [ ] `FunctionChunker.run()` succeeds silently if `function_nodes` is empty for the job.
- [ ] `function_embeddings` rows are created after a full analysis pipeline run.

### Frontend

- [ ] `AskPage` renders `ChatThread` + `ChatInput` instead of `QueryBar`.
- [ ] Typing a question and pressing Enter (or clicking Send) shows the user bubble immediately.
- [ ] The assistant bubble starts empty and fills progressively as tokens stream.
- [ ] The pulsing cursor disappears when the stream ends.
- [ ] Source citations appear below the assistant bubble with correct file names.
- [ ] Clicking the Stop button (`■`) aborts the stream and shows "Response cancelled."
- [ ] The `+` button clears the thread and starts a new conversation (new `conversationId` on next send).
- [ ] Switching to a different graph job (different `jobId`) triggers `initConversation`, clearing the old thread.
- [ ] `AiPanel` shows Info / Chat tabs; Chat tab renders `ChatThread` + `ChatInput` within the panel.
- [ ] `conversationSlice` is registered in the root reducer and `state.conversation` is visible in Redux DevTools.
- [ ] On page refresh, the thread is cleared (ephemeral); `QueryHistory` (existing component) still shows past queries.