export class GraphRagExpander {
  constructor(db) {
    this.db = db;
  }

  async expand(seedPaths, jobId, { maxExpanded = 12, seedLimit = 5 } = {}) {
    if (!Array.isArray(seedPaths) || seedPaths.length === 0 || !jobId) {
      return Array.isArray(seedPaths) ? seedPaths.slice(0, maxExpanded) : [];
    }

    const seeds = seedPaths.slice(0, seedLimit);

    try {
      const { rows } = await this.db.query(
        `
        SELECT DISTINCT
          CASE
            WHEN source_path = ANY($1) THEN target_path
            ELSE source_path
          END AS neighbour
        FROM graph_edges
        WHERE job_id = $2
          AND (source_path = ANY($1) OR target_path = ANY($1))
        `,
        [seeds, jobId],
      );

      const neighbours = rows
        .map((row) => row.neighbour)
        .filter(Boolean)
        .filter((path) => !seedPaths.includes(path));

      const merged = [...seedPaths, ...neighbours];
      const seen = new Set();
      return merged.filter((path) => {
        if (seen.has(path)) return false;
        seen.add(path);
        return true;
      }).slice(0, maxExpanded);
    } catch {
      return seedPaths.slice(0, maxExpanded);
    }
  }
}