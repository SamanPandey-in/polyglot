import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  Network,
  Zap,
  ArrowRight,
  Database,
  RefreshCw,
  Clock3,
  FolderGit2,
  Search, History,
  ChevronDown,
  ChevronUp,
  Loader2,
  Star,
  RotateCcw,
  BarChart3,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { useAuth } from '@/features/auth/context/AuthContext';
import {
  fetchAnalyzedRepositories,
  fetchCacheMetrics,
  fetchRepositoryJobs,
  selectDashboardCacheMetrics,
  selectDashboardCacheMetricsStatus,
  toggleRepositoryStar,
  selectAnalyzedRepositories,
  selectDashboardError,
  selectRepositoryJobsById,
  selectDashboardStatus,
  selectDashboardSummary,
} from '../index';
import { analyzeCodebase } from '@/features/graph/slices/graphSlice';
import { setSelectedAnalyzeRepository } from '@/features/analyze';

const QUICK_ACTIONS = [
  {
    icon: <Network className="size-5 text-primary" />,
    title: 'Analyze a repository',
    description: 'Parse a local project and render its dependency graph.',
    href: '/analyze',
    cta: 'Start analysis',
  },
];

const SORT_OPTIONS = [
  { value: 'recent', label: 'Most recent first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'biggest', label: 'Biggest repo first' },
  { value: 'smallest', label: 'Smallest repo first' },
];

const SOURCE_FILTER_OPTIONS = [
  { value: 'all', label: 'All analyzed repos' },
  { value: 'github-owned', label: 'My GitHub fetched repos' },
  { value: 'github-public', label: 'Public repos analyzed' },
  { value: 'local', label: 'Local repos analyzed' },
];

const DEFAULT_SORT = 'recent';
const DEFAULT_SOURCE_FILTER = 'all';
const CACHE_POLL_BASE_MS = 15000;
const CACHE_POLL_HIDDEN_MS = 60000;
const CACHE_POLL_MAX_MS = 120000;
const CACHE_TREND_WINDOW_SIZE = 12;
const CACHE_HIT_RATE_WARN_PERCENT = 75;
const CACHE_HIT_RATE_CRITICAL_PERCENT = 55;
const CACHE_READ_ERROR_WARN_DELTA = 1;
const CACHE_READ_ERROR_CRITICAL_DELTA = 3;

const parseSortFromQuery = (value) => {
  return SORT_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_SORT;
};

const parseSourceFromQuery = (value) => {
  return SOURCE_FILTER_OPTIONS.some((option) => option.value === value)
    ? value
    : DEFAULT_SOURCE_FILTER;
};

const formatDate = (value) => {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  
  const month = parsed.toLocaleString(undefined, { month: 'short' });
  const day = parsed.getDate();
  const year = parsed.getFullYear().toString().slice(-2);
  const time = parsed.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  
  return `${month} ${day}, '${year}, ${time}`;
};

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(2)}%`;
};

const formatCompactNumber = (value) => {
  if (!Number.isFinite(value)) return '-';
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
};

const getCachePollDelay = ({
  consecutiveFailures,
  hidden,
}) => {
  const baseDelay = hidden ? CACHE_POLL_HIDDEN_MS : CACHE_POLL_BASE_MS;
  const exp = Math.min(Math.max(consecutiveFailures - 1, 0), 3);
  return Math.min(baseDelay * (2 ** exp), CACHE_POLL_MAX_MS);
};

const getCacheHealthBadgeStyle = (level) => {
  if (level === 'critical') {
    return 'bg-red-500/15 text-red-300 border border-red-500/40';
  }

  if (level === 'warning') {
    return 'bg-amber-500/15 text-amber-300 border border-amber-500/40';
  }

  return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40';
};

function MetricCard({ icon, title, value, helper, index = 0 }) {
  return (
    <Card
      className="group relative overflow-hidden shadow-neu-inset border-none bg-background/40 hover:bg-background/60 rounded-2xl transition-all duration-500 animate-in fade-in zoom-in-95 fill-mode-both active:scale-[0.98]"
      style={{ 
        animationDelay: `${200 + index * 100}ms`,
        transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)'
      }}
    >
      <CardContent className="flex items-center justify-between p-5">
        <div className="flex items-center gap-4">
          <div className="flex size-11 items-center justify-center rounded-xl bg-background/50 shadow-neu-inset border border-border/5 group-hover:scale-110 transition-transform duration-500">
            {icon}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] uppercase tracking-[0.2em] font-bold text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors duration-300">
              {title}
            </span>
            {helper && (
              <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/30">
                {helper}
              </p>
            )}
          </div>
        </div>
        <p className="text-xl font-display font-bold tracking-tight text-foreground/80 group-hover:text-foreground transition-colors duration-300 text-right">
          {value}
        </p>
      </CardContent>
    </Card>
  );
}

function RepositoryListSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={`repo-skeleton-${index}`} className="border-dashed">
          <CardContent className="py-4">
            <div className="flex flex-col gap-2">
              <div className="h-4 w-56 rounded bg-muted" />
              <div className="h-3 w-40 rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [sortBy, setSortBy] = useState(() =>
    parseSortFromQuery(searchParams.get('sort')),
  );
  const [sourceFilter, setSourceFilter] = useState(() =>
    parseSourceFromQuery(searchParams.get('source')),
  );
  const [searchTerm, setSearchTerm] = useState(() => searchParams.get('q') || '');
  const [expandedRepos, setExpandedRepos] = useState({});
  const [starringRepoId, setStarringRepoId] = useState(null);
  const [reanalyzingRepoId, setReanalyzingRepoId] = useState(null);
  const [cacheTrend, setCacheTrend] = useState([]);
  const cachePollTimerRef = useRef(null);
  const cachePollFailureRef = useRef(0);

  const status = useSelector(selectDashboardStatus);
  const error = useSelector(selectDashboardError);
  const repositories = useSelector(selectAnalyzedRepositories);
  const summary = useSelector(selectDashboardSummary);
  const repositoryJobsById = useSelector(selectRepositoryJobsById);
  const cacheMetrics = useSelector(selectDashboardCacheMetrics);
  const cacheMetricsStatus = useSelector(selectDashboardCacheMetricsStatus);

  const displayName = user?.username || user?.email?.split('@')[0] || 'there';

  useEffect(() => {
    if (!user?.id) return;

    dispatch(
      fetchAnalyzedRepositories({
        userId: user.id,
        page: 1,
        limit: 50,
      }),
    );
  }, [dispatch, user?.id]);

  useEffect(() => {
    if (!user?.id || import.meta.env.VITE_APP_ENV !== 'development') return undefined;

    let cancelled = false;
    cachePollFailureRef.current = 0;

    const scheduleNext = (delay) => {
      if (cachePollTimerRef.current) {
        clearTimeout(cachePollTimerRef.current);
      }

      cachePollTimerRef.current = setTimeout(async () => {
        if (cancelled) return;

        const result = await dispatch(fetchCacheMetrics());
        const requestFailed = fetchCacheMetrics.rejected.match(result);

        cachePollFailureRef.current = requestFailed
          ? cachePollFailureRef.current + 1
          : 0;

        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const nextDelay = getCachePollDelay({
          consecutiveFailures: cachePollFailureRef.current,
          hidden,
        });

        scheduleNext(nextDelay);
      }, delay);
    };

    scheduleNext(0);

    return () => {
      cancelled = true;
      if (cachePollTimerRef.current) {
        clearTimeout(cachePollTimerRef.current);
        cachePollTimerRef.current = null;
      }
    };
  }, [dispatch, user?.id]);

  useEffect(() => {
    if (!cacheMetrics.generatedAt) return;

    setCacheTrend((previous) => {
      const previousPoint = previous[previous.length - 1];
      if (previousPoint?.generatedAt === cacheMetrics.generatedAt) {
        return previous;
      }

      const nextPoint = {
        generatedAt: cacheMetrics.generatedAt,
        hitRatePercent: Number.isFinite(cacheMetrics.summary.hitRatePercent)
          ? cacheMetrics.summary.hitRatePercent
          : null,
        readsTotal: cacheMetrics.summary.readsTotal,
        readError: cacheMetrics.metrics.readError,
      };

      return [...previous, nextPoint].slice(-CACHE_TREND_WINDOW_SIZE);
    });
  }, [
    cacheMetrics.generatedAt,
    cacheMetrics.metrics.readError,
    cacheMetrics.summary.hitRatePercent,
    cacheMetrics.summary.readsTotal,
  ]);

  useEffect(() => {
    const nextParams = new URLSearchParams();

    if (sortBy !== DEFAULT_SORT) {
      nextParams.set('sort', sortBy);
    }

    if (sourceFilter !== DEFAULT_SOURCE_FILTER) {
      nextParams.set('source', sourceFilter);
    }

    const trimmed = searchTerm.trim();
    if (trimmed) {
      nextParams.set('q', trimmed);
    }

    setSearchParams(nextParams, { replace: true });
  }, [searchTerm, setSearchParams, sortBy, sourceFilter]);

  const stats = useMemo(
    () => {
      const items = [
        {
          key: 'total',
          icon: <Database className="size-4 text-primary" />,
          title: 'Analyzed repositories',
          value: summary.totalAnalyzed,
          helper: '',
        },
        {
          key: 'owners',
          icon: <FolderGit2 className="size-4 text-primary" />,
          title: 'Unique owners',
          value: summary.uniqueOwners,
          helper: '',
        },
        {
          key: 'last',
          icon: <Clock3 className="size-4 text-primary" />,
          title: 'Last analyzed',
          value: summary.lastAnalyzedAt ? formatDate(summary.lastAnalyzedAt) : 'No analyses yet',
          helper: '',
        },
      ];

      if (import.meta.env.VITE_APP_ENV === 'development') {
        items.push({
          key: 'cache-hit-rate',
          icon: <Zap className="size-4 text-primary" />,
          title: 'Cache hit rate',
          value: formatPercent(cacheMetrics.summary.hitRatePercent),
          helper:
            cacheMetricsStatus === 'loading'
              ? 'Refreshing cache metrics...'
              : `Reads ${cacheMetrics.summary.readsTotal} · Redis ${cacheMetrics.redis.status}`,
        });
      }

      return items;
    },
    [
      cacheMetrics.redis.status,
      cacheMetrics.summary.hitRatePercent,
      cacheMetrics.summary.readsTotal,
      cacheMetricsStatus,
      summary.lastAnalyzedAt,
      summary.totalAnalyzed,
      summary.uniqueOwners,
    ],
  );

  const cacheTrendSummary = useMemo(() => {
    const latest = cacheTrend[cacheTrend.length - 1] || null;
    const previous = cacheTrend[cacheTrend.length - 2] || null;

    const hitRateDelta =
      latest && previous && Number.isFinite(latest.hitRatePercent) && Number.isFinite(previous.hitRatePercent)
        ? latest.hitRatePercent - previous.hitRatePercent
        : null;

    const readsDelta =
      latest && previous && Number.isFinite(latest.readsTotal) && Number.isFinite(previous.readsTotal)
        ? latest.readsTotal - previous.readsTotal
        : null;

    const errorDelta =
      latest && previous && Number.isFinite(latest.readError) && Number.isFinite(previous.readError)
        ? latest.readError - previous.readError
        : null;

    return {
      latest,
      hitRateDelta,
      readsDelta,
      errorDelta,
    };
  }, [cacheTrend]);

  const cacheHealth = useMemo(() => {
    const alerts = [];
    const redisStatus = cacheMetrics.redis.status;
    const latestHitRate = cacheTrendSummary.latest?.hitRatePercent;
    const errorDelta = cacheTrendSummary.errorDelta;

    if (redisStatus && redisStatus !== 'connected') {
      alerts.push({
        id: 'redis-status',
        level: 'critical',
        message: `Redis status is ${redisStatus}. Cache reliability may be degraded.`,
      });
    }

    if (Number.isFinite(latestHitRate)) {
      if (latestHitRate < CACHE_HIT_RATE_CRITICAL_PERCENT) {
        alerts.push({
          id: 'hit-rate-critical',
          level: 'critical',
          message: `Hit rate ${latestHitRate.toFixed(1)}% is below ${CACHE_HIT_RATE_CRITICAL_PERCENT}% (critical floor).`,
        });
      } else if (latestHitRate < CACHE_HIT_RATE_WARN_PERCENT) {
        alerts.push({
          id: 'hit-rate-warning',
          level: 'warning',
          message: `Hit rate ${latestHitRate.toFixed(1)}% is below ${CACHE_HIT_RATE_WARN_PERCENT}% (warning floor).`,
        });
      }
    }

    if (Number.isFinite(errorDelta)) {
      if (errorDelta >= CACHE_READ_ERROR_CRITICAL_DELTA) {
        alerts.push({
          id: 'read-error-critical',
          level: 'critical',
          message: `Read errors increased by ${errorDelta} in the latest interval.`,
        });
      } else if (errorDelta >= CACHE_READ_ERROR_WARN_DELTA) {
        alerts.push({
          id: 'read-error-warning',
          level: 'warning',
          message: `Read errors increased by ${errorDelta} since the previous sample.`,
        });
      }
    }

    if (cacheMetricsStatus === 'failed') {
      alerts.push({
        id: 'metrics-fetch-failed',
        level: 'warning',
        message: 'Metrics polling failed. Backoff is active until fetches recover.',
      });
    }

    const level = alerts.some((alert) => alert.level === 'critical')
      ? 'critical'
      : alerts.some((alert) => alert.level === 'warning')
        ? 'warning'
        : 'healthy';

    return {
      level,
      alerts,
    };
  }, [
    cacheMetrics.redis.status,
    cacheMetricsStatus,
    cacheTrendSummary.errorDelta,
    cacheTrendSummary.latest,
  ]);

  const cacheTrendBars = useMemo(() => {
    const validPoints = cacheTrend.filter((point) => Number.isFinite(point.hitRatePercent));

    if (validPoints.length === 0) {
      return [];
    }

    const maxHitRate = Math.max(...validPoints.map((point) => point.hitRatePercent), 1);

    return cacheTrend.map((point, index) => {
      const value = Number.isFinite(point.hitRatePercent) ? point.hitRatePercent : 0;
      const normalized = Math.max(10, Math.round((value / maxHitRate) * 100));

      return {
        id: `${point.generatedAt}-${index}`,
        height: `${normalized}%`,
        label: Number.isFinite(point.hitRatePercent) ? `${point.hitRatePercent.toFixed(1)}%` : 'N/A',
      };
    });
  }, [cacheTrend]);

  const isLoadingFirstTime = status === 'loading' && repositories.length === 0;
  const isRefreshing = status === 'loading' && repositories.length > 0;
  const backendNotReady = error?.code === 'NOT_READY';

  const visibleRepositories = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();

    const getAnalysisTime = (repo) => {
      const timestamp = repo.analyzedAt ? new Date(repo.analyzedAt).getTime() : NaN;
      return Number.isNaN(timestamp) ? 0 : timestamp;
    };

    const getRepoSize = (repo) => {
      if (Number.isFinite(repo.nodeCount)) return repo.nodeCount;
      if (Number.isFinite(repo.edgeCount)) return repo.edgeCount;
      return 0;
    };

    const filtered = repositories.filter((repo) => {
      if (sourceFilter !== 'all' && repo.sourceCategory !== sourceFilter) return false;

      if (!query) return true;

      const target = `${repo.fullName || ''} ${repo.name || ''}`.toLowerCase();
      return target.includes(query);
    });

    return filtered.toSorted((a, b) => {
      if (a.isStarred !== b.isStarred) {
        return a.isStarred ? -1 : 1;
      }

      if (sortBy === 'oldest') {
        return getAnalysisTime(a) - getAnalysisTime(b);
      }

      if (sortBy === 'biggest') {
        const bySize = getRepoSize(b) - getRepoSize(a);
        return bySize !== 0 ? bySize : getAnalysisTime(b) - getAnalysisTime(a);
      }

      if (sortBy === 'smallest') {
        const bySize = getRepoSize(a) - getRepoSize(b);
        return bySize !== 0 ? bySize : getAnalysisTime(b) - getAnalysisTime(a);
      }

      // Default order: most recently analyzed repositories first.
      return getAnalysisTime(b) - getAnalysisTime(a);
    });
  }, [repositories, searchTerm, sortBy, sourceFilter]);

  const hasActiveFilters =
    sortBy !== DEFAULT_SORT ||
    sourceFilter !== DEFAULT_SOURCE_FILTER ||
    searchTerm.trim().length > 0;

  const refreshHistory = () => {
    if (!user?.id) return;
    dispatch(fetchAnalyzedRepositories({ userId: user.id, page: 1, limit: 50 }));
    if (import.meta.env.VITE_APP_ENV === 'development') {
      dispatch(fetchCacheMetrics());
    }
  };

  const clearFilters = () => {
    setSortBy(DEFAULT_SORT);
    setSourceFilter(DEFAULT_SOURCE_FILTER);
    setSearchTerm('');
  };

  const getGraphLink = (repo) => {
    if (!repo?.jobId) return null;

    return {
      to: `/graph?jobId=${encodeURIComponent(repo.jobId)}`,
      state: {
        jobId: repo.jobId,
        rootDir: repo.fullName || `${repo.owner}/${repo.name}`,
        fileCount: repo.nodeCount,
        analyzedAt: repo.analyzedAt,
      },
    };
  };

  const buildAnalyzeRepositoryFromRepo = (repo) => {
    if (!repo) return null;

    if (repo.source === 'local') {
      return {
        source: 'local',
        localPath: repo.fullName,
      };
    }

    return {
      source: 'github',
      mode:
        repo.githubMode ||
        (repo.sourceCategory === 'github-public' ? 'public' : 'owned'),
      owner: repo.owner,
      repo: repo.name,
      branch: repo.branch || 'main',
      fullName: repo.fullName || `${repo.owner}/${repo.name}`,
      jobId: repo.jobId || null,
      latestJobId: repo.latestJobId || null,
    };
  };

  const handleSelectAnalyzeRepository = (repo) => {
    const selectedRepo = buildAnalyzeRepositoryFromRepo(repo);
    if (!selectedRepo) return;
    dispatch(setSelectedAnalyzeRepository(selectedRepo));
  };

  const buildAnalyzeRepositoryFromJob = (repo, job) => {
    const selectedRepo = buildAnalyzeRepositoryFromRepo(repo);
    if (!selectedRepo) return null;

    if (selectedRepo.source !== 'github') {
      return selectedRepo;
    }

    return {
      ...selectedRepo,
      branch: job?.branch || selectedRepo.branch,
      jobId: job?.id || selectedRepo.jobId || null,
      latestJobId: job?.id || selectedRepo.latestJobId || null,
    };
  };

  const handleOpenAnalyzePage = (repo, e) => {
    e?.preventDefault();
    e?.stopPropagation();
    handleSelectAnalyzeRepository(repo);
    navigate('/analyze');
  };

  const handleOpenAnalyzePageForJob = (repo, job, e) => {
    e?.preventDefault();
    e?.stopPropagation();

    const selectedRepo = buildAnalyzeRepositoryFromJob(repo, job);
    if (!selectedRepo) return;

    dispatch(setSelectedAnalyzeRepository(selectedRepo));
    navigate('/analyze');
  };

  const toggleJobs = (repoId) => {
    setExpandedRepos((prev) => {
      const next = { ...prev, [repoId]: !prev[repoId] };
      return next;
    });

    const jobsState = repositoryJobsById[repoId];
    if (!jobsState || (jobsState.status !== 'loading' && jobsState.status !== 'succeeded')) {
      dispatch(fetchRepositoryJobs({ repositoryId: repoId, page: 1, limit: 20 }));
    }
  };

  const getJobGraphLink = (repo, job) => {
    if (!job?.id || job?.status !== 'completed') return null;

    return {
      to: `/graph?jobId=${encodeURIComponent(job.id)}`,
      state: {
        jobId: job.id,
        rootDir: repo.fullName || `${repo.owner}/${repo.name}`,
        fileCount: job.nodeCount,
        analyzedAt: job.completedAt || job.createdAt,
      },
    };
  };

  const handleToggleStar = async (repoId, e) => {
    e?.preventDefault();
    setStarringRepoId(repoId);
    try {
      await dispatch(toggleRepositoryStar({ repositoryId: repoId })).unwrap();
    } catch (error) {
      console.error('Failed to toggle star:', error);
    } finally {
      setStarringRepoId(null);
    }
  };

  const handleReanalyze = (repo, e) => {
    e?.preventDefault();
    e?.stopPropagation();
    setReanalyzingRepoId(repo.id);

    const config =
      repo.source === 'local'
        ? {
          source: 'local',
          localPath: repo.fullName,
        }
        : {
          source: 'github',
          github: {
            mode:
              repo.githubMode ||
              (repo.sourceCategory === 'github-public' ? 'public' : 'owned'),
            owner: repo.owner,
            repo: repo.name,
            branch: repo.branch || 'main',
          },
        };

    handleSelectAnalyzeRepository(repo);

    dispatch(analyzeCodebase(config));
    navigate('/graph');
    setReanalyzingRepoId(null);
  };

  return (
    <div className="flex flex-col gap-10 py-6">
      <div className="animate-in fade-in slide-in-from-top-4 duration-700">
        <h1 className="text-4xl font-display font-bold tracking-tight text-foreground">
          Welcome back, <span className="text-gold">{displayName}</span>
        </h1>
      </div>

      <section className="animate-in fade-in slide-in-from-bottom-4 duration-700 delay-150">
        <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-[0.2em] mb-4 opacity-70">
          Quick actions
        </h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_ACTIONS.map((action, idx) => (
            <Card
              key={action.title}
              className="group rounded-2xl shadow-neu-inset border-none bg-background/40 hover:bg-background/60 transition-all duration-500 animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
              style={{ animationDelay: `${300 + idx * 100}ms` }}
            >
              <CardHeader className="pb-4">
                <div className="flex items-center gap-4">
                  <div className="flex size-10 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border-none group-hover:scale-110 transition-transform duration-300">
                    {action.icon}
                  </div>
                  <CardTitle className="text-base font-display font-bold tracking-tight">{action.title}</CardTitle>
                </div>
                <CardDescription className="text-xs leading-relaxed opacity-70 mt-1">{action.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link to={action.href}>
                  <Button size="sm" className="gap-2 w-full sm:w-auto bg-gold text-white hover:bg-gold/90 shadow-md rounded-xl font-bold tracking-wide transition-all group-hover:-translate-y-0.5">
                    {action.cta}
                    <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Analyzed repositories
          </h2>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refreshHistory}
            disabled={status === 'loading'}
            className="gap-1.5"
          >
            <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh history
          </Button>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {stats.map((item, idx) => (
            <MetricCard
              key={item.key}
              icon={item.icon}
              title={item.title}
              value={item.value}
              helper={item.helper}
              index={idx}
            />
          ))}
        </div>

        {import.meta.env.VITE_APP_ENV === 'development' && (
          <Card className="mt-4 rounded-2xl shadow-neu-inset border-none bg-background/40">
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-background/50 shadow-neu-inset">
                    <BarChart3 className="size-4 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="text-sm font-semibold tracking-wide">Cache operations snapshot</CardTitle>
                    <CardDescription className="text-[11px]">
                      Rolling session view with adaptive polling and backoff.
                    </CardDescription>
                  </div>
                </div>
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/70">
                  {cacheTrendSummary.latest?.generatedAt
                    ? `Updated ${formatDate(cacheTrendSummary.latest.generatedAt)}`
                    : 'Awaiting first metrics sample'}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${getCacheHealthBadgeStyle(cacheHealth.level)}`}>
                  Cache health: {cacheHealth.level}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  Warning floor {CACHE_HIT_RATE_WARN_PERCENT}% · Critical floor {CACHE_HIT_RATE_CRITICAL_PERCENT}%
                </span>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3">
              {cacheHealth.alerts.length > 0 ? (
                <div className="md:col-span-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="flex items-center gap-1 text-[11px] font-semibold text-amber-200">
                    <AlertTriangle className="size-3.5" />
                    Active cache alerts
                  </p>
                  <ul className="mt-1 space-y-1 text-[11px] text-amber-100/90">
                    {cacheHealth.alerts.map((alert) => (
                      <li key={alert.id}>- {alert.message}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="rounded-xl bg-background/50 px-3 py-2 shadow-neu-inset">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Hit rate trend</p>
                <p className="mt-1 text-xl font-display font-bold text-foreground">
                  {formatPercent(cacheTrendSummary.latest?.hitRatePercent)}
                </p>
                <p className="text-[10px] text-muted-foreground/70">
                  {Number.isFinite(cacheTrendSummary.hitRateDelta)
                    ? `${cacheTrendSummary.hitRateDelta >= 0 ? '+' : ''}${cacheTrendSummary.hitRateDelta.toFixed(2)} pts from previous sample`
                    : 'Need two samples to compute delta'}
                </p>
              </div>

              <div className="rounded-xl bg-background/50 px-3 py-2 shadow-neu-inset">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Read throughput</p>
                <p className="mt-1 text-xl font-display font-bold text-foreground">
                  {formatCompactNumber(cacheTrendSummary.latest?.readsTotal)}
                </p>
                <p className="text-[10px] text-muted-foreground/70">
                  {Number.isFinite(cacheTrendSummary.readsDelta)
                    ? `${cacheTrendSummary.readsDelta >= 0 ? '+' : ''}${cacheTrendSummary.readsDelta} reads since previous sample`
                    : 'Need two samples to compute delta'}
                </p>
              </div>

              <div className="rounded-xl bg-background/50 px-3 py-2 shadow-neu-inset">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Read errors</p>
                <p className="mt-1 text-xl font-display font-bold text-foreground">
                  {formatCompactNumber(cacheTrendSummary.latest?.readError)}
                </p>
                <p className="text-[10px] text-muted-foreground/70">
                  {Number.isFinite(cacheTrendSummary.errorDelta)
                    ? `${cacheTrendSummary.errorDelta >= 0 ? '+' : ''}${cacheTrendSummary.errorDelta} since previous sample`
                    : 'Need two samples to compute delta'}
                </p>
              </div>

              <div className="md:col-span-3 rounded-xl bg-background/60 px-3 py-3 shadow-neu-inset">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Session sparkline</p>
                {cacheTrendBars.length > 0 ? (
                  <div className="mt-2 flex h-20 items-end gap-1">
                    {cacheTrendBars.map((bar) => (
                      <div
                        key={bar.id}
                        className="group relative h-full flex-1 rounded-sm bg-gold/10"
                        title={`Hit rate ${bar.label}`}
                      >
                        <div
                          className="absolute bottom-0 left-0 right-0 rounded-sm bg-gold/70 transition-all duration-300 group-hover:bg-gold"
                          style={{ height: bar.height }}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">Collecting cache trend samples...</p>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="mt-4">
          <Card className="mb-4 shadow-neu-inset border-none bg-background/40 rounded-2xl animate-in fade-in slide-in-from-bottom-2 duration-500 delay-300">
            <CardContent className="flex flex-col gap-3 py-4">
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="relative lg:col-span-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search by repository name"
                    className="pl-9"
                  />
                </div>

                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger aria-label="Sort analyzed repositories" className="w-full">
                    <SelectValue placeholder="Select sorting" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SORT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>

                <Select value={sourceFilter} onValueChange={setSourceFilter}>
                  <SelectTrigger aria-label="Filter analyzed repositories by source" className="w-full">
                    <SelectValue placeholder="Select source filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {SOURCE_FILTER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              <p className="text-xs text-muted-foreground">
                Showing {visibleRepositories.length} of {repositories.length} analyzed repositories.
              </p>

              {hasActiveFilters ? (
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    className="h-7 px-2 text-xs"
                  >
                    Clear filters
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {isLoadingFirstTime ? (
            <RepositoryListSkeleton />
          ) : null}

          {!isLoadingFirstTime && backendNotReady ? (
            <Card className="border-dashed bg-muted/30">
              <CardHeader>
                <CardTitle className="text-base">Database history integration pending</CardTitle>
                <CardDescription>
                  The dashboard is wired to read repositories and job history from
                  <span className="font-mono"> GET /api/repositories </span>
                  and
                  <span className="font-mono"> GET /api/repositories/:id/jobs </span>
                  once that endpoint is connected to your database.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {!isLoadingFirstTime && !backendNotReady && error?.message ? (
            <Card className="border-destructive/40 bg-destructive/10">
              <CardHeader>
                <CardTitle className="text-base text-destructive">Could not load repository history</CardTitle>
                <CardDescription className="text-destructive/90">{error.message}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {!isLoadingFirstTime && !error?.message && repositories.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No repositories analyzed yet</CardTitle>
                <CardDescription>
                  Once the user runs an analysis, this section will list each analyzed repository
                  from database-backed history.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link to="/analyze">
                  <Button size="sm" className="gap-1.5">
                    Analyze a repository
                    <ArrowRight className="size-3.5" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : null}

          {!isLoadingFirstTime && !error?.message && repositories.length > 0 && visibleRepositories.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">No repositories match your filters</CardTitle>
                <CardDescription>
                  Try clearing the search term or changing the source and sorting options.
                </CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          {!isLoadingFirstTime && !error?.message && visibleRepositories.length > 0 ? (
            <div className="grid gap-3">
              {visibleRepositories.map((repo) => {
                const graphLink = getGraphLink(repo);

                return (
                  <Card
                    key={repo.id}
                    className="rounded-2xl shadow-neu-inset border-none bg-background/40 transition-all duration-300 animate-in fade-in slide-in-from-right-4 fill-mode-both"
                    style={{ animationDelay: `${400 + repositories.indexOf(repo) * 50}ms` }}
                  >
                    <CardContent className="flex flex-col gap-4 py-6">
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="space-y-1">
                          {graphLink ? (
                            <Link
                              to={graphLink.to}
                              state={graphLink.state}
                              onClick={() => handleSelectAnalyzeRepository(repo)}
                              className="text-left text-base font-display font-bold text-foreground hover:text-gold transition-colors cursor-pointer tracking-tight"
                            >
                              {repo.fullName || `${repo.owner}/${repo.name}`}
                            </Link>
                          ) : (
                            <span className="text-left text-base font-display font-bold text-foreground/70 tracking-tight">
                              {repo.fullName || `${repo.owner}/${repo.name}`}
                            </span>
                          )}
                          <p className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground/60">
                            {repo.source} <span className="mx-1 opacity-30">|</span> {repo.branch || 'unknown'}
                          </p>
                        </div>
                        <span className="rounded-xl border-none bg-background/50 px-3 py-1 text-[9px] font-black uppercase tracking-[0.15em] text-muted-foreground shadow-neu-inset">
                          {repo.status}
                        </span>
                      </div>

                      <div className="grid gap-4 text-[11px] text-muted-foreground/80 sm:grid-cols-2 lg:grid-cols-4 pt-2 border-t border-border/10">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Analyzed</span>
                          <span className="font-semibold text-foreground/70">{formatDate(repo.analyzedAt)}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Nodes</span>
                          <span className="font-semibold text-foreground/70">{repo.nodeCount ?? '-'}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Edges</span>
                          <span className="font-semibold text-foreground/70">{repo.edgeCount ?? '-'}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Scans</span>
                          <span className="font-semibold text-foreground/70">{repo.scanCount ?? 0}</span>
                        </div>
                      </div>

                      <div className="grid gap-2 border-t border-border/10 pt-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Last scanned</span>
                          <span className="font-semibold text-foreground/70">{formatDate(repo.lastScannedAt || repo.analyzedAt)}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Confidence</span>
                          <span className="font-semibold text-foreground/70">{repo.latestConfidence ?? '-'}</span>
                        </div>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[9px] uppercase font-bold tracking-tighter opacity-40">Latest job</span>
                          <span className="font-semibold text-foreground/70 truncate" title={repo.latestJobId || ''}>
                            {repo.latestJobId ? repo.latestJobId.slice(0, 12) : '-'}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={(e) => handleToggleStar(repo.id, e)}
                          disabled={starringRepoId === repo.id}
                          className="gap-1.5"
                          title={repo.isStarred ? 'Remove from favorites' : 'Add to favorites'}
                        >
                          <Star
                            className={`size-3.5 ${repo.isStarred
                                ? 'fill-gold text-gold'
                                : 'text-muted-foreground'
                              } transition-all`}
                          />
                        </Button>

                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={(e) => handleReanalyze(repo, e)}
                          disabled={reanalyzingRepoId === repo.id}
                          className="gap-1.5"
                        >
                          <RotateCcw className={`size-3.5 ${reanalyzingRepoId === repo.id ? 'animate-spin' : ''}`} />
                          Re-analyze
                        </Button>

                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleJobs(repo.id)}
                          className="gap-1.5"
                        >
                          <History className="size-3.5" />
                          Job history
                          {expandedRepos[repo.id] ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                        </Button>

                        {graphLink ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={(e) => handleOpenAnalyzePage(repo, e)}
                          >
                            Analyze Codebase
                          </Button>
                        ) : null}

                        {graphLink ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to={graphLink.to}
                              state={graphLink.state}
                              onClick={() => handleSelectAnalyzeRepository(repo)}
                            >
                              Open graph
                            </Link>
                          </Button>
                        ) : null}
                      </div>

                      {expandedRepos[repo.id] ? (
                        <div className="rounded-xl border border-border/20 bg-background/50 p-3">
                          {repositoryJobsById[repo.id]?.status === 'loading' ? (
                            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="size-3.5 animate-spin" />
                              Loading job history...
                            </p>
                          ) : null}

                          {repositoryJobsById[repo.id]?.status === 'failed' ? (
                            <p className="text-xs text-destructive">
                              {repositoryJobsById[repo.id]?.error?.message || 'Failed to load repository jobs.'}
                            </p>
                          ) : null}

                          {repositoryJobsById[repo.id]?.status === 'succeeded' && (repositoryJobsById[repo.id]?.jobs || []).length === 0 ? (
                            <p className="text-xs text-muted-foreground">No jobs found for this repository yet.</p>
                          ) : null}

                          {repositoryJobsById[repo.id]?.status === 'succeeded' && (repositoryJobsById[repo.id]?.jobs || []).length > 0 ? (
                            <div className="grid gap-2">
                              {(repositoryJobsById[repo.id]?.jobs || []).map((job) => {
                                const jobGraphLink = getJobGraphLink(repo, job);

                                return (
                                  <div
                                    key={job.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl shadow-neu-inset border-none bg-background/60 px-4 py-3 transition-all duration-300 hover:bg-background/80"
                                  >
                                    <div className="flex min-w-0 flex-col gap-0.5 text-[11px] text-muted-foreground">
                                      <span className="font-semibold text-foreground/80">
                                        {job.id.slice(0, 12)} • {job.status}
                                      </span>
                                      <span>
                                        {job.branch || repo.branch || 'unknown'} • {formatDate(job.completedAt || job.createdAt)} • nodes {job.nodeCount ?? '-'}
                                      </span>
                                    </div>

                                    {jobGraphLink ? (
                                      <div className="flex items-center gap-2">
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          onClick={(e) => handleOpenAnalyzePageForJob(repo, job, e)}
                                        >
                                          Analyze Codebase
                                        </Button>
                                        <Button size="sm" variant="outline" asChild>
                                          <Link
                                            to={jobGraphLink.to}
                                            state={jobGraphLink.state}
                                            onClick={() => handleSelectAnalyzeRepository(repo)}
                                          >
                                            Open graph
                                          </Link>
                                        </Button>
                                      </div>
                                    ) : (
                                      <Button type="button" size="sm" variant="outline" disabled>
                                        Not restorable
                                      </Button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
