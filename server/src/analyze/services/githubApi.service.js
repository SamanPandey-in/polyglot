const GITHUB_API_BASE = 'https://api.github.com';

function getRequiredRepoScopes() {
  const raw = process.env.GITHUB_REQUIRED_SCOPES || process.env.GITHUB_OAUTH_SCOPES || 'repo';
  return raw
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseScopesHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return [];

  return headerValue
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function hasRequiredScopes(grantedScopes, requiredScopes) {
  if (!requiredScopes.length) return true;

  const granted = new Set(grantedScopes);

  return requiredScopes.every((required) => {
    if (required === 'repo') {
      return granted.has('repo');
    }
    return granted.has(required);
  });
}

function extractNextLink(linkHeader) {
  if (!linkHeader) return null;

  const parts = linkHeader.split(',').map((part) => part.trim());
  for (const part of parts) {
    const match = part.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match && match[2] === 'next') {
      return match[1];
    }
  }

  return null;
}

function parseGitHubRateLimitError(response, context = 'GitHub API request') {
  if (response.status === 401) {
    const err = new Error('Failed authentication with GitHub. Please sign in again and retry.');
    err.statusCode = 401;
    throw err;
  }

  if (response.status === 403) {
    const err = new Error(`${context} was forbidden or rate-limited by GitHub. Retry later or re-authenticate with required permissions.`);
    err.statusCode = 403;
    throw err;
  }

  if (response.status === 404) {
    const err = new Error('Repository not found or inaccessible.');
    err.statusCode = 404;
    throw err;
  }

  const err = new Error(`${context} failed with status ${response.status}.`);
  err.statusCode = response.status;
  throw err;
}

async function githubFetchRaw(urlOrPath, { token, headers = {}, method = 'GET', body } = {}) {
  const targetUrl = urlOrPath.startsWith('http') ? urlOrPath : `${GITHUB_API_BASE}${urlOrPath}`;
  return fetch(targetUrl, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'polyglot',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function githubFetch(pathname, options = {}) {
  const response = await githubFetchRaw(pathname, options);

  if (!response.ok) {
    parseGitHubRateLimitError(response, `GitHub API request (${pathname})`);
  }

  return response.json();
}

export async function getTokenScopeInfo({ token }) {
  if (!token) {
    const err = new Error('GitHub authentication required. Please log in with GitHub.');
    err.statusCode = 401;
    throw err;
  }

  const response = await githubFetchRaw('/user', { token });

  if (!response.ok) {
    parseGitHubRateLimitError(response, 'GitHub token scope validation');
  }

  const grantedScopes = parseScopesHeader(response.headers.get('x-oauth-scopes'));
  const requiredScopes = getRequiredRepoScopes();
  const ok = hasRequiredScopes(grantedScopes, requiredScopes);

  return {
    ok,
    grantedScopes,
    requiredScopes,
  };
}

export function parseGitHubRepoUrl(repoUrl) {
  let parsed;

  try {
    parsed = new URL(repoUrl.trim());
  } catch {
    const err = new Error('Invalid GitHub repository URL format.');
    err.statusCode = 400;
    throw err;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    const err = new Error('Repository URL must be from github.com.');
    err.statusCode = 400;
    throw err;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    const err = new Error('Repository URL must include owner and repository name.');
    err.statusCode = 400;
    throw err;
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');

  if (!owner || !repo) {
    const err = new Error('Repository URL must include owner and repository name.');
    err.statusCode = 400;
    throw err;
  }

  return { owner, repo };
}

export async function fetchRepoDetails({ owner, repo, token }) {
  const data = await githubFetch(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    token,
  });

  return {
    owner: data.owner?.login || owner,
    repo: data.name || repo,
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    private: Boolean(data.private),
  };
}

export async function fetchRepoBranches({ owner, repo, token }) {
  const data = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    { token },
  );

  return data.map((branch) => ({
    name: branch.name,
    protected: Boolean(branch.protected),
  }));
}

function buildRepoContentsPath({ owner, repo, path: repoPath = '', ref = '' }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const normalizedPath = String(repoPath || '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  const basePath = normalizedPath
    ? `/repos/${encodedOwner}/${encodedRepo}/contents/${normalizedPath}`
    : `/repos/${encodedOwner}/${encodedRepo}/contents`;

  if (!ref) return basePath;
  return `${basePath}?ref=${encodeURIComponent(ref)}`;
}

function normalizeContentEntry(entry) {
  return {
    name: entry?.name || '',
    path: entry?.path || '',
    type: entry?.type || 'file',
    size: Number.isFinite(entry?.size) ? entry.size : 0,
    sha: entry?.sha || null,
    htmlUrl: entry?.html_url || null,
    downloadUrl: entry?.download_url || null,
  };
}

export async function fetchRepoContents({ owner, repo, path = '', ref = '', token }) {
  const apiPath = buildRepoContentsPath({ owner, repo, path, ref });
  const data = await githubFetch(apiPath, { token });

  if (!Array.isArray(data)) {
    return [];
  }

  const entries = data.map(normalizeContentEntry);

  entries.sort((a, b) => {
    const aIsDir = a.type === 'dir';
    const bIsDir = b.type === 'dir';

    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;

    return a.name.localeCompare(b.name);
  });

  return entries;
}

export async function fetchRepoTree({ owner, repo, ref = '', token }) {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const encodedRef = encodeURIComponent(ref || 'HEAD');
  const data = await githubFetch(
    `/repos/${encodedOwner}/${encodedRepo}/git/trees/${encodedRef}?recursive=1`,
    { token },
  );

  const tree = Array.isArray(data?.tree) ? data.tree : [];

  return {
    truncated: Boolean(data?.truncated),
    tree: tree.map((entry) => ({
      path: entry?.path || '',
      type: entry?.type || 'blob',
      size: Number.isFinite(entry?.size) ? entry.size : 0,
      sha: entry?.sha || null,
    })),
  };
}

function decodeGitHubBase64Content(content) {
  try {
    return Buffer.from(String(content || ''), 'base64').toString('utf8');
  } catch {
    const err = new Error('Failed to decode GitHub file content.');
    err.statusCode = 422;
    throw err;
  }
}

function encodeGitHubBase64Content(content) {
  return Buffer.from(String(content || ''), 'utf8').toString('base64');
}

export async function fetchRepoFileContent({ owner, repo, path, ref = '', token }) {
  const apiPath = buildRepoContentsPath({ owner, repo, path, ref });
  const data = await githubFetch(apiPath, { token });

  if (Array.isArray(data) || data?.type !== 'file') {
    const err = new Error('Requested path is not a file.');
    err.statusCode = 400;
    throw err;
  }

  const encoding = data?.encoding || 'base64';
  const rawContent = String(data?.content || '').replace(/\n/g, '');

  if (encoding !== 'base64') {
    const err = new Error(`Unsupported GitHub file encoding: ${encoding}.`);
    err.statusCode = 422;
    throw err;
  }

  const content = decodeGitHubBase64Content(rawContent);

  return {
    name: data?.name || path.split('/').pop() || 'unknown-file',
    path: data?.path || path,
    sha: data?.sha || null,
    size: Number.isFinite(data?.size) ? data.size : 0,
    htmlUrl: data?.html_url || null,
    downloadUrl: data?.download_url || null,
    content,
    encoding: 'utf8',
  };
}

export async function updateRepoFileContent({
  owner,
  repo,
  path,
  ref = '',
  token,
  content,
  sha,
  message,
}) {
  if (!token) {
    const err = new Error('GitHub authentication required to update files.');
    err.statusCode = 401;
    throw err;
  }

  if (!sha) {
    const err = new Error('A file SHA is required to update file content.');
    err.statusCode = 400;
    throw err;
  }

  const apiPath = buildRepoContentsPath({ owner, repo, path });
  const response = await githubFetchRaw(apiPath, {
    token,
    method: 'PUT',
    body: {
      message: message || `Update ${path} via PolyGlot`,
      content: encodeGitHubBase64Content(content),
      sha,
      ...(ref ? { branch: ref } : {}),
    },
  });

  if (!response.ok) {
    parseGitHubRateLimitError(response, `GitHub file update (${path})`);
  }

  const data = await response.json();

  return {
    path: data?.content?.path || path,
    sha: data?.content?.sha || null,
    htmlUrl: data?.content?.html_url || `https://github.com/${owner}/${repo}/blob/${ref || 'main'}/${path}`,
    commitSha: data?.commit?.sha || null,
  };
}

export async function fetchOwnedRepositories({ token }) {
  if (!token) {
    const err = new Error('GitHub authentication required. Please log in with GitHub.');
    err.statusCode = 401;
    throw err;
  }

  const scopeInfo = await getTokenScopeInfo({ token });
  if (!scopeInfo.ok) {
    const err = new Error(
      `Insufficient GitHub permissions. Required scopes: ${scopeInfo.requiredScopes.join(', ')}. Re-authenticate and grant access.`,
    );
    err.statusCode = 403;
    err.code = 'INSUFFICIENT_SCOPE';
    err.requiredScopes = scopeInfo.requiredScopes;
    err.grantedScopes = scopeInfo.grantedScopes;
    throw err;
  }

  let nextUrl = `${GITHUB_API_BASE}/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&per_page=100`;
  const allRepos = [];

  while (nextUrl) {
    const response = await githubFetchRaw(nextUrl, { token });

    if (!response.ok) {
      parseGitHubRateLimitError(response, 'GitHub repository listing');
    }

    const pageRepos = await response.json();
    if (Array.isArray(pageRepos)) {
      allRepos.push(...pageRepos);
    }

    const linkHeader = response.headers.get('link');
    nextUrl = extractNextLink(linkHeader);
  }

  const mapped = allRepos.map((repo) => ({
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner?.login,
    defaultBranch: repo.default_branch,
    private: Boolean(repo.private),
    htmlUrl: repo.html_url,
  }));

  return {
    repositories: mapped,
    scopes: {
      required: scopeInfo.requiredScopes,
      granted: scopeInfo.grantedScopes,
    },
  };
}

export async function resolvePublicRepository(repoUrl) {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  const details = await fetchRepoDetails({ owner, repo });
  const branches = await fetchRepoBranches({ owner: details.owner, repo: details.repo });

  return {
    repository: {
      owner: details.owner,
      repo: details.repo,
      fullName: details.fullName,
      private: details.private,
      defaultBranch: details.defaultBranch,
      htmlUrl: `https://github.com/${details.owner}/${details.repo}`,
    },
    branches,
  };
}
