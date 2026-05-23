import { stat, access, mkdtemp, rm, readdir, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { BaseAgent } from '../core/BaseAgent.js';
import { scoreIngestion } from '../core/confidence.js';
import {
  fetchRepoBranches,
  fetchRepoDetails,
  parseGitHubRepoUrl,
} from '../../analyze/services/githubApi.service.js';

const BLOCKED_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/run',
  '/boot',
  '/root',
  '/bin',
  '/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/lib',
  '/lib64',
];

function validatePath(resolved) {
  const norm = resolved.replace(/\/+$/, '');

  for (const prefix of BLOCKED_PREFIXES) {
    if (norm === prefix || norm.startsWith(prefix + '/')) {
      return `Access to system path "${prefix}" is not allowed.`;
    }
  }

  const allowedRoot = process.env.SCAN_ROOT;
  if (allowedRoot) {
    const normAllowed = path.resolve(allowedRoot);
    if (!norm.startsWith(normAllowed + '/') && norm !== normAllowed) {
      return `Path must be inside the configured SCAN_ROOT (${normAllowed}).`;
    }
  }

  return null;
}

async function hasRepositoryMarkers(rootDir) {
  const markerChecks = [
    access(path.join(rootDir, '.git')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'package.json')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'pyproject.toml')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'go.mod')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'pom.xml')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'src')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'app')).then(() => true).catch(() => false),
    access(path.join(rootDir, 'lib')).then(() => true).catch(() => false),
  ];

  const checks = await Promise.all(markerChecks);
  return checks.some(Boolean);
}

function normalizeBranchList(branches, defaultBranch) {
  const names = branches.map((b) => b.name);
  if (defaultBranch && !names.includes(defaultBranch)) {
    return [{ name: defaultBranch, protected: false }, ...branches];
  }
  return branches;
}

export class IngestionAgent extends BaseAgent {
  agentId = 'ingestion-agent';
  maxRetries = 3;
  timeoutMs = 120_000;

  async process(input, context) {
    const start = Date.now();
    const errors = [];
    const warnings = [];

    try {
      if (input.source === 'local') {
        const result = await this._handleLocal(input.localPath);
        const confidence = scoreIngestion({
          repoMeta: result.meta,
          extractedPath: result.path,
          errors,
        });

        return this.buildResult({
          jobId: context?.jobId,
          status: 'success',
          confidence,
          data: { extractedPath: result.path, repoMeta: result.meta },
          errors,
          warnings,
          metrics: { estimatedFileCount: result.meta.estimatedFileCount || 0 },
          processingTimeMs: Date.now() - start,
        });
      }

      if (input.source === 'github') {
        const result = await this._handleGitHub(input.github, input.githubToken);
        const confidence = scoreIngestion({
          repoMeta: result.repoMeta,
          extractedPath: result.extractedPath,
          errors,
        });

        return this.buildResult({
          jobId: context?.jobId,
          status: 'success',
          confidence,
          data: result,
          errors,
          warnings,
          metrics: { estimatedFileCount: result.repoMeta?.estimatedFileCount || 0 },
          processingTimeMs: Date.now() - start,
        });
      }

      const err = new Error('Invalid ingestion source configuration.');
      err.statusCode = 400;
      throw err;
    } catch (error) {
      return this.buildResult({
        jobId: context?.jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: error.statusCode || 500, message: error.message }],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }
  }

  async _handleLocal(projectPath) {
    const rootDir = path.resolve(projectPath);

    const securityError = validatePath(rootDir);
    if (securityError) {
      const err = new Error(securityError);
      err.statusCode = 403;
      throw err;
    }

    try {
      const info = await stat(rootDir);
      if (!info.isDirectory()) {
        const err = new Error(`"${rootDir}" is not a directory.`);
        err.statusCode = 400;
        throw err;
      }
    } catch (e) {
      if (e.statusCode) throw e;
      const err = new Error(`Directory "${rootDir}" does not exist or is not accessible.`);
      err.statusCode = 400;
      throw err;
    }

    const looksLikeRepo = await hasRepositoryMarkers(rootDir);
    if (!looksLikeRepo) {
      const err = new Error(
        'Path does not look like a repository. Expected a .git folder or project markers like package.json/src.',
      );
      err.statusCode = 400;
      throw err;
    }

    return {
      path: rootDir,
      meta: {
        fullName: rootDir,
        source: 'local',
        repoHasMarkers: true,
      },
    };
  }

  async _handleGitHub(githubConfig, githubToken) {
    const sourceMode = githubConfig?.mode || 'public';

    let owner = githubConfig?.owner;
    let repo = githubConfig?.repo;
    let branch = githubConfig?.branch;
    const token = sourceMode === 'owned' ? githubToken : undefined;

    if (githubConfig?.url) {
      const parsed = parseGitHubRepoUrl(githubConfig.url);
      owner = parsed.owner;
      repo = parsed.repo;
    }

    if (!owner || !repo) {
      const err = new Error('GitHub source requires a valid repository owner and name.');
      err.statusCode = 400;
      throw err;
    }

    const repoDetails = await fetchRepoDetails({ owner, repo, token });
    const branches = await fetchRepoBranches({
      owner: repoDetails.owner,
      repo: repoDetails.repo,
      token,
    });

    const normalizedBranches = normalizeBranchList(branches, repoDetails.defaultBranch);
    const selectedBranch = branch || repoDetails.defaultBranch;

    if (!normalizedBranches.some((b) => b.name === selectedBranch)) {
      const err = new Error(`Branch "${selectedBranch}" was not found for ${repoDetails.fullName}.`);
      err.statusCode = 400;
      throw err;
    }

    const archive = await this._downloadGitHubRepositoryArchive({
      owner: repoDetails.owner,
      repo: repoDetails.repo,
      branch: selectedBranch,
      token,
    });

    return {
      extractedPath: archive.extractedRepoPath,
      tempRoot: archive.tempRoot,
      repoMeta: {
        owner: repoDetails.owner,
        repo: repoDetails.repo,
        fullName: repoDetails.fullName,
        branch: selectedBranch,
        defaultBranch: repoDetails.defaultBranch,
        source: 'github',
        repoHasMarkers: true,
      },
    };
  }

  async _downloadGitHubRepositoryArchive({ owner, repo, branch, token }) {
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${encodeURIComponent(branch)}`;
    const response = await fetch(archiveUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'polyglot',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        const err = new Error('Failed authentication with GitHub. Please sign in again.');
        err.statusCode = 401;
        throw err;
      }
      if (response.status === 404) {
        const err = new Error('Repository or branch not found on GitHub.');
        err.statusCode = 404;
        throw err;
      }

      const err = new Error(`Unable to download repository archive (status ${response.status}).`);
      err.statusCode = response.status;
      throw err;
    }

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codegraph-github-'));
    const zipPath = path.join(tempRoot, 'repo.zip');
    const extractRoot = path.join(tempRoot, 'repo');

    await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));

    const zip = new AdmZip(zipPath);
    zip.extractAllTo(extractRoot, true);

    const entries = await readdir(extractRoot, { withFileTypes: true });
    const firstEntry = entries.find((entry) => entry.isDirectory());
    if (!firstEntry) {
      const err = new Error('Could not extract GitHub repository archive.');
      err.statusCode = 500;
      throw err;
    }

    return {
      tempRoot,
      extractedRepoPath: path.join(extractRoot, firstEntry.name),
    };
  }

  async cleanup(tempRoot) {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
