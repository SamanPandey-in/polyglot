/**
 * ImpactAnalysisAgent
 * Finds all files that are impacted (i.e., depend on) a changed file.
 *
 * FIXES applied:
 *  Bug 1 — env var: NEO4J_USER → NEO4J_USERNAME
 *  Bug 2 — uses singleton getNeo4jDriver(), never calls driver.close()
 *  Bug 3 — BFS direction fixed: inbound (impacted → start) not outbound
 *  Bug 4 — relationship type scoped to [:IMPORTS] only, not wildcard [*]
 *  Bug 11 — reads db_type from analysis_jobs to skip unnecessary Neo4j attempts
 */

import { pgPool } from '../../infrastructure/connections.js';
import { getNeo4jDriver } from '../../infrastructure/db/neo4jDriver.js'; // BUG 2 FIX: singleton
import { BaseAgent } from '../core/BaseAgent.js';
import { scoreAnalysis } from '../core/confidence.js';

const MAX_HOPS = 6;

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value?.toNumber === 'function') {
    try {
      const n = value.toNumber();
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/**
 * Inbound BFS via Cypher.
 *
 * BUG 3 FIX: direction is now (impacted)-[:IMPORTS*]->(start), not (start)-[*]->(impacted).
 * BUG 4 FIX: relationship type is [:IMPORTS], not wildcard [*].
 * BUG 2 FIX: uses module singleton driver — never closes the driver.
 */
async function bfsNeo4j(jobId, startNode, maxHops) {
  const driver = getNeo4jDriver(); // BUG 2 FIX: singleton from module
  const session = driver.session();

  try {
    const result = await session.run(
      // BUG 3+4 FIX: inbound IMPORTS traversal only
      `MATCH path = (impacted:CodeFile { jobId: $jobId })
                    -[:IMPORTS*1..${maxHops}]->
                    (start:CodeFile { jobId: $jobId, path: $startNode })
       RETURN DISTINCT
         impacted.path       AS path,
         length(path)        AS depth,
         labels(impacted)[0] AS nodeType
       ORDER BY depth ASC`,
      { jobId, startNode },
    );

    const nodes = result.records.map((record) => ({
      path:     String(record.get('path') || ''),
      depth:    toNumber(record.get('depth'), 0),
      nodeType: String(record.get('nodeType') || 'CodeFile'),
    }));

    return { nodes, source: 'neo4j' };
  } finally {
    await session.close(); // BUG 2 FIX: close session only, NOT driver
  }
}

/**
 * Inbound BFS via Postgres adjacency table.
 * Loads all edges once and traverses in-memory — suitable for repos ≤ 500 files.
 */
async function bfsPostgres(jobId, startNode, maxHops) {
  const edgeResult = await pgPool.query(
    'SELECT source_path, target_path FROM graph_edges WHERE job_id = $1',
    [jobId],
  );

  // Reverse map: target → [sources that import it]
  const reverseMap = new Map();
  for (const row of edgeResult.rows) {
    if (!reverseMap.has(row.target_path)) reverseMap.set(row.target_path, []);
    reverseMap.get(row.target_path).push(row.source_path);
  }

  const visited = new Set([startNode]);
  const nodes = [];
  let current = [startNode];
  let depth = 0;

  while (current.length > 0 && depth < maxHops) {
    depth += 1;
    const next = [];
    for (const node of current) {
      for (const dep of reverseMap.get(node) || []) {
        if (visited.has(dep)) continue;
        visited.add(dep);
        nodes.push({ path: dep, depth, nodeType: 'CodeFile' });
        next.push(dep);
      }
    }
    current = next;
  }

  return { nodes, source: 'postgres' };
}

/**
 * Reads which DB backed a job from the analysis_jobs table.
 * Returns 'postgres' as default if unknown.
 */
async function getJobDbType(jobId) {
  try {
    const result = await pgPool.query(
      "SELECT db_type FROM analysis_jobs WHERE id = $1 LIMIT 1",
      [jobId],
    );
    return result.rows[0]?.db_type || 'postgres';
  } catch {
    return 'postgres';
  }
}

export class ImpactAnalysisAgent extends BaseAgent {
  agentId = 'impact-analysis-agent';
  maxRetries = 1;
  timeoutMs = 30_000;

  async process(input, context) {
    const start = Date.now();
    const jobId = input?.jobId || context?.jobId;
    const nodePath = input?.nodePath;
    const maxHops = Number.isFinite(Number(input?.maxHops))
      ? Math.min(MAX_HOPS, Math.max(1, Number(input.maxHops)))
      : MAX_HOPS;

    if (!jobId || !nodePath) {
      return this.buildResult({
        jobId: context?.jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 400, message: 'ImpactAnalysisAgent requires jobId and nodePath.' }],
        warnings: [],
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    const warnings = [];
    let result;

    // BUG 11 FIX: read db_type to choose the right BFS strategy directly,
    // avoiding a wasted Neo4j connection attempt for Postgres-backed jobs.
    const dbType = await getJobDbType(jobId);

    if (dbType === 'neo4j' && process.env.NEO4J_URI) {
      try {
        result = await bfsNeo4j(jobId, nodePath, maxHops);
      } catch (neo4jErr) {
        warnings.push(`Neo4j BFS failed (${neo4jErr.message}), falling back to Postgres.`);
        try {
          result = await bfsPostgres(jobId, nodePath, Math.min(maxHops, 3));
        } catch (pgErr) {
          return this.buildResult({
            jobId,
            status: 'failed',
            confidence: 0,
            data: {},
            errors: [{ code: 500, message: `Both BFS strategies failed: ${pgErr.message}` }],
            warnings,
            metrics: {},
            processingTimeMs: Date.now() - start,
          });
        }
      }
    } else {
      // Postgres job — go straight to Postgres BFS, no Neo4j attempt
      try {
        result = await bfsPostgres(jobId, nodePath, maxHops);
      } catch (pgErr) {
        return this.buildResult({
          jobId,
          status: 'failed',
          confidence: 0,
          data: {},
          errors: [{ code: 500, message: `Postgres BFS failed: ${pgErr.message}` }],
          warnings,
          metrics: {},
          processingTimeMs: Date.now() - start,
        });
      }
    }

    const direct        = result.nodes.filter((n) => n.depth === 1);
    const nearTransitive = result.nodes.filter((n) => n.depth >= 2 && n.depth <= 3);
    const farTransitive  = result.nodes.filter((n) => n.depth >= 4);

    return this.buildResult({
      jobId,
      status: 'success',
      confidence: scoreAnalysis(),
      data: {
        startNode:     nodePath,
        impactedNodes: result.nodes,
        direct,
        nearTransitive,
        farTransitive,
        totalImpacted: result.nodes.length,
        maxDepth:      Math.max(0, ...result.nodes.map((n) => n.depth)),
        source:        result.source,
        dbType,
      },
      errors: [],
      warnings,
      metrics: {
        totalImpacted:    result.nodes.length,
        directCount:      direct.length,
        transitiveCount:  nearTransitive.length + farTransitive.length,
        source:           result.source,
      },
      processingTimeMs: Date.now() - start,
    });
  }
}
