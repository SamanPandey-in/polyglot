import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useLocation } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  Github,
  ArrowRight,
  Search,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/features/auth';
import { setSelectedAnalyzeRepository } from '@/features/analyze';
import { graphService } from '../services/graphService';
import { analyzeCodebase, selectGraphStatus } from '../slices/graphSlice';
import LocalRepoSection from './LocalRepoSection';

function toErrorMessage(err, fallback) {
  const message = err?.response?.data?.error || err?.message || fallback;
  const missing = err?.response?.data?.missing;
  const requiredScopes = err?.response?.data?.requiredScopes;
  const grantedScopes = err?.response?.data?.grantedScopes;
  const action = err?.response?.data?.action;

  if (Array.isArray(missing) && missing.length > 0) {
    return `${message} Missing: ${missing.join(', ')}`;
  }

  if (Array.isArray(requiredScopes) && requiredScopes.length > 0) {
    const granted = Array.isArray(grantedScopes) && grantedScopes.length > 0
      ? grantedScopes.join(', ')
      : 'none';

    const actionLine = action ? ` ${action}` : '';
    return `${message} Required scopes: ${requiredScopes.join(', ')}. Granted scopes: ${granted}.${actionLine}`;
  }

  if (action) {
    return `${message} ${action}`;
  }

  return message;
}

function SourceToggle({ value, onChange, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl shadow-neu-inset border-none bg-background/40 p-1.5 transition-all duration-300">
      <button
        type="button"
        className={`rounded-lg px-4 py-2.5 text-sm font-bold tracking-tight transition-all duration-300 active:scale-[0.98] ${value === 'local'
            ? 'bg-background shadow-neu-flat text-foreground'
            : 'text-muted-foreground/60 hover:text-foreground hover:bg-background/20'
          }`}
        disabled={disabled}
        onClick={() => onChange('local')}
      >
        Local Repository
      </button>
      <button
        type="button"
        className={`rounded-lg px-4 py-2.5 text-sm font-bold tracking-tight transition-all duration-300 active:scale-[0.98] ${value === 'github'
            ? 'bg-background shadow-neu-flat text-foreground'
            : 'text-muted-foreground/60 hover:text-foreground hover:bg-background/20'
          }`}
        disabled={disabled}
        onClick={() => onChange('github')}
      >
        GitHub Repository
      </button>
    </div>
  );
}

function GitHubModeToggle({ value, onChange, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-xl shadow-neu-inset border-none bg-background/40 p-1.5 transition-all duration-300">
      <button
        type="button"
        className={`rounded-lg px-4 py-2.5 text-sm font-bold tracking-tight transition-all duration-300 active:scale-[0.98] ${value === 'public'
            ? 'bg-background shadow-neu-flat text-foreground'
            : 'text-muted-foreground/60 hover:text-foreground hover:bg-background/20'
          }`}
        disabled={disabled}
        onClick={() => onChange('public')}
      >
        Public Repository
      </button>
      <button
        type="button"
        className={`rounded-lg px-4 py-2.5 text-sm font-bold tracking-tight transition-all duration-300 active:scale-[0.98] ${value === 'owned'
            ? 'bg-background shadow-neu-flat text-foreground'
            : 'text-muted-foreground/60 hover:text-foreground hover:bg-background/20'
          }`}
        disabled={disabled}
        onClick={() => onChange('owned')}
      >
        My Repositories
      </button>
    </div>
  );
}

export default function UploadRepoForm() {
  const dispatch = useDispatch();
  const location = useLocation();
  const status = useSelector(selectGraphStatus);
  const { isAuthenticated, loginWithGithub } = useAuth();

  const [source, setSource] = useState('local');

  const initialLocalPath = useMemo(() => {
    const reanalyzeConfig = location.state?.reanalyzeConfig;
    if (!reanalyzeConfig || reanalyzeConfig.source !== 'local') return '';
    return reanalyzeConfig.localPath || reanalyzeConfig.fullName || '';
  }, [location.state?.reanalyzeConfig]);

  const [githubMode, setGitHubMode] = useState('public');
  const [publicRepoUrl, setPublicRepoUrl] = useState('');
  const [publicRepoInfo, setPublicRepoInfo] = useState(null);
  const [publicBranches, setPublicBranches] = useState([]);
  const [publicBranch, setPublicBranch] = useState('');
  const [publicLoading, setPublicLoading] = useState(false);
  const [publicError, setPublicError] = useState('');

  const [ownedReposLoading, setOwnedReposLoading] = useState(false);
  const [ownedReposError, setOwnedReposError] = useState('');
  const [ownedRepos, setOwnedRepos] = useState([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [hasLoadedOwnedRepos, setHasLoadedOwnedRepos] = useState(false);
  const [ownedAuthRequired, setOwnedAuthRequired] = useState(false);
  const [ownedLoginUrl, setOwnedLoginUrl] = useState('/auth/github');
  const [selectedOwnedRepo, setSelectedOwnedRepo] = useState(null);
  const [ownedBranchesLoading, setOwnedBranchesLoading] = useState(false);
  const [ownedBranchesError, setOwnedBranchesError] = useState('');
  const [ownedBranches, setOwnedBranches] = useState([]);
  const [ownedBranch, setOwnedBranch] = useState('');

  const isLoading = status === 'loading';

  // Handle re-analyze: pre-fill form with previous repo configuration
  useEffect(() => {
    const reanalyzeConfig = location.state?.reanalyzeConfig;
    if (!reanalyzeConfig) return;

    const { source: configSource, owner, repo, branch, fullName } = reanalyzeConfig;

    if (configSource === 'local') {
      setSource('local');
    } else if (configSource === 'github' || configSource === 'github-owned' || configSource === 'github-public') {
      setSource('github');
      setGitHubMode('owned');

      if (owner && repo) {
        setSelectedOwnedRepo({
          id: reanalyzeConfig.id,
          owner,
          name: repo,
          fullName: fullName || `${owner}/${repo}`,
          defaultBranch: branch || 'main',
        });

        if (branch) {
          setOwnedBranch(branch);
          setOwnedBranches([{ name: branch, isDefault: true }]);
        }
      }
    }
  }, [location.state?.reanalyzeConfig]);

  const filteredOwnedRepos = useMemo(() => {
    const query = repoQuery.trim().toLowerCase();
    if (!query) return ownedRepos;

    return ownedRepos.filter((repo) => {
      return (
        repo.fullName.toLowerCase().includes(query) ||
        repo.name.toLowerCase().includes(query)
      );
    });
  }, [ownedRepos, repoQuery]);

  const canAnalyze = useMemo(() => {
    if (source === 'local') return false;

    if (githubMode === 'public') {
      return Boolean(
        publicRepoUrl.trim() &&
        publicRepoInfo &&
        publicBranch &&
        !publicLoading,
      );
    }

    return Boolean(
      isAuthenticated &&
      !ownedAuthRequired &&
      selectedOwnedRepo &&
      ownedBranch &&
      !ownedBranchesLoading,
    );
  }, [
    source,
    githubMode,
    publicRepoUrl,
    publicRepoInfo,
    publicBranch,
    publicLoading,
    isAuthenticated,
    ownedAuthRequired,
    selectedOwnedRepo,
    ownedBranch,
    ownedBranchesLoading,
  ]);

  const resolvePublicRepository = async () => {
    const trimmed = publicRepoUrl.trim();

    if (!trimmed) {
      setPublicRepoInfo(null);
      setPublicBranches([]);
      setPublicBranch('');
      setPublicError('Please enter a public GitHub repository URL.');
      return false;
    }

    setPublicLoading(true);
    setPublicError('');

    try {
      const data = await graphService.resolvePublicRepo(trimmed);
      const branches = data.branches || [];
      const defaultBranch = data.repository?.defaultBranch || branches[0]?.name || '';

      setPublicRepoInfo(data.repository);
      setPublicBranches(branches);
      setPublicBranch(defaultBranch);
      return true;
    } catch (err) {
      setPublicRepoInfo(null);
      setPublicBranches([]);
      setPublicBranch('');
      setPublicError(
        toErrorMessage(err, 'Could not validate this public repository.'),
      );
      return false;
    } finally {
      setPublicLoading(false);
    }
  };

  const fetchOwnedRepositories = async () => {
    setOwnedReposLoading(true);
    setOwnedReposError('');

    try {
      const data = await graphService.getOwnedRepos();
      const repositories = data.repositories || [];

      setOwnedRepos(repositories);
      setHasLoadedOwnedRepos(true);
      setOwnedAuthRequired(false);
      setOwnedLoginUrl('/auth/github');

      if (repositories.length === 0) {
        setOwnedReposError('No repositories found in your GitHub account.');
      }
    } catch (err) {
      const authRequired = err?.response?.status === 401;
      const scopeRequired = err?.response?.status === 403;
      const loginUrl = err?.response?.data?.loginUrl;
      setOwnedRepos([]);
      setOwnedAuthRequired(authRequired || scopeRequired);
      if (typeof loginUrl === 'string' && loginUrl.trim()) {
        setOwnedLoginUrl(loginUrl.trim());
      }
      setOwnedReposError(
        toErrorMessage(
          err,
          'Failed to fetch your repositories. Please connect GitHub and try again.',
        ),
      );
      setHasLoadedOwnedRepos(true);
    } finally {
      setOwnedReposLoading(false);
    }
  };

  const fetchOwnedBranches = async (repo) => {
    setOwnedBranchesLoading(true);
    setOwnedBranchesError('');

    try {
      const data = await graphService.getRepoBranches({
        source: 'owned',
        owner: repo.owner,
        repo: repo.name,
      });

      const branches = data.branches || [];
      const defaultBranch = data.repository?.defaultBranch || branches[0]?.name || '';

      setOwnedBranches(branches);
      setOwnedBranch(defaultBranch);
    } catch (err) {
      setOwnedBranches([]);
      setOwnedBranch('');
      setOwnedBranchesError(
        toErrorMessage(err, 'Failed to fetch repository branches.'),
      );
    } finally {
      setOwnedBranchesLoading(false);
    }
  };

  const handleRefreshOwnedRepos = async () => {
    if (!isAuthenticated) {
      setOwnedReposError('GitHub login is required to load your repositories.');
      return;
    }

    await fetchOwnedRepositories();
  };

  const handleOwnedRepoSelect = async (repo) => {
    setSelectedOwnedRepo(repo);
    await fetchOwnedBranches(repo);
  };

  useEffect(() => {
    if (source !== 'github' || githubMode !== 'owned') return;
    if (!isAuthenticated) return;
    if (hasLoadedOwnedRepos || ownedReposLoading) return;

    fetchOwnedRepositories();
  }, [source, githubMode, isAuthenticated, hasLoadedOwnedRepos, ownedReposLoading]);

  const buildAnalyzePayload = () => {
    if (githubMode === 'public') {
      return {
        source: 'github',
        github: {
          mode: 'public',
          url: publicRepoUrl.trim(),
          owner: publicRepoInfo.owner,
          repo: publicRepoInfo.repo,
          branch: publicBranch,
        },
      };
    }

    return {
      source: 'github',
      github: {
        mode: 'owned',
        owner: selectedOwnedRepo.owner,
        repo: selectedOwnedRepo.name,
        branch: ownedBranch,
      },
    };
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (source === 'github' && githubMode === 'public') {
      const resolved = await resolvePublicRepository();
      if (!resolved) return;
    }

    if (source === 'github' && githubMode === 'owned' && !selectedOwnedRepo) {
      setOwnedReposError('Please select one of your repositories and a branch.');
      return;
    }

    if (source === 'github' && githubMode === 'public' && publicRepoInfo) {
      dispatch(
        setSelectedAnalyzeRepository({
          source: 'github',
          mode: 'public',
          owner: publicRepoInfo.owner,
          repo: publicRepoInfo.repo,
          branch: publicBranch,
          url: publicRepoUrl.trim(),
          fullName: publicRepoInfo.fullName,
        }),
      );
    }

    if (source === 'github' && githubMode === 'owned' && selectedOwnedRepo) {
      dispatch(
        setSelectedAnalyzeRepository({
          source: 'github',
          mode: 'owned',
          owner: selectedOwnedRepo.owner,
          repo: selectedOwnedRepo.name,
          branch: ownedBranch,
          fullName: selectedOwnedRepo.fullName,
        }),
      );
    }

    dispatch(analyzeCodebase(buildAnalyzePayload()));
  };

  const handleSourceChange = (nextSource) => {
    setSource(nextSource);
  };

  const handleGitHubModeChange = (nextMode) => {
    setGitHubMode(nextMode);
    setOwnedReposError('');
    setOwnedAuthRequired(false);

    if (nextMode === 'owned') {
      setPublicError('');
      setPublicRepoInfo(null);
      setPublicBranches([]);
      setPublicBranch('');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-4 py-16">
      <div className="mb-2 flex size-14 items-center justify-center rounded-2xl shadow-neu-inset border-none bg-background/50 animate-in zoom-in duration-700">
        <Sparkles className="size-6 text-gold" />
      </div>
      <h1 className="mt-4 text-4xl font-bold tracking-tight text-center">
        Upload Repo
      </h1>
      <p className="mt-3 max-w-md text-center text-muted-foreground">
        Choose a local or GitHub repository, select a branch when required, and
        run dependency graph analysis.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-10 w-full max-w-2xl flex flex-col gap-4"
      >
        <SourceToggle
          value={source}
          onChange={handleSourceChange}
          disabled={isLoading}
        />

        {source === 'local' && (
          <LocalRepoSection
            key={initialLocalPath || 'local'}
            disabled={isLoading}
            initialPath={initialLocalPath}
            onReady={(localPath) => {
              dispatch(setSelectedAnalyzeRepository({ source: 'local', localPath }));
              dispatch(analyzeCodebase({ source: 'local', localPath }));
            }}
          />
        )}

        {source === 'github' && (
          <div className="flex flex-col gap-4 rounded-2xl shadow-neu-inset border-none bg-background/40 p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <GitHubModeToggle
              value={githubMode}
              onChange={handleGitHubModeChange}
              disabled={isLoading}
            />

            {githubMode === 'public' && (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="public-github-url">Public GitHub repository URL</Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Github className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                      <Input
                        id="public-github-url"
                        type="text"
                        value={publicRepoUrl}
                        onChange={(e) => {
                          setPublicRepoUrl(e.target.value);
                          setPublicError('');
                          setPublicRepoInfo(null);
                          setPublicBranches([]);
                          setPublicBranch('');
                        }}
                        placeholder="https://github.com/owner/repository"
                        className="pl-9 rounded-xl shadow-neu-inset border-none bg-background/50"
                        disabled={isLoading}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
                      disabled={isLoading || publicLoading || !publicRepoUrl.trim()}
                      onClick={resolvePublicRepository}
                    >
                      {publicLoading ? (
                        <>
                          <Loader2 className="animate-spin" />
                          Checking
                        </>
                      ) : (
                        'Validate'
                      )}
                    </Button>
                  </div>
                </div>

                {publicRepoInfo && (
                  <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600">
                    <div className="flex items-center gap-1.5 font-medium">
                      <CheckCircle2 className="size-3.5" />
                      Repository found: {publicRepoInfo.fullName}
                    </div>
                    <div className="mt-1 text-emerald-700/80">
                      Default branch: {publicRepoInfo.defaultBranch}
                    </div>
                  </div>
                )}

                {publicError && (
                  <p className="text-xs text-destructive flex items-center gap-1.5">
                    <AlertCircle className="size-3.5" />
                    {publicError}
                  </p>
                )}

                <div className="flex flex-col gap-2">
                  <Label htmlFor="public-branch" className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground/70">Branch</Label>
                  <select
                    id="public-branch"
                    value={publicBranch}
                    onChange={(e) => setPublicBranch(e.target.value)}
                    className="flex h-11 w-full rounded-xl shadow-neu-inset border-none bg-background/50 px-4 py-2 text-sm font-medium text-foreground transition-all duration-300 focus:ring-1 focus:ring-gold/50 disabled:cursor-not-allowed disabled:opacity-50 appearance-none"
                    disabled={
                      isLoading ||
                      publicLoading ||
                      !publicRepoInfo ||
                      publicBranches.length === 0
                    }
                  >
                    <option value="">
                      {publicBranches.length === 0
                        ? 'Validate repository first'
                        : 'Select branch'}
                    </option>
                    {publicBranches.map((branch) => (
                      <option key={branch.name} value={branch.name}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {githubMode === 'owned' && (
              <>
                {(!isAuthenticated || ownedAuthRequired) && (
                  <div className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground flex items-center justify-between gap-2">
                    <span>GitHub authentication required. Please log in with GitHub.</span>
                    <Button type="button" variant="outline" onClick={() => loginWithGithub(ownedLoginUrl)}>
                      <Github />
                      Connect GitHub
                    </Button>
                  </div>
                )}

                {isAuthenticated && !ownedAuthRequired && (
                  <>
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="owned-repo-search">Your repositories</Label>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleRefreshOwnedRepos}
                        className="rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
                        disabled={isLoading || ownedReposLoading}
                      >
                        {ownedReposLoading ? (
                          <>
                            <Loader2 className="animate-spin" />
                            Loading
                          </>
                        ) : (
                          'Refresh'
                        )}
                      </Button>
                    </div>

                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
                      <Input
                        id="owned-repo-search"
                        type="text"
                        value={repoQuery}
                        onChange={(e) => setRepoQuery(e.target.value)}
                        placeholder="Search your repositories..."
                        className="pl-9 rounded-xl shadow-neu-inset border-none bg-background/50"
                        disabled={isLoading || ownedReposLoading}
                        autoComplete="off"
                      />
                    </div>

                    <div className="max-h-60 overflow-y-auto rounded-2xl shadow-neu-inset border-none bg-background/30 p-2 custom-scrollbar">
                      {ownedReposLoading && (
                        <div className="flex items-center justify-center py-10">
                          <Loader2 className="size-6 animate-spin text-gold" />
                        </div>
                      )}

                      {!ownedReposLoading && filteredOwnedRepos.length === 0 && (
                        <p className="py-10 text-center text-xs text-muted-foreground">
                          {repoQuery ? 'No matching repositories found.' : 'Search for a repository above.'}
                        </p>
                      )}

                      {!ownedReposLoading && filteredOwnedRepos.length > 0 && (
                        <div className="grid gap-1">
                          {filteredOwnedRepos.map((repo) => (
                            <button
                              key={repo.id}
                              type="button"
                              onClick={() => handleOwnedRepoSelect(repo)}
                              disabled={isLoading}
                              className={`flex flex-col items-start gap-0.5 rounded-xl px-4 py-3 text-left transition-all active-scale ${selectedOwnedRepo?.id === repo.id
                                  ? 'bg-background shadow-neu-flat text-foreground'
                                  : 'text-muted-foreground hover:bg-background/20 hover:text-foreground'
                                }`}
                            >
                              <span className="text-sm font-bold tracking-tight">{repo.name}</span>
                              <span className="text-[10px] opacity-60">{repo.fullName}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {selectedOwnedRepo && (
                  <div className="rounded-xl shadow-neu-inset border-none bg-background/60 px-4 py-3 text-xs">
                    <p className="font-bold uppercase tracking-widest text-[9px] opacity-40">Selected repository</p>
                    <p className="font-bold text-foreground mt-0.5">
                      {selectedOwnedRepo.fullName}
                    </p>
                  </div>
                )}

                {ownedReposError && (
                  <p className="text-xs text-destructive flex items-center gap-1.5">
                    <AlertCircle className="size-3.5" />
                    {ownedReposError}
                  </p>
                )}

                {selectedOwnedRepo && (
                  <div className="flex flex-col gap-2 rounded-xl shadow-neu-inset border-none bg-background/40 p-4">
                    <Label htmlFor="owned-branch-inline" className="text-[9px] uppercase font-bold tracking-[0.2em] opacity-40">Select Branch</Label>
                    <select
                      id="owned-branch-inline"
                      value={ownedBranch}
                      onChange={(e) => setOwnedBranch(e.target.value)}
                      className="flex h-11 w-full rounded-xl shadow-neu-inset border-none bg-background/50 px-4 py-2 text-sm font-bold text-foreground transition-all duration-300 focus:ring-1 focus:ring-gold/50 disabled:cursor-not-allowed disabled:opacity-50 appearance-none"
                      disabled={ownedBranchesLoading || ownedBranches.length === 0}
                    >
                      <option value="">
                        {ownedBranches.length === 0
                          ? 'Select repository first'
                          : 'Select branch'}
                      </option>
                      {ownedBranches.map((branch) => (
                        <option key={branch.name} value={branch.name}>
                          {branch.name}
                        </option>
                      ))}
                    </select>

                    {ownedBranchesLoading && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Loader2 className="size-3.5 animate-spin" />
                        Loading branches...
                      </p>
                    )}

                    {ownedBranchesError && (
                      <p className="text-xs text-destructive flex items-center gap-1.5">
                        <AlertCircle className="size-3.5" />
                        {ownedBranchesError}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {source !== 'local' && (
          <Button
            type="submit"
            size="lg"
            className="mt-6 h-14 w-full rounded-2xl bg-gold text-white shadow-xl hover:bg-gold/90 transition-all font-black uppercase tracking-widest text-xs active-scale"
            disabled={isLoading || !canAnalyze}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 size-5 animate-spin" />
                Analyzing Codebase...
              </>
            ) : (
              <>
                Analyze Codebase Structure
                <ArrowRight className="ml-2 size-4" />
              </>
            )}
          </Button>
        )}
      </form>
    </div>
  );
}
