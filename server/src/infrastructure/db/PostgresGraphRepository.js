import { IGraphRepository } from './IGraphRepository.js';

function toJson(value, fallback) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  return JSON.stringify(value);
}

function toVectorLiteral(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return null;
  const normalized = embedding
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (normalized.length === 0) return null;
  return `[${normalized.join(',')}]`;
}

export class PostgresGraphRepository extends IGraphRepository {
  constructor(pgPool) {
    super();
    this.pgPool = pgPool;
  }

  async persistGraph(params) {
    const { jobId, graph = {}, typedEdges = [], edges = [], embeddings = {}, functionNodes = {}, contracts = {}, topology = {} } = params;
    
    if (!jobId) throw new Error('PostgresGraphRepository.persistGraph requires a jobId.');

    const client = await this.pgPool.connect();
    try {
      await client.query('BEGIN');

      // 1. Nodes
      const nodePaths = [], nodeTypes = [], nodeDeclarations = [], nodeMetrics = [], nodeSummaries = [], nodeDeadFlags = [];
      const deadCodeSet = new Set(Array.isArray(topology.deadCodeCandidates) ? topology.deadCodeCandidates : []);
      
      for (const [path, node] of Object.entries(graph)) {
        nodePaths.push(path);
        nodeTypes.push(node?.type || 'module');
        nodeDeclarations.push(toJson(node?.declarations, []));
        nodeMetrics.push(toJson(node?.metrics, {}));
        nodeSummaries.push(params.enriched?.[path]?.summary || null);
        nodeDeadFlags.push(deadCodeSet.has(path));
      }

      if (nodePaths.length > 0) {
        await client.query(
          `INSERT INTO graph_nodes (job_id, file_path, file_type, declarations, metrics, summary, is_dead_code)
           SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::jsonb[]), unnest($5::jsonb[]), unnest($6::text[]), unnest($7::boolean[])
           ON CONFLICT (job_id, file_path) DO UPDATE SET file_type = EXCLUDED.file_type, declarations = EXCLUDED.declarations, metrics = EXCLUDED.metrics, summary = EXCLUDED.summary, is_dead_code = EXCLUDED.is_dead_code`,
          [jobId, nodePaths, nodeTypes, nodeDeclarations, nodeMetrics, nodeSummaries, nodeDeadFlags]
        );
      }

      // 2. Edges
      const edgeSourcePaths = [], edgeTargetPaths = [], edgeTypes = [];
      const edgesToPersist = typedEdges.length > 0 ? typedEdges : edges;
      for (const edge of edgesToPersist) {
        if (!edge?.source || !edge?.target) continue;
        edgeSourcePaths.push(edge.source);
        edgeTargetPaths.push(edge.target);
        edgeTypes.push(edge.type || 'import');
      }

      if (edgeSourcePaths.length > 0) {
        await client.query(
          `INSERT INTO graph_edges (job_id, source_path, target_path, edge_type)
           SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::text[])
           ON CONFLICT (job_id, source_path, target_path, edge_type) DO NOTHING`,
          [jobId, edgeSourcePaths, edgeTargetPaths, edgeTypes]
        );
      }

      // 3. Embeddings
      const embeddingPaths = [], embeddingVectors = [];
      for (const [path, vector] of Object.entries(embeddings)) {
        const literal = toVectorLiteral(vector);
        if (literal) {
          embeddingPaths.push(path);
          embeddingVectors.push(literal);
        }
      }

      if (embeddingPaths.length > 0) {
        await client.query(
          `INSERT INTO file_embeddings (job_id, file_path, embedding)
           SELECT $1, t.file_path, t.embedding::vector FROM unnest($2::text[], $3::text[]) AS t(file_path, embedding)
           ON CONFLICT (job_id, file_path) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [jobId, embeddingPaths, embeddingVectors]
        );
      }

      // 4. Function Nodes
      const fnPaths = [], fnNames = [], fnKinds = [], fnCalls = [], fnLocs = [];
      for (const [path, declarations] of Object.entries(functionNodes)) {
        if (!Array.isArray(declarations)) continue;
        for (const dec of declarations) {
          if (!dec.name) continue;
          fnPaths.push(path);
          fnNames.push(dec.name);
          fnKinds.push(dec.kind || 'function');
          fnCalls.push(toJson(dec.calls, []));
          fnLocs.push(dec.loc ?? null);
        }
      }

      if (fnPaths.length > 0) {
        await client.query(
          `INSERT INTO function_nodes (job_id, file_path, name, kind, calls, loc)
           SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::jsonb[]), unnest($6::integer[])
           ON CONFLICT (job_id, file_path, name) DO UPDATE SET kind = EXCLUDED.kind, calls = EXCLUDED.calls, loc = EXCLUDED.loc`,
          [jobId, fnPaths, fnNames, fnKinds, fnCalls, fnLocs]
        );
      }

      // 5. Contracts
      const cPaths = [], cRoutes = [], cEnvDeps = [], cExtServices = [], cCaching = [];
      for (const [path, contract] of Object.entries(contracts)) {
        cPaths.push(path);
        cRoutes.push(toJson(contract?.routes, []));
        cEnvDeps.push(toJson(contract?.envDependencies, []));
        cExtServices.push(toJson(contract?.externalServices, []));
        cCaching.push(toJson(contract?.cachingPatterns, []));
      }

      if (cPaths.length > 0) {
        await client.query(
          `INSERT INTO api_contracts (job_id, file_path, routes, env_deps, ext_services, caching)
           SELECT $1, unnest($2::text[]), unnest($3::jsonb[]), unnest($4::jsonb[]), unnest($5::jsonb[]), unnest($6::jsonb[])
           ON CONFLICT (job_id, file_path) DO UPDATE SET routes = EXCLUDED.routes, env_deps = EXCLUDED.env_deps, ext_services = EXCLUDED.ext_services, caching = EXCLUDED.caching`,
          [jobId, cPaths, cRoutes, cEnvDeps, cExtServices, cCaching]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getDependencies(jobId, filePath, n = 3) {
    const result = await this.pgPool.query(
      `SELECT source_path, target_path FROM graph_edges WHERE job_id = $1`,
      [jobId]
    );

    const adj = new Map();
    for (const row of result.rows) {
      if (!adj.has(row.source_path)) adj.set(row.source_path, []);
      adj.get(row.source_path).push(row.target_path);
    }

    const dependencies = new Set();
    const visited = new Set([filePath]);
    let current = [filePath];
    let depth = 0;

    while (current.length > 0 && depth < n) {
      const next = [];
      for (const file of current) {
        for (const dep of adj.get(file) || []) {
          if (!visited.has(dep)) {
            visited.add(dep);
            dependencies.add(dep);
            next.push(dep);
          }
        }
      }
      current = next;
      depth++;
    }

    return Array.from(dependencies);
  }

  async getImpactedFiles(jobId, filePath, n = 3) {
    const result = await this.pgPool.query(
      `SELECT source_path, target_path FROM graph_edges WHERE job_id = $1`,
      [jobId]
    );

    const reverseAdj = new Map();
    for (const row of result.rows) {
      if (!reverseAdj.has(row.target_path)) reverseAdj.set(row.target_path, []);
      reverseAdj.get(row.target_path).push(row.source_path);
    }

    const impacted = new Set();
    const visited = new Set([filePath]);
    let current = [filePath];
    let depth = 0;

    while (current.length > 0 && depth < n) {
      const next = [];
      for (const file of current) {
        for (const dep of reverseAdj.get(file) || []) {
          if (!visited.has(dep)) {
            visited.add(dep);
            impacted.add(dep);
            next.push(dep);
          }
        }
      }
      current = next;
      depth++;
    }

    return Array.from(impacted);
  }

  async getContextForQuery(jobId, seedPaths, { maxFiles = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0) return [];

    const seeds = seedPaths.slice(0, seedLimit).filter(Boolean);
    if (seeds.length === 0) return [];

    try {
      const seedResult = await this.pgPool.query(
        `SELECT file_path, file_type, summary, declarations
         FROM graph_nodes
         WHERE job_id = $1 AND file_path = ANY($2)`,
        [jobId, seeds],
      );

      const fileMap = new Map();
      for (const row of seedResult.rows) {
        fileMap.set(row.file_path, {
          filePath: row.file_path,
          fileType: row.file_type || 'module',
          summary: row.summary || null,
          declarations: Array.isArray(row.declarations) ? row.declarations : [],
          relationships: [],
          distance: 0,
        });
      }

      const edgeResult = await this.pgPool.query(
        `SELECT
           CASE WHEN source_path = ANY($1) THEN target_path ELSE source_path END AS neighbour,
           CASE
             WHEN source_path = ANY($1) AND lower(edge_type) = 'import' THEN 'IMPORTS'
             WHEN source_path = ANY($1) THEN UPPER(edge_type)
             ELSE 'IMPORTED_BY'
           END AS rel_type,
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

        if (row.seed_path && fileMap.has(row.seed_path) && row.neighbour) {
          fileMap.get(row.seed_path).relationships.push({
            type: row.rel_type || 'IMPORTS',
            target: row.neighbour,
          });
        }
      }

      if (neighbourPaths.size > 0) {
        const neighbourResult = await this.pgPool.query(
          `SELECT file_path, file_type, summary, declarations
           FROM graph_nodes
           WHERE job_id = $1 AND file_path = ANY($2)`,
          [jobId, [...neighbourPaths]],
        );

        for (const row of neighbourResult.rows) {
          fileMap.set(row.file_path, {
            filePath: row.file_path,
            fileType: row.file_type || 'module',
            summary: row.summary || null,
            declarations: Array.isArray(row.declarations) ? row.declarations : [],
            relationships: [],
            distance: 1.0,
          });
        }
      }

      return [...fileMap.values()]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, maxFiles);
    } catch {
      return seedPaths.slice(0, maxFiles).map((path) => ({
        filePath: path,
        fileType: 'module',
        summary: null,
        declarations: [],
        relationships: [],
        distance: 0,
      }));
    }
  }

  async healthCheck() {
    await this.pgPool.query('SELECT 1');
    return true;
  }

  async deleteJob(jobId) {
    const tables = ['graph_nodes', 'graph_edges', 'file_embeddings', 'function_nodes', 'api_contracts'];
    for (const table of tables) {
      await this.pgPool.query(`DELETE FROM ${table} WHERE job_id = $1`, [jobId]);
    }
  }
}
