import { pgPool } from '../../infrastructure/connections.js';

export class GraphRagExpander {
  constructor(dbOrRepo) {
    if (dbOrRepo && typeof dbOrRepo.getContextForQuery === 'function') {
      this.repo = dbOrRepo;
      this._legacyPool = null;
    } else {
      this.repo = null;
      this._legacyPool = dbOrRepo || pgPool;
    }
  }

  async expand(seedPaths, jobId, { maxExpanded = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0 || !jobId) {
      return Array.isArray(seedPaths) ? seedPaths.slice(0, maxExpanded) : [];
    }

    if (this.repo) {
      try {
        const context = await this.repo.getContextForQuery(jobId, seedPaths, {
          maxFiles: maxExpanded,
          seedLimit,
        });
        return context.map((entry) => entry.filePath).filter(Boolean);
      } catch {
        return seedPaths.slice(0, maxExpanded);
      }
    }

    return this._legacyExpand(seedPaths, jobId, { maxExpanded, seedLimit });
  }

  async getEnrichedContext(seedPaths, jobId, { maxFiles = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0 || !jobId) {
      return [];
    }

    if (this.repo) {
      try {
        return await this.repo.getContextForQuery(jobId, seedPaths, { maxFiles, seedLimit });
      } catch {
        return this._basicContext(seedPaths, maxFiles);
      }
    }

    const paths = await this._legacyExpand(seedPaths, jobId, {
      maxExpanded: maxFiles,
      seedLimit,
    });

    return paths.map((path) => ({
      filePath: path,
      fileType: 'module',
      summary: null,
      declarations: [],
      relationships: [],
      distance: seedPaths.includes(path) ? 0 : 1.0,
    }));
  }

  async _legacyExpand(seedPaths, jobId, { maxExpanded = 12, seedLimit = 5 } = {}) {
    const seeds = seedPaths.slice(0, seedLimit);

    try {
      const { rows } = await this._legacyPool.query(
        `SELECT DISTINCT
           CASE WHEN source_path = ANY($1) THEN target_path ELSE source_path END AS neighbour
         FROM graph_edges
         WHERE job_id = $2
           AND (source_path = ANY($1) OR target_path = ANY($1))`,
        [seeds, jobId],
      );

      const neighbours = rows
        .map((row) => row.neighbour)
        .filter(Boolean)
        .filter((path) => !seedPaths.includes(path));

      const seen = new Set();
      return [...seedPaths, ...neighbours]
        .filter((path) => {
          if (seen.has(path)) return false;
          seen.add(path);
          return true;
        })
        .slice(0, maxExpanded);
    } catch {
      return seedPaths.slice(0, maxExpanded);
    }
  }

  _basicContext(seedPaths, maxFiles) {
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
