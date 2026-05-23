import neo4j from 'neo4j-driver';

let _driver = null;

/**
 * Returns a singleton Neo4j driver instance.
 * @returns {neo4j.Driver}
 */
export function getNeo4jDriver() {
  if (_driver) return _driver;

  const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  const user = process.env.NEO4J_USERNAME || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || 'neo4j';

  _driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    maxConnectionPoolSize: 25,
    connectionAcquisitionTimeout: 60_000,
    connectionTimeout: 30_000,
    // Keep connections warm — Aura idles them out faster than local
    connectionLivenessCheckTimeout: 30_000,
  });

  return _driver;
}

/**
 * Closes the singleton driver instance.
 */
export async function closeNeo4jDriver() {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

/**
 * Verifies connectivity to the Neo4j cluster.
 * @returns {Promise<boolean>}
 */
export async function verifyNeo4jConnectivity() {
  try {
    const driver = getNeo4jDriver();
    await driver.verifyConnectivity();
    return true;
  } catch (err) {
    console.error('[Neo4jDriver] Connectivity verification failed:', err.message);
    return false;
  }
}
