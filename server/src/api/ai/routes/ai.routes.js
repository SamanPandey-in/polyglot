import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { QueryAgent } from '../../../agents/query/QueryAgent.js';
import { AnalysisAgent } from '../../../agents/analysis/AnalysisAgent.js';
import { SnippetAnalyzerAgent } from '../../../agents/analysis/SnippetAnalyzerAgent.js';
import { pgPool, redisClient } from '../../../infrastructure/connections.js';
import { requirePlan } from '../../../middleware/planGuard.middleware.js';
import { createChatClient } from '../../../services/ai/llmProvider.js';
import { getAuthUser, resolveDatabaseUserId } from '../../../utils/authUser.js';

const router = Router();
const chatClient = createChatClient();
const defaultChatModel = chatClient.model;

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

export default router;
