import axios from 'axios';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';

const analyzeClient = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

function buildRepoParams(repository, extra = {}) {
  const params = {
    source: repository?.mode === 'owned' ? 'owned' : 'public',
    ...extra,
  };

  if (repository?.owner && repository?.repo) {
    params.owner = repository.owner;
    params.repo = repository.repo;
  } else if (repository?.url) {
    params.url = repository.url;
  }

  if (repository?.branch) {
    params.branch = repository.branch;
  }

  return params;
}

export const analyzeService = {
  async getRepositoryStructure(repository) {
    const { data } = await analyzeClient.get('/api/analyze/github/structure', {
      params: buildRepoParams(repository),
    });

    return {
      repository: data?.repository || null,
      truncated: Boolean(data?.truncated),
      directories: Array.isArray(data?.directories) ? data.directories : [],
      files: Array.isArray(data?.files) ? data.files : [],
    };
  },

  async getDirectoryContents(repository, path = '') {
    const { data } = await analyzeClient.get('/api/analyze/github/contents', {
      params: buildRepoParams(repository, {
        path: String(path || '').trim(),
      }),
    });

    return {
      repository: data?.repository || null,
      path: data?.path || '',
      entries: Array.isArray(data?.entries) ? data.entries : [],
    };
  },

  async getFileContent(repository, path = '') {
    const { data } = await analyzeClient.get('/api/analyze/github/file', {
      params: buildRepoParams(repository, {
        path: String(path || '').trim(),
      }),
    });

    return {
      repository: data?.repository || null,
      file: data?.file || null,
      canEdit: Boolean(data?.canEdit),
    };
  },

  async saveFileContent(repository, { path, content, sha, message }) {
    const { data } = await analyzeClient.put('/api/analyze/github/file', {
      ...buildRepoParams(repository),
      path: String(path || '').trim(),
      content: String(content ?? ''),
      sha: String(sha || '').trim(),
      message: String(message || '').trim() || undefined,
    });

    return {
      file: data?.file || null,
    };
  },

  async commitCreatePR(repository, { path, content, sha, base, head, commitMessage, prTitle, prBody }) {
    const payload = {
      ...buildRepoParams(repository),
      path: String(path || '').trim(),
      content: String(content ?? ''),
      sha: sha || undefined,
      base: base || undefined,
      head: head || undefined,
      commitMessage: commitMessage || undefined,
      prTitle: prTitle || undefined,
      prBody: prBody || undefined,
    };

    const { data } = await analyzeClient.post('/api/analyze/commit', payload);
    return data;
  },
};
