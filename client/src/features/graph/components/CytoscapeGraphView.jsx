import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { AiPanel } from '../../ai';
import {
  Filter,
  Info,
  Loader2,
  Maximize2,
  RefreshCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { selectGraphData, selectSelectedNodeId, selectNode } from '../slices/graphSlice';
import { selectThemeMode } from '../../theme/slices/themeSlice';
import {
  buildCyElements,
  buildCyStylesheet,
  computeLocalImpact,
  CLUSTER_CONFIG,
} from './cytoscapeHelpers';

cytoscape.use(fcose);

const STORAGE_KEYS = {
  hiddenTypes: 'cytoscape:hiddenTypes',
  filterQuery: 'cytoscape:filterQuery',
};

function readStoredArray(key) {
  if (typeof window === 'undefined') return [];

  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function readStoredString(key) {
  if (typeof window === 'undefined') return '';

  try {
    return String(window.localStorage.getItem(key) || '');
  } catch {
    return '';
  }
}

function useStoredSet(key) {
  const [values, setValues] = useState(() => new Set(readStoredArray(key)));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, JSON.stringify([...values]));
  }, [key, values]);

  return [values, setValues];
}

function useStoredValue(key) {
  const [value, setValue] = useState(() => readStoredString(key));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, value);
  }, [key, value]);

  return [value, setValue];
}

function ToolbarButton({ active, icon: Icon, label, onClick }) {
  const IconComponent = Icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
      style={{
        background: active ? 'rgba(59,130,246,0.12)' : 'var(--card)',
        color: active ? '#3b82f6' : 'var(--text-muted)',
        border: '1px solid var(--border)',
      }}
    >
      <IconComponent size={13} />
      {label}
    </button>
  );
}

function SelectedNodeBar({ selectedNodeId, graph, directImpact, transitiveImpact, onClose }) {
  if (!selectedNodeId) return null;

  const node = graph[selectedNodeId];
  if (!node) return null;

  const label = selectedNodeId.split('/').pop() || selectedNodeId;

  return (
    <div
      className="flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm flex-wrap"
      style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.25)' }}
    >
      <span className="truncate font-mono text-xs font-semibold" style={{ color: '#ef4444' }}>
        {label}
      </span>
      <span className="hidden truncate text-xs sm:block" style={{ color: 'var(--text-muted)' }}>
        {selectedNodeId}
      </span>
      <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span style={{ color: '#f97316' }}>{directImpact.size} direct</span>
        <span style={{ color: '#eab308' }}>{transitiveImpact.size} transitive</span>
        <button type="button" onClick={onClose} className="rounded p-0.5 hover:opacity-60">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function LegendRow({ color, label }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block size-3 rounded-sm border-2" style={{ borderColor: color, background: color }} />
      {label}
    </span>
  );
}

export default function CytoscapeGraphView() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const layoutKeyRef = useRef('');
  const selectedRef = useRef(null);

  const graphData = useSelector(selectGraphData);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const themeMode = useSelector(selectThemeMode);

  const graph = useMemo(() => graphData?.graph ?? {}, [graphData]);
  const jobId = graphData?.jobId || null;

  const [hiddenTypes, setHiddenTypes] = useStoredSet(STORAGE_KEYS.hiddenTypes);
  const [filterQuery, setFilterQuery] = useStoredValue(STORAGE_KEYS.filterQuery);
  const [showFilters, setShowFilters] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [viewportZoom, setViewportZoom] = useState(1);
  const [isLoadingImpact, setIsLoadingImpact] = useState(false);
  const [impactFeedback, setImpactFeedback] = useState('');

  const availableTypes = useMemo(() => {
    const types = new Set();
    Object.values(graph).forEach((entry) => {
      if (entry?.type) types.add(String(entry.type).toLowerCase());
    });
    return [...types].sort();
  }, [graph]);

  const cyElements = useMemo(
    () => buildCyElements(graph, { hiddenTypes, filterQuery }),
    [graph, hiddenTypes, filterQuery],
  );

  const searchMatches = useMemo(() => {
    const query = String(filterQuery || '').trim().toLowerCase();
    if (!query) return [];

    return Object.keys(graph).filter((filePath) => filePath.toLowerCase().includes(query));
  }, [filterQuery, graph]);

  const { direct: directImpact, transitive: transitiveImpact } = useMemo(
    () => computeLocalImpact(selectedNodeId, graph),
    [graph, selectedNodeId],
  );

  useEffect(() => {
    if (!jobId) return;

    layoutKeyRef.current = '';
    setHiddenTypes(new Set());
    setFilterQuery('');
  }, [jobId, setFilterQuery, setHiddenTypes]);

  useEffect(() => {
    selectedRef.current = selectedNodeId;
  }, [selectedNodeId]);

  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements: [],
      style: buildCyStylesheet(),
      boxSelectionEnabled: false,
      minZoom: 0.08,
      maxZoom: 3,
    });

    cy.on('zoom', () => {
      setViewportZoom(Number(cy.zoom().toFixed(2)));
    });

    cy.on('tap', 'node', (event) => {
      if (event.target.data('type') === 'cluster') return;

      const id = event.target.id();
      dispatch(selectNode(id === selectedRef.current ? null : id));
    });

    cy.on('tap', (event) => {
      if (event.target === cy) {
        dispatch(selectNode(null));
      }
    });

    cy.on('mouseover', 'node', (event) => {
      if (event.target.data('type') !== 'cluster') {
        event.target.addClass('show-label');
      }
    });

    cy.on('mouseout', 'node', () => {
      cy.nodes().removeClass('show-label');

      if (selectedRef.current) {
        const selected = cy.$id(selectedRef.current);
        if (selected.length) selected.addClass('show-label');
      }
    });

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [dispatch]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().remove();
      cy.add(cyElements);
    });

    const layoutKey = `${cyElements.length}:${[...hiddenTypes].join(',')}:${filterQuery}`;
    if (layoutKey !== layoutKeyRef.current) {
      layoutKeyRef.current = layoutKey;

      cy.layout({
        name: 'fcose',
        animate: false,
        randomize: true,
        idealEdgeLength: 160,
        nodeRepulsion: () => 6500,
        edgeElasticity: () => 0.45,
        nestingFactor: 0.1,
        gravity: 0.25,
        gravityRange: 3.8,
        gravityCompound: 1,
        gravityRangeCompound: 1.5,
        numIter: 2500,
        tile: true,
        tilingPaddingVertical: 40,
        tilingPaddingHorizontal: 40,
        fit: true,
        padding: 60,
        uniformNodeDimensions: false,
      }).run();

      setViewportZoom(Number(cy.zoom().toFixed(2)));
    }
  }, [cyElements, filterQuery, hiddenTypes]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass('selected direct-impact transitive-impact dimmed search-match');
    cy.edges().removeClass('dimmed');

    searchMatches.forEach((id) => {
      const node = cy.$id(id);
      if (node.length) node.addClass('search-match show-label');
    });

    if (!selectedNodeId) return;

    const allImpacted = new Set([...directImpact, ...transitiveImpact]);

    cy.nodes().forEach((node) => {
      if (node.data('type') === 'cluster') return;

      const id = node.id();
      if (id === selectedNodeId) {
        node.addClass('selected show-label');
      } else if (directImpact.has(id)) {
        node.addClass('direct-impact');
      } else if (transitiveImpact.has(id)) {
        node.addClass('transitive-impact');
      } else if (!searchMatches.includes(id)) {
        node.addClass('dimmed');
      }
    });

    cy.edges().forEach((edge) => {
      const source = edge.data('source');
      const target = edge.data('target');
      if (
        source !== selectedNodeId
        && target !== selectedNodeId
        && !allImpacted.has(source)
        && !allImpacted.has(target)
      ) {
        edge.addClass('dimmed');
      }
    });

    const selected = cy.$id(selectedNodeId);
    if (selected.length) {
      cy.animate({ fit: { eles: selected.closedNeighborhood(), padding: 100 }, duration: 250 });
    }
  }, [directImpact, searchMatches, selectedNodeId, transitiveImpact]);

  const nodeCount = cyElements.filter((element) => !element.data?.source && element.data?.type !== 'cluster').length;
  const edgeCount = cyElements.filter((element) => Boolean(element.data?.source)).length;

  const canvasStyle = useMemo(() => {
    const zoom = Math.max(0.2, Math.min(3, viewportZoom));
    const major = Math.max(40, Math.round(80 * zoom));
    const minor = Math.max(10, Math.round(20 * zoom));
    const isDark = themeMode === 'dark';
    const gridRgb = isDark ? '51,65,85' : '226,232,240';

    return {
      backgroundColor: isDark ? '#0f172a' : '#f8fafc',
      backgroundImage: [
        `linear-gradient(rgba(${gridRgb},0.8) 1px, transparent 1px)`,
        `linear-gradient(90deg, rgba(${gridRgb},0.8) 1px, transparent 1px)`,
        `linear-gradient(rgba(${gridRgb},0.4) 1px, transparent 1px)`,
        `linear-gradient(90deg, rgba(${gridRgb},0.4) 1px, transparent 1px)`,
      ].join(','),
      backgroundSize: `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`,
      border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
      minHeight: 0,
    };
  }, [themeMode, viewportZoom]);

  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom(cy.zoom() * 1.25);
  }, []);

  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom(cy.zoom() * 0.8);
  }, []);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 30);
  }, []);

  const handleReset = useCallback(() => {
    dispatch(selectNode(null));
    setHiddenTypes(new Set());
    setFilterQuery('');
    setShowFilters(false);
    setShowLegend(false);
    cyRef.current?.fit(undefined, 30);
  }, [dispatch, setFilterQuery, setHiddenTypes]);

  const handleSearchFocus = useCallback(() => {
    const match = searchMatches[0];
    if (!match) return;
    dispatch(selectNode(match));
  }, [dispatch, searchMatches]);

  const handleRunImpact = useCallback(async () => {
    if (!jobId || !selectedNodeId || isLoadingImpact) return;

    setIsLoadingImpact(true);
    setImpactFeedback('');

    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL || ''}/api/graph/${jobId}/impact?node=${encodeURIComponent(selectedNodeId)}&hops=6`,
        {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        },
      );

      if (!response.ok) {
        let message = `Impact analysis failed (HTTP ${response.status})`;
        try {
          const payload = await response.json();
          if (payload?.error) message = payload.error;
        } catch {
          // keep default message
        }
        throw new Error(message);
      }

      const payload = await response.json();
      setImpactFeedback(payload?.message || 'Impact analysis completed.');
      navigate('/impact');
    } catch (error) {
      setImpactFeedback(error?.message || 'Impact analysis failed.');
    } finally {
      setIsLoadingImpact(false);
    }
  }, [isLoadingImpact, jobId, navigate, selectedNodeId]);

  if (!graphData) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4 text-center">
        <div className="max-w-xl">
          <Search className="mx-auto mb-3 size-8 text-muted-foreground" />
          <div className="text-lg font-medium">No active graph</div>
          <p className="mt-2 text-sm text-muted-foreground">Run an analysis first to view the Cytoscape graph.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <button type="button" onClick={handleZoomIn} className="rounded-md p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
            <ZoomIn size={15} />
          </button>
          <button type="button" onClick={handleZoomOut} className="rounded-md p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
            <ZoomOut size={15} />
          </button>
          <button type="button" onClick={handleFit} className="rounded-md p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
            <Maximize2 size={15} />
          </button>
          <button type="button" onClick={handleReset} className="rounded-md p-1.5 transition-colors" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleSearchFocus();
            }}
            placeholder="Filter files…"
            className="w-44 bg-transparent text-xs outline-none"
            style={{ color: 'var(--text)' }}
          />
          {searchMatches.length > 0 && (
            <span className="rounded px-1.5 text-xs" style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>
              {searchMatches.length}
            </span>
          )}
          {filterQuery && (
            <button type="button" onClick={() => setFilterQuery('')}>
              <X size={12} style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </div>

        <ToolbarButton active={showFilters} icon={Filter} label="Filters" onClick={() => setShowFilters((current) => !current)} />
        <ToolbarButton active={showLegend} icon={Info} label="Legend" onClick={() => setShowLegend((current) => !current)} />

        <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{nodeCount} files</span>
          <span>{edgeCount} deps</span>
          <span>{Math.round(viewportZoom * 100)}%</span>
        </div>
      </div>

      {impactFeedback && (
        <div className="rounded-lg border px-3 py-2 text-xs" style={{ background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(59,130,246,0.2)', color: '#60a5fa' }}>
          {impactFeedback}
        </div>
      )}

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Types:</span>
          {availableTypes.map((type) => {
            const config = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
            const hidden = hiddenTypes.has(type);

            return (
              <button
                key={type}
                type="button"
                onClick={() => {
                  setHiddenTypes((current) => {
                    const next = new Set(current);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  });
                }}
                className="rounded-full px-2.5 py-1 text-xs font-medium transition-all"
                style={{
                  background: hidden ? 'var(--bg-muted)' : `${config.border}20`,
                  color: hidden ? 'var(--text-muted)' : config.border,
                  border: `1px solid ${hidden ? 'var(--border)' : `${config.border}60`}`,
                  opacity: hidden ? 0.5 : 1,
                }}
              >
                {type}
              </button>
            );
          })}
          {hiddenTypes.size > 0 && (
            <button type="button" onClick={() => setHiddenTypes(new Set())} className="rounded-full px-2 py-1 text-xs" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
              Show all
            </button>
          )}
        </div>
      )}

      {showLegend && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg px-3 py-2 text-xs" style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}>
          {Object.entries(CLUSTER_CONFIG).map(([type, config]) => (
            <LegendRow key={type} color={config.border} label={type} />
          ))}
          <LegendRow color="#ef4444" label="Selected" />
          <LegendRow color="#f97316" label="Direct" />
          <LegendRow color="#eab308" label="Transitive" />
        </div>
      )}

      {selectedNodeId && (
        <SelectedNodeBar
          selectedNodeId={selectedNodeId}
          graph={graph}
          directImpact={directImpact}
          transitiveImpact={transitiveImpact}
          onClose={() => dispatch(selectNode(null))}
        />
      )}

      {jobId && selectedNodeId && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRunImpact}
            disabled={isLoadingImpact}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-all"
            style={{
              background: 'rgba(239,68,68,0.1)',
              color: '#ef4444',
              border: '1px solid rgba(239,68,68,0.25)',
            }}
          >
            {isLoadingImpact ? <Loader2 size={13} className="animate-spin" /> : null}
            Run Impact →
          </button>
        </div>
      )}

      <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl" style={canvasStyle}>
        <div ref={containerRef} className="h-full w-full" />

        {selectedNodeId && (
          <div className="pointer-events-none absolute right-3 top-3 z-20 w-88 max-w-[calc(100%-1.5rem)] animate-in fade-in slide-in-from-right-2 duration-200">
            <div className="pointer-events-auto max-h-[calc(100vh-12rem)] overflow-auto custom-scrollbar">
              <AiPanel
                nodeId={selectedNodeId}
                graph={graph}
                onClose={() => dispatch(selectNode(null))}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}