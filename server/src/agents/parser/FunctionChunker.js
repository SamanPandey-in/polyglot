import { pgPool } from '../../infrastructure/connections.js';
import { createEmbeddingClient } from '../../services/ai/llmProvider.js';

const BATCH_SIZE = 50;

function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;

  const normalized = embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (normalized.length === 0) return null;
  return `[${normalized.join(',')}]`;
}

export class FunctionChunker {
  constructor({ db, embeddingClient } = {}) {
    this.db = db || pgPool;
    this.embeddingClient = embeddingClient || createEmbeddingClient();
  }

  async run(jobId, { functionNodes = null, graph = null } = {}) {
    if (!jobId) throw new Error('jobId is required');

    if (!this.embeddingClient?.isConfigured?.()) {
      console.warn('[FunctionChunker] Embedding client not configured; skipping.');
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    let fnRows = [];

    if (functionNodes && typeof functionNodes === 'object') {
      for (const [filePath, declarations] of Object.entries(functionNodes)) {
        if (!Array.isArray(declarations)) continue;

        for (const declaration of declarations) {
          if (!declaration?.name) continue;
          fnRows.push({
            job_id: jobId,
            file_path: filePath,
            function_name: declaration.name,
            kind: declaration.kind || 'function',
            calls: declaration.calls || [],
            file_summary: graph?.[filePath]?.summary || null,
            file_type: graph?.[filePath]?.type || 'module',
          });
        }
      }
    } else {
      const { rows } = await this.db.query(
        `
          SELECT
            fn.job_id,
            fn.file_path,
            fn.name AS function_name,
            fn.kind,
            fn.calls,
            gn.summary AS file_summary,
            gn.file_type
          FROM function_nodes fn
          LEFT JOIN graph_nodes gn
            ON gn.job_id = fn.job_id AND gn.file_path = fn.file_path
          WHERE fn.job_id = $1
        `,
        [jobId],
      );

      fnRows = rows;
    }

    if (!fnRows.length) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    let attempted = fnRows.length;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < fnRows.length; i += BATCH_SIZE) {
      const batch = fnRows.slice(i, i + BATCH_SIZE);
      const texts = batch.map((fn) => [
        `Function: ${fn.function_name}`,
        `File: ${fn.file_path} (${fn.file_type || 'module'})`,
        fn.kind ? `Kind: ${fn.kind}` : '',
        fn.file_summary ? `File context: ${fn.file_summary}` : '',
        Array.isArray(fn.calls) && fn.calls.length > 0 ? `Calls: ${fn.calls.map((call) => call?.name).filter(Boolean).join(', ')}` : '',
      ].filter(Boolean).join('\n'));

      try {
        const response = await this.embeddingClient.createEmbedding({ model: this.embeddingClient.model, input: texts });
        const vectors = Array.isArray(response?.data) ? response.data : [];

        for (let index = 0; index < batch.length; index += 1) {
          const vector = vectors[index]?.embedding;
          const literal = toVectorLiteral(vector);
          if (!literal) {
            failed += 1;
            continue;
          }

          const row = batch[index];
          await this.db.query(
            `
              INSERT INTO function_embeddings (job_id, file_path, function_name, embedding, body_summary)
              VALUES ($1, $2, $3, $4::vector, $5)
              ON CONFLICT (job_id, file_path, function_name) DO UPDATE
              SET embedding = EXCLUDED.embedding,
                  body_summary = EXCLUDED.body_summary
            `,
            [jobId, row.file_path, row.function_name, literal, row.file_summary || null],
          );
          succeeded += 1;
        }
      } catch (error) {
        console.error('[FunctionChunker] batch error:', error.message);
        failed += batch.length;
      }
    }

    return { attempted, succeeded, failed };
  }
}
