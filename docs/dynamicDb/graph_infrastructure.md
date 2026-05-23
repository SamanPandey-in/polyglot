# Dynamic Database Switching & Graph Infrastructure

## 1 — Dynamic Database Switching

### 1.1 The Core Problem
Your `GraphBuilderAgent` produces a graph in memory, then two agents persist it:

- `PersistenceAgent` → PostgreSQL (always available)
- `Neo4jGraphRepository` → Neo4j (cloud, optional)

The goal is to dynamically decide when Neo4j (graph DB) should be used instead of PostgreSQL (relational DB).

---

### 1.2 Decision Thresholds

Base the decision on metrics computed by `GraphBuilderAgent`:

| Metric | Postgres Suitable | Neo4j Preferred |
|------|------------------|----------------|
| nodeCount | < 500 | ≥ 500 |
| edgeCount | < 2,000 | ≥ 2,000 |
| Graph density | < 0.05 | ≥ 0.05 |
| cyclesDetected | < 20 | ≥ 20 |
| Max traversal depth | ≤ 3 hops | > 3 hops |

#### Hard Overrides (Always Use Neo4j)
- Impact analysis > 5 hops
- Circular dependency cycles > 50 nodes
- More than 3 relationship types

```js
const density = topology.edgeCount / (topology.nodeCount * (topology.nodeCount - 1) || 1);
```

---

### 1.3 Database Interface Abstraction

```js
export class IGraphRepository {
  async persistGraph(params)              { throw new Error("Not implemented"); }
  async getGraph(jobId)                   { throw new Error("Not implemented"); }
  async getDependencies(jobId, path, n)   { throw new Error("Not implemented"); }
  async getImpactedFiles(jobId, path, n)  { throw new Error("Not implemented"); }
  async healthCheck()                     { throw new Error("Not implemented"); }
  async deleteJob(jobId)                  { throw new Error("Not implemented"); }
}
```

---

### 1.4 Runtime Database Selection

```js
const THRESHOLDS = {
  NODE_COUNT: 500,
  EDGE_COUNT: 2000,
  DENSITY: 0.05,
  CYCLES: 20,
};

export function selectDatabase(topology, options = {}) {
  if (options.forceNeo4j) return { db: "neo4j", reasons: ["manual override"] };
  if (options.forcePostgres) return { db: "postgres", reasons: ["manual override"] };

  const { nodeCount = 0, edgeCount = 0, cyclesDetected = 0 } = topology;
  const density = edgeCount / (nodeCount * (nodeCount - 1) || 1);

  const reasons = [];

  if (nodeCount >= THRESHOLDS.NODE_COUNT) reasons.push("nodeCount");
  if (edgeCount >= THRESHOLDS.EDGE_COUNT) reasons.push("edgeCount");
  if (density >= THRESHOLDS.DENSITY) reasons.push("density");
  if (cyclesDetected >= THRESHOLDS.CYCLES) reasons.push("cycles");

  return { db: reasons.length ? "neo4j" : "postgres", reasons };
}
```

---

### 1.5 Factory Pattern

```js
import { selectDatabase } from "./dbSelector.js";
import { PostgresGraphRepository } from "./PostgresGraphRepository.js";
import { Neo4jGraphRepository } from "./Neo4jGraphRepository.js";
import { pgPool } from "../connections.js";
import { getNeo4jDriver } from "./neo4jDriver.js";

export function createGraphRepository(topology, options = {}) {
  const { db } = selectDatabase(topology, options);

  if (db === "neo4j") {
    return new Neo4jGraphRepository(getNeo4jDriver());
  }

  return new PostgresGraphRepository(pgPool);
}
```

---

## 2 — Neo4j Implementation (Cloud - Aura)

### 2.1 Neo4j Aura Setup

1. Go to https://console.neo4j.io  
2. Create AuraDB instance (Free or Pro)  
3. Download credentials  
4. Add to `.env`

```env
NEO4J_URI=neo4j+s://<your-instance>.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=your-password
```

---

### 2.2 Singleton Driver Pattern

```js
import neo4j from "neo4j-driver";
let _driver = null;

export function getNeo4jDriver() {
  if (_driver) return _driver;

  _driver = neo4j.driver(
    process.env.NEO4J_URI,
    neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD),
    {
      maxConnectionPoolSize: 50,
      connectionTimeout: 10000,
    }
  );

  return _driver;
}
```

---

## 3 — PostgreSQL (Local / Docker Only)

### 3.1 Environment Configuration

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5433/codegraph
PG_POOL_MAX=10
```

---

### 3.2 PostgreSQL Connection

```js
import { Pool } from "pg";

export const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX ?? "10", 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
```

---

### 3.3 Docker Setup

```yaml
version: "3.9"

services:
  postgres:
    image: ankane/pgvector:latest
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: codegraph

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  backend:
    build: ./server
    depends_on:
      - postgres
      - redis
    environment:
      DATABASE_URL: postgres://postgres:postgres@postgres:5432/codegraph
    command: sh -c "npm run migrate && npm run dev"
```

---

## 4 — Startup Logic

```js
async function startServer() {
  await pgPool.query("SELECT 1");
  console.log("Postgres OK");

  if (process.env.NEO4J_URI) {
    try {
      await getNeo4jDriver().verifyConnectivity();
      console.log("Neo4j Aura connected");
    } catch {
      console.warn("Neo4j unavailable — fallback to Postgres");
    }
  }

  app.listen(PORT);
}
```
