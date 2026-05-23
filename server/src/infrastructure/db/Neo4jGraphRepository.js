import { IGraphRepository } from './IGraphRepository.js';
import { PostgresGraphRepository } from './PostgresGraphRepository.js';
import { pgPool as defaultPgPool } from '../connections.js';

const VALID_RELATIONSHIPS = new Set([
  'IMPORTS',
  'CALLS',
  'EXPOSES_API',
  'CONSUMES_API',
  'USES_TABLE',
  'USES_FIELD',
  'EMITS_EVENT',
  'LISTENS_EVENT',
]);

const LABEL_MAP = {
  EXPOSES_API:   'ApiEndpoint',
  CONSUMES_API:  'ApiEndpoint',
  USES_TABLE:    'DatabaseTable',
  USES_FIELD:    'DatabaseField',
  EMITS_EVENT:   'EventChannel',
  LISTENS_EVENT: 'EventChannel',
  IMPORTS:       'CodeFile',
  CALLS:         'Symbol',
};

export class Neo4jGraphRepository extends IGraphRepository {
  constructor(driverOrOptions = {}) {
    super();
    const options =
      driverOrOptions &&
      typeof driverOrOptions === 'object' &&
      'session' in driverOrOptions
        ? { driver: driverOrOptions }
        : driverOrOptions;

    this.driver = options.driver;
    this.pgRepo =
      options.pgRepo ||
      new PostgresGraphRepository(options.pgPool || defaultPgPool);
  }

  // ── Internal helper: open a session, run fn, always close session ───────
  async _withSession(fn, { write = true } = {}) {
    const session = this.driver.session();
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  // ── persistGraph ─────────────────────────────────────────────────────────
  async persistGraph(params) {
    const { jobId, graph = {}, typedEdges = [], topology = {} } = params;

    // 1. Write everything to Postgres first (write-through — always the source of truth)
    await this.pgRepo.persistGraph(params);

    // 2. Seed Neo4j graph structure
    await this._withSession(async (session) => {
      // 2.1 AnalysisJob node
      await session.run(
        `MERGE (j:AnalysisJob { jobId: $jobId })
         SET j.repositoryId = $repositoryId,
             j.status       = $status,
             j.nodeCount    = $nodeCount,
             j.edgeCount    = $edgeCount,
             j.updatedAt    = datetime()`,
        {
          jobId,
          repositoryId: params.repositoryId || 'unknown',
          status:       'completed',
          nodeCount:    topology.nodeCount || 0,
          edgeCount:    topology.edgeCount || 0,
        },
      );

      // 2.2 CodeFile nodes in batches of 100
      const fileEntries = Object.entries(graph);
      const deadCodeSet = new Set(topology.deadCodeCandidates || []);
      const FILE_BATCH  = 100;

      for (let i = 0; i < fileEntries.length; i += FILE_BATCH) {
        const batch = fileEntries.slice(i, i + FILE_BATCH).map(([filePath, node]) => ({
          path:     filePath,
          type:     node?.type     || 'module',
          language: node?.language || 'unknown',
          isDead:   deadCodeSet.has(filePath),
          jobId,
        }));

        await session.run(
          `UNWIND $batch AS item
           MERGE (f:CodeFile { jobId: item.jobId, path: item.path })
           SET f.type     = item.type,
               f.language = item.language,
               f.isDead   = item.isDead`,
          { batch },
        );
      }

      // 2.3 Typed relationships in batches of 200
      const edges      = typedEdges.filter((e) => VALID_RELATIONSHIPS.has(e.type));
      const EDGE_BATCH = 200;

      for (let i = 0; i < edges.length; i += EDGE_BATCH) {
        const batch  = edges.slice(i, i + EDGE_BATCH);
        const byType = {};
        for (const edge of batch) {
          (byType[edge.type] = byType[edge.type] || []).push(edge);
        }

        for (const [relType, typeEdges] of Object.entries(byType)) {
          const targetLabel = LABEL_MAP[relType] || 'Node';

          // Handle CALLS relationships (Symbol nodes) with special constraint properties
          if (relType === 'CALLS') {
            const processedEdges = typeEdges.map((e) => {
              const [prefix, name] = e.target.split(':');
              return {
                source: e.source,
                target: e.target,
                symbolName: name || e.target,
                symbolKind: 'function',
              };
            });

            await session.run(
              `UNWIND $edges AS e
               MERGE (src:CodeFile { jobId: $jobId, path: e.source })
               MERGE (tgt:Symbol { jobId: $jobId, filePath: e.source, name: e.symbolName, kind: e.symbolKind })
               MERGE (src)-[:\`${relType}\` { jobId: $jobId }]->(tgt)`,
              { edges: processedEdges, jobId },
            );
          } else {
            // For other relationships, use the original path-based merge
            await session.run(
              `UNWIND $edges AS e
               MERGE (src:CodeFile { jobId: $jobId, path: e.source })
               MERGE (tgt:\`${targetLabel}\` { jobId: $jobId, path: e.target })
               MERGE (src)-[:\`${relType}\` { jobId: $jobId }]->(tgt)`,
              { edges: typeEdges, jobId },
            );
          }
        }
      }
    });
  }

  // ── getGraph ─────────────────────────────────────────────────────────────
  // BUG 9 FIX: this method was missing — threw "Method getGraph() must be implemented"
  async getGraph(jobId) {
    return this._withSession(async (session) => {
      const result = await session.run(
        `MATCH (f:CodeFile { jobId: $jobId })
         OPTIONAL MATCH (f)-[:IMPORTS]->(dep:CodeFile { jobId: $jobId })
         RETURN
           f.path     AS src,
           f.type     AS type,
           f.isDead   AS isDead,
           f.language AS language,
           collect(dep.path) AS deps`,
        { jobId },
      );

      const nodes = [];
      const edges = [];

      for (const rec of result.records) {
        const src = rec.get('src');
        nodes.push({
          id:       src,
          type:     rec.get('type'),
          isDead:   rec.get('isDead'),
          language: rec.get('language'),
        });
        for (const dep of rec.get('deps') || []) {
          if (dep) edges.push({ source: src, target: dep, type: 'IMPORTS' });
        }
      }

      return { nodes, edges };
    }, { write: false });
  }

  // ── getDependencies ───────────────────────────────────────────────────────
  // Outbound: files that filePath imports (directly or transitively)
  async getDependencies(jobId, filePath, n = 5) {
    return this._withSession(async (session) => {
      const result = await session.run(
        `MATCH path = (start:CodeFile { jobId: $jobId, path: $filePath })
                      -[:IMPORTS*1..${n}]->(dep:CodeFile { jobId: $jobId })
         RETURN DISTINCT dep.path AS path, length(path) AS depth
         ORDER BY depth, dep.path`,
        { jobId, filePath },
      );
      return result.records.map((r) => ({
        path:  String(r.get('path')),
        depth: r.get('depth')?.toNumber?.() ?? r.get('depth'),
      }));
    }, { write: false });
  }

  // ── getImpactedFiles ──────────────────────────────────────────────────────
  // Inbound: files that depend on filePath (directly or transitively)
  async getImpactedFiles(jobId, filePath, n = 5) {
    return this._withSession(async (session) => {
      const result = await session.run(
        `MATCH path = (dep:CodeFile { jobId: $jobId })
                      -[:IMPORTS*1..${n}]->
                      (changed:CodeFile { jobId: $jobId, path: $filePath })
         RETURN DISTINCT dep.path AS path, length(path) AS depth
         ORDER BY depth, dep.path`,
        { jobId, filePath },
      );
      return result.records.map((r) => ({
        path:  String(r.get('path')),
        depth: r.get('depth')?.toNumber?.() ?? r.get('depth'),
      }));
    }, { write: false });
  }

  // ── healthCheck ───────────────────────────────────────────────────────────
  async healthCheck() {
    try {
      await this.driver.verifyConnectivity();
      return true;
    } catch {
      return false;
    }
  }

  // ── deleteJob ─────────────────────────────────────────────────────────────
  async deleteJob(jobId) {
    // Remove all Neo4j nodes associated with this job
    await this._withSession(async (session) => {
      await session.run(
        `MATCH (n { jobId: $jobId }) DETACH DELETE n`,
        { jobId },
      );
    });

    // Also delete from Postgres (write-through parity)
    await this.pgRepo.deleteJob(jobId);
  }
}
