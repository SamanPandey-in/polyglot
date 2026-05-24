import React, { useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import GraphToolbar from '../components/GraphToolbar';
import GraphTabBar from '../components/GraphTabBar';
import GraphView from '../components/GraphView';
import CytoscapeGraphView from '../components/CytoscapeGraphView';
import {
  loadSharedGraph,
  loadSavedGraph,
  selectActiveGraphTab,
  selectGraphData,
  selectGraphError,
  selectGraphStatus,
  setActiveGraphTab,
} from '../slices/graphSlice';
import { useToast } from '@/components/ui/toast';

function toFiniteNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

export default function GraphPage() {
  const dispatch = useDispatch();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const status = useSelector(selectGraphStatus);
  const error = useSelector(selectGraphError);
  const data = useSelector(selectGraphData);
  const activeTab = useSelector(selectActiveGraphTab);
  const { addToast } = useToast();
  const lastNotifiedJobId = useRef(null);
  const currentJobId = data?.jobId || null;

  const requestedJobId = useMemo(() => {
    const stateJobId = location.state?.jobId;
    const queryJobId = searchParams.get('jobId');
    return stateJobId || queryJobId || null;
  }, [location.state, searchParams]);

  const shareToken = useMemo(() => {
    const token = String(searchParams.get('share') || '').trim();
    return token || null;
  }, [searchParams]);

  useEffect(() => {
    if (!shareToken) return;

    const isCurrentGraphShared = data?.rootDir === `shared:${shareToken}`;
    if (isCurrentGraphShared) return;

    if (currentJobId && !String(currentJobId).startsWith('shared:')) {
      // Avoid replacing an existing private graph without explicit confirmation.
      if (!window.confirm('Load shared graph? This will replace your current view.')) return;
    }

    dispatch(loadSharedGraph({ token: shareToken }));
  }, [currentJobId, data?.rootDir, dispatch, shareToken]);

  useEffect(() => {
    if (shareToken) return;
    if (!requestedJobId) return;
    if (currentJobId === requestedJobId) return;

    dispatch(
      loadSavedGraph({
        jobId: requestedJobId,
        rootDir: location.state?.rootDir || null,
        fileCount: toFiniteNumber(location.state?.fileCount),
        analyzedAt: location.state?.analyzedAt || null,
      }),
    );
  }, [currentJobId, dispatch, location.state, requestedJobId, shareToken]);

  useEffect(() => {
    if (status === 'succeeded' && data) {
      const jobId = data.jobId || data?.job?.jobId || null;
      if (jobId && lastNotifiedJobId.current !== jobId) {
        const nodeCount = Number.isFinite(data?.nodeCount)
          ? data.nodeCount
          : Number.isFinite(data?.topology?.nodeCount)
          ? data.topology.nodeCount
          : Number.isFinite(data?.job?.nodeCount)
          ? data.job.nodeCount
          : 0;

        const edgeCount = Number.isFinite(data?.edgeCount)
          ? data.edgeCount
          : Number.isFinite(data?.topology?.edgeCount)
          ? data.topology.edgeCount
          : Number.isFinite(data?.job?.edgeCount)
          ? data.job.edgeCount
          : 0;

        try {
          addToast({
            title: 'Analysis complete',
            message: `Analysis complete — ${nodeCount} nodes, ${edgeCount} edges`,
          });
        } catch {
          // ignore toast errors
        }

        lastNotifiedJobId.current = jobId;
      }
    }
  }, [status, data, addToast]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('activeGraphTab', activeTab);
  }, [activeTab]);

  if (!data && status === 'loading') {
    return (
      <div className="flex min-h-[calc(100vh-9rem)] items-center justify-center text-sm text-muted-foreground">
        Loading saved analysis graph...
      </div>
    );
  }

  if (!data && status === 'failed' && error) {
    return (
      <div className="mx-auto max-w-xl px-4 pt-8">
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-9rem)] max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">No active graph yet</h2>
        <p className="text-sm text-muted-foreground">
          Choose a repository from Dashboard history or run a new analysis.
        </p>
        <div className="flex items-center gap-2">
          <Link to="/dashboard">
            <Button variant="outline">Open dashboard</Button>
          </Link>
          <Link to="/analyze">
            <Button>New analysis</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6.75rem)] flex-col gap-0.5">
      {status === 'succeeded' && data && (
        <section className="mx-auto mt-6 h-[calc(100vh-10rem)] w-full max-w-375 px-4 pb-4">
          <div id="graph-container" className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
            <GraphToolbar graphContainerId="graph-container" />
            <div className="border-b border-border/40 px-4 py-2">
              <GraphTabBar
                activeTab={activeTab}
                onChange={(tabId) => dispatch(setActiveGraphTab(tabId))}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {activeTab === 'reactflow' && <GraphView />}
              {activeTab === 'cytoscape' && <CytoscapeGraphView />}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
