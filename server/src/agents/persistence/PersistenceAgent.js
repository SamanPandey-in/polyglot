import { BaseAgent } from '../core/BaseAgent.js';
import { scorePersistence } from '../core/confidence.js';

export class PersistenceAgent extends BaseAgent {
  agentId = 'persistence-agent';
  maxRetries = 1;
  timeoutMs = 120_000;

  constructor({ db } = {}) {
    super();
    this.db = db; // Legacy, kept for compatibility if needed elsewhere
  }

  async process(input, context) {
    const start = Date.now();
    const jobId = input?.jobId || context?.jobId;

    if (!jobId) {
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        errors: [{ code: 400, message: 'PersistenceAgent requires a jobId.' }],
        processingTimeMs: Date.now() - start,
      });
    }

    const { graphRepo } = context;
    if (!graphRepo) {
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        errors: [{ code: 500, message: 'No graphRepo provided in context.' }],
        processingTimeMs: Date.now() - start,
      });
    }

    try {
      // 1. Prepare persistence payload
      const persistParams = {
        jobId,
        repositoryId: input?.repositoryId,
        graph: input?.graph,
        typedEdges: input?.typedEdges,
        edges: input?.edges,
        functionNodes: input?.functionNodes,
        enriched: input?.enriched,
        contracts: input?.contracts,
        embeddings: input?.embeddings,
        topology: input?.topology,
      };

      // 2. Delegate to the repository implementation
      await graphRepo.persistGraph(persistParams);

      // 3. Compute simple confidence score
      // (Since logic is delegated, we assume success means high confidence here, 
      // but in a production app we'd get granular metrics from the repo)
      const confidence = scorePersistence({
        recordsAttempted: Object.keys(persistParams.graph || {}).length,
        recordsWritten: Object.keys(persistParams.graph || {}).length, 
      });

      return this.buildResult({
        jobId,
        status: 'success',
        confidence,
        data: {
          durationMs: Date.now() - start,
          mode: graphRepo.constructor.name,
        },
        metrics: {
          nodeCount: Object.keys(persistParams.graph || {}).length,
        },
        processingTimeMs: Date.now() - start,
      });
    } catch (error) {
      console.error('[PersistenceAgent] Storage error:', error.message);
      return this.buildResult({
        jobId,
        status: 'failed',
        confidence: 0,
        errors: [{ code: error.statusCode || 500, message: error.message }],
        processingTimeMs: Date.now() - start,
      });
    }
  }
}
