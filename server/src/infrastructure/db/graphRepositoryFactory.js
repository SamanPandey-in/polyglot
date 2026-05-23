import { selectDatabase } from './dbSelector.js';
import { PostgresGraphRepository } from './PostgresGraphRepository.js';
import { Neo4jGraphRepository } from './Neo4jGraphRepository.js';
import { pgPool } from '../connections.js';
import { getNeo4jDriver } from './neo4jDriver.js';

/**
 * Creates a repository instance based on topology metrics and database availability.
 *
 * @param {Object} topology - Metrics from GraphBuilderAgent.
 * @param {Object} options - Manual overrides and additional settings.
 * @returns {IGraphRepository}
 */
export function createGraphRepository(topology, options = {}) {
  const { db, reasons } = selectDatabase(topology, options);

  console.log(`[GraphRepositoryFactory] Selecting database: ${db}`, reasons);

  if (db === 'neo4j') {
    return new Neo4jGraphRepository({
      driver: getNeo4jDriver(),
      pgPool, // metadata still goes to Postgres
    });
  }

  return new PostgresGraphRepository(pgPool);
}
