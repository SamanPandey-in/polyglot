import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { QueryAgent } from '../../../agents/query/QueryAgent.js';
import { GraphRagExpander } from '../../../agents/query/GraphRagExpander.js';
import { AnalysisAgent } from '../../../agents/analysis/AnalysisAgent.js';
import { SnippetAnalyzerAgent } from '../../../agents/analysis/SnippetAnalyzerAgent.js';
import { pgPool, redisClient } from '../../../infrastructure/connections.js';
import { requirePlan } from '../../../middleware/planGuard.middleware.js';
import { createChatClient, createEmbeddingClient } from '../../../services/ai/llmProvider.js';
import { getAuthUser, resolveDatabaseUserId } from '../../../utils/authUser.js';

const router = Router();
const chatClient = createChatClient();
const defaultChatModel = chatClient.model;
const embeddingClient = createEmbeddingClient();
const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

// BUG 5 FIX: Redis cache for streamed explanations
const STREAM_CACHE_TTL = 60 * 60; // 1 hour

function streamCacheKey(jobId, question) {
  const hash = crypto
    .createHash('sha256')
    .update(`${jobId}:${question}`)
    .digest('hex');
  return `stream:explain:${hash}`;
}

// BUG 8 FIX: safe positive integer parser — returns undefined (not NaN) on invalid input
function toSafePositiveInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;

  const normalized = vector.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (normalized.length === 0) return null;
  return `[${normalized.join(',')}]`;
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildFallbackChatAnswer(question, contextFiles) {
  const topFiles = Array.isArray(contextFiles) ? contextFiles.slice(0, 3) : [];

  if (topFiles.length === 0) {
    return [
      'I could not reach the configured AI provider for this request.',
      'The analysis data for this job did not yield enough retrieval context to synthesize a stronger answer locally.',
      `Question: ${question}`,
    ].join(' ');
  }

  return [
    'I could not reach the configured AI provider, so here is a deterministic summary from the repository context.',
    `Question: ${question}`,
    'Most relevant files:',
    ...topFiles.map((file) => `- ${file.file_path}: ${file.summary || 'No summary available.'}`),
  ].join('\n');
}

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_PER_MINUTE || 30),
  keyGenerator: (req) => {
    const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
    if (token && process.env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (decoded?.id) return `user:${decoded.id}`;
      } catch {
        // Fall back to IP key if JWT is invalid.
      }
    }
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Please wait a moment and try again.' },
});

function toGraphFromRows(nodeRows = [], edgeRows = []) {
  const depsBySource = new Map();
  for (const row of edgeRows) {
    if (!depsBySource.has(row.source_path)) depsBySource.set(row.source_path, []);
    depsBySource.get(row.source_path).push(row.target_path);
  }
  const graph = {};
  for (const node of nodeRows) {
    graph[node.file_path] = {
      deps: depsBySource.get(node.file_path) || [],
      type: node.file_type,
      declarations: node.declarations || [],
      metrics: node.metrics || {},
      summary: node.summary || null,
    };
  }
  return graph;
}

router.use(aiLimiter);

// ── POST /suggest-refactor ──────────────────────────────────────────────────
router.post('/suggest-refactor', requirePlan(), async (req, res, next) => {
  const jobId    = String(req.body?.jobId    || '').trim();
  const filePath = String(req.body?.filePath || '').trim();

  if (!jobId || !filePath) {
    return res.status(400).json({ error: 'jobId and filePath are required.' });
  }

  // BUG 4.2: basic path traversal guard
  if (filePath.includes('../') || filePath.includes('..\\')) {
    return res.status(400).json({ error: 'Invalid file path.' });
  }

  try {
    const nodeResult = await pgPool.query(
      `SELECT file_path, file_type, declarations, metrics, summary
       FROM graph_nodes
       WHERE job_id = $1 AND file_path = $2
       LIMIT 1`,
      [jobId, filePath],
    );

    if (nodeResult.rowCount === 0) {
      return res.status(404).json({ error: 'File not found.' });
    }

    if (!chatClient.isConfigured()) {
      return res.status(503).json({ error: 'AI provider is not configured.' });
    }

    const node = nodeResult.rows[0];
    const exportsList = (node.declarations || []).map((d) => d?.name).filter(Boolean);

    const prompt = `You are a senior software architect reviewing a file in a dependency graph analysis.

File: ${node.file_path}
Type: ${node.file_type}
Lines of code: ${node.metrics?.loc || 'unknown'}
In-degree (files that import this): ${node.metrics?.inDegree || 0}
Out-degree (files this imports): ${node.metrics?.outDegree || 0}
Exports: ${exportsList.join(', ') || 'none'}
Summary: ${node.summary || 'no summary available'}

Respond with a JSON object:
{
  "concerns": ["list of specific architectural concerns"],
  "suggestions": ["list of concrete refactoring steps"],
  "priority": "high | medium | low",
  "estimatedEffort": "hours estimate as a string, e.g. '2-4 hours'"
}
Only respond with the JSON object.`;

    const completion = await chatClient.createChatCompletion({
      model: defaultChatModel,
      maxTokens: 400,
      temperature: 0.2,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = completion?.content?.trim() || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { concerns: [], suggestions: content ? [content] : [], priority: 'medium', estimatedEffort: 'unknown' };
    }

    return res.status(200).json({
      filePath,
      concerns:        Array.isArray(parsed?.concerns)     ? parsed.concerns     : [],
      suggestions:     Array.isArray(parsed?.suggestions)  ? parsed.suggestions  : [],
      priority:        ['high','medium','low'].includes(parsed?.priority) ? parsed.priority : 'medium',
      estimatedEffort: typeof parsed?.estimatedEffort === 'string' && parsed.estimatedEffort.trim()
        ? parsed.estimatedEffort.trim()
        : 'unknown',
    });
  } catch (error) {
    return next(error);
  }
});

// ── GET /queries ────────────────────────────────────────────────────────────
router.get('/queries', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const jobId  = String(req.query?.jobId || '').trim();
  const page   = Math.max(1, Number.parseInt(req.query?.page, 10)  || 1);
  const limit  = Math.min(50, Math.max(1, Number.parseInt(req.query?.limit, 10) || 20));
  const offset = (page - 1) * limit;

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve authenticated user.' });

    if (jobId) {
      const ownership = await pgPool.query(
        `SELECT 1 FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [jobId, userId],
      );
      if (ownership.rowCount === 0) {
        return res.status(404).json({ error: 'Analysis job not found for this user.' });
      }
    }

    const queryText = jobId
      ? `SELECT id, question, answer, highlights, confidence, created_at
         FROM saved_queries
         WHERE user_id = $1 AND job_id = $2
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`
      : `SELECT id, question, answer, highlights, confidence, created_at
         FROM saved_queries
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`;

    const params = jobId ? [userId, jobId, limit, offset] : [userId, limit, offset];
    const result = await pgPool.query(queryText, params);

    return res.status(200).json({
      queries: result.rows.map((row) => ({
        id:         row.id,
        question:   row.question,
        answer:     row.answer,
        highlights: Array.isArray(row.highlights) ? row.highlights : [],
        confidence: row.confidence || null,
        createdAt:  row.created_at,
      })),
      page,
      limit,
    });
  } catch (error) {
    return next(error);
  }
});

// ── POST /query ─────────────────────────────────────────────────────────────
router.post('/query', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const question = String(req.body?.question || '').trim();
  const jobId    = String(req.body?.jobId    || '').trim();

  if (!question || !jobId) {
    return res.status(400).json({ error: 'question and jobId are required.' });
  }

  // BUG 4.2 FIX: question length guard
  if (question.length > 2000) {
    return res.status(400).json({ error: 'Question must be 2000 characters or fewer.' });
  }

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve authenticated user.' });

    const agent  = new QueryAgent({ db: pgPool, redis: redisClient });
    const result = await agent.process({ question, jobId, userId }, { jobId });

    if (result.status === 'failed') {
      // Log agent errors for debugging — this helps surface internal failures
      try { console.error('[QueryAgent] failed:', JSON.stringify(result.errors || result, null, 2)); } catch (e) { console.error('[QueryAgent] failed (non-serializable)', result.errors || result); }
      return res.status(400).json({
        error: result.errors?.[0]?.message || 'Unable to process query.',
        details: result.errors || [],
      });
    }

    return res.status(200).json(result.data);
  } catch (error) {
    return next(error);
  }
});

// ── POST /explain/stream ────────────────────────────────────────────────────
router.post('/explain/stream', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const question = String(req.body?.question || '').trim();
  const jobId    = String(req.body?.jobId    || '').trim();

  if (!question || !jobId) {
    return res.status(400).json({ error: 'question and jobId are required.' });
  }

  if (!chatClient.isConfigured()) {
    return res.status(503).json({ error: 'AI provider is not configured for streaming.' });
  }

  let clientClosed  = false;
  let streamSession = null;

  const closeStream = () => { streamSession?.cancel?.(); };
  const writeEvent  = (payload) => {
    if (clientClosed || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  req.on('close', () => { clientClosed = true; closeStream(); });

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve authenticated user.' });

    const ownership = await pgPool.query(
      `SELECT 1 FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    if (ownership.rowCount === 0) {
      return res.status(404).json({ error: 'Analysis job not found for this user.' });
    }

    // BUG 5 FIX: check Redis cache before hitting the AI provider
    const cacheKey = streamCacheKey(jobId, question);
    let cachedText = null;
    try { cachedText = await redisClient.get(cacheKey); } catch { /* cache miss */ }

    if (cachedText) {
      // Serve from cache as a single SSE chunk — instant, zero API calls
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Cache', 'HIT');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      res.write(`data: ${JSON.stringify({ text: cachedText })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Cache miss — stream from AI provider
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Cache', 'MISS');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let fullText = '';

    streamSession = await chatClient.createStream({
      model: defaultChatModel,
      maxTokens: 500,
      messages: [{ role: 'user', content: question }],
      onText: (text) => {
        if (!clientClosed) {
          writeEvent({ text });
          fullText += text;
        }
      },
    });

    await streamSession.consume();

    // Save to Redis after a successful stream (non-blocking)
    if (fullText && redisClient) {
      try { await redisClient.setex(cacheKey, STREAM_CACHE_TTL, fullText); } catch { /* best-effort */ }
    }

    if (!clientClosed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }

    return undefined;
  } catch (error) {
    closeStream();
    if (res.headersSent) {
      if (!clientClosed && !res.writableEnded) {
        writeEvent({ error: error.message || 'Streaming failed.' });
        res.end();
      }
      return undefined;
    }
    return next(error);
  }
});

// ── POST /impact ────────────────────────────────────────────────────────────
router.post('/impact', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const jobId    = String(req.body?.jobId    || '').trim();
  const filePath = String(req.body?.filePath || '').trim();

  if (!jobId || !filePath) {
    return res.status(400).json({ error: 'jobId and filePath are required.' });
  }

  try {
    const [nodesResult, edgesResult] = await Promise.all([
      pgPool.query(
        `SELECT file_path, file_type, declarations, metrics, summary
         FROM graph_nodes WHERE job_id = $1`,
        [jobId],
      ),
      pgPool.query(
        `SELECT source_path, target_path FROM graph_edges WHERE job_id = $1`,
        [jobId],
      ),
    ]);

    if (nodesResult.rowCount === 0) {
      return res.status(404).json({ error: 'No graph data found for this job.' });
    }

    const graph = toGraphFromRows(nodesResult.rows, edgesResult.rows);
    if (!graph[filePath]) {
      return res.status(404).json({ error: 'filePath not found in this job graph.' });
    }

    const edges = edgesResult.rows.map((row) => ({
      source: row.source_path,
      target: row.target_path,
    }));

    const analysisAgent = new AnalysisAgent();
    const result = await analysisAgent.process({ graph, edges, filePath }, { jobId });

    if (result.status === 'failed') {
      return res.status(400).json({
        error: result.errors?.[0]?.message || 'Unable to compute impact.',
        details: result.errors || [],
      });
    }

    return res.status(200).json({
      filePath,
      affectedFiles:       result.data?.impactedFiles       || [],
      deadCodeCandidates:  result.data?.deadCodeCandidates  || [],
    });
  } catch (error) {
    return next(error);
  }
});

// ── POST /snippet-impact ────────────────────────────────────────────────────
router.post('/snippet-impact', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const jobId    = String(req.body?.jobId    || '').trim();
  const filePath = String(req.body?.filePath || '').trim();
  const snippet  = String(req.body?.snippet  || '').trim();

  if (!jobId || !filePath || !snippet) {
    return res.status(400).json({ error: 'jobId, filePath, and snippet are required.' });
  }

  // BUG 4.2 FIX: snippet length guard
  if (snippet.length > 8000) {
    return res.status(400).json({ error: 'Snippet must be 8000 characters or fewer.' });
  }

  // BUG 8 FIX: safe integer parsing — never pass NaN to the agent
  const lineStart = toSafePositiveInt(req.body?.lineStart);
  const lineEnd   = toSafePositiveInt(req.body?.lineEnd);

  // BUG 8 FIX: validate range consistency
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    return res.status(400).json({ error: 'lineEnd must be greater than or equal to lineStart.' });
  }

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve authenticated user.' });

    const ownership = await pgPool.query(
      `SELECT 1 FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    if (ownership.rowCount === 0) {
      return res.status(404).json({ error: 'Analysis job not found for this user.' });
    }

    const agent  = new SnippetAnalyzerAgent({ db: pgPool });
    const result = await agent.process(
      { jobId, filePath, snippet, lineStart, lineEnd },
      { jobId },
    );

    if (result.status === 'failed') {
      const statusCode = Number(result.errors?.[0]?.code) || 400;
      return res.status(statusCode).json({
        error:   result.errors?.[0]?.message || 'Unable to analyze snippet impact.',
        details: result.errors || [],
      });
    }

    return res.status(200).json(result.data);
  } catch (error) {
    return next(error);
  }
});

// ── POST /chat ──────────────────────────────────────────────────────────────
router.post('/chat', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const question = String(req.body?.question || '').trim();
  const jobId = String(req.body?.jobId || '').trim();
  const conversationId = String(req.body?.conversationId || '').trim() || null;
  const historyLimit = Math.min(10, Math.max(0, Number(req.body?.historyLimit ?? 6)));

  if (!question || !jobId) {
    return res.status(400).json({ error: 'question and jobId are required.' });
  }

  if (question.length > 2000) {
    return res.status(400).json({ error: 'Question must be 2000 characters or fewer.' });
  }

  if (!chatClient.isConfigured()) {
    return res.status(503).json({ error: 'AI provider is not configured.' });
  }

  if (!embeddingClient.isConfigured()) {
    return res.status(503).json({ error: 'Embedding provider is not configured.' });
  }

  const cacheKey = `chat:${jobId}:${conversationId || 'new'}:${crypto.createHash('sha256').update(question).digest('hex')}`;
  const clientClosed = { value: false };
  let streamSession = null;

  const closeStream = () => {
    streamSession?.cancel?.();
  };

  req.on('close', () => {
    clientClosed.value = true;
    closeStream();
  });

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve authenticated user.' });

    const ownership = await pgPool.query(
      `SELECT 1 FROM analysis_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [jobId, userId],
    );
    if (ownership.rowCount === 0) {
      return res.status(404).json({ error: 'Analysis job not found for this user.' });
    }

    const cached = await redisClient.get(cacheKey).catch(() => null);
    if (cached) {
      let parsed = null;
      try {
        parsed = JSON.parse(cached);
      } catch {
        parsed = null;
      }

      if (parsed) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Cache', 'HIT');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      writeSseEvent(res, { type: 'chunk', text: parsed.text || '' });
      writeSseEvent(res, {
        type: 'done',
        sources: Array.isArray(parsed.sources) ? parsed.sources : [],
        conversationId: parsed.conversationId || null,
        confidence: parsed.confidence || 'medium',
        cached: true,
      });
      return res.end();
      }
    }

    let activeConversationId = conversationId;
    if (activeConversationId) {
      const conversationCheck = await pgPool.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND job_id = $3 LIMIT 1`,
        [activeConversationId, userId, jobId],
      );
      if (conversationCheck.rowCount === 0) activeConversationId = null;
    }

    if (!activeConversationId) {
      const createdConversation = await pgPool.query(
        `
          INSERT INTO conversations (user_id, job_id, title)
          VALUES ($1, $2, $3)
          RETURNING id
        `,
        [userId, jobId, question.slice(0, 80)],
      );
      activeConversationId = createdConversation.rows[0]?.id || null;
    }

    const historyResult = await pgPool.query(
      `
        SELECT role, content
        FROM (
          SELECT role, content, created_at
          FROM conversation_messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT $2
        ) AS recent_messages
        ORDER BY created_at ASC
      `,
      [activeConversationId, historyLimit * 2],
    );

    const history = historyResult.rows.map((row) => ({ role: row.role, content: row.content }));

    let contextFiles = [];
    const embeddingResponse = await embeddingClient.createEmbedding({
      model: DEFAULT_EMBEDDING_MODEL,
      input: question,
    });
    const vectorLiteral = toVectorLiteral(embeddingResponse?.data?.[0]?.embedding);

    if (vectorLiteral) {
      const semanticResult = await pgPool.query(
        `
          SELECT
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
          LIMIT 20
        `,
        [vectorLiteral, jobId],
      );

      const candidates = Array.isArray(semanticResult.rows) ? semanticResult.rows : [];
      const seedPaths = candidates.slice(0, 5).map((row) => row.file_path);
      const expander = new GraphRagExpander(pgPool);
      const expandedPaths = await expander.expand(seedPaths, jobId, { maxExpanded: 12 });
      const candidateMap = new Map(candidates.map((row) => [row.file_path, row]));
      const missingPaths = expandedPaths.filter((path) => !candidateMap.has(path));

      if (missingPaths.length > 0) {
        const expandedResult = await pgPool.query(
          `
            SELECT file_path, file_type, declarations, summary, 1.0 AS distance
            FROM graph_nodes
            WHERE job_id = $1 AND file_path = ANY($2)
          `,
          [jobId, missingPaths],
        );

        for (const row of expandedResult.rows) {
          candidateMap.set(row.file_path, row);
        }
      }

      const orderedCandidates = expandedPaths
        .map((path) => candidateMap.get(path))
        .filter(Boolean);

      const queryTokens = question
        .toLowerCase()
        .replace(/[^a-z0-9_\-/\s]+/g, ' ')
        .split(/\s+/)
        .filter((token) => token.length >= 2);

      contextFiles = orderedCandidates
        .map((candidate, index) => {
          const declarationNames = Array.isArray(candidate.declarations)
            ? candidate.declarations.map((entry) => entry?.name).filter(Boolean).join(' ')
            : '';

          const haystack = [candidate.file_path, candidate.file_type, candidate.summary, declarationNames]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          const hits = queryTokens.filter((token) => haystack.includes(token)).length;
          const keywordScore = queryTokens.length ? hits / queryTokens.length : 0;
          const semanticScore = 1 - Math.min(1, Math.max(0, Number(candidate.distance || 0)));
          const positionBoost = (20 - index) / 20;

          return { ...candidate, _score: keywordScore * 0.5 + semanticScore * 0.35 + positionBoost * 0.15 };
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, 12);

      const fnResult = await pgPool.query(
        `
          SELECT file_path, function_name, body_summary, embedding <=> $1::vector AS distance
          FROM function_embeddings
          WHERE job_id = $2
          ORDER BY embedding <=> $1::vector
          LIMIT 6
        `,
        [vectorLiteral, jobId],
      );

      const highScoringFiles = new Set(
        fnResult.rows
          .filter((row) => Number(row.distance) < 0.35)
          .map((row) => row.file_path),
      );

      contextFiles.sort((a, b) => {
        const aBoost = highScoringFiles.has(a.file_path) ? 1 : 0;
        const bBoost = highScoringFiles.has(b.file_path) ? 1 : 0;
        if (bBoost !== aBoost) return bBoost - aBoost;
        return b._score - a._score;
      });
    }

    const contextBlock = contextFiles.length
      ? contextFiles.map((file, index) => {
          const exports = Array.isArray(file.declarations)
            ? file.declarations.map((entry) => entry?.name).filter(Boolean).slice(0, 8).join(', ')
            : '';
          return `[Context ${index + 1}] ${file.file_path} (${file.file_type || 'module'})\nSummary: ${file.summary || 'N/A'}\nExports: ${exports || 'none'}`;
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

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let fullText = '';
    let streamError = null;

    try {
      streamSession = await chatClient.createStream({
        model: defaultChatModel,
        maxTokens: 800,
        messages,
        onText: (text) => {
          if (!clientClosed.value) {
            writeSseEvent(res, { type: 'chunk', text });
            fullText += text;
          }
        },
      });

      await streamSession.consume();
    } catch (streamErr) {
      streamError = streamErr;
      if (!clientClosed.value) {
        console.warn('[chat] provider stream failed, using local fallback:', streamErr.message);
      }
    }

    if ((!fullText || streamError) && !clientClosed.value) {
      fullText = buildFallbackChatAnswer(question, contextFiles);
    }

    if ((fullText || streamError) && !clientClosed.value) {
      const sourcePaths = contextFiles.map((file) => file.file_path);

      Promise.all([
        pgPool.query(
          `INSERT INTO conversation_messages (conversation_id, role, content) VALUES ($1, 'user', $2)`,
          [activeConversationId, question],
        ),
        pgPool.query(
          `
            INSERT INTO conversation_messages (conversation_id, role, content, source_files, confidence)
            VALUES ($1, 'assistant', $2, $3::jsonb, 'medium')
          `,
          [activeConversationId, fullText, JSON.stringify(sourcePaths)],
        ),
        redisClient.setex(cacheKey, 3600, JSON.stringify({
          text: fullText,
          sources: sourcePaths,
          conversationId: activeConversationId,
          confidence: streamError ? 'low' : 'medium',
        })).catch(() => {}),
      ]).catch((error) => console.error('[chat] post-stream persistence error:', error));

      writeSseEvent(res, {
        type: 'done',
        sources: sourcePaths,
        conversationId: activeConversationId,
        confidence: streamError ? 'low' : 'medium',
        fallback: Boolean(streamError),
      });
    }

    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent) return next(error);
    writeSseEvent(res, { type: 'error', message: error.message || 'Chat failed.' });
    if (!res.writableEnded) res.end();
  }
});

// ── GET /conversations ───────────────────────────────────────────────────────
router.get('/conversations', async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) return res.status(401).json({ error: 'Authentication required.' });

  const jobId = String(req.query?.jobId || '').trim();
  const limit = Math.min(50, Math.max(1, Number(req.query?.limit) || 20));

  if (!jobId) return res.status(400).json({ error: 'jobId is required.' });

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) return res.status(500).json({ error: 'Failed to resolve user.' });

    const { rows } = await pgPool.query(
      `
        SELECT c.id, c.title, c.created_at, c.updated_at,
               COUNT(m.id)::int AS message_count
        FROM conversations c
        LEFT JOIN conversation_messages m ON m.conversation_id = c.id
        WHERE c.user_id = $1 AND c.job_id = $2
        GROUP BY c.id
        ORDER BY c.updated_at DESC
        LIMIT $3
      `,
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

    const { rows } = await pgPool.query(
      `
        SELECT m.id, m.role, m.content, m.source_files, m.confidence, m.created_at
        FROM conversation_messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.id = $1 AND c.user_id = $2
        ORDER BY m.created_at ASC
      `,
      [convId, userId],
    );

    return res.json({ messages: rows });
  } catch (error) {
    return next(error);
  }
});

export default router;
