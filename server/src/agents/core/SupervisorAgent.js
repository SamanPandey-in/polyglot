import { IngestionAgent } from '../ingestion/IngestionAgent.js';
import { ScannerAgent } from '../scanner/ScannerAgent.js';
import { PolyglotParserAgent } from '../parser/PolyglotParserAgent.js';
import { GraphBuilderAgent } from '../graph/GraphBuilderAgent.js';
import { RelationshipExtractorAgent } from '../graph/RelationshipExtractorAgent.js';
// BUG 7 FIX: Neo4jSeedAgent REMOVED — Neo4jGraphRepository.persistGraph() handles seeding internally
import { EnrichmentAgent } from '../enrichment/EnrichmentAgent.js';
import { ContractInferenceAgent } from '../enrichment/ContractInferenceAgent.js';
import { EmbeddingAgent } from '../embedding/EmbeddingAgent.js';
import { PersistenceAgent } from '../persistence/PersistenceAgent.js';
import { createGraphRepository } from '../../infrastructure/db/graphRepositoryFactory.js';
// BUG 8 FIX: runMigrations() is NO LONGER called here — it runs in bootstrapGraphInfrastructure()
import { AuditLogger } from './AuditLogger.js';
import { JobStatusEmitter } from './JobStatusEmitter.js';
import { decideConfidence, computeOverallConfidence } from './confidence.js';
import GitHubPRService from '../../services/GitHubPRService.js';
import ImpactAnalysisService from '../../services/ImpactAnalysisService.js';
import {
  buildGraphCacheKey,
  deleteCacheKey,
  invalidateAnalysisHistoryCacheForUser,
  invalidateRepositoriesCacheForUser,
} from '../../infrastructure/cache.js';

export class SupervisorAgent {
  constructor({ db, redis } = {}) {
    this.db    = db;
    this.redis = redis;

    this.logger  = new AuditLogger(db);
    this.emitter = new JobStatusEmitter(redis);

    this.agents = {
      ingestion:             new IngestionAgent(),
      scanner:               new ScannerAgent(),
      parser:                new PolyglotParserAgent(),
      graphBuilder:          new GraphBuilderAgent(),
      relationshipExtractor: new RelationshipExtractorAgent(),
      // BUG 7 FIX: neo4jSeed REMOVED from agents map
      enrichment:            new EnrichmentAgent(),
      contractInference:     new ContractInferenceAgent(),
      embedding:             new EmbeddingAgent(),
      persistence:           new PersistenceAgent({ db }),
    };
  }

  async runPipeline(jobId, input) {
    const context      = { jobId, startedAt: Date.now() };
    const agentTrace   = [];
    const pipelineData = {};

    await this._updateJobStatus(jobId, 'ingesting');

    try {
      // ── 1. Ingestion ────────────────────────────────────────────────────
      const ingestionResult = await this._runWithSupervision(this.agents.ingestion, input, context);
      agentTrace.push(ingestionResult);
      if (ingestionResult.status === 'failed') return this._abort(jobId, ingestionResult, agentTrace);
      Object.assign(pipelineData, ingestionResult.data);

      // ── 2. Scanning ─────────────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'scanning');
      const scanResult = await this._runWithSupervision(
        this.agents.scanner,
        { extractedPath: pipelineData.extractedPath, repoMeta: pipelineData.repoMeta },
        context,
      );
      agentTrace.push(scanResult);
      if (scanResult.status === 'failed') return this._abort(jobId, scanResult, agentTrace);
      Object.assign(pipelineData, scanResult.data);

      // ── 3. Parsing ──────────────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'parsing');
      const parseResult = await this._runWithSupervision(
        this.agents.parser,
        { manifest: pipelineData.manifest, extractedPath: pipelineData.extractedPath },
        context,
      );
      agentTrace.push(parseResult);
      if (parseResult.status === 'failed') return this._abort(jobId, parseResult, agentTrace);
      Object.assign(pipelineData, parseResult.data);

      // ── 4. Graph Building ───────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'building');
      const graphResult = await this._runWithSupervision(
        this.agents.graphBuilder,
        { parsedFiles: pipelineData.parsedFiles, extractedPath: pipelineData.extractedPath },
        context,
      );
      agentTrace.push(graphResult);
      if (graphResult.status === 'failed') return this._abort(jobId, graphResult, agentTrace);
      Object.assign(pipelineData, graphResult.data);

      // ── 5. Relationship Extraction ──────────────────────────────────────
      // BUG 10 FIX: graphRepo creation moved to AFTER this step so dbSelector
      // receives full topology including typedEdges + distinctRelationshipTypes.
      await this._updateJobStatus(jobId, 'extracting-relationships');
      const relationshipResult = await this._runWithSupervision(
        this.agents.relationshipExtractor,
        {
          graph:         pipelineData.graph,
          functionNodes: pipelineData.functionNodes,
          extractedPath: pipelineData.extractedPath,
        },
        context,
        { abortOnCritical: false },
      );
      agentTrace.push(relationshipResult);
      Object.assign(pipelineData, relationshipResult.data);

      // ── 6. Dynamic DB selection ─────────────────────────────────────────
      // BUG 10 FIX: topology now includes typedEdges + distinctRelationshipTypes
      context.graphRepo = createGraphRepository(pipelineData.topology, {
        impactAnalysisDepth: input?.maxDepth || 3,
        forceNeo4j:          input?.forceNeo4j,
        forcePostgres:       input?.forcePostgres,
      });

      // BUG 11 FIX: record which DB was chosen so ImpactAnalysisAgent can use it
      const dbType = context.graphRepo.constructor.name === 'Neo4jGraphRepository'
        ? 'neo4j'
        : 'postgres';
      await this._recordDbType(jobId, dbType);

      // ── 7. Enrichment ───────────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'enriching');
      const enrichmentResult = await this._runWithSupervision(
        this.agents.enrichment,
        { graph: pipelineData.graph, extractedPath: pipelineData.extractedPath },
        context,
        { abortOnCritical: false },
      );
      agentTrace.push(enrichmentResult);
      Object.assign(pipelineData, enrichmentResult.data);

      // ── 8. Contract Inference ───────────────────────────────────────────
      await this._updateJobStatus(jobId, 'inferring-contracts');
      const contractResult = await this._runWithSupervision(
        this.agents.contractInference,
        { graph: pipelineData.graph, extractedPath: pipelineData.extractedPath },
        context,
        { abortOnCritical: false },
      );
      agentTrace.push(contractResult);
      Object.assign(pipelineData, contractResult.data);

      // ── 9. Embedding ────────────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'embedding');
      const embeddingResult = await this._runWithSupervision(
        this.agents.embedding,
        { graph: pipelineData.graph, enriched: pipelineData.enriched, jobId },
        context,
        { abortOnCritical: false },
      );
      agentTrace.push(embeddingResult);
      Object.assign(pipelineData, embeddingResult.data);

      // BUG 7 FIX: Neo4jSeedAgent step REMOVED.
      // Neo4jGraphRepository.persistGraph() seeds Neo4j internally as part of step 10.
      // Postgres jobs never touch Neo4j at all.

      // ── 10. Persistence ─────────────────────────────────────────────────
      await this._updateJobStatus(jobId, 'persisting');
      const persistenceResult = await this._runWithSupervision(
        this.agents.persistence,
        {
          jobId,
          repositoryId:  input?.repositoryId,
          graph:         pipelineData.graph,
          typedEdges:    pipelineData.typedEdges,
          edges:         pipelineData.edges,
          functionNodes: pipelineData.functionNodes,
          enriched:      pipelineData.enriched,
          contracts:     pipelineData.contracts,
          embeddings:    pipelineData.embeddings,
          topology:      pipelineData.topology,
        },
        context,
      );
      agentTrace.push(persistenceResult);
      if (persistenceResult.status === 'failed') return this._abort(jobId, persistenceResult, agentTrace);

      const overallConfidence = computeOverallConfidence(agentTrace);

      await this._updateJobStatus(jobId, 'completed', {
        overallConfidence,
        agentTrace,
        fileCount: pipelineData.manifest?.length || 0,
        nodeCount: Object.keys(pipelineData.graph || {}).length,
        edgeCount: pipelineData.edges?.length || 0,
      });

      await this._tryPostPRComment(jobId, input);
      await this.agents.ingestion.cleanup(pipelineData.tempRoot);

      return { jobId, status: 'completed', overallConfidence, agentTrace };
    } catch (error) {
      await this._abort(jobId, { errors: [{ message: error.message }] }, agentTrace);
      await this.agents.ingestion.cleanup(pipelineData.tempRoot).catch(() => {});
      throw error;
    }
  }

  /**
   * BUG 11 FIX: Writes the chosen db_type to analysis_jobs.
   * ImpactAnalysisAgent reads this to route BFS to the correct backend.
   */
  async _recordDbType(jobId, dbType) {
    if (!this.db || typeof this.db.query !== 'function') return;
    try {
      await this.db.query(
        `UPDATE analysis_jobs SET db_type = $1 WHERE id = $2`,
        [dbType, jobId],
      );
    } catch (err) {
      console.warn('[SupervisorAgent] Could not write db_type:', err.message);
    }
  }

  async _runWithSupervision(agent, input, context, opts = { abortOnCritical: true }) {
    let attempt  = 0;
    let lastResult;

    while (attempt <= agent.maxRetries) {
      attempt += 1;
      const result = await this._runWithTimeout(agent, input, context);
      result.retryCount = attempt - 1;

      await this.logger.log({ ...result, attempt, jobId: context.jobId });

      const decision = decideConfidence(result.confidence);

      if (decision === 'PROCEED' || decision === 'PROCEED_WARN') {
        if (decision === 'PROCEED_WARN') {
          result.warnings = [...(result.warnings || []), 'Proceeding with medium confidence'];
        }
        return result;
      }

      if (decision === 'RETRY' && attempt <= agent.maxRetries) {
        lastResult = result;
        await this._sleep(Math.pow(2, attempt) * 500);
        continue;
      }

      const confidenceMessage = `${agent.agentId} confidence ${result.confidence} was too low to continue.`;

      if (opts.abortOnCritical) {
        result.status = 'failed';
        result.errors = [...(result.errors || []), { message: confidenceMessage }];
      } else {
        result.status   = 'partial';
        result.warnings = [...(result.warnings || []), `${confidenceMessage} Proceeding in degraded mode.`];
      }
      return result;
    }

    return lastResult;
  }

  async _runWithTimeout(agent, input, context) {
    return Promise.race([
      agent.process(input, context),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`${agent.agentId} timed out after ${agent.timeoutMs}ms`)),
          agent.timeoutMs,
        );
      }),
    ]).catch((error) =>
      agent.buildResult({
        jobId:            context.jobId,
        status:           'failed',
        confidence:       0,
        data:             {},
        errors:           [{ message: error.message }],
        warnings:         [],
        metrics:          {},
        processingTimeMs: agent.timeoutMs,
      }),
    );
  }

  async _abort(jobId, result, agentTrace) {
    const summary = result.errors?.map((e) => e.message).join('; ') || 'Agent failed';
    await this._updateJobStatus(jobId, 'failed', { errorSummary: summary, agentTrace });
    return { jobId, status: 'failed', error: summary, agentTrace };
  }

  async _updateJobStatus(jobId, status, extra = {}) {
    if (this.db && typeof this.db.query === 'function') {
      try {
        await this.db.query(
          `UPDATE analysis_jobs
           SET status             = $1::job_status,
               overall_confidence = COALESCE($2, overall_confidence),
               file_count         = COALESCE($3, file_count),
               node_count         = COALESCE($4, node_count),
               edge_count         = COALESCE($5, edge_count),
               error_summary      = COALESCE($6, error_summary),
               started_at         = CASE
                 WHEN $1::job_status = 'ingesting'::job_status AND started_at IS NULL THEN NOW()
                 ELSE started_at END,
               completed_at       = CASE
                 WHEN $1::job_status IN ('completed'::job_status,'failed'::job_status,'partial'::job_status)
                 THEN NOW() ELSE completed_at END,
               agent_trace        = COALESCE($7::jsonb, agent_trace)
           WHERE id = $8`,
          [
            status,
            extra.overallConfidence ?? null,
            extra.fileCount         ?? null,
            extra.nodeCount         ?? null,
            extra.edgeCount         ?? null,
            extra.errorSummary      ?? null,
            extra.agentTrace ? JSON.stringify(extra.agentTrace) : null,
            jobId,
          ],
        );
      } catch (error) {
        console.error('[SupervisorAgent] Failed to update analysis_jobs status:', error.message);
      }
    }

    if (['completed', 'failed', 'partial'].includes(status)) {
      await this._invalidateReadCachesForJob(jobId);
    }

    await this.emitter.emit(jobId, { status, ...extra });
  }

  async _invalidateReadCachesForJob(jobId) {
    try {
      await deleteCacheKey(this.redis, buildGraphCacheKey(jobId));

      if (!this.db || typeof this.db.query !== 'function') return;

      const jobResult = await this.db.query(
        'SELECT user_id FROM analysis_jobs WHERE id = $1 LIMIT 1',
        [jobId],
      );

      const userId = jobResult.rows?.[0]?.user_id;
      if (userId) {
        await invalidateAnalysisHistoryCacheForUser(this.redis, userId);
        await invalidateRepositoriesCacheForUser(this.redis, userId);
      }
    } catch (error) {
      console.error('[SupervisorAgent] Failed to invalidate Redis caches:', error.message);
    }
  }

  async _tryPostPRComment(jobId, input) {
    try {
      const prNumber = input?.github?.prNumber;
      const owner    = input?.github?.owner;
      const repo     = input?.github?.repo;
      const sha      = input?.github?.headSha;

      if (!prNumber || !owner || !repo) return;
      if (!GitHubPRService.isConfigured()) {
        console.log('[SupervisorAgent] GitHub token not configured, skipping PR comment.');
        return;
      }

      let diff;
      try {
        diff = await GitHubPRService.getPRDiff(owner, repo, parseInt(prNumber, 10));
      } catch (err) {
        console.warn('[SupervisorAgent] Could not fetch PR diff:', err.message);
        return;
      }

      const changedFiles = GitHubPRService.parseDiff(diff).map((f) => f.file);
      if (changedFiles.length === 0) return;

      const { impactedFiles } = await ImpactAnalysisService.findImpactedFiles(jobId, changedFiles, 3);
      const graphUrl = `${process.env.CLIENT_URL || 'http://localhost:5173'}/graph?jobId=${jobId}`;
      const comment  = GitHubPRService.formatImpactComment(
        changedFiles,
        Array.from(impactedFiles).sort(),
        graphUrl,
      );

      const existing = await GitHubPRService.findExistingComment(owner, repo, parseInt(prNumber, 10));
      if (existing) {
        await GitHubPRService.updatePRComment(owner, repo, existing.id, comment);
      } else {
        await GitHubPRService.postPRComment(owner, repo, parseInt(prNumber, 10), comment);
      }

      console.log(`[SupervisorAgent] PR comment posted to ${owner}/${repo}#${prNumber}`);

      if (sha) {
        const conclusion = impactedFiles.size > 10 ? 'failure' : 'neutral';
        await GitHubPRService.createCheckRun(owner, repo, sha, {
          conclusion,
          title:      `${impactedFiles.size} files potentially impacted`,
          summary:    `${changedFiles.length} changed files affect ${impactedFiles.size} dependent files.`,
          detailsUrl: graphUrl,
        });
      }
    } catch (err) {
      console.error('[SupervisorAgent] Failed to post PR comment:', err.message);
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
