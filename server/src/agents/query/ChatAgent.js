import crypto from 'crypto';
import { BaseAgent } from '../core/BaseAgent.js';
import { pgPool, redisClient } from '../../infrastructure/connections.js';
import { createChatClient, createEmbeddingClient } from '../../services/ai/llmProvider.js';
import { GraphRagExpander } from './GraphRagExpander.js';

const CACHE_TTL_SECONDS = Number(process.env.AI_CACHE_TTL_SECONDS || 3600);
const SEMANTIC_LIMIT = 20;
const CONTEXT_FILE_LIMIT = 12;
const HISTORY_TURN_LIMIT = 6;

function toVectorLiteral(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values = vector.map(Number).filter(Number.isFinite);
  return values.length ? `[${values.join(',')}]` : null;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function keywordRerank(question, candidates) {
  const tokens = tokenize(question);

  return candidates
    .map((candidate, index) => {
      const declarations = (candidate.declarations || [])
        .map((entry) => entry?.name)
        .filter(Boolean)
        .join(' ');
      const functionText = (candidate.functionMatches || [])
        .map((entry) => `${entry.functionName} ${entry.bodySummary || ''}`)
        .join(' ');
      const relationshipText = (candidate.relationships || [])
        .map((entry) => `${entry.type} ${entry.target}`)
        .join(' ');
      const haystack = [
        candidate.filePath,
        candidate.fileType,
        candidate.summary,
        declarations,
        functionText,
        relationshipText,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const hits = tokens.filter((token) => haystack.includes(token)).length;
      const keywordScore = tokens.length ? hits / tokens.length : 0;
      const semanticScore = 1 - Math.min(1, Math.max(0, Number(candidate.distance || 0)));
      const positionBoost = (SEMANTIC_LIMIT - index) / SEMANTIC_LIMIT;

      return {
        ...candidate,
        _score: keywordScore * 0.5 + semanticScore * 0.35 + positionBoost * 0.15,
      };
    })
    .sort((a, b) => b._score - a._score);
}

function buildContextBlock(contextEntries) {
  if (!contextEntries.length) {
    return 'No relevant files found in the codebase for this question.';
  }

  return contextEntries
    .map((entry, index) => {
      const exports = (entry.declarations || [])
        .map((declaration) => declaration?.name)
        .filter(Boolean)
        .slice(0, 8)
        .join(', ') || 'none';

      const relationships = (entry.relationships || [])
        .slice(0, 8)
        .map((relationship) => `  ${relationship.type} -> ${relationship.target}`)
        .join('\n');

      const functions = (entry.functionMatches || [])
        .slice(0, 4)
        .map((fn) => `  ${fn.functionName}: ${fn.bodySummary || 'No function summary available.'}`)
        .join('\n');

      return [
        `[${index + 1}] File: ${entry.filePath}`,
        `    Type: ${entry.fileType || 'module'}`,
        `    Summary: ${entry.summary || 'N/A'}`,
        `    Exports: ${exports}`,
        relationships ? `    Relationships:\n${relationships}` : '',
        functions ? `    Relevant functions:\n${functions}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

function buildSystemPrompt(contextBlock) {
  return [
    'You are an expert codebase architect assistant.',
    'Answer the user question using ONLY the provided codebase context below.',
    'Be specific: reference actual file paths, function names, and relationship types from the context.',
    'When a file EXPOSES_API, USES_TABLE, or EMITS_EVENT, call that out explicitly.',
    'If the context is insufficient, say so clearly. Do not guess or invent files, functions, APIs, tables, or behavior.',
    'Format your response in plain text. Use a short code snippet only if it greatly aids clarity.',
    '',
    '=== CODEBASE CONTEXT ===',
    contextBlock,
  ].join('\n');
}

function buildProviderFallback(question, contextEntries) {
  if (!contextEntries.length) {
    return `Unable to reach the AI provider. The retrieved codebase context is insufficient for: "${question}"`;
  }

  return [
    `Unable to reach the AI provider. Most relevant codebase context for: "${question}"`,
    ...contextEntries.slice(0, 3).map((entry) => {
      const rels = (entry.relationships || [])
        .slice(0, 3)
        .map((rel) => `${rel.type} -> ${rel.target}`)
        .join('; ');
      return `- ${entry.filePath}: ${entry.summary || 'No summary.'}${rels ? ` Relationships: ${rels}` : ''}`;
    }),
  ].join('\n');
}

export class ChatAgent extends BaseAgent {
  agentId = 'chat-agent';
  maxRetries = 1;
  timeoutMs = 120_000;

  constructor({ graphRepo, db, redis, llmClient, embeddingClient } = {}) {
    super();
    this.graphRepo = graphRepo || null;
    this.db = db || pgPool;
    this.redis = redis || redisClient;
    this.llmClient = llmClient || createChatClient();
    this.embeddingClient = embeddingClient || createEmbeddingClient();
    this.expander = new GraphRagExpander(graphRepo || this.db);
  }

  async process(input, context = {}) {
    const start = Date.now();
    const errors = [];
    const warnings = [];

    const question = String(input?.question || '').trim();
    const jobId = String(input?.jobId || context?.jobId || '').trim();
    const userId = String(input?.userId || '').trim();
    const conversationId = String(input?.conversationId || '').trim() || null;
    const historyLimit = Math.min(10, Math.max(0, Number(input?.historyLimit ?? HISTORY_TURN_LIMIT)));
    const onToken = typeof input?.onToken === 'function' ? input.onToken : null;

    if (!question || !jobId || !userId) {
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 400, message: 'ChatAgent requires question, jobId, and userId.' }],
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
        errors: [{ code: 500, message: 'LLM provider is not configured.' }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    const questionHash = crypto.createHash('sha256').update(question).digest('hex');
    const cacheKey = `chat:${jobId}:${conversationId || 'new'}:${questionHash}`;

    try {
      const cached = await this.redis?.get?.(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed?.text) onToken?.(parsed.text);
        return this.buildResult({
          jobId,
          status: 'success',
          confidence: parsed.confidence === 'high' ? 0.9 : parsed.confidence === 'medium' ? 0.7 : 0.5,
          data: { ...parsed, cacheHit: true },
          errors,
          warnings,
          metrics: { cacheHit: 1 },
          processingTimeMs: Date.now() - start,
        });
      }
    } catch {
      // Cache is best-effort.
    }

    let activeConversationId = conversationId;
    if (activeConversationId) {
      const conversationCheck = await this.db.query(
        `SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND job_id = $3 LIMIT 1`,
        [activeConversationId, userId, jobId],
      ).catch(() => ({ rowCount: 0 }));
      if (conversationCheck.rowCount === 0) activeConversationId = null;
    }

    if (!activeConversationId) {
      const createdConversation = await this.db.query(
        `INSERT INTO conversations (user_id, job_id, title)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [userId, jobId, question.slice(0, 80)],
      ).catch(() => ({ rows: [] }));
      activeConversationId = createdConversation.rows[0]?.id || null;
    }

    let history = [];
    if (activeConversationId) {
      const historyResult = await this.db.query(
        `SELECT role, content
         FROM (
           SELECT role, content, created_at
           FROM conversation_messages
           WHERE conversation_id = $1
           ORDER BY created_at DESC
           LIMIT $2
         ) AS recent_messages
         ORDER BY created_at ASC`,
        [activeConversationId, historyLimit * 2],
      ).catch(() => ({ rows: [] }));
      history = historyResult.rows.map((row) => ({ role: row.role, content: row.content }));
    }

    let contextEntries = [];
    let embeddingTokens = 0;
    let completionTokens = 0;

    if (this.embeddingClient.isConfigured()) {
      try {
        const embeddingResponse = await this.embeddingClient.createEmbedding({
          model: this.embeddingClient.model,
          input: question,
        });

        embeddingTokens = Number(embeddingResponse?.usage?.total_tokens || 0);
        const vectorLiteral = toVectorLiteral(embeddingResponse?.data?.[0]?.embedding);

        if (vectorLiteral) {
          const semanticResult = await this.db.query(
            `SELECT fe.file_path, fe.embedding <=> $1::vector AS distance
             FROM file_embeddings fe
             WHERE fe.job_id = $2
             ORDER BY fe.embedding <=> $1::vector
             LIMIT $3`,
            [vectorLiteral, jobId, SEMANTIC_LIMIT],
          ).catch(() => ({ rows: [] }));

          const semanticRows = Array.isArray(semanticResult.rows) ? semanticResult.rows : [];
          const seedPaths = semanticRows.map((row) => row.file_path).filter(Boolean);
          const distanceMap = new Map(semanticRows.map((row) => [row.file_path, Number(row.distance)]));

          const enriched = await this.expander.getEnrichedContext(seedPaths, jobId, {
            maxFiles: CONTEXT_FILE_LIMIT,
            seedLimit: 5,
          });

          contextEntries = enriched.map((entry) => ({
            ...entry,
            distance: distanceMap.get(entry.filePath) ?? entry.distance,
            functionMatches: [],
          }));

          try {
            const functionResult = await this.db.query(
              `SELECT file_path, function_name, body_summary, embedding <=> $1::vector AS distance
               FROM function_embeddings
               WHERE job_id = $2
               ORDER BY embedding <=> $1::vector
               LIMIT 12`,
              [vectorLiteral, jobId],
            );

            const functionsByFile = new Map();
            const highScoringFiles = new Set();
            for (const row of functionResult.rows || []) {
              if (!row.file_path) continue;
              if (!functionsByFile.has(row.file_path)) functionsByFile.set(row.file_path, []);
              functionsByFile.get(row.file_path).push({
                functionName: row.function_name,
                bodySummary: row.body_summary,
                distance: Number(row.distance),
              });
              if (Number(row.distance) < 0.35) highScoringFiles.add(row.file_path);
            }

            contextEntries = contextEntries.map((entry) => ({
              ...entry,
              functionMatches: functionsByFile.get(entry.filePath) || [],
              _fnBoost: highScoringFiles.has(entry.filePath) ? 0.2 : 0,
            }));
          } catch {
            // Function embeddings are additive context; file-level RAG still works without them.
          }

          contextEntries = keywordRerank(question, contextEntries)
            .map((entry) => ({ ...entry, _score: (entry._score || 0) + (entry._fnBoost || 0) }))
            .sort((a, b) => b._score - a._score)
            .slice(0, CONTEXT_FILE_LIMIT);
        }
      } catch (error) {
        warnings.push(`Embedding failed: ${error.message}`);
      }
    } else {
      warnings.push('Embedding provider is not configured; no RAG context was retrieved.');
    }

    const messages = [
      { role: 'system', content: buildSystemPrompt(buildContextBlock(contextEntries)) },
      ...history,
      { role: 'user', content: question },
    ];

    let fullText = '';
    let streamError = null;

    try {
      const streamSession = await this.llmClient.createStream({
        model: this.llmClient.model,
        maxTokens: 800,
        messages,
        onText: (text) => {
          fullText += text;
          onToken?.(text);
        },
      });

      await streamSession.consume();
      completionTokens = Number(streamSession?.usage?.completion_tokens || 0);
    } catch (error) {
      streamError = error;
      warnings.push(`LLM stream failed: ${error.message}`);
      fullText = buildProviderFallback(question, contextEntries);
      onToken?.(fullText);
    }

    if (!fullText.trim()) {
      fullText = contextEntries.length
        ? 'The provider returned no answer. The retrieved codebase context is available, but I cannot summarize it confidently.'
        : 'The retrieved codebase context is insufficient to answer this question.';
      onToken?.(fullText);
    }

    const sourcePaths = contextEntries.map((entry) => entry.filePath).filter(Boolean);
    const confidence = streamError ? 'low' : contextEntries.length >= 3 ? 'medium' : 'low';

    if (activeConversationId && fullText) {
      Promise.all([
        this.db.query(
          `INSERT INTO conversation_messages (conversation_id, role, content)
           VALUES ($1, 'user', $2)`,
          [activeConversationId, question],
        ),
        this.db.query(
          `INSERT INTO conversation_messages
             (conversation_id, role, content, source_files, confidence)
           VALUES ($1, 'assistant', $2, $3::jsonb, $4)`,
          [activeConversationId, fullText, JSON.stringify(sourcePaths), confidence],
        ),
      ]).catch((error) => console.error('[ChatAgent] turn persistence failed:', error.message));
    }

    if (fullText && !streamError) {
      const cachePayload = JSON.stringify({
        text: fullText,
        sources: sourcePaths,
        conversationId: activeConversationId,
        confidence,
      });
      this.redis?.setex?.(cacheKey, CACHE_TTL_SECONDS, cachePayload).catch(() => {});
    }

    return this.buildResult({
      jobId,
      status: streamError ? 'partial' : 'success',
      confidence: confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.7 : 0.5,
      data: {
        text: fullText,
        sources: sourcePaths,
        conversationId: activeConversationId,
        confidence,
        fallback: Boolean(streamError),
        cacheHit: false,
        retrievedFiles: contextEntries.length,
      },
      errors,
      warnings,
      metrics: {
        embeddingTokens,
        completionTokens,
        retrievedFiles: contextEntries.length,
        cacheHit: 0,
      },
      processingTimeMs: Date.now() - start,
    });
  }
}
