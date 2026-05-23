import test from "node:test";
import assert from "node:assert/strict";

import { selectDatabase } from "../src/infrastructure/db/dbSelector.js";
import { createGraphRepository } from "../src/infrastructure/db/graphRepositoryFactory.js";

test("selectDatabase prefers Postgres for small graphs", () => {
  const result = selectDatabase({
    nodeCount: 10,
    edgeCount: 1,
    cyclesDetected: 0,
    relationshipTypeCount: 1,
  });

  assert.equal(result.db, "postgres");
  assert.deepEqual(result.reasons, []);
});

test("selectDatabase switches to Neo4j for large topology signals", () => {
  const result = selectDatabase({
    nodeCount: 500,
    edgeCount: 12475,
    cyclesDetected: 20,
    relationshipTypeCount: 4,
    largestCycleSize: 51,
  });

  assert.equal(result.db, "neo4j");
  assert.deepEqual(
    new Set(result.reasons),
    new Set([
      "nodeCount",
      "edgeCount",
      "density",
      "cyclesDetected",
      "relationshipTypeCount",
      "largestCycleSize",
    ]),
  );
});

test("selectDatabase respects manual overrides", () => {
  assert.equal(
    selectDatabase({ nodeCount: 999 }, { forcePostgres: true }).db,
    "postgres",
  );
  assert.equal(
    selectDatabase({ nodeCount: 1 }, { forceNeo4j: true }).db,
    "neo4j",
  );
});

test("createGraphRepository follows the selection result", () => {
  const postgresRepo = createGraphRepository({
    nodeCount: 10,
    edgeCount: 1,
    cyclesDetected: 0,
  });
  const neo4jRepo = createGraphRepository({
    nodeCount: 500,
    edgeCount: 12475,
    cyclesDetected: 20,
    relationshipTypeCount: 4,
    largestCycleSize: 51,
  });

  assert.equal(postgresRepo.constructor.name, "PostgresGraphRepository");
  assert.equal(neo4jRepo.constructor.name, "Neo4jGraphRepository");
});
