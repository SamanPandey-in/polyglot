/**
 * Interface for Graph Repositories.
 * All graph storage backends (Postgres, Neo4j, etc.) must implement this.
 */
export class IGraphRepository {
  /**
   * Persists the entire graph and associated metadata.
   * @param {Object} params - The data to persist (graph, edges, embeddings, functionNodes, contracts, topology, jobId).
   */
  async persistGraph(params) {
    throw new Error('Method persistGraph() must be implemented');
  }

  /**
   * Retrieves the full graph for a given jobId.
   * @param {string} jobId
   */
  async getGraph(jobId) {
    throw new Error('Method getGraph() must be implemented');
  }

  /**
   * Gets N-hop dependencies (outbound) for a file.
   * @param {string} jobId
   * @param {string} filePath
   * @param {number} n - Number of hops.
   */
  async getDependencies(jobId, filePath, n) {
    throw new Error('Method getDependencies() must be implemented');
  }

  /**
   * Gets N-hop impacted files (inbound) for a file.
   * @param {string} jobId
   * @param {string} filePath
   * @param {number} n - Number of hops.
   */
  async getImpactedFiles(jobId, filePath, n) {
    throw new Error('Method getImpactedFiles() must be implemented');
  }

  /**
   * Checks the health/connectivity of the database.
   */
  async healthCheck() {
    throw new Error('Method healthCheck() must be implemented');
  }

  /**
   * Deletes all records associated with a jobId.
   * @param {string} jobId
   */
  async deleteJob(jobId) {
    throw new Error('Method deleteJob() must be implemented');
  }
}
