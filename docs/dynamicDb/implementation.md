# Dynamic Database Switching - Implementation Report

**Date:** April 29, 2026

## Overview

Implemented dynamic graph storage selection logic that automatically routes analysis job graphs to either PostgreSQL (relational) or Neo4j (graph) based on topology metrics. This allows the system to handle both small and large codebases efficiently without requiring manual configuration per job.

---

## Changes Summary

### 1. Database Selector Logic ([dbSelector.js](../../server/src/infrastructure/db/dbSelector.js))

**What Changed:**
- Aligned selector with documented thresholds from [graph_infrastructure.md](graph_infrastructure.md)
- Added three new threshold constants: `IMPACT_HOPS: 5`, `LARGE_CYCLE_SIZE: 50`, `RELATIONSHIP_TYPES: 3`
- Removed hard environment check (`NEO4J_URI/PASSWORD`) so Neo4j is optional, not a blocker
- Changed reason strings to be machine-readable tokens (`'nodeCount'`, `'edgeCount'`, etc.) instead of verbose messages
- Added support for backward-compatible topology field aliases (`distinctRelationshipTypes`, `maxCycleSize`)

**Why:**
- Makes Neo4j truly optional—Postgres works even if Neo4j is not configured
- Decisions are now pure data-driven: topology metrics → boolean → repository type
- Standardized reason format for logging and observability

**Formula:**
```js
const density = edgeCount / (nodeCount * (nodeCount - 1) || 1);
```

**Decision Table:**
| Signal | Postgres | Neo4j |
|--------|----------|-------|
| `nodeCount` | < 500 | ≥ 500 |
| `edgeCount` | < 2,000 | ≥ 2,000 |
| `density` | < 0.05 | ≥ 0.05 |
| `cyclesDetected` | < 20 | ≥ 20 |
| `largestCycleSize` | ≤ 50 | > 50 |
| `relationshipTypeCount` | ≤ 3 | > 3 |
| `impactAnalysisDepth` | ≤ 5 | > 5 |

---

### 2. Graph Topology Metrics ([GraphBuilderAgent.js](../../server/src/agents/graph/GraphBuilderAgent.js#L199))

**What Changed:**
- Added computation of `relationshipTypeCount` (distinct edge types in the graph)
- Added computation of `largestCycleSize` (size of the largest strongly connected component)
- Exported both as primary names and backward-compatible aliases

**Output Shape:**
```js
const topology = {
  nodeCount,
  edgeCount,
  cyclesDetected,
  cycles,
  relationshipTypeCount,
  distinctRelationshipTypes: relationshipTypeCount,  // alias
  largestCycleSize,
  maxCycleSize: largestCycleSize,  // alias
  // ... existing fields ...
};
```

**Why:**
- Enables precise Neo4j/Postgres routing decisions based on actual graph complexity
- Aliases allow gradual migration of downstream consumers

---

### 3. Graph Repository Flexibility ([Neo4jGraphRepository.js](../../server/src/infrastructure/db/Neo4jGraphRepository.js#L28))

**What Changed:**
- Constructor now accepts both a driver instance or an options object
- Defaults to importing `pgPool` from connections if not provided
- Maintains backward compatibility with existing call sites

**Constructor Signatures:**
```js
// Old style (still works)
new Neo4jGraphRepository({ driver, pgPool })

// New style (more flexible)
new Neo4jGraphRepository(driver)
```

**Why:**
- Simplifies testing and dependency injection
- Allows the factory to pass just the driver without reimporting pgPool

---

### 4. Connection Pool Configuration ([connections.js](../../server/src/infrastructure/connections.js#L4))

**What Changed:**
- Made pool size configurable via `PG_POOL_MAX` environment variable
- Added `connectionTimeoutMillis: 10000` to prevent indefinite hangs
- Used safe parsing: `Number.isFinite(pgPoolMax) ? pgPoolMax : 10`

**Config:**
```env
PG_POOL_MAX=10
DATABASE_URL=postgres://postgres:postgres@localhost:5433/codegraph
```

**Why:**
- Production deployments can tune pool size for their workload
- Connection timeout prevents zombie connections from accumulating

---

### 5. Startup Probe ([startup.js](../../server/src/infrastructure/db/startup.js))

**What Changed:**
- Created new `bootstrapGraphInfrastructure()` async function
- Probes Postgres connectivity at startup (required)
- Probes Neo4j connectivity at startup (optional, non-blocking)
- Logs connectivity status and fallback behavior

**Behavior:**
```js
await bootstrapGraphInfrastructure();
// Logs:
// [GraphInfrastructure] Postgres OK
// [GraphInfrastructure] Neo4j connected  OR
// [GraphInfrastructure] Neo4j unavailable - falling back to Postgres
```

**Why:**
- Catches infrastructure misconfigurations at boot time
- Provides clear diagnostic messages for deployment troubleshooting
- Non-blocking fallback means deployments don't fail if Neo4j is down

---

### 6. Server Initialization ([index.js](../../server/index.js#L27))

**What Changed:**
- Added import of `bootstrapGraphInfrastructure`
- Await bootstrap probe before starting worker or listening

**Sequence:**
```js
await bootstrapGraphInfrastructure();  // Check databases
startAnalysisWorker();                  // Start async work processor
startCacheMetricsPersistence();         // Start cache housekeeping
app.listen(PORT);                       // Start HTTP server
```

**Why:**
- Infrastructure failures are caught before the server starts accepting traffic
- Provides observability into connection state at startup

---

## Testing

### Regression Test Suite ([dynamic-db-selection.test.js](../../server/test/dynamic-db-selection.test.js))

Four test cases cover the selector behavior:

1. **Small graph → Postgres**
   - nodeCount: 10, edgeCount: 1 → selects Postgres
   - reason: all thresholds below trigger point

2. **Large graph → Neo4j**
   - nodeCount: 500, edgeCount: 12,475, density: 0.05+, cyclesDetected: 20, largestCycleSize: 51, relationshipTypeCount: 4
   - reason: every threshold triggers
   - verifies all seven decision signals work together

3. **Manual overrides**
   - `forcePostgres: true` overrides any large topology
   - `forceNeo4j: true` overrides any small topology

4. **Factory integration**
   - Small topology → PostgresGraphRepository instance
   - Large topology → Neo4jGraphRepository instance

**Status:** All 4 tests pass ✅

---

## Migration Path

### For Existing Codebases

No action needed. The system automatically selects the right backend:
- Existing small repos use Postgres (faster, simpler)
- Large repos added in the future use Neo4j (better for deep traversals)

### For Operations/Deployment

1. **Keep Neo4j Optional:**
   ```env
   # Minimal: Postgres only
   DATABASE_URL=postgres://...
   # Optional: add Neo4j for large repos
   NEO4J_URI=neo4j+s://...
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=...
   ```

2. **Monitor Connectivity:**
   - Check logs for `[GraphInfrastructure]` messages at startup
   - Confirm either "Postgres OK" or "Neo4j connected"
   - If "Neo4j unavailable", system gracefully falls back to Postgres

3. **Tune Pool Size (Optional):**
   ```env
   PG_POOL_MAX=20  # for high-concurrency deployments
   ```

---

## Implementation Safety Guarantees

1. **No Breaking Changes**
   - Existing Postgres-only deployments work unchanged
   - SupervisorAgent still receives `createGraphRepository(topology, options)` from the same call site
   - All persistence methods remain identical

2. **Backward Compatibility**
   - Topology payload includes field aliases (`distinctRelationshipTypes`, `maxCycleSize`)
   - Neo4j constructor accepts both driver and options object
   - Reason array maintains previous semantic meaning

3. **Optional Features**
   - Neo4j unavailability is logged but not fatal
   - Postgres always available and used as fallback
   - Manual overrides available for testing and special cases

4. **Data Consistency**
   - Neo4jGraphRepository always writes Postgres first (atomic fallback)
   - Graph and metadata never split between stores
   - shareToken, job status, and analytics remain in Postgres always

---

## Code Locations

| File | Purpose |
|------|---------|
| [dbSelector.js](../../server/src/infrastructure/db/dbSelector.js) | Threshold-based database selection |
| [graphRepositoryFactory.js](../../server/src/infrastructure/db/graphRepositoryFactory.js) | Factory pattern for repository creation |
| [GraphBuilderAgent.js](../../server/src/agents/graph/GraphBuilderAgent.js#L199) | Topology metric computation |
| [Neo4jGraphRepository.js](../../server/src/infrastructure/db/Neo4jGraphRepository.js) | Neo4j persistence implementation |
| [PostgresGraphRepository.js](../../server/src/infrastructure/db/PostgresGraphRepository.js) | Postgres persistence (unchanged) |
| [connections.js](../../server/src/infrastructure/connections.js) | Connection pool configuration |
| [startup.js](../../server/src/infrastructure/db/startup.js) | Infrastructure bootstrap probe |
| [index.js](../../server/index.js) | Server entry point (bootstrap integration) |
| [dynamic-db-selection.test.js](../../server/test/dynamic-db-selection.test.js) | Regression tests |

---

## Validation

### Unit Tests
```bash
npm run test dynamic-db-selection.test.js
# Result: ✔ 4/4 tests pass
```

### Type Checking
All files pass ESLint and have no type errors.

### Integration
- Selector logic matches documented decision table exactly
- Topology metrics computed in GraphBuilder
- Factory creates correct repository type based on selection
- Bootstrap probe runs at startup and logs results

---

## Future Enhancements

1. **Observability:**
   - Add Prometheus metrics: `graph_repository_selection_total{type=["postgres","neo4j"]}`
   - Track repository type per job in analysis_jobs table

2. **Dynamic Adjustment:**
   - Allow mid-job repository migration if topology changes during enrichment
   - Implement read-from-cache / write-to-new pattern for zero-downtime transitions

3. **Cost Optimization:**
   - Lower density threshold if Neo4j is billed per query
   - Implement Neo4j connection pooling per request for shared instances

4. **Advanced Heuristics:**
   - Consider file count and language mix in decision
   - Account for historical query latencies per repository
   - Implement A/B testing for threshold tuning
