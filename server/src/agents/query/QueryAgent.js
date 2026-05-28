import crypto from 'crypto';
import { BaseAgent } from '../core/BaseAgent.js';
import { pgPool, redisClient } from '../../infrastructure/connections.js';
import { createChatClient, createEmbeddingClient } from '../../services/ai/llmProvider.js';

const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS || 3600);
const SEMANTIC_CANDIDATE_LIMIT = 20;
const CONTEXT_LIMIT = 8;

function normalizeQuestion(value) {
  return String(value || '').trim();
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;

  const normalized = vector
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (normalized.length === 0) return null;
  return `[${normalized.join(',')}]`;
}

function clamp01(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function confidenceLabel(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  return 'low';
}

function sanitizeHighlights(filePaths) {
  if (!Array.isArray(filePaths)) return [];
  const normalized = [];
  for (const item of filePaths) {
    if (!item) continue;
    if (typeof item === 'string') normalized.push(item.trim());
    else if (typeof item === 'object') {
      const p = item.filePath || item.file_path || item.path;
      if (p) normalized.push(String(p).trim());
    }
  }
  return [...new Set(normalized)].slice(0, CONTEXT_LIMIT);
}

function buildContextLine(candidate) {
  const declarations = Array.isArray(candidate.declarations)
    ? candidate.declarations
        .map((entry) => entry?.name)
        .filter(Boolean)
        .slice(0, 10)
        .join(', ')
    : 'none';

  return [
    `File: ${candidate.file_path}`,
    `Type: ${candidate.file_type || 'module'}`,
    `Summary: ${candidate.summary || 'No summary available'}`,
    `Declarations: ${declarations || 'none'}`,
  ].join('\n');
}

function buildAnswerPrompt(question, contextFiles) {
  const contextText = contextFiles
    .map((file, index) => `Context ${index + 1}:\n${buildContextLine(file)}`)
    .join('\n\n');

  return [
    'You are an assistant for repository architecture Q&A.',
    'Answer using only the provided context. If uncertain, say what is unknown briefly.',
    'Return strictly valid JSON with keys: answer, highlightedFiles, confidence.',
    'confidence must be one of: high, medium, low.',
    '',
    `Question: ${question}`,
    '',
    'Context files:',
    contextText,
  ].join('\n');
}

function keywordRerank(question, candidates) {
  const queryTokens = tokenize(question);

  return candidates
    .map((candidate, index) => {
      const declarations = Array.isArray(candidate.declarations)
        ? candidate.declarations.map((entry) => entry?.name).filter(Boolean).join(' ')
        : '';
      const haystack = [candidate.file_path, candidate.file_type, candidate.summary, declarations]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let tokenHits = 0;
      for (const token of queryTokens) {
        if (haystack.includes(token)) tokenHits += 1;
      }

      const keywordScore = queryTokens.length === 0 ? 0 : tokenHits / queryTokens.length;
      const semanticScore = 1 - clamp01(Number(candidate.distance));
      const rankBoost = (SEMANTIC_CANDIDATE_LIMIT - index) / SEMANTIC_CANDIDATE_LIMIT;

      return {
        ...candidate,
        _score: keywordScore * 0.6 + semanticScore * 0.3 + rankBoost * 0.1,
      };
    })
    .sort((a, b) => b._score - a._score);
}

export class QueryAgent extends BaseAgent {
  agentId = 'query-agent';
  maxRetries = 1;
  timeoutMs = 90_000;

  constructor({ db, redis, llmClient, embeddingClient } = {}) {
    super();
    this.db = db || pgPool;
    this.redis = redis || redisClient;
    this.llmClient = llmClient || createChatClient();
    this.embeddingClient = embeddingClient || createEmbeddingClient();
    this.model = this.llmClient.model;
    this.embeddingModel = this.embeddingClient.model;
    this.cacheTtlSeconds = Number.isFinite(CACHE_TTL_SECONDS) ? CACHE_TTL_SECONDS : 3600;
  }

  async process(input, context) {
    const start = Date.now();
    const errors = [];
    const warnings = [];

    const question = normalizeQuestion(input?.question);
    const jobId = input?.jobId || context?.jobId;
    const userId = input?.userId;

    if (!question || !jobId || !userId) {
      return this.buildResult({
        jobId: context?.jobId || jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 400, message: 'QueryAgent requires question, jobId, and userId.' }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    if (!this.llmClient.isConfigured()) {
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 500, message: 'AI provider is not configured for QueryAgent.' }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    if (!this.embeddingClient.isConfigured()) {
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 500, message: 'Embedding provider is not configured for QueryAgent.' }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    const cacheKey = this._cacheKey(jobId, question);

    try {
      const cached = await this._readCache(cacheKey);
      if (cached) {
        return this.buildResult({
          jobId,
          status: 'success',
          confidence: cached.confidence === 'high' ? 0.9 : cached.confidence === 'medium' ? 0.7 : 0.5,
          data: {
            answer: cached.answer,
            highlightedFiles: cached.highlightedFiles,
            confidence: cached.confidence,
            retrievedFiles: cached.retrievedFiles || 0,
            queryEmbeddingTokens: cached.queryEmbeddingTokens || 0,
            completionTokens: cached.completionTokens || 0,
            cacheHit: true,
          },
          errors,
          warnings,
          metrics: {
            retrievedFiles: cached.retrievedFiles || 0,
            queryEmbeddingTokens: cached.queryEmbeddingTokens || 0,
            completionTokens: cached.completionTokens || 0,
            cacheHit: 1,
          },
          processingTimeMs: Date.now() - start,
        });
      }

      const embeddingResponse = await this.embeddingClient.createEmbedding({
        model: this.embeddingModel,
        input: question,
      });

      const queryEmbedding = embeddingResponse?.data?.[0]?.embedding;
      const vectorLiteral = toVectorLiteral(queryEmbedding);
      if (!vectorLiteral) {
        throw new Error('Failed to generate query embedding.');
      }

      const semanticCandidates = await this.db.query(
        `
          SELECT
            fe.file_path,
            fe.embedding <=> $1::vector AS distance,
            gn.file_type,
            gn.declarations,
            gn.summary
          FROM file_embeddings fe
          JOIN graph_nodes gn
            ON gn.job_id = fe.job_id
           AND gn.file_path = fe.file_path
          WHERE fe.job_id = $2
          ORDER BY fe.embedding <=> $1::vector
          LIMIT ${SEMANTIC_CANDIDATE_LIMIT}
        `,
        [vectorLiteral, jobId],
      );

      const candidates = Array.isArray(semanticCandidates?.rows) ? semanticCandidates.rows : [];
      if (candidates.length === 0) {
        throw new Error('No semantic candidates found for this job.');
      }

      const reranked = keywordRerank(question, candidates);
      const topFiles = reranked.slice(0, CONTEXT_LIMIT);

      // Parallel: query function embeddings to find function-level matches and optionally fetch body_source
      let functionHighlights = new Map();
      try {
        const fnRes = await this.db.query(
          `SELECT file_path, function_name, body_summary, embedding <=> $1::vector AS distance
           FROM function_embeddings
           WHERE job_id = $2
           ORDER BY embedding <=> $1::vector
           LIMIT 12`,
          [vectorLiteral, jobId],
        );

        const toFetch = (fnRes.rows || []).filter((r) => Number(r.distance) < 0.30);
        if (toFetch.length > 0) {
          // Build dynamic OR query to fetch body_source from function_nodes for matched functions
          const clauses = [];
          const params = [jobId];
          let idx = 2;
          for (const f of toFetch) {
            clauses.push(`(file_path = $${idx} AND name = $${idx + 1})`);
            params.push(f.file_path, f.function_name);
            idx += 2;
          }

          const q = `SELECT file_path, name, body_source FROM function_nodes WHERE job_id = $1 AND (${clauses.join(' OR ')})`;
          const bodies = await this.db.query(q, params).catch(() => ({ rows: [] }));
          for (const b of bodies.rows || []) {
            if (!b.file_path) continue;
            const snippet = b.body_source ? (String(b.body_source).slice(0, 400)) : null;
            if (!functionHighlights.has(b.file_path)) functionHighlights.set(b.file_path, snippet);
          }
        }
      } catch (err) {
        // best-effort
      }

      const completion = await this.llmClient.createChatCompletion({
        model: this.model,
        temperature: 0.1,
        maxTokens: 320,
        responseFormat: { type: 'json_object' },
        messages: [{ role: 'user', content: buildAnswerPrompt(question, topFiles) }],
      });

      const rawMessage = completion?.content || '{}';
      let parsed;
      try {
        parsed = JSON.parse(rawMessage);
      } catch {
        parsed = {
          answer: String(rawMessage).trim() || 'Unable to generate a confident answer from repository context.',
          highlightedFiles: topFiles.map((file) => file.file_path),
          confidence: 'low',
        };
      }

      // Build highlighted files array with optional snippet from function-level highlights
      const highlightedCandidates = parsed.highlightedFiles?.length
        ? parsed.highlightedFiles
        : topFiles.map((file) => ({ filePath: file.file_path, snippet: functionHighlights.get(file.file_path) || null }));

      const highlightedFiles = sanitizeHighlights(highlightedCandidates);
      const llmConfidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : confidenceLabel((topFiles[0]?._score || 0));

      const result = {
        answer: String(parsed.answer || '').trim() || 'Unable to generate a confident answer from repository context.',
        highlightedFiles,
        confidence: llmConfidence,
        retrievedFiles: topFiles.length,
        queryEmbeddingTokens: Number(embeddingResponse?.usage?.total_tokens || 0),
        completionTokens: Number(completion?.usage?.completion_tokens || completion?.usage?.output_tokens || 0),
      };

      await this._saveQuery({
        userId,
        jobId,
        question,
        answer: result.answer,
        highlightedFiles: result.highlightedFiles,
        confidence: result.confidence,
      });

      await this._writeCache(cacheKey, result);

      return this.buildResult({
        jobId,
        status: 'success',
        confidence: result.confidence === 'high' ? 0.9 : result.confidence === 'medium' ? 0.7 : 0.5,
        data: result,
        errors,
        warnings,
        metrics: {
          retrievedFiles: result.retrievedFiles,
          queryEmbeddingTokens: result.queryEmbeddingTokens,
          completionTokens: result.completionTokens,
          cacheHit: 0,
        },
        processingTimeMs: Date.now() - start,
      });
    } catch (error) {
      errors.push({ code: error?.status || 500, message: error.message });

      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors,
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }
  }

  _cacheKey(jobId, question) {
    const hash = crypto.createHash('sha256').update(question).digest('hex');
    return `nlq:${jobId}:${hash}`;
  }

  async _readCache(key) {
    if (!this.redis || typeof this.redis.get !== 'function') return null;

    try {
      const raw = await this.redis.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async _writeCache(key, value) {
    if (!this.redis || typeof this.redis.set !== 'function') return;

    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', this.cacheTtlSeconds);
    } catch {
      // Cache writes are best-effort.
    }
  }

  async _saveQuery({ userId, jobId, question, answer, highlightedFiles, confidence }) {
    await this.db.query(
      `
        INSERT INTO saved_queries (user_id, job_id, question, answer, highlights, confidence)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `,
      [userId, jobId, question, answer, JSON.stringify(highlightedFiles || []), confidence || null],
    );
  }
}
