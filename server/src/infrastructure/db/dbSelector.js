/**
 * Thresholds for choosing Neo4j over Postgres as the primary graph store.
 */
const THRESHOLDS = {
  NODE_COUNT: Number.parseInt(process.env.NEO4J_THRESHOLD_NODES ?? "500", 10),
  EDGE_COUNT: Number.parseInt(process.env.NEO4J_THRESHOLD_EDGES ?? "2000", 10),
  DENSITY: Number.parseFloat(process.env.NEO4J_THRESHOLD_DENSITY ?? "0.05"),
  CYCLES: Number.parseInt(process.env.NEO4J_THRESHOLD_CYCLES ?? "20", 10),
  IMPACT_HOPS: 5,
  LARGE_CYCLE_SIZE: 50,
  RELATIONSHIP_TYPES: 3,
};

/**
 * Dynamically selects the database backend based on graph topology metrics.
 *
 * @param {Object} topology - Metrics from GraphBuilderAgent.
 * @param {Object} options - Manual overrides (forceNeo4j, forcePostgres).
 * @returns {Object} { db: 'neo4j' | 'postgres', reasons: string[] }
 */
export function selectDatabase(topology, options = {}) {
  const reasons = [];
  const safeTopology = topology && typeof topology === "object" ? topology : {};

  if (options.forceNeo4j) return { db: "neo4j", reasons: ["manual override"] };
  if (options.forcePostgres)
    return { db: "postgres", reasons: ["manual override"] };

  const {
    nodeCount = 0,
    edgeCount = 0,
    cyclesDetected = 0,
    relationshipTypeCount = 0,
    distinctRelationshipTypes = 0,
    largestCycleSize = 0,
    maxCycleSize = 0,
  } = safeTopology;

  const density = edgeCount / (nodeCount * (nodeCount - 1) || 1);
  const resolvedRelationshipTypeCount = Math.max(
    Number(relationshipTypeCount) || 0,
    Number(distinctRelationshipTypes) || 0,
  );
  const resolvedLargestCycleSize = Math.max(
    Number(largestCycleSize) || 0,
    Number(maxCycleSize) || 0,
  );

  if (nodeCount >= THRESHOLDS.NODE_COUNT) {
    reasons.push("nodeCount");
  }
  if (edgeCount >= THRESHOLDS.EDGE_COUNT) {
    reasons.push("edgeCount");
  }
  if (density >= THRESHOLDS.DENSITY) {
    reasons.push("density");
  }
  if (cyclesDetected >= THRESHOLDS.CYCLES) {
    reasons.push("cyclesDetected");
  }
  if (Number(options.impactAnalysisDepth) > THRESHOLDS.IMPACT_HOPS) {
    reasons.push("impactAnalysisDepth");
  }
  if (resolvedLargestCycleSize > THRESHOLDS.LARGE_CYCLE_SIZE) {
    reasons.push("largestCycleSize");
  }
  if (resolvedRelationshipTypeCount > THRESHOLDS.RELATIONSHIP_TYPES) {
    reasons.push("relationshipTypeCount");
  }

  return {
    db: reasons.length > 0 ? "neo4j" : "postgres",
    reasons,
  };
}
