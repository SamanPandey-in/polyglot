import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { AlertCircle, ChevronRight, GitBranch, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { selectGraphData, selectSelectedNodeId } from '../slices/graphSlice';

const SEVERITY_CONFIG = {
  direct: {
    label: 'Direct',
    color: 'text-red-500',
    bg: 'bg-red-500/10',
    border: 'border-red-500/30',
  },
  nearTransitive: {
    label: 'Near-transitive',
    color: 'text-orange-400',
    bg: 'bg-orange-400/10',
    border: 'border-orange-400/30',
  },
  farTransitive: {
    label: 'Far-transitive',
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/10',
    border: 'border-yellow-400/30',
  },
};

function NodeRow({ node, color }) {
  return (
    <div className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-mono ${color}`}>
      <ChevronRight className="size-3 shrink-0 opacity-60" />
      <span className="truncate">{node.path}</span>
      <span className="ml-auto shrink-0 opacity-50">depth {node.depth}</span>
    </div>
  );
}

function ImpactGroup({ title, nodes, config }) {
  const [expanded, setExpanded] = useState(true);
  if (!nodes?.length) return null;

  return (
    <div className="mb-4">
      <button
        onClick={() => setExpanded((current) => !current)}
        className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-xs font-semibold ${config.bg} ${config.border} ${config.color}`}
      >
        <span className="flex items-center gap-2">
          <span className="inline-block size-2 rounded-full bg-current" />
          {title}
        </span>
        <span>
          {nodes.length} node{nodes.length !== 1 ? 's' : ''} {expanded ? '▲' : '▼'}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {nodes.map((node) => (
            <NodeRow key={`${node.path}-${node.depth}`} node={node} color={config.color} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ImpactPanel() {
  const graphData      = useSelector(selectGraphData);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const jobId          = graphData?.jobId;

  const [impact,  setImpact]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  // BUG 2 FIX: use VITE_API_BASE_URL consistently — never hardcode localhost
  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  async function runImpact() {
    if (!jobId || !selectedNodeId) return;

    setLoading(true);
    setError('');
    setImpact(null);

    try {
      // BUG 2 FIX: credentials:'include' sends the httpOnly JWT cookie.
      // Without this the request returns 401 silently on every call.
      const response = await fetch(
        `${apiBase}/api/graph/${jobId}/impact?node=${encodeURIComponent(selectedNodeId)}&hops=6`,
        {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        },
      );

      if (!response.ok) {
        // BUG 10 FIX: parse JSON error body instead of showing raw HTML via response.text()
        let msg = `Impact analysis failed (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (body?.error) msg = body.error;
        } catch {
          // Non-JSON response — keep the generic message above
        }
        throw new Error(msg);
      }

      const data = await response.json();
      setImpact(data);
    } catch (err) {
      setError(err.message || 'Impact analysis failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Zap className="size-4 text-primary" />
        <h2 className="text-sm font-semibold">Impact Simulator</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">6-hop BFS</span>
      </div>

      {!selectedNodeId ? (
        <p className="text-xs text-muted-foreground">
          Click any node in the graph to select it, then run impact analysis.
        </p>
      ) : (
        <>
          <div className="truncate rounded-lg border border-border bg-card/60 px-3 py-2 text-xs font-mono text-muted-foreground">
            {selectedNodeId}
          </div>
          <Button size="sm" onClick={runImpact} disabled={loading} className="gap-2">
            {loading ? 'Analysing…' : 'Run Impact Analysis'}
            <Zap className="size-3" />
          </Button>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {impact && (
        <div className="mt-2">
          <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
            <GitBranch className="size-3" />
            <span>{impact.totalImpacted} total nodes impacted</span>
            {impact.source && (
              <span className="ml-auto opacity-50">via {impact.source}</span>
            )}
          </div>

          <ImpactGroup
            title={SEVERITY_CONFIG.direct.label}
            nodes={impact.direct}
            config={SEVERITY_CONFIG.direct}
          />
          <ImpactGroup
            title={SEVERITY_CONFIG.nearTransitive.label}
            nodes={impact.nearTransitive}
            config={SEVERITY_CONFIG.nearTransitive}
          />
          <ImpactGroup
            title={SEVERITY_CONFIG.farTransitive.label}
            nodes={impact.farTransitive}
            config={SEVERITY_CONFIG.farTransitive}
          />
        </div>
      )}
    </div>
  );
}
