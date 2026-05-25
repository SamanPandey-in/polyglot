# Polyglot Phase 6 — Supplement & Corrections

> **This document supersedes parts of the original guide wherever they conflict.**
> The original guide was written against an assumed Redux shape. After reading the
> actual source files, the real Redux structure, data format, and component wiring
> are materially different. Every breaking difference is listed and corrected here.

---

## Table of Contents

1. [Critical Corrections — Redux State Shape](#1-critical-corrections--redux-state-shape)
2. [Critical Correction — Graph Data Format](#2-critical-correction--graph-data-format)
3. [Corrected `cytoscapeHelpers.js`](#3-corrected-cytoscapehelperjs)
4. [Corrected `CytoscapeGraphView.jsx`](#4-corrected-cytoscapegraphviewjsx)
5. [Corrected GraphPage Integration](#5-corrected-graphpage-integration)
6. [Impact Panel Integration](#6-impact-panel-integration)
7. [GraphTabBar — No Changes Needed](#7-graphtabbar--no-changes-needed)
8. [LocalRepoSection — One Correction](#8-localreposection--one-correction)

---

## 1. Critical Corrections — Redux State Shape

The original guide used **invented field names** that do not exist in `graphSlice.js`.
Here is the exact mapping of what was wrong and what to use instead.

### Selector corrections

| Guide (WRONG) | Actual codebase (CORRECT) |
|---|---|
| `s.graph.graphData` | `s.graph.data` via `selectGraphData` |
| `s.graph.selectedNode` | `s.graph.selectedNodeId` via `selectSelectedNodeId` |
| `s.graph.directImpact` | **Does not exist** — compute locally with BFS |
| `s.graph.transitiveImpact` | **Does not exist** — compute locally with BFS |
| `s.graph.filterLangs` | **Does not exist** — use local `useState` |
| `s.graph.filterTypes` | **Does not exist** — use local `useState` |
| `s.theme.mode` | `selectThemeMode` from `../../theme/slices/themeSlice` |

### Action creator corrections

| Guide (WRONG) | Actual codebase (CORRECT) |
|---|---|
| `setSelectedNode({ id, graphData })` | `selectNode(id)` — takes just the node id string |
| `clearSelection()` | `selectNode(null)` — same action, null payload |
| `dispatch({ type: 'graph/setFilterLangs', ... })` | **Not in Redux** — local state only |

### Correct imports to use in `CytoscapeGraphView.jsx`

```js
import {
  selectNode,              // action: sets selectedNodeId
  selectGraphData,         // selector: state.graph.data
  selectSelectedNodeId,    // selector: state.graph.selectedNodeId
} from '../slices/graphSlice';
import { selectThemeMode } from '../../theme/slices/themeSlice';
```

---

## 2. Critical Correction — Graph Data Format

The original guide assumed the graph is stored as:
```js
// WRONG — this format does not exist
{ nodes: [{ id, type, name, path }], edges: [{ source, target, type }] }
```

The **actual format** returned by the API and stored in `state.graph.data` is:

```js
{
  jobId:     'uuid-string',
  rootDir:   '/path/to/repo',
  fileCount: 42,
  graph: {
    // Keys are file paths. Values describe each file.
    'src/components/Button.jsx': {
      type: 'component',          // 'component'|'page'|'hook'|'service'|'util'|'config'|'module'
      deps: [                     // array of file-path strings this file imports
        'src/utils/cn.js',
        'src/hooks/useTheme.js',
      ],
      metrics: {
        inDegree:  3,
        loc:       120,
        riskScore: 4.2,
      },
    },
    // ...more files
  },
}
```

**All helpers that build Cytoscape elements must iterate `Object.entries(data.graph)`**,
not `data.nodes` / `data.edges`.

---

## 3. Corrected `cytoscapeHelpers.js`

Replace the entire file from the original guide with this version.
The key fix is **`buildCyElements`** which now reads the correct adjacency-list format.

**`/client/src/features/graph/components/cytoscapeHelpers.js`**

```js
// ─── Cluster colour palette ───────────────────────────────────────────────────
export const CLUSTER_CONFIG = {
  component: { border: '#38bdf8', bg: 'rgba(14,165,233,0.06)'  },
  page:      { border: '#60a5fa', bg: 'rgba(96,165,250,0.06)'  },
  hook:      { border: '#c084fc', bg: 'rgba(168,85,247,0.06)'  },
  service:   { border: '#4ade80', bg: 'rgba(34,197,94,0.06)'   },
  util:      { border: '#2dd4bf', bg: 'rgba(20,184,166,0.06)'  },
  config:    { border: '#94a3b8', bg: 'rgba(148,163,184,0.06)' },
  module:    { border: '#64748b', bg: 'rgba(100,116,139,0.06)' },
};

// ─── Build compound parent (cluster) IDs ────────────────────────────────────
function getClusterId(type) {
  return `cluster:${type || 'module'}`;
}

/**
 * Convert the adjacency-list graph (state.graph.data.graph) into
 * a flat array of Cytoscape elements.
 *
 * @param {Record<string, {type:string, deps:string[], metrics:object}>} graph
 * @param {{ hiddenTypes?: Set<string>, filterQuery?: string }} options
 */
export function buildCyElements(graph, { hiddenTypes = new Set(), filterQuery = '' } = {}) {
  if (!graph || typeof graph !== 'object') return [];

  const allFiles = Object.keys(graph);
  const query    = filterQuery.trim().toLowerCase();

  // Filter visible files
  const visibleFiles = allFiles.filter(file => {
    const { type } = graph[file];
    if (hiddenTypes.has(type)) return false;
    if (query && !file.toLowerCase().includes(query)) return false;
    return true;
  });

  const visibleSet = new Set(visibleFiles);
  const elements   = [];
  const usedTypes  = new Set(visibleFiles.map(f => graph[f].type || 'module'));

  // ── Compound parent nodes (one per type) ────────────────────────────────
  usedTypes.forEach(type => {
    const cfg = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
    elements.push({
      data: {
        id:          getClusterId(type),
        label:       type,
        type:        'cluster',
        borderColor: cfg.border,
        bgColor:     cfg.bg,
      },
      classes: 'cluster-parent',
    });
  });

  // ── File nodes ───────────────────────────────────────────────────────────
  visibleFiles.forEach(file => {
    const { type = 'module', metrics = {} } = graph[file];
    const cfg   = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
    const label = file.split('/').pop() || file;   // basename only

    // Size by inDegree — more imports → bigger node
    const inDegree = Number(metrics.inDegree) || 0;
    const nodeSize = Math.min(70, Math.max(24, 24 + inDegree * 4));

    elements.push({
      data: {
        id:          file,
        label,
        fullPath:    file,
        type,
        nodeSize,
        borderColor: cfg.border,
        bgColor:     cfg.bg,
        inDegree,
        loc:         Number(metrics.loc) || 0,
        parent:      getClusterId(type),
      },
    });
  });

  // ── Dependency edges ─────────────────────────────────────────────────────
  visibleFiles.forEach(source => {
    const deps = graph[source]?.deps || [];
    deps.forEach(target => {
      if (!visibleSet.has(target)) return;       // skip cross-cluster hidden targets
      if (source === target) return;
      elements.push({
        data: {
          id:     `${source}→${target}`,
          source,
          target,
          count:  1,
        },
      });
    });
  });

  return elements;
}

// ─── Local BFS for impact highlighting ──────────────────────────────────────
/**
 * Given a selected file path, return direct and transitive dependents/dependencies.
 * Runs in the browser — no backend call needed for canvas highlighting.
 *
 * @param {string} selectedFile
 * @param {Record<string, {deps:string[]}>} graph
 * @returns {{ direct: Set<string>, transitive: Set<string> }}
 */
export function computeLocalImpact(selectedFile, graph) {
  if (!selectedFile || !graph) return { direct: new Set(), transitive: new Set() };

  // Build reverse-adjacency (who imports this file)
  const reverseAdj = {};
  Object.entries(graph).forEach(([file, { deps }]) => {
    (deps || []).forEach(dep => {
      if (!reverseAdj[dep]) reverseAdj[dep] = [];
      reverseAdj[dep].push(file);
    });
  });

  // BFS — follow both forward deps AND reverse deps for full blast radius
  const forwardDeps  = new Set(graph[selectedFile]?.deps || []);
  const reverseDeps  = new Set(reverseAdj[selectedFile] || []);
  const direct       = new Set([...forwardDeps, ...reverseDeps]);

  const visited    = new Set([selectedFile, ...direct]);
  const queue      = [...direct];
  const transitive = new Set();

  while (queue.length) {
    const current = queue.shift();
    const fwd = graph[current]?.deps || [];
    const rev = reverseAdj[current] || [];
    [...fwd, ...rev].forEach(neighbor => {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        transitive.add(neighbor);
        queue.push(neighbor);
      }
    });
  }

  return { direct, transitive };
}

// ─── Cytoscape stylesheet ────────────────────────────────────────────────────
export function buildCyStylesheet() {
  return [
    // Compound cluster parent
    {
      selector: 'node.cluster-parent',
      style: {
        shape:                        'round-rectangle',
        'background-opacity':          0.04,
        'border-width':               '1.5px',
        'border-style':               'dashed',
        'border-color':               'data(borderColor)',
        'background-color':           'data(bgColor)',
        label:                        'data(label)',
        'text-valign':                'top',
        'text-halign':                'center',
        'font-size':                  '11px',
        'font-weight':                'bold',
        'font-family':                'monospace',
        color:                        'data(borderColor)',
        padding:                      '40px',
        'min-width':                  '120px',
        'min-height':                 '80px',
        'compound-sizing-wrt-labels': 'include',
      },
    },
    // File nodes
    {
      selector: 'node[type != "cluster"]',
      style: {
        shape:               'round-rectangle',
        width:               'data(nodeSize)',
        height:              'data(nodeSize)',
        'background-opacity': 0,
        'border-width':      '1.5px',
        'border-color':      'data(borderColor)',
        label:               '',
        'text-valign':       'bottom',
        'text-halign':       'center',
        'font-size':         '8px',
        'font-family':       'monospace',
        color:               '#94a3b8',
        'text-margin-y':     '4px',
        'overlay-opacity':    0,
      },
    },
    { selector: 'node.show-label', style: { label: 'data(label)' } },
    // Edges
    {
      selector: 'edge',
      style: {
        width:                'mapData(count, 1, 5, 1.2, 3.5)',
        'line-color':         '#2563eb',
        'target-arrow-color': '#2563eb',
        'target-arrow-shape': 'triangle',
        'curve-style':        'bezier',
        opacity:               0.45,
      },
    },
    // Impact states
    { selector: 'node.selected',          style: { 'border-width': '3px', 'border-color': '#ef4444', 'overlay-color': '#ef4444', 'overlay-opacity': 0.08 } },
    { selector: 'node.direct-impact',     style: { 'border-width': '3px', 'border-color': '#f97316', 'overlay-color': '#f97316', 'overlay-opacity': 0.08 } },
    { selector: 'node.transitive-impact', style: { 'border-width': '2px', 'border-color': '#eab308', 'overlay-color': '#eab308', 'overlay-opacity': 0.06 } },
    { selector: 'node.search-match',      style: { 'border-width': '3px', 'border-color': '#38bdf8', 'overlay-color': '#38bdf8', 'overlay-opacity': 0.06 } },
    { selector: 'node.dimmed',            style: { opacity: 0.15 } },
    { selector: 'edge.dimmed',            style: { opacity: 0.05 } },
  ];
}
```

---

## 4. Corrected `CytoscapeGraphView.jsx`

This is a full replacement of the component from the original guide.
Every Redux reference now uses the correct selectors and action creators.

**`/client/src/features/graph/components/CytoscapeGraphView.jsx`**

```jsx
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import cytoscape from 'cytoscape';
import fcose    from 'cytoscape-fcose';
import {
  ZoomIn, ZoomOut, Maximize2, RefreshCw,
  Search, Filter, Info, X, Zap,
} from 'lucide-react';

// ✅ Correct selectors and action creators from the actual slices
import {
  selectNode,          // action creator: selectNode(id | null)
  selectGraphData,     // selector: state.graph.data
  selectSelectedNodeId,// selector: state.graph.selectedNodeId
} from '../slices/graphSlice';
import { selectThemeMode } from '../../theme/slices/themeSlice';

import {
  buildCyElements,
  buildCyStylesheet,
  computeLocalImpact,
  CLUSTER_CONFIG,
} from './cytoscapeHelpers';

cytoscape.use(fcose);

// ─── GraphView type colours for the cluster filter pills ─────────────────────
const TYPE_LABELS = {
  component: 'Component',
  page:      'Page',
  hook:      'Hook',
  service:   'Service',
  util:      'Utility',
  config:    'Config',
  module:    'Module',
};

export default function CytoscapeGraphView() {
  const dispatch       = useDispatch();
  const navigate       = useNavigate();
  const containerRef   = useRef(null);
  const cyRef          = useRef(null);
  const layoutKeyRef   = useRef('');
  const selectedRef    = useRef(null);
  const graphRef       = useRef({});  // keeps graph object in sync for tap handler

  // ── Redux (correct field names) ──────────────────────────────────────────
  const rawData        = useSelector(selectGraphData);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const themeMode      = useSelector(selectThemeMode);

  // rawData shape: { jobId, rootDir, fileCount, graph: { [filePath]: { type, deps, metrics } } }
  const graph = rawData?.graph ?? {};
  const jobId = rawData?.jobId ?? null;

  // ── Local UI state (none of these are in Redux) ──────────────────────────
  const [hiddenTypes,  setHiddenTypes]  = useState(new Set());
  const [filterQuery,  setFilterQuery]  = useState('');
  const [showFilters,  setShowFilters]  = useState(false);
  const [showLegend,   setShowLegend]   = useState(false);
  const [viewportZoom, setViewportZoom] = useState(1);

  // ── Local BFS impact (NOT in Redux) ──────────────────────────────────────
  const { direct: directImpact, transitive: transitiveImpact } = useMemo(
    () => computeLocalImpact(selectedNodeId, graph),
    [selectedNodeId, graph],
  );

  // ── Available node types for the filter panel ────────────────────────────
  const availableTypes = useMemo(() => {
    const types = new Set(Object.values(graph).map(n => n.type || 'module'));
    return [...types].sort();
  }, [graph]);

  // ── Cytoscape elements ───────────────────────────────────────────────────
  const cyElements = useMemo(
    () => buildCyElements(graph, { hiddenTypes, filterQuery }),
    [graph, hiddenTypes, filterQuery],
  );

  // ── Search matches ───────────────────────────────────────────────────────
  const searchMatches = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return [];
    return Object.keys(graph).filter(f => f.toLowerCase().includes(q));
  }, [graph, filterQuery]);

  // Keep refs in sync
  useEffect(() => { selectedRef.current = selectedNodeId; }, [selectedNodeId]);
  useEffect(() => { graphRef.current    = graph; },         [graph]);

  // ── Mount Cytoscape ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements:  [],
      style:     buildCyStylesheet(),
      boxSelectionEnabled: false,
      minZoom: 0.05,
      maxZoom: 3,
    });

    cy.on('zoom', () => setViewportZoom(Number(cy.zoom().toFixed(2))));

    cy.on('tap', 'node', evt => {
      const id   = evt.target.id();
      const type = evt.target.data('type');
      if (type === 'cluster') return;         // ignore compound parent taps

      // Toggle: tap same node again to deselect
      if (id === selectedRef.current) {
        dispatch(selectNode(null));
      } else {
        dispatch(selectNode(id));
      }
    });

    cy.on('tap', evt => {
      if (evt.target === cy) dispatch(selectNode(null));
    });

    cy.on('mouseover', 'node', evt => {
      if (evt.target.data('type') !== 'cluster') evt.target.addClass('show-label');
    });
    cy.on('mouseout', 'node', () => {
      cy.nodes().removeClass('show-label');
      if (selectedRef.current) cy.$id(selectedRef.current).addClass('show-label');
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [dispatch]);

  // ── Sync elements + run layout ───────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => { cy.elements().remove(); cy.add(cyElements); });

    const layoutKey = `${cyElements.length}:${hiddenTypes.size}:${filterQuery}`;
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
        gravityCompound: 1.0,
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
  }, [cyElements, hiddenTypes.size, filterQuery]);

  // ── Impact + selection highlighting ─────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass('selected direct-impact transitive-impact dimmed search-match');
    cy.edges().removeClass('dimmed');

    searchMatches.forEach(id => cy.$id(id).addClass('search-match show-label'));

    if (!selectedNodeId) return;

    const allImpacted = new Set([...directImpact, ...transitiveImpact]);

    cy.nodes().forEach(node => {
      const id = node.id();
      if (node.data('type') === 'cluster') return;
      if (id === selectedNodeId)           node.addClass('selected show-label');
      else if (directImpact.has(id))       node.addClass('direct-impact');
      else if (transitiveImpact.has(id))   node.addClass('transitive-impact');
      else if (!searchMatches.includes(id)) node.addClass('dimmed');
    });

    cy.edges().forEach(edge => {
      const s = edge.data('source'), t = edge.data('target');
      if (s !== selectedNodeId && t !== selectedNodeId && !allImpacted.has(s) && !allImpacted.has(t)) {
        edge.addClass('dimmed');
      }
    });

    const sel = cy.$id(selectedNodeId);
    if (sel.length) cy.animate({ fit: { eles: sel.closedNeighborhood(), padding: 100 }, duration: 250 });
  }, [selectedNodeId, directImpact, transitiveImpact, searchMatches]);

  // ── Toolbar actions ──────────────────────────────────────────────────────
  const handleZoomIn  = () => cyRef.current?.zoom(cyRef.current.zoom() * 1.25);
  const handleZoomOut = () => cyRef.current?.zoom(cyRef.current.zoom() * 0.8);
  const handleFit     = () => cyRef.current?.fit(undefined, 30);
  const handleReset   = useCallback(() => {
    dispatch(selectNode(null));
    setHiddenTypes(new Set());
    setFilterQuery('');
    cyRef.current?.fit(undefined, 30);
  }, [dispatch]);

  const toggleType = useCallback(type => {
    setHiddenTypes(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  }, []);

  // ── Canvas grid background ───────────────────────────────────────────────
  const canvasStyle = useMemo(() => {
    const z      = Math.max(0.2, Math.min(3, viewportZoom));
    const maj    = Math.max(40, Math.round(80 * z));
    const min    = Math.max(10, Math.round(20 * z));
    const isDark = themeMode === 'dark';
    const rgb    = isDark ? '51,65,85' : '226,232,240';
    return {
      backgroundColor: isDark ? '#0f172a' : '#f8fafc',
      backgroundImage: [
        `linear-gradient(rgba(${rgb},0.8) 1px,transparent 1px)`,
        `linear-gradient(90deg,rgba(${rgb},0.8) 1px,transparent 1px)`,
        `linear-gradient(rgba(${rgb},0.4) 1px,transparent 1px)`,
        `linear-gradient(90deg,rgba(${rgb},0.4) 1px,transparent 1px)`,
      ].join(','),
      backgroundSize: `${maj}px ${maj}px,${maj}px ${maj}px,${min}px ${min}px,${min}px ${min}px`,
      border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
      minHeight: 0,
    };
  }, [viewportZoom, themeMode]);

  const nodeCount = cyElements.filter(e => e.data && !e.data.source && e.data.type !== 'cluster').length;
  const edgeCount = cyElements.filter(e => e.data?.source).length;

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!rawData) {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-4 text-center"
        style={{ color: 'var(--text-muted)' }}
      >
        <p className="text-sm">No active graph. Run an analysis first.</p>
        <button
          onClick={() => navigate('/upload-repo')}
          className="text-xs px-4 py-2 rounded-lg"
          style={{ background: '#3b82f6', color: '#fff' }}
        >
          Go to Upload
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-2"
      style={{ height: '100%', minHeight: 0 }}
    >
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* Zoom controls */}
        <div className="flex items-center gap-1 rounded-lg p-1" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          {[
            { Icon: ZoomIn,    fn: handleZoomIn,  title: 'Zoom in'  },
            { Icon: ZoomOut,   fn: handleZoomOut, title: 'Zoom out' },
            { Icon: Maximize2, fn: handleFit,     title: 'Fit all'  },
            { Icon: RefreshCw, fn: handleReset,   title: 'Reset'    },
          ].map(({ Icon, fn, title }) => (
            <button
              key={title}
              onClick={fn}
              title={title}
              className="p-1.5 rounded-md transition-colors"
              style={{ color: 'var(--text-muted)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-muted)'; e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input
            value={filterQuery}
            onChange={e => setFilterQuery(e.target.value)}
            placeholder="Filter files…"
            className="bg-transparent outline-none text-xs w-44"
            style={{ color: 'var(--text)' }}
          />
          {searchMatches.length > 0 && (
            <span className="text-xs px-1.5 rounded" style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>
              {searchMatches.length}
            </span>
          )}
          {filterQuery && (
            <button onClick={() => setFilterQuery('')}>
              <X size={12} style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </div>

        {/* Filters toggle */}
        <button
          onClick={() => setShowFilters(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{
            background: showFilters ? 'rgba(59,130,246,0.12)' : 'var(--card)',
            color:      showFilters ? '#3b82f6' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
        >
          <Filter size={13} /> Filters
        </button>

        {/* Legend toggle */}
        <button
          onClick={() => setShowLegend(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{
            background: showLegend ? 'rgba(59,130,246,0.12)' : 'var(--card)',
            color:      showLegend ? '#3b82f6' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
        >
          <Info size={13} /> Legend
        </button>

        {/* Impact button — opens existing /impact route */}
        {jobId && (
          <button
            onClick={() => navigate('/impact')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{
              background: selectedNodeId ? 'rgba(239,68,68,0.10)' : 'var(--card)',
              color:      selectedNodeId ? '#ef4444' : 'var(--text-muted)',
              border: `1px solid ${selectedNodeId ? 'rgba(239,68,68,0.30)' : 'var(--border)'}`,
            }}
          >
            <Zap size={13} />
            {selectedNodeId ? 'Run Impact →' : 'Impact'}
          </button>
        )}

        {/* Stats */}
        <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{nodeCount} files</span>
          <span>{edgeCount} deps</span>
          <span>{Math.round(viewportZoom * 100)}%</span>
        </div>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────────────── */}
      {showFilters && (
        <div
          className="flex flex-wrap items-center gap-2 py-2 px-3 rounded-lg shrink-0"
          style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
        >
          <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>
            Node type:
          </span>
          {availableTypes.map(type => {
            const cfg    = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
            const hidden = hiddenTypes.has(type);
            return (
              <button
                key={type}
                onClick={() => toggleType(type)}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all"
                style={{
                  background: hidden ? 'var(--bg-muted)'      : `${cfg.border}20`,
                  color:      hidden ? 'var(--text-muted)'    :  cfg.border,
                  border:    `1px solid ${hidden ? 'var(--border)' : `${cfg.border}60`}`,
                  opacity:    hidden ? 0.5 : 1,
                }}
              >
                {TYPE_LABELS[type] || type}
              </button>
            );
          })}
          {hiddenTypes.size > 0 && (
            <button
              onClick={() => setHiddenTypes(new Set())}
              className="text-xs px-2 py-1 rounded-full"
              style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}
            >
              Show all
            </button>
          )}
        </div>
      )}

      {/* ── Legend ───────────────────────────────────────────────────────── */}
      {showLegend && (
        <div
          className="flex flex-wrap items-center gap-3 py-2 px-3 rounded-lg text-xs shrink-0"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          {Object.entries(CLUSTER_CONFIG).map(([type, cfg]) => (
            <span key={type} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: cfg.border, background: cfg.bg }} />
              {TYPE_LABELS[type] || type}
            </span>
          ))}
          <span className="flex items-center gap-1.5 ml-2">
            <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#ef4444' }} /> Selected
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#f97316' }} /> Direct
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#eab308' }} /> Transitive
          </span>
        </div>
      )}

      {/* ── Selected node info bar ───────────────────────────────────────── */}
      {selectedNodeId && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm flex-wrap shrink-0"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}
        >
          <span className="font-semibold font-mono text-xs truncate max-w-xs" style={{ color: '#ef4444' }}>
            {selectedNodeId.split('/').pop()}
          </span>
          <span className="text-xs hidden sm:block truncate" style={{ color: 'var(--text-muted)' }}>
            {selectedNodeId}
          </span>
          <div className="ml-auto flex items-center gap-3 text-xs shrink-0" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: '#f97316' }}>{directImpact.size} direct</span>
            <span style={{ color: '#eab308' }}>{transitiveImpact.size} transitive</span>
            <button
              onClick={() => dispatch(selectNode(null))}
              className="p-0.5 rounded hover:opacity-60"
            >
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <div className="flex-1 rounded-xl overflow-hidden" style={{ ...canvasStyle, minHeight: 0 }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
```

---

## 5. Corrected GraphPage Integration

The original guide said "find the GraphPage and add tabs". The actual `GraphPage.jsx` has a specific
structure you must match precisely. Here is the exact replacement section.

### What exists now

```jsx
// Current GraphPage.jsx return (bottom section)
return (
  <div className="flex h-[calc(100vh-6.75rem)] flex-col gap-0.5">
    {status === 'succeeded' && data && (
      <section className="mx-auto mt-6 h-[calc(100vh-10rem)] w-full max-w-375 px-4 pb-4">
        <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
          <GraphToolbar />
          <GraphView />
        </div>
      </section>
    )}
  </div>
);
```

### What to change it to

Add `useState` and `CytoscapeGraphView` imports at the top, then replace **only** the
`<GraphView />` line and add a tab bar above it:

```jsx
// Add these imports to GraphPage.jsx
import { useState } from 'react';
import CytoscapeGraphView from '../components/CytoscapeGraphView';
import GraphTabBar        from '../components/GraphTabBar';
```

Replace the return section:

```jsx
return (
  <div className="flex h-[calc(100vh-6.75rem)] flex-col gap-0.5">
    {status === 'succeeded' && data && (
      <section className="mx-auto mt-6 h-[calc(100vh-10rem)] w-full max-w-375 px-4 pb-4">
        <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
          {/* Existing toolbar — unchanged */}
          <GraphToolbar />

          {/* NEW: tab bar sits between toolbar and canvas */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 shrink-0">
            <GraphTabBar activeTab={activeTab} onChange={setActiveTab} />
          </div>

          {/* Canvas area — only one tab renders at a time */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === 'reactflow' && <GraphView />}
            {activeTab === 'cytoscape' && (
              <div className="h-full p-3">
                <CytoscapeGraphView />
              </div>
            )}
          </div>
        </div>
      </section>
    )}
  </div>
);
```

Add `activeTab` state at the top of the `GraphPage` component function body:

```jsx
export default function GraphPage() {
  // ... existing hooks ...
  const [activeTab, setActiveTab] = useState('reactflow'); // ← add this line

  // rest of the component unchanged
```

---

## 6. Impact Panel Integration

The existing `ImpactPanel` component (at `/impact` route) already works correctly.
It reads `selectedNodeId` from `state.graph.selectedNodeId` and `jobId` from
`state.graph.data.jobId` — both of which `CytoscapeGraphView` sets correctly
via `dispatch(selectNode(id))`.

**No changes are needed to `ImpactPanel.jsx`.** The Cytoscape tab integrates
with it automatically because it dispatches to the same Redux key.

The user flow is:
1. User clicks a node in the Cytoscape canvas → `selectNode(id)` dispatched.
2. The **"Run Impact →"** button in the Cytoscape toolbar turns red/active.
3. User clicks it → `navigate('/impact')` → the existing full-page Impact Simulator
   opens, already pre-loaded with the selected node.
4. User clicks Back → returns to `/graph` with the Cytoscape tab still active.

> **Optional enhancement:** if you want an inline impact side panel instead of
> navigation, you can render `<ImpactPanel />` in a drawer alongside the canvas.
> But the current UX (separate route) requires zero extra code.

---

## 7. GraphTabBar — No Changes Needed

The `GraphTabBar` component from the original guide is correct as written.
No corrections required.

---

## 8. LocalRepoSection — One Correction

The `LocalRepoSection` component from the original guide is mostly correct.
One fix: the parent `UploadRepoForm` should pass `disabled={isLoading}` where
`isLoading` comes from `status === 'loading'` (the correct Redux field name in
this project's slice):

```jsx
// In UploadRepoForm.jsx — this is already how isLoading is defined, so no change:
const status    = useSelector(selectGraphStatus);  // 'idle'|'loading'|'succeeded'|'failed'
const isLoading = status === 'loading';

// This prop already uses the right value:
{source === 'local' && (
  <LocalRepoSection
    disabled={isLoading}
    onReady={(localPath) => {
      dispatch(setSelectedAnalyzeRepository({ source: 'local', localPath }));
      dispatch(analyzeCodebase({ source: 'local', localPath }));
    }}
  />
)}
```

The `analyzeCodebase` thunk and `setSelectedAnalyzeRepository` are both correctly
imported in the existing `UploadRepoForm.jsx` — no import changes needed there.

---

## Summary of All Files to Create/Edit

| File | Action | Original guide status |
|---|---|---|
| `components/GraphTabBar.jsx` | **Create** | ✅ Correct as-is |
| `components/cytoscapeHelpers.js` | **Create** | ❌ Replace with Section 3 above |
| `components/CytoscapeGraphView.jsx` | **Create** | ❌ Replace with Section 4 above |
| `pages/GraphPage.jsx` | **Edit** | ❌ Use Section 5 above |
| `components/LocalRepoSection.jsx` | **Create** | ✅ Correct as-is |
| `components/UploadRepoForm.jsx` | **Edit** | ✅ Correct as-is |
| `pages/ImpactPanel.jsx` | **No change** | N/A — already works |
| `slices/graphSlice.js` | **No change** | N/A — do NOT add filterLangs |
