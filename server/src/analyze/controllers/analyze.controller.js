import path from 'path';
import { validateLocalRepository } from '../services/analyze.service.js';
import {
  getLocalPickerCapabilities,
  pickLocalDirectory,
} from '../services/localPicker.service.js';
import {
  fetchRepoFileContent,
  fetchRepoContents,
  fetchOwnedRepositories,
  fetchRepoBranches,
  fetchRepoDetails,
  fetchRepoTree,
  parseGitHubRepoUrl,
  resolvePublicRepository,
  updateRepoFileContent,
} from '../services/githubApi.service.js';
import { pgPool, redisClient } from '../../infrastructure/connections.js';
import {
  buildAnalysisHistoryCacheKey,
  cacheTtl,
  invalidateAnalysisHistoryCacheForUser,
  invalidateRepositoriesCacheForUser,
  readJsonCache,
  writeJsonCache,
} from '../../infrastructure/cache.js';
import { enqueueAnalysisJob } from '../../queue/analysisQueue.js';
import { getAuthUser, resolveDatabaseUserId } from '../../utils/authUser.js';

function buildRepositoryIdentity(input) {
  if (input?.source === 'local') {
    return {
      source: 'local',
      fullName: input.localPath,
      githubOwner: null,
      githubRepo: null,
      defaultBranch: null,
      branch: null,
    };
  }

  const github = input?.github || {};
  let owner = github.owner || null;
  let repo = github.repo || null;

  if ((!owner || !repo) && github.url) {
    const parsed = parseGitHubRepoUrl(github.url);
    owner = parsed.owner;
    repo = parsed.repo;
  }

  if (!owner || !repo) {
    const err = new Error('GitHub source requires owner/repo or a valid GitHub URL.');
    err.statusCode = 400;
    throw err;
  }

  return {
    source: 'github',
    fullName: `${owner}/${repo}`,
    githubOwner: owner,
    githubRepo: repo,
    defaultBranch: github.branch || null,
    branch: github.branch || null,
  };
}

function inferRepositoryName({ source, fullName, githubRepo }) {
  if (githubRepo) return githubRepo;
  if (!fullName) return source === 'local' ? 'Local repository' : 'Unknown repository';

  if (source === 'local') {
    const normalized = String(fullName).replace(/\\/g, '/');
    return path.posix.basename(normalized) || 'Local repository';
  }

  const parts = String(fullName).split('/').filter(Boolean);
  return parts[1] || parts[0] || 'Unknown repository';
}

function inferRepositoryOwner({ source, fullName, githubOwner }) {
  if (githubOwner) return githubOwner;
  if (source === 'local') return 'local';

  const parts = String(fullName || '').split('/').filter(Boolean);
  return parts[0] || 'unknown';
}

async function createOrGetRepository({ userId, repository }) {
  const result = await pgPool.query(
    `
      INSERT INTO repositories (
        owner_id,
        source,
        full_name,
        github_owner,
        github_repo,
        default_branch,
        last_scanned_at,
        scan_count
      )
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), 1)
      ON CONFLICT (owner_id, full_name)
      DO UPDATE
      SET source = EXCLUDED.source,
          github_owner = COALESCE(EXCLUDED.github_owner, repositories.github_owner),
          github_repo = COALESCE(EXCLUDED.github_repo, repositories.github_repo),
          default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
          last_scanned_at = NOW(),
          scan_count = repositories.scan_count + 1
      RETURNING id
    `,
    [
      userId,
      repository.source,
      repository.fullName,
      repository.githubOwner,
      repository.githubRepo,
      repository.defaultBranch,
    ],
  );

  return result.rows[0]?.id;
}

async function createAnalysisJob({ repositoryId, userId, branch }) {
  const result = await pgPool.query(
    `
      INSERT INTO analysis_jobs (repository_id, user_id, branch, status)
      VALUES ($1, $2, $3, 'queued')
      RETURNING id
    `,
    [repositoryId, userId, branch || null],
  );

  return result.rows[0]?.id;
}

export async function analyzeController(req, res, next) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser?.id) {
      return res.status(401).json({
        error: 'Authentication required to start analysis jobs.',
      });
    }

    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) {
      const err = new Error('Failed to resolve authenticated user record.');
      err.statusCode = 500;
      throw err;
    }

    const repository = buildRepositoryIdentity(req.body);
    const repositoryId = await createOrGetRepository({ userId, repository });

    if (!repositoryId) {
      const err = new Error('Failed to resolve repository record for analysis job.');
      err.statusCode = 500;
      throw err;
    }

    const jobId = await createAnalysisJob({
      repositoryId,
      userId,
      branch: repository.branch,
    });

    if (!jobId) {
      const err = new Error('Failed to create analysis job.');
      err.statusCode = 500;
      throw err;
    }

    const queueInput = {
      ...req.body,
      repositoryId,
      userId,
      githubToken: req.cookies?.github_token,
      // optional forcing source for manual testing
      // forceNeo4j: true,
      // forcePostgres: true,
    };

    await enqueueAnalysisJob({
      jobId,
      input: queueInput,
    });

    await invalidateAnalysisHistoryCacheForUser(redisClient, userId);
    await invalidateRepositoriesCacheForUser(redisClient, userId);

    return res.status(202).json({ jobId });
  } catch (err) {
    return next(err);
  }
}

export async function listAnalysisHistoryController(req, res, next) {
  try {
    const authUser = getAuthUser(req);
    if (!authUser?.id) {
      return res.status(401).json({
        error: 'Authentication required to load analysis history.',
      });
    }

    const requestedUserId = typeof req.query?.userId === 'string' ? req.query.userId.trim() : null;
    if (requestedUserId && requestedUserId !== String(authUser.id)) {
      return res.status(403).json({
        error: 'You can only access your own analysis history.',
      });
    }

    const page = Math.max(1, Number.parseInt(req.query?.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) {
      const err = new Error('Failed to resolve authenticated user record.');
      err.statusCode = 500;
      throw err;
    }
        
    const historyCacheKey = buildAnalysisHistoryCacheKey({ userId, page, limit });
    const cachedHistory = await readJsonCache(redisClient, historyCacheKey);
    if (cachedHistory) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cachedHistory);
    }

    const [historyResult, countResult] = await Promise.all([
      pgPool.query(
        `
          WITH latest_repo_jobs AS (
            SELECT DISTINCT ON (r.id)
              r.id AS repository_id,
              r.source,
              r.full_name,
              r.github_owner,
              r.github_repo,
              r.default_branch,
              aj.id AS job_id,
              (
                SELECT aj_completed.id
                FROM analysis_jobs aj_completed
                WHERE aj_completed.repository_id = r.id
                  AND aj_completed.status = 'completed'
                ORDER BY COALESCE(aj_completed.completed_at, aj_completed.created_at) DESC
                LIMIT 1
              ) AS latest_completed_job_id,
              aj.status,
              aj.branch,
              aj.node_count,
              aj.edge_count,
              COALESCE(aj.completed_at, aj.created_at) AS analyzed_at
            FROM repositories r
            JOIN analysis_jobs aj ON aj.repository_id = r.id
            WHERE r.owner_id = $1
            ORDER BY r.id, COALESCE(aj.completed_at, aj.created_at) DESC
          )
          SELECT *
          FROM latest_repo_jobs
          ORDER BY analyzed_at DESC
          LIMIT $2 OFFSET $3
        `,
        [userId, limit, offset],
      ),
      pgPool.query(
        `
          SELECT COUNT(*)::int AS total
          FROM repositories r
          WHERE r.owner_id = $1
        `,
        [userId],
      ),
    ]);

    const repositories = historyResult.rows.map((row) => {
      const name = inferRepositoryName({
        source: row.source,
        fullName: row.full_name,
        githubRepo: row.github_repo,
      });
      const owner = inferRepositoryOwner({
        source: row.source,
        fullName: row.full_name,
        githubOwner: row.github_owner,
      });
      const graphJobId = row.latest_completed_job_id || (row.status === 'completed' ? row.job_id : null);

      return {
        id: row.repository_id,
        jobId: graphJobId,
        latestJobId: row.job_id,
        name,
        owner,
        fullName: row.full_name,
        source: row.source,
        branch: row.branch || row.default_branch || null,
        analyzedAt: row.analyzed_at,
        nodeCount: Number.isFinite(row.node_count) ? row.node_count : null,
        edgeCount: Number.isFinite(row.edge_count) ? row.edge_count : null,
        status: row.status || 'completed',
      };
    });

    const totalAnalyzed = countResult.rows[0]?.total || 0;
    const uniqueOwners = new Set(repositories.map((repo) => repo.owner).filter(Boolean)).size;

    const responsePayload = {
      repositories,
      summary: {
        totalAnalyzed,
        lastAnalyzedAt: repositories[0]?.analyzedAt || null,
        uniqueOwners,
      },
      pagination: {
        page,
        limit,
        total: totalAnalyzed,
        totalPages: totalAnalyzed > 0 ? Math.ceil(totalAnalyzed / limit) : 0,
      },
    };

    await writeJsonCache(
      redisClient,
      historyCacheKey,
      responsePayload,
      cacheTtl.analysisHistorySeconds,
    );

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(responsePayload);
  } catch (err) {
    return next(err);
  }
}

export async function validateLocalPathController(req, res, next) {
  try {
    const result = await validateLocalRepository(req.body.path);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

export async function browseLocalPathController(_req, res, next) {
  try {
    const selectedPath = await pickLocalDirectory();
    return res.status(200).json({ path: selectedPath });
  } catch (err) {
    return next(err);
  }
}

export async function localPickerCapabilitiesController(_req, res, next) {
  try {
    const capabilities = await getLocalPickerCapabilities();
    return res.status(200).json(capabilities);
  } catch (err) {
    return next(err);
  }
}

export async function resolvePublicRepoController(req, res, next) {
  try {
    const result = await resolvePublicRepository(req.body.url);
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
}

export async function listOwnedReposController(req, res, next) {
  try {
    const result = await fetchOwnedRepositories({ token: req.cookies?.github_token });
    return res.status(200).json({
      repositories: result.repositories,
      scopes: result.scopes,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.status(401).json({
        error: err.message,
        loginUrl: '/api/auth/github?reauth=1',
        action:
          'Re-authenticate with GitHub. If this persists, revoke this app in GitHub Settings > Applications, then connect again.',
      });
    }

    if (err.statusCode === 403 && err.code === 'INSUFFICIENT_SCOPE') {
      return res.status(403).json({
        error: err.message,
        requiredScopes: err.requiredScopes,
        grantedScopes: err.grantedScopes,
        loginUrl: '/api/auth/github?reauth=1',
        action:
          'Grant the required scopes. If GitHub does not prompt for new scopes, revoke the app authorization in GitHub Settings > Applications and reconnect.',
      });
    }

    return next(err);
  }
}

export async function listBranchesController(req, res, next) {
  try {
    const source = req.query.source === 'owned' ? 'owned' : 'public';
    const token = source === 'owned' ? req.cookies?.github_token : undefined;

    const owner = typeof req.query.owner === 'string' ? req.query.owner.trim() : '';
    const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';

    let targetOwner = owner;
    let targetRepo = repo;

    if ((!targetOwner || !targetRepo) && typeof req.query.url === 'string') {
      const parsed = parseGitHubRepoUrl(req.query.url);
      targetOwner = parsed.owner;
      targetRepo = parsed.repo;
    }

    if (!targetOwner || !targetRepo) {
      const err = new Error('Branch lookup requires owner/repo or a valid GitHub URL.');
      err.statusCode = 400;
      throw err;
    }

    const [repoDetails, branches] = await Promise.all([
      fetchRepoDetails({ owner: targetOwner, repo: targetRepo, token }),
      fetchRepoBranches({ owner: targetOwner, repo: targetRepo, token }),
    ]);

    return res.status(200).json({
      repository: {
        owner: repoDetails.owner,
        repo: repoDetails.repo,
        fullName: repoDetails.fullName,
        defaultBranch: repoDetails.defaultBranch,
      },
      branches,
    });
  } catch (err) {
    return next(err);
  }
}

function resolveRepoFromQuery(req) {
  const source = req.query.source === 'owned' ? 'owned' : 'public';
  const token = source === 'owned' ? req.cookies?.github_token : undefined;

  const owner = typeof req.query.owner === 'string' ? req.query.owner.trim() : '';
  const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
  const branch = typeof req.query.branch === 'string' ? req.query.branch.trim() : '';

  let targetOwner = owner;
  let targetRepo = repo;

  if ((!targetOwner || !targetRepo) && typeof req.query.url === 'string') {
    const parsed = parseGitHubRepoUrl(req.query.url);
    targetOwner = parsed.owner;
    targetRepo = parsed.repo;
  }

  if (!targetOwner || !targetRepo) {
    const err = new Error('Repository lookup requires owner/repo or a valid GitHub URL.');
    err.statusCode = 400;
    throw err;
  }

  return {
    source,
    token,
    owner: targetOwner,
    repo: targetRepo,
    branch,
  };
}

export async function listRepositoryStructureController(req, res, next) {
  try {
    const { token, owner, repo, branch } = resolveRepoFromQuery(req);

    const [repoDetails, repoTree] = await Promise.all([
      fetchRepoDetails({ owner, repo, token }),
      fetchRepoTree({ owner, repo, ref: branch, token }),
    ]);

    const topLevelDirectories = new Map();
    const topLevelFiles = new Map();

    for (const entry of repoTree.tree) {
      const pathValue = String(entry?.path || '').trim();
      if (!pathValue) continue;

      const segments = pathValue.split('/').filter(Boolean);
      if (!segments.length) continue;

      const topLevelName = segments[0];

      // Top-level blobs are root files and should not be grouped as directories.
      if (segments.length === 1 && entry.type === 'blob') {
        topLevelFiles.set(topLevelName, {
          name: topLevelName,
          path: topLevelName,
          size: Number.isFinite(entry?.size) ? entry.size : 0,
          type: 'file',
        });
        continue;
      }

      if (!topLevelDirectories.has(topLevelName)) {
        topLevelDirectories.set(topLevelName, {
          name: topLevelName,
          path: topLevelName,
          fileCount: 0,
          subdirectories: new Set(),
        });
      }

      const current = topLevelDirectories.get(topLevelName);

      if (entry.type === 'blob') {
        current.fileCount += 1;
      }

      if (segments.length > 1) {
        current.subdirectories.add(segments[1]);
      }
    }

    const directories = Array.from(topLevelDirectories.values())
      .map((item) => ({
        name: item.name,
        path: item.path,
        fileCount: item.fileCount,
        subdirectories: Array.from(item.subdirectories)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const files = Array.from(topLevelFiles.values())
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      repository: {
        owner: repoDetails.owner,
        repo: repoDetails.repo,
        fullName: repoDetails.fullName,
        branch: branch || repoDetails.defaultBranch || null,
        defaultBranch: repoDetails.defaultBranch,
        htmlUrl: `https://github.com/${repoDetails.owner}/${repoDetails.repo}`,
      },
      truncated: repoTree.truncated,
      directories,
      files,
    });
  } catch (err) {
    return next(err);
  }
}

export async function listRepositoryDirectoryController(req, res, next) {
  try {
    const { token, owner, repo, branch } = resolveRepoFromQuery(req);
    const requestedPath = typeof req.query.path === 'string'
      ? req.query.path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
      : '';

    const [repoDetails, entries] = await Promise.all([
      fetchRepoDetails({ owner, repo, token }),
      fetchRepoContents({ owner, repo, path: requestedPath, ref: branch, token }),
    ]);

    return res.status(200).json({
      repository: {
        owner: repoDetails.owner,
        repo: repoDetails.repo,
        fullName: repoDetails.fullName,
        branch: branch || repoDetails.defaultBranch || null,
        defaultBranch: repoDetails.defaultBranch,
        htmlUrl: `https://github.com/${repoDetails.owner}/${repoDetails.repo}`,
      },
      path: requestedPath,
      entries,
    });
  } catch (err) {
    return next(err);
  }
}

export async function getRepositoryFileController(req, res, next) {
  try {
    const { token, owner, repo, branch } = resolveRepoFromQuery(req);
    const requestedPath = typeof req.query.path === 'string'
      ? req.query.path.trim().replace(/^\/+/, '').replace(/\/+$/, '')
      : '';

    if (!requestedPath) {
      const err = new Error('File path is required to load repository file content.');
      err.statusCode = 400;
      throw err;
    }

    const [repoDetails, file] = await Promise.all([
      fetchRepoDetails({ owner, repo, token }),
      fetchRepoFileContent({ owner, repo, path: requestedPath, ref: branch, token }),
    ]);

    return res.status(200).json({
      repository: {
        owner: repoDetails.owner,
        repo: repoDetails.repo,
        fullName: repoDetails.fullName,
        branch: branch || repoDetails.defaultBranch || null,
        defaultBranch: repoDetails.defaultBranch,
        htmlUrl: `https://github.com/${repoDetails.owner}/${repoDetails.repo}`,
      },
      file,
      canEdit: req.query.source === 'owned',
    });
  } catch (err) {
    return next(err);
  }
}

export async function updateRepositoryFileController(req, res, next) {
  try {
    const source = req.body.source === 'owned' ? 'owned' : 'public';
    const token = source === 'owned' ? req.cookies?.github_token : undefined;

    let targetOwner = req.body.owner || '';
    let targetRepo = req.body.repo || '';

    if ((!targetOwner || !targetRepo) && typeof req.body.url === 'string') {
      const parsed = parseGitHubRepoUrl(req.body.url);
      targetOwner = parsed.owner;
      targetRepo = parsed.repo;
    }

    if (!targetOwner || !targetRepo) {
      const err = new Error('Repository update requires owner/repo or a valid GitHub URL.');
      err.statusCode = 400;
      throw err;
    }

    if (source !== 'owned') {
      const err = new Error('Editing files is only supported for authenticated owned repositories.');
      err.statusCode = 403;
      throw err;
    }

    const updated = await updateRepoFileContent({
      owner: targetOwner,
      repo: targetRepo,
      path: req.body.path,
      ref: req.body.branch,
      token,
      content: req.body.content,
      sha: req.body.sha,
      message: req.body.message,
    });

    return res.status(200).json({
      file: {
        path: updated.path,
        sha: updated.sha,
        htmlUrl: updated.htmlUrl,
        commitSha: updated.commitSha,
      },
    });
  } catch (err) {
    return next(err);
  }
}
