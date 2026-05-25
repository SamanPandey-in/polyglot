import { BaseAgent } from '../core/BaseAgent.js';
import { scoreEmbedding } from '../core/confidence.js';
import { createEmbeddingClient } from '../../services/ai/llmProvider.js';

const EMBEDDING_BATCH_SIZE = 100;

function formatDeclarationNames(declarations) {
  if (!Array.isArray(declarations) || declarations.length === 0) return 'none';
  return declarations
    .map((entry) => entry?.name)
    .filter(Boolean)
    .slice(0, 20)
    .join(', ') || 'none';
}

function formatDependencies(deps) {
  if (!Array.isArray(deps) || deps.length === 0) return 'none';
  return deps.slice(0, 30).join(', ');
}

function buildEmbeddingInput(filePath, node, enrichedNode) {
  return [
    `File: ${filePath}`,
    `Type: ${node?.type || 'module'}`,
    `Summary: ${enrichedNode?.summary || 'No summary available.'}`,
    `Exports: ${formatDeclarationNames(node?.declarations)}`,
    `Imports from: ${formatDependencies(node?.deps)}`,
  ].join('\n');
}

export class EmbeddingAgent extends BaseAgent {
  agentId = 'embedding-agent';
  maxRetries = 2;
  timeoutMs = 180_000;

  constructor({ embeddingClient } = {}) {
    super();
    this.embeddingClient = embeddingClient || createEmbeddingClient();
    this.model = this.embeddingClient.model;
  }

  async process(input, context) {
    const start = Date.now();
    const errors = [];
    const warnings = [];

    const graph = input?.graph || {};
    const enriched = input?.enriched || {};
    const entries = Object.entries(graph);

    if (entries.length === 0) {
      return this.buildResult({
        jobId: context?.jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 400, message: 'EmbeddingAgent requires a non-empty graph.' }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    if (!this.embeddingClient.isConfigured()) {
      return this.buildResult({
        jobId: context?.jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 500, message: 'Embedding provider is not configured for EmbeddingAgent.' }],
        warnings,
        metrics: {
          attempted: entries.length,
          succeeded: 0,
          failed: entries.length,
        },
        processingTimeMs: Date.now() - start,
      });
    }

    const payload = entries.map(([filePath, node]) => ({
      filePath,
      text: buildEmbeddingInput(filePath, node, enriched[filePath]),
    }));

    const embeddings = {};
    let attempted = payload.length;
    let succeeded = 0;
    let failed = 0;
    let totalTokens = 0;

    for (let idx = 0; idx < payload.length; idx += EMBEDDING_BATCH_SIZE) {
      const batch = payload.slice(idx, idx + EMBEDDING_BATCH_SIZE);

      try {
        const response = await this.embeddingClient.createEmbedding({
          model: this.model,
          input: batch.map((item) => item.text),
        });

        const vectors = Array.isArray(response?.data) ? response.data : [];
        totalTokens += Number(response?.usage?.total_tokens || 0);

        for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
          const vector = vectors[itemIndex]?.embedding;
          const filePath = batch[itemIndex].filePath;

          if (Array.isArray(vector) && vector.length > 0) {
            embeddings[filePath] = vector;
            succeeded += 1;
          } else {
            failed += 1;
            warnings.push(`No embedding returned for ${filePath}`);
          }
        }
      } catch (error) {
        failed += batch.length;
        errors.push({ code: error?.status || 500, message: `Embedding batch failed: ${error.message}` });
      }
    }

    const confidence = scoreEmbedding({ attempted, succeeded });
    const status = succeeded === 0 ? 'failed' : failed > 0 ? 'partial' : 'success';

    return this.buildResult({
      jobId: context?.jobId,
      status,
      confidence,
      data: {
        embeddings,
        stats: {
          attempted,
          succeeded,
          failed,
          totalTokens,
        },
      },
      errors,
      warnings,
      metrics: {
        attempted,
        succeeded,
        failed,
        totalTokens,
      },
      processingTimeMs: Date.now() - start,
    });
  }
}
