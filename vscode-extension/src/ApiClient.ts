/**
 * API Client for PolyGlot backend
 * Handles authentication and graph data retrieval
 */
export class ApiClient {
  currentJobId: string | null = null;
  private cache: Map<string, any> = new Map();

  constructor(private serverUrl: string, private apiToken: string) {
    // Normalize URL
    this.serverUrl = serverUrl.replace(/\/$/, '');
  }

  /**
   * Set the current job ID for graph queries
   */
  setCurrentJobId(jobId: string) {
    this.currentJobId = jobId;
    // Clear cache when switching jobs
    this.cache.clear();
  }

  /**
   * Fetch full graph data for a job
   */
  async getGraph(jobId: string) {
    const cacheKey = `graph:${jobId}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/graph/${jobId}`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch graph: ${response.statusText}`);
      }

      const data = await response.json();
      this.cache.set(cacheKey, data);
      return data;
    } catch (err) {
      console.error('[ApiClient] Failed to fetch graph:', err);
      throw err;
    }
  }

  /**
   * Fetch heatmap data (complexity/risk scoring)
   */
  async getHeatmap(jobId: string) {
    const cacheKey = `heatmap:${jobId}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/graph/${jobId}/heatmap`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch heatmap: ${response.statusText}`);
      }

      const data = await response.json();
      this.cache.set(cacheKey, data);
      return data;
    } catch (err) {
      console.error('[ApiClient] Failed to fetch heatmap:', err);
      throw err;
    }
  }

  /**
   * Get AI refactor suggestions for a file
   */
  async getRefactorSuggestions(jobId: string, filePath: string) {
    try {
      const response = await fetch(`${this.serverUrl}/api/ai/suggest-refactor`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ jobId, filePath }),
      });

      if (!response.ok) {
        throw new Error(`Failed to get refactor suggestions: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      console.error('[ApiClient] Failed to get refactor suggestions:', err);
      throw err;
    }
  }

  /**
   * List user's repositories
   */
  async getRepositories() {
    try {
      const response = await fetch(`${this.serverUrl}/api/repositories`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch repositories: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      console.error('[ApiClient] Failed to fetch repositories:', err);
      throw err;
    }
  }

  /**
   * List analysis jobs for a repository
   */
  async getRepositoryJobs(repositoryId: string) {
    try {
      const response = await fetch(`${this.serverUrl}/api/repositories/${repositoryId}/jobs`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch jobs: ${response.statusText}`);
      }

      return await response.json();
    } catch (err) {
      console.error('[ApiClient] Failed to fetch jobs:', err);
      throw err;
    }
  }

  /**
   * Build HTTP headers with authorization
   */
  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    return headers;
  }

  /**
   * Clear cache (useful when data might have changed)
   */
  clearCache() {
    this.cache.clear();
  }
}
