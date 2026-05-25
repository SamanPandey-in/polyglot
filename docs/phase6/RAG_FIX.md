# Polyglot Phase 6 — Gap Analysis & Fix Guide
## RAG · Neo4j Integration · ChatAgent · Browse Button

---

## Executive Summary: What Is Actually Broken

After auditing the full Phase 6 codebase, seven concrete gaps were found. They fall into three categories:

| # | Category | Gap | Severity |
|---|---|---|---|
| 1 | Architecture | No `ChatAgent` — entire Ask flow is inline route code | Critical |
| 2 | RAG | `GraphRagExpander` never uses Neo4j graph — always hits Postgres `graph_edges` | Critical |
| 3 | RAG | Neo4j typed relationships (`EXPOSES_API`, `USES_TABLE`, `EMITS_EVENT`) never included in LLM context | High |
| 4 | RAG | `IGraphRepository` has no `getContextForQuery` method — no contract for RAG retrieval | High |
| 5 | Database | `009_conversations.sql` is a Postgres migration but `migrate.js` only runs `.cypher` files — tables may not exist on new deployments | High |
| 6 | Upload | Browse button: a cancelled folder picker (status 400) is treated as an error and shown to the user | Medium |
| 7 | Upload | Browse button stays disabled until `getLocalPickerCapabilities` resolves — no loading indicator, appears broken | Low |

---

## Table of Contents

1. [Fix 1 — Add `getContextForQuery` to `IGraphRepository`](#fix-1)
2. [Fix 2 — Neo4j Implementation of `getContextForQuery`](#fix-2)
3. [Fix 3 — Postgres Implementation of `getContextForQuery`](#fix-3)
4. [Fix 4 — Neo4j-Aware `GraphRagExpander`](#fix-4)
5. [Fix 5 — New `ChatAgent`](#fix-5)
6. [Fix 6 — Wire `/chat` Route to `ChatAgent`](#fix-6)
7. [Fix 7 — Postgres Migration Runner](#fix-7)
8. [Fix 8 — Browse Button: Cancel ≠ Error](#fix-8)
9. [Files Changed Summary](#files-changed-summary)
10. [Testing Checklist](#testing-checklist)

---

## Fix 1 — Add `getContextForQuery` to `IGraphRepository` {#fix-1}

The interface currently has `persistGraph`, `getGraph`, `getDependencies`, `getImpactedFiles`,
`healthCheck`, `deleteJob`. There is no method for RAG context retrieval.
The `ChatAgent` needs a single method to call regardless of whether Postgres or Neo4j is active.

**Edit `server/src/infrastructure/db/IGraphRepository.js`** — add at the bottom of the class:

```js
  /**
   * Returns enriched context for RAG retrieval.
   *
   * Given a set of seed file paths (from vector search), returns those files plus
   * their immediate graph neighbours, enriched with relationship type metadata.
   *
   * @param {string}   jobId
   * @param {string[]} seedPaths        - top-K paths from vector search
   * @param {object}   [options]
   * @param {number}   [options.maxFiles=12]    - hard cap on returned files
   * @param {number}   [options.seedLimit=5]    - max seeds to expand from
   * @returns {Promise<Array<{
   *   filePath:      string,
   *   fileType:      string,
   *   summary:       string|null,
   *   declarations:  Array<{name:string}>,
   *   relationships: Array<{type:string, target:string}>,  // ← Neo4j enrichment
   *   distance:      number,   // 0–1 cosine distance from seed (1.0 for expanded)
   * }>>}
   */
  async getContextForQuery(jobId, seedPaths, options) {
    throw new Error('Method getContextForQuery() must be implemented');
  }
```

---

## Fix 2 — Neo4j Implementation of `getContextForQuery` {#fix-2}

The Neo4j repository already holds the full typed-relationship graph. This implementation
walks the graph in Cypher to find neighbours AND returns what relationship type connects them.

**Edit `server/src/infrastructure/db/Neo4jGraphRepository.js`** — add after `getImpactedFiles`:

```js
  // ── getContextForQuery ────────────────────────────────────────────────────
  // RAG context expansion: seeds → 1-hop neighbours via ALL typed relationships.
  // Returns seed files + neighbours with their typed relationship metadata.
  async getContextForQuery(jobId, seedPaths, { maxFiles = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0) return [];

    const seeds = seedPaths.slice(0, seedLimit);

    return this._withSession(async (session) => {
      // Step 1: Get seed file metadata
      const seedResult = await session.run(
        `MATCH (f:CodeFile { jobId: $jobId })
         WHERE f.path IN $seeds
         RETURN f.path AS path, f.type AS type, f.language AS language`,
        { jobId, seeds },
      );

      const seedMeta = new Map();
      for (const rec of seedResult.records) {
        seedMeta.set(rec.get('path'), {
          filePath:      rec.get('path'),
          fileType:      rec.get('type') || 'module',
          summary:       null,
          declarations:  [],
          relationships: [],
          distance:      0,
        });
      }

      // Step 2: One-hop relationship expansion using ALL typed edge types
      // This is the key Neo4j advantage — we get EXPOSES_API, USES_TABLE, etc.
      const relResult = await session.run(
        `MATCH (src:CodeFile { jobId: $jobId })-[r]->(tgt { jobId: $jobId })
         WHERE src.path IN $seeds
           AND type(r) IN ['IMPORTS','CALLS','EXPOSES_API','CONSUMES_API',
                           'USES_TABLE','USES_FIELD','EMITS_EVENT','LISTENS_EVENT']
         RETURN src.path AS srcPath,
                tgt.path AS tgtPath,
                type(r)  AS relType,
                labels(tgt) AS tgtLabels,
                tgt.type AS tgtType
         LIMIT 100`,
        { jobId, seeds },
      );

      // Collect neighbour paths and record the relationship types
      const neighbourPaths = new Set();
      const relationshipsByFile = new Map(); // srcPath → [{type, target}]

      for (const rec of relResult.records) {
        const srcPath = rec.get('srcPath');
        const tgtPath = rec.get('tgtPath');
        const relType = rec.get('relType');

        if (tgtPath && tgtPath !== srcPath) {
          neighbourPaths.add(tgtPath);
        }

        if (!relationshipsByFile.has(srcPath)) {
          relationshipsByFile.set(srcPath, []);
        }
        if (tgtPath) {
          relationshipsByFile.get(srcPath).push({ type: relType, target: tgtPath });
        }
      }

      // Attach relationships to seed metadata
      for (const [path, rels] of relationshipsByFile) {
        if (seedMeta.has(path)) {
          seedMeta.get(path).relationships = rels;
        }
      }

      // Step 3: Fetch metadata for neighbour files that aren't seeds
      const newNeighbours = [...neighbourPaths].filter(p => !seedMeta.has(p));

      if (newNeighbours.length > 0) {
        const nbrResult = await session.run(
          `MATCH (f:CodeFile { jobId: $jobId })
           WHERE f.path IN $paths
           RETURN f.path AS path, f.type AS type`,
          { jobId, paths: newNeighbours },
        );

        for (const rec of nbrResult.records) {
          const path = rec.get('path');
          seedMeta.set(path, {
            filePath:      path,
            fileType:      rec.get('type') || 'module',
            summary:       null,
            declarations:  [],
            relationships: [],
            distance:      1.0,  // expanded neighbour, not a direct vector match
          });
        }
      }

      // Step 4: Enrich with Postgres summaries and declarations
      // (Neo4j holds structure; Postgres holds enriched text from EnrichmentAgent)
      const allPaths = [...seedMeta.keys()];
      if (allPaths.length > 0) {
        const pgResult = await this.pgRepo.pgPool.query(
          `SELECT file_path, file_type, summary, declarations
           FROM graph_nodes
           WHERE job_id = $1 AND file_path = ANY($2)`,
          [jobId, allPaths],
        );

        for (const row of pgResult.rows) {
          const entry = seedMeta.get(row.file_path);
          if (entry) {
            entry.summary      = row.summary || null;
            entry.declarations = Array.isArray(row.declarations) ? row.declarations : [];
            if (!entry.fileType || entry.fileType === 'module') {
              entry.fileType = row.file_type || entry.fileType;
            }
          }
        }
      }

      // Return ordered: seeds first (distance 0), then neighbours (distance 1.0)
      return [...seedMeta.values()]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxFiles);
    }, { write: false });
  }
```

> **Why this matters:** When the LLM sees "src/api/users.js EXPOSES_API `/users` and USES_TABLE `users`", it can accurately answer "what does the users endpoint depend on?" without hallucinating.

---

## Fix 3 — Postgres Implementation of `getContextForQuery` {#fix-3}

For jobs that use Postgres (smaller codebases), the expansion uses `graph_edges`.

**Edit `server/src/infrastructure/db/PostgresGraphRepository.js`** — add after `getImpactedFiles`:

```js
  // ── getContextForQuery ─────────────────────────────────────────────────────
  async getContextForQuery(jobId, seedPaths, { maxFiles = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0) return [];

    const seeds = seedPaths.slice(0, seedLimit);

    try {
      // Fetch seed metadata
      const seedResult = await this.pgPool.query(
        `SELECT file_path, file_type, summary, declarations
         FROM graph_nodes
         WHERE job_id = $1 AND file_path = ANY($2)`,
        [jobId, seeds],
      );

      const fileMap = new Map();
      for (const row of seedResult.rows) {
        fileMap.set(row.file_path, {
          filePath:      row.file_path,
          fileType:      row.file_type || 'module',
          summary:       row.summary   || null,
          declarations:  Array.isArray(row.declarations) ? row.declarations : [],
          relationships: [],
          distance:      0,
        });
      }

      // One-hop expansion via graph_edges
      const edgeResult = await this.pgPool.query(
        `SELECT
           CASE WHEN source_path = ANY($1) THEN target_path ELSE source_path END AS neighbour,
           CASE WHEN source_path = ANY($1) THEN 'IMPORTS' ELSE 'IMPORTED_BY' END AS rel_type,
           CASE WHEN source_path = ANY($1) THEN source_path ELSE target_path END AS seed_path
         FROM graph_edges
         WHERE job_id = $2
           AND (source_path = ANY($1) OR target_path = ANY($1))`,
        [seeds, jobId],
      );

      const neighbourPaths = new Set();
      for (const row of edgeResult.rows) {
        if (row.neighbour && !fileMap.has(row.neighbour)) {
          neighbourPaths.add(row.neighbour);
        }
        // Attach the relationship to the seed file
        if (row.seed_path && fileMap.has(row.seed_path)) {
          fileMap.get(row.seed_path).relationships.push({
            type:   row.rel_type,
            target: row.neighbour,
          });
        }
      }

      // Fetch metadata for neighbour files
      if (neighbourPaths.size > 0) {
        const nbrResult = await this.pgPool.query(
          `SELECT file_path, file_type, summary, declarations
           FROM graph_nodes
           WHERE job_id = $1 AND file_path = ANY($2)`,
          [jobId, [...neighbourPaths]],
        );
        for (const row of nbrResult.rows) {
          fileMap.set(row.file_path, {
            filePath:      row.file_path,
            fileType:      row.file_type || 'module',
            summary:       row.summary   || null,
            declarations:  Array.isArray(row.declarations) ? row.declarations : [],
            relationships: [],
            distance:      1.0,
          });
        }
      }

      return [...fileMap.values()]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxFiles);
    } catch {
      // Fallback: return just the seeds with basic metadata
      return seedPaths.slice(0, maxFiles).map(path => ({
        filePath: path, fileType: 'module', summary: null,
        declarations: [], relationships: [], distance: 0,
      }));
    }
  }
```

---

## Fix 4 — Neo4j-Aware `GraphRagExpander` {#fix-4}

The current `GraphRagExpander` ignores Neo4j entirely. Replace it with a version that
accepts a graph repository and delegates to it.

**Replace the entire contents of `server/src/agents/query/GraphRagExpander.js`:**

```js
import { pgPool } from '../../infrastructure/connections.js';

/**
 * GraphRagExpander
 *
 * Wraps a graph repository's `getContextForQuery` method for use in the
 * ChatAgent's retrieval pipeline. When Neo4j is active, it walks typed
 * relationships (EXPOSES_API, USES_TABLE, etc.). When Postgres is active,
 * it walks graph_edges. The caller never needs to know which backend is live.
 */
export class GraphRagExpander {
  /**
   * @param {import('../../infrastructure/db/IGraphRepository').IGraphRepository|import('pg').Pool} dbOrRepo
   */
  constructor(dbOrRepo) {
    // Accept either a graph repository (preferred) or a raw pg.Pool (legacy)
    if (dbOrRepo && typeof dbOrRepo.getContextForQuery === 'function') {
      this.repo = dbOrRepo;
    } else {
      // Legacy path: raw pg.Pool passed directly (e.g. from old ai.routes.js code)
      this._legacyPool = dbOrRepo || pgPool;
      this.repo = null;
    }
  }

  /**
   * Expand seed paths to a richer context set.
   *
   * @param {string[]} seedPaths
   * @param {string}   jobId
   * @param {object}   [options]
   * @returns {Promise<string[]>}   ordered file paths (seeds first, then neighbours)
   */
  async expand(seedPaths, jobId, { maxExpanded = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0 || !jobId) {
      return Array.isArray(seedPaths) ? seedPaths.slice(0, maxExpanded) : [];
    }

    // Use the repository if available (preferred — Neo4j or Postgres with enrichment)
    if (this.repo) {
      try {
        const context = await this.repo.getContextForQuery(jobId, seedPaths, {
          maxFiles: maxExpanded,
          seedLimit,
        });
        return context.map(entry => entry.filePath);
      } catch {
        return seedPaths.slice(0, maxExpanded);
      }
    }

    // Legacy path: raw pg.Pool (fallback for old code)
    return this._legacyExpand(seedPaths, jobId, { maxExpanded, seedLimit });
  }

  /**
   * Returns the full enriched context objects (not just paths).
   * Used by ChatAgent to build the LLM context block.
   *
   * @param {string[]} seedPaths
   * @param {string}   jobId
   * @param {object}   [options]
   * @returns {Promise<Array<import('../../infrastructure/db/IGraphRepository').ContextEntry>>}
   */
  async getEnrichedContext(seedPaths, jobId, { maxFiles = 12, seedLimit = 5 } = {}) {
    if (!this.repo) {
      // Legacy: return basic context without relationship enrichment
      const paths = await this._legacyExpand(seedPaths, jobId, { maxExpanded: maxFiles, seedLimit });
      return paths.map(p => ({
        filePath: p, fileType: 'module', summary: null,
        declarations: [], relationships: [], distance: seedPaths.includes(p) ? 0 : 1.0,
      }));
    }

    try {
      return await this.repo.getContextForQuery(jobId, seedPaths, { maxFiles, seedLimit });
    } catch {
      return seedPaths.slice(0, maxFiles).map(p => ({
        filePath: p, fileType: 'module', summary: null,
        declarations: [], relationships: [], distance: 0,
      }));
    }
  }

  // ── Legacy fallback (raw Postgres pool, no repository) ──────────────────
  async _legacyExpand(seedPaths, jobId, { maxExpanded, seedLimit }) {
    const seeds = seedPaths.slice(0, seedLimit);
    try {
      const { rows } = await this._legacyPool.query(
        `SELECT DISTINCT
           CASE WHEN source_path = ANY($1) THEN target_path ELSE source_path END AS neighbour
         FROM graph_edges
         WHERE job_id = $2
           AND (source_path = ANY($1) OR target_path = ANY($1))`,
        [seeds, jobId],
      );
      const neighbours = rows.map(r => r.neighbour).filter(Boolean).filter(p => !seedPaths.includes(p));
      const merged = [...seedPaths, ...neighbours];
      const seen = new Set();
      return merged.filter(p => { if (seen.has(p)) return false; seen.add(p); return true; }).slice(0, maxExpanded);
    } catch {
      return seedPaths.slice(0, maxExpanded);
    }
  }
}
```

---

## Fix 5 — New `ChatAgent` {#fix-5}

Create **`server/src/agents/query/ChatAgent.js`** — a proper `BaseAgent` subclass that
owns the entire multi-turn RAG pipeline.

```js
import crypto from 'crypto';
import { BaseAgent } from '../core/BaseAgent.js';
import { pgPool, redisClient } from '../../infrastructure/connections.js';
import { createChatClient, createEmbeddingClient } from '../../services/ai/llmProvider.js';
import { GraphRagExpander } from './GraphRagExpander.js';

const CACHE_TTL_SECONDS   = Number(process.env.AI_CACHE_TTL_SECONDS || 3600);
const SEMANTIC_LIMIT      = 20;
const CONTEXT_FILE_LIMIT  = 12;
const HISTORY_TURN_LIMIT  = 6;   // max conversation turns fed to LLM

// ── Helpers ──────────────────────────────────────────────────────────────────

function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const nums = vector.map(Number).filter(Number.isFinite);
  return nums.length ? `[${nums.join(',')}]` : null;
}

function buildContextBlock(contextEntries) {
  if (!contextEntries.length) {
    return 'No relevant files found in the codebase for this question.';
  }

  return contextEntries.map((entry, i) => {
    const exports = (entry.declarations || [])
      .map(d => d?.name).filter(Boolean).slice(0, 8).join(', ') || 'none';

    const relLines = (entry.relationships || [])
      .slice(0, 6)
      .map(r => `  ${r.type} → ${r.target}`)
      .join('\n');

    return [
      `[${i + 1}] File: ${entry.filePath}`,
      `    Type: ${entry.fileType || 'module'}`,
      `    Summary: ${entry.summary || 'N/A'}`,
      `    Exports: ${exports}`,
      relLines ? `    Relationships:\n${relLines}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function buildSystemPrompt(contextBlock) {
  return [
    'You are an expert codebase architect assistant.',
    'Answer the user\'s question using ONLY the provided codebase context below.',
    'Be specific: reference actual file paths, function names, and relationship types.',
    'When a file EXPOSES_API, USES_TABLE, or EMITS_EVENT, call that out explicitly.',
    'If the context is insufficient, say so clearly — do not guess.',
    'Format: plain text. Use a short code snippet only if it greatly aids clarity.',
    '',
    '=== CODEBASE CONTEXT ===',
    contextBlock,
  ].join('\n');
}

function keywordRerank(question, candidates) {
  const tokens = question.toLowerCase().replace(/[^a-z0-9_\-/\s]+/g, ' ').split(/\s+/).filter(t => t.length >= 2);
  return candidates.map((c, i) => {
    const haystack = [c.filePath, c.fileType, c.summary,
      (c.declarations || []).map(d => d?.name).join(' ')].filter(Boolean).join(' ').toLowerCase();
    const hits = tokens.filter(t => haystack.includes(t)).length;
    const keywordScore  = tokens.length ? hits / tokens.length : 0;
    const semanticScore = 1 - Math.min(1, Math.max(0, Number(c.distance || 0)));
    const positionBoost = (SEMANTIC_LIMIT - i) / SEMANTIC_LIMIT;
    return { ...c, _score: keywordScore * 0.5 + semanticScore * 0.35 + positionBoost * 0.15 };
  }).sort((a, b) => b._score - a._score);
}

// ── ChatAgent ─────────────────────────────────────────────────────────────────

/**
 * ChatAgent
 *
 * Runs the full multi-turn RAG pipeline for the Ask feature:
 *   1. Embed the question
 *   2. Vector search (Postgres pgvector)
 *   3. Graph-RAG expansion (Neo4j typed rels OR Postgres graph_edges)
 *   4. Function-level boost (function_embeddings)
 *   5. Keyword rerank
 *   6. Build LLM context block (with relationship metadata)
 *   7. Stream LLM response (SSE tokens sent via onToken callback)
 *   8. Persist conversation turn
 *   9. Cache result in Redis
 *
 * The `graphRepo` constructor param accepts any IGraphRepository implementation.
 * When Neo4j is active, getContextForQuery() uses Cypher + typed relationships.
 * When Postgres is active, it uses graph_edges.
 */
export class ChatAgent extends BaseAgent {
  agentId    = 'chat-agent';
  maxRetries = 1;
  timeoutMs  = 120_000;

  /**
   * @param {object} options
   * @param {import('../../infrastructure/db/IGraphRepository').IGraphRepository} options.graphRepo
   * @param {import('pg').Pool}         [options.db]
   * @param {object}                    [options.redis]
   * @param {object}                    [options.llmClient]
   * @param {object}                    [options.embeddingClient]
   */
  constructor({ graphRepo, db, redis, llmClient, embeddingClient } = {}) {
    super();
    this.graphRepo       = graphRepo || null;
    this.db              = db              || pgPool;
    this.redis           = redis           || redisClient;
    this.llmClient       = llmClient       || createChatClient();
    this.embeddingClient = embeddingClient || createEmbeddingClient();
    this.expander        = new GraphRagExpander(graphRepo || this.db);
  }

  /**
   * @param {object} input
   * @param {string}   input.question
   * @param {string}   input.jobId
   * @param {string}   input.userId
   * @param {string}   [input.conversationId]
   * @param {number}   [input.historyLimit=6]
   * @param {Function} [input.onToken]       - called with each streamed text chunk
   * @param {object}   [context]
   */
  async process(input, context = {}) {
    const start = Date.now();
    const errors   = [];
    const warnings = [];

    const question       = String(input?.question       || '').trim();
    const jobId          = String(input?.jobId          || context?.jobId || '').trim();
    const userId         = String(input?.userId         || '').trim();
    const conversationId = String(input?.conversationId || '').trim() || null;
    const historyLimit   = Math.min(10, Math.max(0, Number(input?.historyLimit ?? HISTORY_TURN_LIMIT)));
    const onToken        = typeof input?.onToken === 'function' ? input.onToken : null;

    if (!question || !jobId || !userId) {
      return this.buildResult({
        jobId, status: 'failed', confidence: 0, data: {},
        errors: [{ code: 400, message: 'ChatAgent requires question, jobId, and userId.' }],
        warnings, metrics: {}, processingTimeMs: Date.now() - start,
      });
    }

    if (!this.llmClient.isConfigured()) {
      return this.buildResult({
        jobId, status: 'failed', confidence: 0, data: {},
        errors: [{ code: 500, message: 'LLM provider is not configured.' }],
        warnings, metrics: {}, processingTimeMs: Date.now() - start,
      });
    }

    // ── 1. Redis cache check ───────────────────────────────────────────────
    const cacheKey = `chat:${jobId}:${conversationId || 'new'}:${
      crypto.createHash('sha256').update(question).digest('hex')
    }`;

    try {
      const cached = await this.redis?.get?.(cacheKey).catch?.(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        onToken?.(parsed.text || '');
        return this.buildResult({
          jobId, status: 'success', confidence: 0.7,
          data: { ...parsed, cacheHit: true },
          errors, warnings,
          metrics: { cacheHit: 1 },
          processingTimeMs: Date.now() - start,
        });
      }
    } catch { /* cache miss — proceed */ }

    // ── 2. Resolve / create conversation ──────────────────────────────────
    let activeConvId = conversationId;
    if (activeConvId) {
      const check = await this.db.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND job_id = $3 LIMIT 1`,
        [activeConvId, userId, jobId],
      ).catch(() => ({ rowCount: 0 }));
      if (check.rowCount === 0) activeConvId = null;
    }

    if (!activeConvId) {
      const created = await this.db.query(
        `INSERT INTO conversations (user_id, job_id, title) VALUES ($1, $2, $3) RETURNING id`,
        [userId, jobId, question.slice(0, 80)],
      ).catch(() => ({ rows: [] }));
      activeConvId = created.rows[0]?.id || null;
    }

    // ── 3. Load conversation history ───────────────────────────────────────
    let history = [];
    if (activeConvId) {
      const histResult = await this.db.query(
        `SELECT role, content
         FROM (
           SELECT role, content, created_at
           FROM conversation_messages
           WHERE conversation_id = $1
           ORDER BY created_at DESC
           LIMIT $2
         ) AS sub
         ORDER BY created_at ASC`,
        [activeConvId, historyLimit * 2],
      ).catch(() => ({ rows: [] }));
      history = histResult.rows.map(r => ({ role: r.role, content: r.content }));
    }

    // ── 4. Embed question ──────────────────────────────────────────────────
    let contextEntries = [];
    let embeddingTokens = 0;

    if (this.embeddingClient.isConfigured()) {
      try {
        const embResp = await this.embeddingClient.createEmbedding({
          model: this.embeddingClient.model,
          input: question,
        });

        embeddingTokens = Number(embResp?.usage?.total_tokens || 0);
        const vectorLiteral = toVectorLiteral(embResp?.data?.[0]?.embedding);

        if (vectorLiteral) {
          // ── 5. Vector search ─────────────────────────────────────────────
          const semanticResult = await this.db.query(
            `SELECT fe.file_path, fe.embedding <=> $1::vector AS distance
             FROM file_embeddings fe
             WHERE fe.job_id = $2
             ORDER BY fe.embedding <=> $1::vector
             LIMIT $3`,
            [vectorLiteral, jobId, SEMANTIC_LIMIT],
          ).catch(() => ({ rows: [] }));

          const seedPaths = (semanticResult.rows || []).map(r => r.file_path);
          const distanceMap = new Map((semanticResult.rows || []).map(r => [r.file_path, Number(r.distance)]));

          // ── 6. Graph-RAG expansion (Neo4j typed rels OR Postgres edges) ──
          const enriched = await this.expander.getEnrichedContext(seedPaths, jobId, {
            maxFiles:  CONTEXT_FILE_LIMIT,
            seedLimit: 5,
          });

          // Attach vector distances for reranking
          contextEntries = enriched.map(e => ({
            ...e,
            distance: distanceMap.get(e.filePath) ?? e.distance,
          }));

          // ── 7. Function-level boost ──────────────────────────────────────
          try {
            const fnResult = await this.db.query(
              `SELECT file_path, embedding <=> $1::vector AS distance
               FROM function_embeddings
               WHERE job_id = $2
               ORDER BY embedding <=> $1::vector
               LIMIT 6`,
              [vectorLiteral, jobId],
            );

            const highScoreFnFiles = new Set(
              (fnResult.rows || [])
                .filter(r => Number(r.distance) < 0.35)
                .map(r => r.file_path),
            );

            // Boost files whose functions scored well
            contextEntries = contextEntries.map(e => ({
              ...e,
              _fnBoost: highScoreFnFiles.has(e.filePath) ? 0.2 : 0,
            }));
          } catch { /* function_embeddings table may not exist yet */ }

          // ── 8. Rerank ────────────────────────────────────────────────────
          contextEntries = keywordRerank(question, contextEntries)
            .map(e => ({ ...e, _score: (e._score || 0) + (e._fnBoost || 0) }))
            .sort((a, b) => b._score - a._score)
            .slice(0, CONTEXT_FILE_LIMIT);
        }
      } catch (embErr) {
        warnings.push(`Embedding failed: ${embErr.message}`);
      }
    }

    // ── 9. Build LLM messages ──────────────────────────────────────────────
    const contextBlock = buildContextBlock(contextEntries);
    const messages = [
      { role: 'system', content: buildSystemPrompt(contextBlock) },
      ...history,
      { role: 'user', content: question },
    ];

    // ── 10. Stream LLM response ────────────────────────────────────────────
    let fullText    = '';
    let streamError = null;
    let completionTokens = 0;

    try {
      const streamSession = await this.llmClient.createStream({
        model:     this.llmClient.model,
        maxTokens: 800,
        messages,
        onText: (text) => {
          fullText += text;
          onToken?.(text);
        },
      });
      await streamSession.consume();
      completionTokens = Number(streamSession?.usage?.completion_tokens || 0);
    } catch (sErr) {
      streamError = sErr;
      warnings.push(`LLM stream failed: ${sErr.message}`);
      // Build a deterministic fallback from context
      fullText = contextEntries.length
        ? [`Unable to reach the AI provider. Most relevant files for: "${question}"`,
           ...contextEntries.slice(0, 3).map(e => `• ${e.filePath}: ${e.summary || 'No summary.'}`)
          ].join('\n')
        : `Unable to reach the AI provider. Question: "${question}"`;
    }

    const sourcePaths = contextEntries.map(e => e.filePath);
    const confidence  = streamError ? 'low' : contextEntries.length >= 3 ? 'medium' : 'low';

    // ── 11. Persist turn (non-blocking) ───────────────────────────────────
    if (activeConvId && fullText) {
      Promise.all([
        this.db.query(
          `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
          [activeConvId, question],
        ),
        this.db.query(
          `INSERT INTO conversation_messages
             (conversation_id, role, content, source_files, confidence)
           VALUES ($1, 'assistant', $2, $3::jsonb, $4)`,
          [activeConvId, fullText, JSON.stringify(sourcePaths), confidence],
        ),
      ]).catch(err => console.error('[ChatAgent] turn persistence failed:', err.message));
    }

    // ── 12. Cache result ───────────────────────────────────────────────────
    if (fullText && !streamError) {
      const cachePayload = JSON.stringify({ text: fullText, sources: sourcePaths, conversationId: activeConvId, confidence });
      this.redis?.setex?.(cacheKey, CACHE_TTL_SECONDS, cachePayload).catch(() => {});
    }

    return this.buildResult({
      jobId,
      status:     streamError ? 'partial' : 'success',
      confidence: confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.7 : 0.5,
      data: {
        text:           fullText,
        sources:        sourcePaths,
        conversationId: activeConvId,
        confidence,
        fallback:       Boolean(streamError),
        cacheHit:       false,
        retrievedFiles: contextEntries.length,
      },
      errors,
      warnings,
      metrics: { embeddingTokens, completionTokens, retrievedFiles: contextEntries.length },
      processingTimeMs: Date.now() - start,
    });
  }
}
```

---

## Fix 6 — Wire `/chat` Route to `ChatAgent` {#fix-6}

Replace the 250-line inline handler in `ai.routes.js` with a thin delegate to `ChatAgent`.

**In `server/src/api/ai/routes/ai.routes.js`** — add this import at the top:

```js
import { ChatAgent } from '../../../agents/query/ChatAgent.js';
import { createGraphRepository } from '../../../infrastructure/db/graphRepositoryFactory.js';
```

**Replace the entire `router.post('/chat', ...)` block** with:

```js
// ── POST /chat ──────────────────────────────────────────────────────────────
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

  // ── SSE setup ─────────────────────────────────────────────────────────────
  let clientClosed = false;
  req.on('close', () => { clientClosed = true; });

  res.status(200)
     .setHeader('Content-Type',      'text/event-stream; charset=utf-8')
     .setHeader('Cache-Control',     'no-cache, no-transform')
     .setHeader('Connection',        'keep-alive')
     .setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) {
      writeSseEvent(res, { type: 'error', message: 'Failed to resolve authenticated user.' });
      return res.end();
    }

    // Verify job ownership
    const ownership = await pgPool.query(
      `SELECT db_type FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    if (ownership.rowCount === 0) {
      writeSseEvent(res, { type: 'error', message: 'Analysis job not found.' });
      return res.end();
    }

    // Select the correct graph repository for this job's topology
    // (Neo4j for large/complex graphs, Postgres otherwise)
    const dbType   = ownership.rows[0]?.db_type || 'postgres';
    const graphRepo = createGraphRepository(
      dbType === 'neo4j' ? { nodeCount: 9999 } : {},  // force correct backend
      dbType === 'neo4j' ? { forceNeo4j: true } : { forcePostgres: true },
    );

    // Instantiate ChatAgent with the correct repository
    const agent = new ChatAgent({
      graphRepo,
      db:              pgPool,
      redis:           redisClient,
      llmClient:       chatClient,
      embeddingClient,
    });

    // Run the agent — onToken streams chunks to the client
    const result = await agent.process({
      question,
      jobId,
      userId,
      conversationId,
      historyLimit,
      onToken: (text) => {
        if (!clientClosed) writeSseEvent(res, { type: 'chunk', text });
      },
    }, { jobId });

    if (!clientClosed) {
      writeSseEvent(res, {
        type:           'done',
        sources:         result.data.sources        || [],
        conversationId:  result.data.conversationId || null,
        confidence:      result.data.confidence     || 'low',
        fallback:        result.data.fallback        || false,
        cached:          result.data.cacheHit        || false,
      });
    }

    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent) return next(error);
    writeSseEvent(res, { type: 'error', message: error.message || 'Chat failed.' });
    if (!res.writableEnded) res.end();
  }
});
```

---

## Fix 7 — Postgres Migration Runner {#fix-7}

The `migrate.js` only runs `.cypher` files for Neo4j. The `.sql` migrations (001–009) need a separate runner that fires at server startup so `conversations`, `function_embeddings`, and all other tables always exist.

**Edit `server/src/infrastructure/db/startup.js`** — add a Postgres migration runner and call it before the Neo4j block:

```js
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { pgPool } from '../connections.js';
import { getNeo4jDriver } from './neo4jDriver.js';
import { runMigrations } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PG_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Runs all .sql files in the migrations directory against Postgres,
 * in lexicographic order. Each file is idempotent (uses IF NOT EXISTS).
 * Already-applied migrations are tracked in a _pg_migrations table.
 */
async function runPostgresMigrations() {
  // Ensure migration tracking table exists
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS _pg_migrations (
      filename  TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  let files;
  try {
    files = (await fs.readdir(PG_MIGRATIONS_DIR))
      .filter(f => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log('[PostgresMigration] No migrations directory found — skipping.');
    return;
  }

  for (const filename of files) {
    // Check if already applied
    const check = await pgPool.query(
      `SELECT 1 FROM _pg_migrations WHERE filename = $1`,
      [filename],
    );
    if (check.rowCount > 0) {
      console.log(`[PostgresMigration] Skipping ${filename} (already applied)`);
      continue;
    }

    console.log(`[PostgresMigration] Applying ${filename}...`);
    const sql = await fs.readFile(path.join(PG_MIGRATIONS_DIR, filename), 'utf8');

    try {
      await pgPool.query(sql);
      await pgPool.query(
        `INSERT INTO _pg_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [filename],
      );
      console.log(`[PostgresMigration] Applied ${filename}`);
    } catch (error) {
      // Re-throw only non-idempotent errors
      if (
        !error.message?.includes('already exists') &&
        !error.message?.includes('duplicate key')
      ) {
        console.error(`[PostgresMigration] Failed ${filename}:`, error.message);
        throw error;
      }
      console.log(`[PostgresMigration] (idempotent) ${filename}: ${error.message.split('\n')[0]}`);
      // Mark as applied even if idempotent
      await pgPool.query(
        `INSERT INTO _pg_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [filename],
      ).catch(() => {});
    }
  }

  console.log('[PostgresMigration] All SQL migrations complete.');
}

export async function bootstrapGraphInfrastructure() {
  // ── Postgres ──────────────────────────────────────────────────────────────
  try {
    await pgPool.query('SELECT 1');
    console.log('[GraphInfrastructure] Postgres OK');
  } catch (error) {
    console.error('[GraphInfrastructure] Postgres FAILED:', error.message);
    throw error;
  }

  // ── Postgres migrations (must run before server accepts requests) ─────────
  try {
    await runPostgresMigrations();
  } catch (error) {
    console.error('[GraphInfrastructure] Postgres migration FAILED:', error.message);
    throw error;   // fatal — conversations table must exist
  }

  // ── Neo4j (optional) ──────────────────────────────────────────────────────
  if (!process.env.NEO4J_URI) {
    console.log('[GraphInfrastructure] NEO4J_URI not set — Neo4j disabled');
    return;
  }

  try {
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    console.log('[GraphInfrastructure] Neo4j connected');
  } catch (error) {
    console.warn('[GraphInfrastructure] Neo4j unavailable (using Postgres):', error.message);
    return;
  }

  try {
    await runMigrations();
    console.log('[GraphInfrastructure] Neo4j migrations complete');
  } catch (error) {
    console.error('[GraphInfrastructure] Neo4j migration FAILED:', error.message);
  }
}
```

---

## Fix 8 — Browse Button: Cancel ≠ Error {#fix-8}

The current `handleBrowse` in `LocalRepoSection.jsx` shows an error when the user
cancels the folder picker (server returns HTTP 400 with "Folder selection was canceled").
Additionally, the button shows no loading state while capabilities are being checked.

**Replace `LocalRepoSection.jsx` — only the `handleBrowse` function and browse error display:**

```jsx
// Replace handleBrowse:
const handleBrowse = useCallback(async () => {
  if (!pickerSupported || disabled) return;

  setBrowseState('loading');
  setBrowseError('');

  try {
    const result = await graphService.browseLocalPath();
    if (!result?.path) {
      // User cancelled — not an error, just reset silently
      setBrowseState('idle');
      return;
    }
    setPath(result.path);
    setValidationState('idle');
    setValidationError('');
    setBrowseState('idle');
    inputRef.current?.focus();
  } catch (error) {
    const status     = error?.response?.status;
    const serverMsg  = error?.response?.data?.error || error?.message || '';

    if (status === 400 || serverMsg.toLowerCase().includes('cancel')) {
      // User pressed Cancel in the OS picker — treat silently
      setBrowseState('idle');
      return;
    }

    if (status === 408 || error?.code === 'ECONNABORTED') {
      setBrowseState('failed');
      setBrowseError('Folder picker timed out. Please paste the path manually.');
      return;
    }

    if (status === 501) {
      // Native picker unavailable on this OS/server
      setBrowseState('idle');
      setPickerSupported(false);
      setPickerMessage(serverMsg || 'Native folder picker unavailable, paste an absolute path.');
      return;
    }

    setBrowseState('failed');
    setBrowseError(serverMsg || 'Could not open native folder picker.');
  }
}, [disabled, pickerSupported]);
```

Also fix the **Browse button disabled state** — show a loading indicator while capabilities
are being checked:

```jsx
// Replace the Browse <Button> in LocalRepoSection.jsx:
<Button
  type="button"
  variant="outline"
  onClick={handleBrowse}
  disabled={isBusy || !pickerSupported}
  className="shrink-0 rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
  title={
    pickerSupported
      ? 'Open native folder picker'
      : pickerMessage || 'Native folder picker unavailable'
  }
>
  {browseState === 'loading' ? (
    <><Loader2 className="animate-spin" /> Opening</>
  ) : pickerMessage === 'Checking folder picker availability...' ? (
    <><Loader2 className="animate-spin" size={14} /> Browse</>
  ) : (
    <><FolderOpen /> Browse</>
  )}
</Button>
```

And initialize `pickerMessage` with a neutral value (not the checking message) to avoid
a flash of loading state on fast connections:

```jsx
// Replace:
const [pickerMessage, setPickerMessage] = useState('Checking folder picker availability...');
// With:
const [pickerMessage, setPickerMessage] = useState('');
```

---

## Files Changed Summary {#files-changed-summary}

| File | Change |
|---|---|
| `server/src/infrastructure/db/IGraphRepository.js` | Add `getContextForQuery()` to interface |
| `server/src/infrastructure/db/Neo4jGraphRepository.js` | Implement `getContextForQuery()` with Cypher typed-rel expansion + Postgres enrichment |
| `server/src/infrastructure/db/PostgresGraphRepository.js` | Implement `getContextForQuery()` with `graph_edges` expansion |
| `server/src/agents/query/GraphRagExpander.js` | Full replacement — accepts `IGraphRepository`, delegates to `getContextForQuery`, has legacy fallback |
| `server/src/agents/query/ChatAgent.js` | **Create new file** — `BaseAgent` subclass owning the full RAG→stream pipeline |
| `server/src/api/ai/routes/ai.routes.js` | Replace `/chat` inline handler with thin `ChatAgent` delegate |
| `server/src/infrastructure/db/startup.js` | Add `runPostgresMigrations()` to auto-apply all `.sql` files |
| `client/src/features/graph/components/LocalRepoSection.jsx` | Fix `handleBrowse` cancel handling; fix loading state |

---

## Testing Checklist {#testing-checklist}

### Postgres migration runner
- [ ] Fresh database: run `npm start` — all 009 `.sql` migrations apply automatically.
- [ ] Second restart: all migrations are skipped ("already applied").
- [ ] `conversations`, `conversation_messages`, `function_embeddings` tables exist.

### ChatAgent — basic
- [ ] `POST /api/ai/chat` with a valid `jobId` returns `text/event-stream`.
- [ ] Response contains `{ type: 'chunk', text: '...' }` events.
- [ ] Response ends with `{ type: 'done', sources: [...], conversationId: '...', confidence: 'medium' }`.
- [ ] Second identical request hits Redis cache (`{ type: 'done', cached: true }`).
- [ ] Conversation history: second question in same `conversationId` receives context from the first turn.

### ChatAgent — Neo4j path
- [ ] For a job stored in Neo4j (`db_type = 'neo4j'`), the `/chat` response includes files connected via `EXPOSES_API` or `USES_TABLE` even if those files aren't in the top vector results.
- [ ] The LLM context block contains "Relationships:" lines like `EXPOSES_API → /api/users`.
- [ ] Ask "what API endpoints does this app expose?" — the answer references actual endpoint paths from Neo4j.

### ChatAgent — Postgres path
- [ ] For a job stored in Postgres (`db_type = 'postgres'`), `/chat` still works correctly.
- [ ] Context files include 1-hop neighbours from `graph_edges`.

### ChatAgent — codebase-specific answers
- [ ] Ask "which files import the auth middleware?" — answer references real file paths from the scanned repo.
- [ ] Ask a question with no relevant context — answer says "context is insufficient" rather than hallucinating.
- [ ] Ask "what does the X function do?" when X is a real function in the repo — answer references body/summary from function-level embeddings.

### Browse button
- [ ] On macOS/Windows local dev: Browse button opens OS folder picker.
- [ ] Clicking Cancel in the OS picker dismisses the picker silently — NO error message shown.
- [ ] On a Linux server without zenity: Browse button is disabled; tooltip shows "Native folder picker unavailable".
- [ ] On first load, the button shows a loading spinner until capabilities resolve (fast connection: imperceptible; slow: visible spinner).
- [ ] Picker timeout (mocked): shows "Folder picker timed out. Please paste the path manually."