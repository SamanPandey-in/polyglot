# Polyglot Phase 6 — Implementation Guide

> **Scope:** Two independent features.
> 1. **Dual Graph Tabs** — Add a Cytoscape.js graph tab that lives alongside the existing React Flow graph, toggled by two tabs at the top of the Graph page.
> 2. **Local Repo Upload Rewrite** — Replace the broken `UploadRepoForm` local-path flow with a clean, tested implementation that correctly calls the existing backend endpoints.

---

## Table of Contents

1. [Feature 1 — Dual Graph Tabs](#feature-1--dual-graph-tabs)
   - [Architecture Overview](#architecture-overview)
   - [Step 1 — Install Dependencies](#step-1--install-dependencies)
   - [Step 2 — Create the Tab Switcher Component](#step-2--create-the-tab-switcher-component)
   - [Step 3 — Create the CytoscapeGraphView Component](#step-3--create-the-cytoscapegraphview-component)
   - [Step 4 — Cytoscape Style Helpers](#step-4--cytoscape-style-helpers)
   - [Step 5 — Wire the Tabs into the Graph Page](#step-5--wire-the-tabs-into-the-graph-page)
   - [Step 6 — Persist Tab Choice in Redux](#step-6--persist-tab-choice-in-redux)
2. [Feature 2 — Local Repo Upload Rewrite](#feature-2--local-repo-upload-rewrite)
   - [Root Cause of the Existing Bug](#root-cause-of-the-existing-bug)
   - [Step 1 — Replace the Local Section in UploadRepoForm](#step-1--replace-the-local-section-in-uploadrepoform)
   - [Step 2 — LocalRepoSection Component (complete)](#step-2--localreposection-component-complete)
   - [Step 3 — Verify Backend Endpoints Are Wired](#step-3--verify-backend-endpoints-are-wired)
3. [Testing Checklist](#testing-checklist)

---

## Feature 1 — Dual Graph Tabs

### Architecture Overview

```
GraphPage (route /graph)
├── GraphTabBar            ← NEW: "React Flow" | "Cytoscape" tab bar
├── [tab === 'reactflow']
│   └── <existing React Flow graph view>
└── [tab === 'cytoscape']
    └── CytoscapeGraphView ← NEW: Cytoscape.js canvas + toolbar
        ├── CytoscapeToolbar
        ├── CytoscapeCanvas  (ref → cytoscape instance)
        ├── CytoscapeFilters (clusters / lang)
        └── CytoscapeInfoBar (selected node)
```

The Cytoscape tab **shares Redux state** (`selectedNode`, `graphData`, `filterLangs`, `filterTypes`, `directImpact`, `transitiveImpact`) with the React Flow tab — switching tabs never loses the user's selection or filters.

---

### Step 1 — Install Dependencies

```bash
# In /client
npm install cytoscape cytoscape-fcose
```

> `cytoscape-fcose` gives the force-directed "fcose" layout used in the reference code. If you already have it from Phase 5 work, skip this step.

---

### Step 2 — Create the Tab Switcher Component

Create **`/client/src/features/graph/components/GraphTabBar.jsx`**:

```jsx
import React from 'react';
import { Network, GitBranch } from 'lucide-react';

const TABS = [
  { id: 'reactflow', label: 'Flow Graph',     Icon: GitBranch },
  { id: 'cytoscape', label: 'Cytoscape View', Icon: Network   },
];

/**
 * GraphTabBar
 * @param {string}   activeTab  - 'reactflow' | 'cytoscape'
 * @param {function} onChange   - (tabId: string) => void
 */
export default function GraphTabBar({ activeTab, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-xl p-1 self-start"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
      }}
      role="tablist"
      aria-label="Graph view switcher"
    >
      {TABS.map(({ id, label, Icon }) => {
        const isActive = activeTab === id;
        return (
          <button
            key={id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200"
            style={{
              background : isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
              color      : isActive ? '#3b82f6' : 'var(--text-muted)',
              border     : isActive ? '1px solid rgba(59,130,246,0.25)' : '1px solid transparent',
            }}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
```

---

### Step 3 — Create the CytoscapeGraphView Component

Create **`/client/src/features/graph/components/CytoscapeGraphView.jsx`**:

```jsx
import React, {
  useEffect, useMemo, useRef, useState, useCallback,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  ZoomIn, ZoomOut, Maximize2, RefreshCw,
  Search, Filter, Info, X,
} from 'lucide-react';
import {
  setSelectedNode,
  clearSelection,
} from '../slices/graphSlice';
import {
  buildCyElements,
  buildCyStylesheet,
  CLUSTER_CONFIG,
  NODE_TYPE_CONFIG,
} from './cytoscapeHelpers';   // ← created in Step 4

cytoscape.use(fcose);

// ─── Sub-components ──────────────────────────────────────────────────────────

function CyToolbar({ onZoomIn, onZoomOut, onFit, onReset, searchText, onSearch, onSearchFocus, searchMatches }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Zoom / Fit controls */}
      <div
        className="flex items-center gap-1 rounded-lg p-1"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        {[
          { Icon: ZoomIn,    action: onZoomIn,  title: 'Zoom in'  },
          { Icon: ZoomOut,   action: onZoomOut, title: 'Zoom out' },
          { Icon: Maximize2, action: onFit,     title: 'Fit'      },
          { Icon: RefreshCw, action: onReset,   title: 'Reset'    },
        ].map(({ Icon, action, title }) => (
          <button
            key={title}
            onClick={action}
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
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <Search size={13} style={{ color: 'var(--text-muted)' }} />
        <input
          value={searchText}
          onChange={e => onSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSearchFocus(); }}
          placeholder="Search nodes…"
          className="bg-transparent outline-none text-xs w-40"
          style={{ color: 'var(--text)' }}
        />
        {searchMatches.length > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded-md" style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>
            {searchMatches.length}
          </span>
        )}
        <button
          onClick={onSearchFocus}
          className="text-xs px-2 py-1 rounded-md"
          style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}
        >
          Focus
        </button>
      </div>
    </div>
  );
}

function CyFilters({ hiddenClusters, onToggleCluster, onResetClusters, filterLangs, availableLangs, onToggleLang, onResetLangs }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 py-2 px-3 rounded-lg"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <span className="text-xs font-semibold" style={{ color: 'var(--text-muted)' }}>Clusters:</span>
      {Object.entries(CLUSTER_CONFIG).map(([name, cfg]) => {
        const active = !hiddenClusters.has(name);
        return (
          <button
            key={name}
            onClick={() => onToggleCluster(name)}
            className="text-xs px-2.5 py-1 rounded-full font-medium transition-all"
            style={{
              background: active ? `${cfg.border}20` : 'var(--bg-muted)',
              color:      active ?  cfg.border       : 'var(--text-muted)',
              border:    `1px solid ${active ? `${cfg.border}60` : 'var(--border)'}`,
            }}
          >
            {name}
          </button>
        );
      })}
      {hiddenClusters.size > 0 && (
        <button onClick={onResetClusters} className="text-xs px-2 py-1 rounded-full" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
          Reset
        </button>
      )}

      {availableLangs.length > 0 && (
        <>
          <span className="text-xs font-semibold ml-2" style={{ color: 'var(--text-muted)' }}>Lang:</span>
          {availableLangs.map(lang => {
            const active = filterLangs.length === 0 || filterLangs.includes(lang);
            return (
              <button
                key={lang}
                onClick={() => onToggleLang(lang)}
                className="text-xs px-2.5 py-1 rounded-full font-medium transition-all"
                style={{
                  background: active ? 'rgba(59,130,246,0.12)' : 'var(--bg-muted)',
                  color:      active ? '#3b82f6'               : 'var(--text-muted)',
                  border:     '1px solid var(--border)',
                }}
              >
                {lang}
              </button>
            );
          })}
          {filterLangs.length > 0 && (
            <button onClick={onResetLangs} className="text-xs px-2 py-1 rounded-full" style={{ color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
              Reset
            </button>
          )}
        </>
      )}
    </div>
  );
}

function CyLegend() {
  return (
    <div
      className="flex flex-wrap items-center gap-3 py-2 px-3 rounded-lg text-xs"
      style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text-muted)' }}
    >
      {Object.entries(CLUSTER_CONFIG).map(([name, cfg]) => (
        <span key={name} className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: cfg.border, background: cfg.bg }} />
          {name}
        </span>
      ))}
      <span className="flex items-center gap-1.5 ml-2">
        <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#ef4444' }} /> Selected
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#f97316' }} /> Direct Impact
      </span>
      <span className="flex items-center gap-1.5">
        <span className="w-3 h-3 rounded-sm border-2 inline-block" style={{ borderColor: '#eab308' }} /> Transitive
      </span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function CytoscapeGraphView() {
  const dispatch         = useDispatch();
  const containerRef     = useRef(null);
  const cyRef            = useRef(null);
  const layoutKeyRef     = useRef('');
  const selectedRef      = useRef(null);

  // Redux state — shared with React Flow tab
  const graphData        = useSelector(s => s.graph.graphData);
  const selectedNode     = useSelector(s => s.graph.selectedNode);
  const directImpact     = useSelector(s => s.graph.directImpact);
  const transitiveImpact = useSelector(s => s.graph.transitiveImpact);
  const filterLangs      = useSelector(s => s.graph.filterLangs);
  const themeMode        = useSelector(s => s.theme?.mode ?? 'light');

  // Local UI state
  const [hiddenClusters, setHiddenClusters] = useState(new Set());
  const [showFilters,    setShowFilters]     = useState(false);
  const [showLegend,     setShowLegend]      = useState(false);
  const [searchText,     setSearchText]      = useState('');
  const [viewportZoom,   setViewportZoom]    = useState(1);

  // Derived
  const availableLangs = useMemo(() => {
    const langs = new Set();
    (graphData.nodes || []).forEach(n => { if (n.language || n.lang) langs.add(n.language || n.lang); });
    return [...langs].sort();
  }, [graphData]);

  const cyElements = useMemo(
    () => buildCyElements(graphData, { hiddenClusters, filterLangs }),
    [graphData, hiddenClusters, filterLangs],
  );

  const searchMatches = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return [];
    return (graphData.nodes || [])
      .filter(n => `${n.name || ''} ${n.path || ''}`.toLowerCase().includes(q))
      .map(n => n.id);
  }, [graphData, searchText]);

  // ── Mount cytoscape ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      elements:  [],
      style:     buildCyStylesheet(),
      boxSelectionEnabled: false,
      minZoom: 0.08,
      maxZoom: 3,
    });

    cy.on('zoom', () => {
      setViewportZoom(Number(cy.zoom().toFixed(2)));
    });

    cy.on('tap', 'node', evt => {
      const id = evt.target.id();
      if (id === selectedRef.current) {
        dispatch(clearSelection());
      } else {
        dispatch(setSelectedNode({ id, graphData }));
      }
    });

    cy.on('tap', evt => {
      if (evt.target === cy) dispatch(clearSelection());
    });

    cy.on('mouseover', 'node', evt => evt.target.addClass('show-label'));
    cy.on('mouseout', 'node', () => {
      cy.nodes().removeClass('show-label');
      if (selectedRef.current) cy.$id(selectedRef.current).addClass('show-label');
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  // Keep selectedRef current
  useEffect(() => { selectedRef.current = selectedNode; }, [selectedNode]);

  // ── Sync elements + layout ───────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      cy.elements().remove();
      cy.add(cyElements);
    });

    const layoutKey = `${cyElements.length}:${hiddenClusters.size}:${filterLangs.join(',')}`;
    if (layoutKey !== layoutKeyRef.current) {
      layoutKeyRef.current = layoutKey;
      cy.layout({
        name: 'fcose',
        animate: false,
        randomize: true,
        idealEdgeLength: 180,
        nodeRepulsion: () => 7000,
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
  }, [cyElements, hiddenClusters, filterLangs]);

  // ── Impact + selection highlighting ─────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass('selected direct-impact transitive-impact dimmed search-match');
    cy.edges().removeClass('dimmed');

    searchMatches.forEach(id => cy.$id(id).addClass('search-match show-label'));

    if (!selectedNode) return;

    const directSet     = new Set(directImpact);
    const transitiveSet = new Set(transitiveImpact);
    const allImpacted   = new Set([...directImpact, ...transitiveImpact]);

    cy.nodes().forEach(node => {
      const id = node.id();
      if (id === selectedNode)          node.addClass('selected show-label');
      else if (directSet.has(id))       node.addClass('direct-impact');
      else if (transitiveSet.has(id))   node.addClass('transitive-impact');
      else if (!searchMatches.includes(id)) node.addClass('dimmed');
    });

    cy.edges().forEach(edge => {
      const s = edge.data('source'), t = edge.data('target');
      if (s !== selectedNode && t !== selectedNode && !allImpacted.has(s) && !allImpacted.has(t)) {
        edge.addClass('dimmed');
      }
    });

    const sel = cy.$id(selectedNode);
    if (sel.length) cy.animate({ fit: { eles: sel.closedNeighborhood(), padding: 90 }, duration: 250 });
  }, [selectedNode, directImpact, transitiveImpact, searchMatches]);

  // ── Search match highlighting ────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.nodes().removeClass('search-match');
    searchMatches.forEach(id => cy.$id(id).addClass('search-match show-label'));
  }, [searchMatches]);

  // ── Cluster / lang filter handlers ───────────────────────────────────────
  const toggleCluster = useCallback(name => {
    setHiddenClusters(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }, []);

  const resetClusters = useCallback(() => setHiddenClusters(new Set()), []);

  const toggleLang = useCallback(lang => {
    const next = filterLangs.includes(lang)
      ? filterLangs.filter(l => l !== lang)
      : [...filterLangs, lang];
    dispatch({ type: 'graph/setFilterLangs', payload: next });
  }, [filterLangs, dispatch]);

  const resetLangs = useCallback(() => {
    dispatch({ type: 'graph/setFilterLangs', payload: [] });
  }, [dispatch]);

  // ── Toolbar actions ──────────────────────────────────────────────────────
  const handleZoomIn  = () => cyRef.current?.zoom(cyRef.current.zoom() * 1.25);
  const handleZoomOut = () => cyRef.current?.zoom(cyRef.current.zoom() * 0.8);
  const handleFit     = () => cyRef.current?.fit(undefined, 30);
  const handleReset   = () => {
    dispatch(clearSelection());
    setHiddenClusters(new Set());
    setSearchText('');
    cyRef.current?.fit(undefined, 30);
  };
  const handleSearchFocus = () => {
    const match = searchMatches[0];
    if (!match) return;
    dispatch(setSelectedNode({ id: match, graphData }));
  };

  // ── Grid canvas background ───────────────────────────────────────────────
  const canvasStyle = useMemo(() => {
    const z   = Math.max(0.2, Math.min(3, viewportZoom));
    const maj = Math.max(40, Math.round(80 * z));
    const min = Math.max(10, Math.round(20 * z));
    const isDark = themeMode === 'dark';
    const gridRgb = isDark ? '51,65,85' : '226,232,240';
    const bg      = isDark ? '#0f172a'  : '#f8fafc';
    return {
      backgroundColor: bg,
      backgroundImage:
        `linear-gradient(rgba(${gridRgb},0.8) 1px, transparent 1px),` +
        `linear-gradient(90deg, rgba(${gridRgb},0.8) 1px, transparent 1px),` +
        `linear-gradient(rgba(${gridRgb},0.4) 1px, transparent 1px),` +
        `linear-gradient(90deg, rgba(${gridRgb},0.4) 1px, transparent 1px)`,
      backgroundSize: `${maj}px ${maj}px,${maj}px ${maj}px,${min}px ${min}px,${min}px ${min}px`,
      border: `1px solid ${isDark ? '#1e293b' : '#e2e8f0'}`,
      minHeight: 0,
    };
  }, [viewportZoom, themeMode]);

  const nodeCount = cyElements.filter(e => !e.data?.source).length;
  const edgeCount = cyElements.filter(e =>  e.data?.source).length;

  return (
    <div className="flex flex-col gap-2" style={{ height: 'calc(100vh - 9rem)' }}>
      {/* Toolbar row */}
      <div className="flex items-center gap-2 flex-wrap">
        <CyToolbar
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onFit={handleFit}
          onReset={handleReset}
          searchText={searchText}
          onSearch={setSearchText}
          onSearchFocus={handleSearchFocus}
          searchMatches={searchMatches}
        />

        <button
          onClick={() => setShowFilters(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: showFilters ? 'rgba(59,130,246,0.12)' : 'var(--card)',
            color:      showFilters ? '#3b82f6' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
        >
          <Filter size={13} /> Filters
        </button>

        <button
          onClick={() => setShowLegend(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
          style={{
            background: showLegend ? 'rgba(59,130,246,0.12)' : 'var(--card)',
            color:      showLegend ? '#3b82f6' : 'var(--text-muted)',
            border: '1px solid var(--border)',
          }}
        >
          <Info size={13} /> Legend
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          <span>{nodeCount} nodes</span>
          <span>{edgeCount} edges</span>
          <span>{Math.round(viewportZoom * 100)}%</span>
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <CyFilters
          hiddenClusters={hiddenClusters}
          onToggleCluster={toggleCluster}
          onResetClusters={resetClusters}
          filterLangs={filterLangs}
          availableLangs={availableLangs}
          onToggleLang={toggleLang}
          onResetLangs={resetLangs}
        />
      )}

      {/* Legend */}
      {showLegend && <CyLegend />}

      {/* Selected node info bar */}
      {selectedNode && (
        <SelectedNodeBar
          selectedNode={selectedNode}
          graphData={graphData}
          directImpact={directImpact}
          transitiveImpact={transitiveImpact}
          onClose={() => dispatch(clearSelection())}
        />
      )}

      {/* Canvas */}
      <div className="flex-1 rounded-xl overflow-hidden" style={canvasStyle}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}

function SelectedNodeBar({ selectedNode, graphData, directImpact, transitiveImpact, onClose }) {
  const nodeData = (graphData.nodes || []).find(n => n.id === selectedNode);
  if (!nodeData) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm flex-wrap"
      style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}
    >
      <span className="font-semibold font-mono" style={{ color: '#ef4444' }}>
        {nodeData.name || nodeData.label || selectedNode}
      </span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {nodeData.language || nodeData.lang || 'mixed'} · {nodeData.type}
      </span>
      <span className="text-xs truncate hidden sm:block" style={{ color: 'var(--text-muted)' }}>
        {nodeData.path || nodeData.name}
      </span>
      <div className="ml-auto flex items-center gap-3 text-xs" style={{ color: 'var(--text-muted)' }}>
        <span style={{ color: '#f97316' }}>{directImpact.length} direct</span>
        <span style={{ color: '#eab308' }}>{transitiveImpact.length} transitive</span>
        <button onClick={onClose} className="p-0.5 rounded hover:opacity-60">
          <X size={14} style={{ color: 'var(--text-muted)' }} />
        </button>
      </div>
    </div>
  );
}
```

---

### Step 4 — Cytoscape Style Helpers

Create **`/client/src/features/graph/components/cytoscapeHelpers.js`**:

```js
// ─── Cluster colour palette (matches your brand) ─────────────────────────────
export const CLUSTER_CONFIG = {
  Frontend:   { color: '#0369a1', border: '#38bdf8', bg: 'rgba(14,165,233,0.06)'   },
  Backend:    { color: '#15803d', border: '#4ade80', bg: 'rgba(34,197,94,0.06)'    },
  Database:   { color: '#b45309', border: '#fbbf24', bg: 'rgba(245,158,11,0.06)'   },
  'AI Engine':{ color: '#7c3aed', border: '#c084fc', bg: 'rgba(168,85,247,0.06)'   },
  Workers:    { color: '#be123c', border: '#fb7185', bg: 'rgba(244,63,94,0.06)'    },
  Tests:      { color: '#475569', border: '#94a3b8', bg: 'rgba(148,163,184,0.06)'  },
  Utilities:  { color: '#0f766e', border: '#2dd4bf', bg: 'rgba(20,184,166,0.06)'   },
  Core:       { color: '#1d4ed8', border: '#60a5fa', bg: 'rgba(96,165,250,0.06)'   },
  Other:      { color: '#334155', border: '#64748b', bg: 'rgba(100,116,139,0.06)'  },
};

// ─── Node type → cluster assignment ──────────────────────────────────────────
const CLUSTER_RULES = [
  { key: 'Tests',     test: p => /test|spec|__tests__|\.test\.|\.spec\./i.test(p) },
  { key: 'Frontend',  test: p => /^frontend\//i.test(p) || /\/(components|pages|views|ui)\//i.test(p) },
  { key: 'Backend',   test: p => /\/(controllers|routes|middlewares|services)\//i.test(p) || /^backend\//i.test(p) },
  { key: 'Database',  test: p => /\/(db|database|migrations|models|queries|schema)\//i.test(p) },
  { key: 'AI Engine', test: p => /^ai[\-_]engine\//i.test(p) || /\/(pipeline|llm|agent)\//i.test(p) },
  { key: 'Workers',   test: p => /\/(workers|queues|jobs)\//i.test(p) },
  { key: 'Utilities', test: p => /\/(config|utils|helpers|lib|store|slices)\//i.test(p) },
];

function assignCluster(filePath = '') {
  const p = filePath.replace(/\\/g, '/').toLowerCase();
  for (const rule of CLUSTER_RULES) { if (rule.test(p)) return rule.key; }
  return filePath.split('/')[0] || 'Other';
}

// ─── Convert raw graphData → cytoscape elements ───────────────────────────────
export function buildCyElements(graphData, { hiddenClusters = new Set(), filterLangs = [] } = {}) {
  const { nodes = [], edges = [] } = graphData;

  // Build parent compound nodes (clusters)
  const clusterIds = new Set();
  const nodeClusterMap = new Map();

  nodes.forEach(node => {
    const filePath = (node.path || node.file || node.name || '').replace(/\\/g, '/');
    const cluster  = assignCluster(filePath);
    nodeClusterMap.set(node.id, cluster);
  });

  const elements = [];

  // Emit cluster parent nodes
  const usedClusters = new Set([...nodeClusterMap.values()]);
  usedClusters.forEach(cluster => {
    if (hiddenClusters.has(cluster)) return;
    const cfg = CLUSTER_CONFIG[cluster] || CLUSTER_CONFIG.Other;
    clusterIds.add(`cluster:${cluster}`);
    elements.push({
      data: {
        id:          `cluster:${cluster}`,
        label:        cluster,
        type:         'cluster',
        borderColor:  cfg.border,
        bgColor:      cfg.bg,
      },
      classes: 'cluster-parent',
    });
  });

  // Emit file/function nodes
  const visibleNodeIds = new Set();
  nodes.forEach(node => {
    const cluster = nodeClusterMap.get(node.id) || 'Other';
    if (hiddenClusters.has(cluster)) return;
    const lang = node.language || node.lang || '';
    if (filterLangs.length > 0 && !filterLangs.includes(lang)) return;

    const cfg       = CLUSTER_CONFIG[cluster] || CLUSTER_CONFIG.Other;
    const clusterId = `cluster:${cluster}`;

    visibleNodeIds.add(node.id);
    elements.push({
      data: {
        id:          node.id,
        label:       node.name || node.label || node.id,
        type:        (node.type || 'file').toLowerCase(),
        lang,
        path:        node.path || node.name || '',
        borderColor: cfg.border,
        bgColor:     cfg.bg,
        nodeSize:    32,
        parent:      clusterIds.has(clusterId) ? clusterId : undefined,
      },
    });
  });

  // Emit edges
  edges.forEach((edge, idx) => {
    const src = edge.source ?? edge.from;
    const tgt = edge.target ?? edge.to;
    if (!src || !tgt || src === tgt) return;
    if (!visibleNodeIds.has(src) || !visibleNodeIds.has(tgt)) return;
    elements.push({
      data: {
        id:       edge.id || `e-${idx}`,
        source:   src,
        target:   tgt,
        edgeType: (edge.type || edge.edgeType || 'RELATED').toUpperCase(),
        count:    1,
      },
    });
  });

  return elements;
}

// ─── Cytoscape stylesheet ────────────────────────────────────────────────────
export function buildCyStylesheet() {
  return [
    // Cluster compound parent
    {
      selector: 'node.cluster-parent',
      style: {
        shape:                         'round-rectangle',
        'background-opacity':           0.04,
        'border-width':                '1.5px',
        'border-style':                'dashed',
        'border-color':                'data(borderColor)',
        'background-color':            'data(bgColor)',
        label:                         'data(label)',
        'text-valign':                 'top',
        'text-halign':                 'center',
        'font-size':                   '11px',
        'font-weight':                 'bold',
        'font-family':                 'monospace',
        color:                         'data(borderColor)',
        padding:                       '40px',
        'min-width':                   '100px',
        'min-height':                  '70px',
        'compound-sizing-wrt-labels':  'include',
      },
    },
    // Default node
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
    // Function nodes → ellipse
    {
      selector: 'node[type = "function"]',
      style: {
        shape:            'ellipse',
        'background-opacity': 0.7,
        'background-color':   '#22c55e',
        'border-color':       '#15803d',
      },
    },
    // API endpoint → diamond
    {
      selector: 'node[type = "api_endpoint"]',
      style: { shape: 'diamond' },
    },
    // Default edge
    {
      selector: 'edge',
      style: {
        width:                 1.6,
        'line-color':          '#2563eb',
        'target-arrow-color':  '#2563eb',
        'target-arrow-shape':  'triangle',
        'curve-style':         'bezier',
        opacity:               0.5,
      },
    },
    // Edge types
    { selector: 'edge[edgeType = "IMPORTS"]', style: { 'line-color': '#3b82f6', 'target-arrow-color': '#3b82f6' } },
    { selector: 'edge[edgeType = "CALLS"]',   style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e', 'line-style': 'dashed' } },
    // Impact states
    { selector: 'node.selected',          style: { 'border-width': '3px', 'border-color': '#ef4444', 'overlay-color': '#ef4444', 'overlay-opacity': 0.08 } },
    { selector: 'node.direct-impact',     style: { 'border-width': '3px', 'border-color': '#f97316', 'overlay-color': '#f97316', 'overlay-opacity': 0.08 } },
    { selector: 'node.transitive-impact', style: { 'border-width': '2px', 'border-color': '#eab308', 'overlay-color': '#eab308', 'overlay-opacity': 0.06 } },
    { selector: 'node.search-match',      style: { 'border-width': '3px', 'border-color': '#38bdf8', 'overlay-color': '#38bdf8', 'overlay-opacity': 0.06 } },
    { selector: 'node.dimmed',            style: { opacity: 0.18 } },
    { selector: 'edge.dimmed',            style: { opacity: 0.06 } },
  ];
}
```

---

### Step 5 — Wire the Tabs into the Graph Page

Find the file that renders the `/graph` route. In your project structure this is likely at:

```
/client/src/features/graph/pages/GraphPage.jsx
   — OR —
/client/src/pages/GraphPage.jsx
```

Replace (or wrap) the existing graph container with:

```jsx
import React, { useState } from 'react';
import GraphTabBar         from '../components/GraphTabBar';
import CytoscapeGraphView  from '../components/CytoscapeGraphView';
// Keep your existing React Flow import — do NOT remove it
import ExistingGraphView   from '../components/GraphView'; // adjust to real filename

export default function GraphPage() {
  const [activeTab, setActiveTab] = useState('reactflow');

  return (
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 4rem)' }}>
      {/* Tab bar — sits at the very top of the graph page */}
      <GraphTabBar activeTab={activeTab} onChange={setActiveTab} />

      {/* Graph panels — only the active one renders */}
      {activeTab === 'reactflow' && (
        <div className="flex-1 min-h-0">
          <ExistingGraphView />
        </div>
      )}
      {activeTab === 'cytoscape' && (
        <div className="flex-1 min-h-0">
          <CytoscapeGraphView />
        </div>
      )}
    </div>
  );
}
```

> **Tip:** If your existing `GraphPage` already has toolbar rows and padding, wrap just the canvas area. The tab bar should appear **above** any existing toolbar so the user always sees it regardless of which graph is active.

---

### Step 6 — Persist Tab Choice in Redux

If you want the active tab to survive page navigation (optional but recommended):

**In `/client/src/features/graph/slices/graphSlice.js`** add to `initialState`:

```js
activeGraphTab: localStorage.getItem('activeGraphTab') || 'reactflow',
```

Add a reducer:

```js
setActiveGraphTab(state, action) {
  state.activeGraphTab = action.payload;
  localStorage.setItem('activeGraphTab', action.payload);
},
```

Export it:

```js
export const { ..., setActiveGraphTab } = graphSlice.actions;
```

Then in `GraphPage.jsx` use Redux instead of `useState`:

```jsx
import { useDispatch, useSelector } from 'react-redux';
import { setActiveGraphTab } from '../slices/graphSlice';

const activeTab = useSelector(s => s.graph.activeGraphTab);
const dispatch  = useDispatch();

// Replace onChange prop:
<GraphTabBar activeTab={activeTab} onChange={tab => dispatch(setActiveGraphTab(tab))} />
```

---

## Feature 2 — Local Repo Upload Rewrite

### Root Cause of the Existing Bug

The current `UploadRepoForm` local section has **three failure modes**:

1. **Browse button silently disabled** when `pickerCapabilities.supported === false` — on most Linux servers (no `zenity`/`kdialog`) the button is frozen with no fallback UX.
2. **`onBlur` validation fires immediately** when the user switches fields, triggering a red error before they finish typing a path.
3. **The Validate button** calls the backend before the user finishes entering a path, and its error messages shadow the more helpful inline hints.

The rewrite below eliminates all three issues with a clean, self-contained `LocalRepoSection` component.

---

### Step 1 — Replace the Local Section in UploadRepoForm

In `/client/src/features/graph/components/UploadRepoForm.jsx`, remove the entire `{source === 'local' && (...)}` JSX block and replace it with:

```jsx
{source === 'local' && (
  <LocalRepoSection
    disabled={isLoading}
    onReady={(localPath) => {
      // localPath has been validated by the child — proceed to analyse
      dispatch(setSelectedAnalyzeRepository({ source: 'local', localPath }));
      dispatch(analyzeCodebase({ source: 'local', localPath }));
    }}
  />
)}
```

Remove the now-unused state variables from the parent form:

```js
// DELETE these from UploadRepoForm state:
// const [localPath, setLocalPath] = useState('');
// const [localValidationState, setLocalValidationState] = useState('idle');
// const [localError, setLocalError] = useState('');
// const [localBrowseLoading, setLocalBrowseLoading] = useState(false);
// const [pickerCapabilitiesLoading, setPickerCapabilitiesLoading] = useState(true);
// const [pickerCapabilities, setPickerCapabilities] = useState({ ... });
// and all the local picker useEffect hooks
```

Also update `canAnalyze` — replace the local branch:

```js
const canAnalyze = useMemo(() => {
  // local tab: the child handles validation internally and calls onReady when done
  // so the parent submit button is not used for local — we can hide it
  if (source === 'local') return false; // submit handled by child
  // ... rest of github logic unchanged
}, [...]);
```

And hide the submit `<Button>` when `source === 'local'` since `LocalRepoSection` has its own Analyse button:

```jsx
{source !== 'local' && (
  <Button type="submit" ... >
    Analyze Codebase Structure
  </Button>
)}
```

---

### Step 2 — LocalRepoSection Component (complete)

Create **`/client/src/features/graph/components/LocalRepoSection.jsx`**:

```jsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FolderOpen, CheckCircle2, AlertCircle,
  Loader2, ArrowRight, Info,
} from 'lucide-react';
import { Button }  from '@/components/ui/button';
import { Input }   from '@/components/ui/input';
import { Label }   from '@/components/ui/label';
import { graphService } from '../services/graphService';

// Debounce helper
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * LocalRepoSection
 *
 * Completely self-contained local-repo form panel.
 * Calls `onReady(localPath)` once the user hits Analyse and
 * the backend confirms the path is a valid git repo.
 *
 * @param {{ disabled: boolean, onReady: (path: string) => void }} props
 */
export default function LocalRepoSection({ disabled, onReady }) {
  const inputRef = useRef(null);

  // ── State ──────────────────────────────────────────────────────────────
  const [path,         setPath]         = useState('');
  const [validation,   setValidation]   = useState('idle'); // 'idle'|'loading'|'ok'|'error'
  const [validError,   setValidError]   = useState('');
  const [browseState,  setBrowseState]  = useState('idle'); // 'idle'|'loading'|'error'
  const [browseError,  setBrowseError]  = useState('');
  const [pickerReady,  setPickerReady]  = useState(false);
  const [pickerMsg,    setPickerMsg]    = useState('');
  const [submitState,  setSubmitState]  = useState('idle'); // 'idle'|'loading'|'error'
  const [submitError,  setSubmitError]  = useState('');

  // Debounce path so we don't spam validation on every keystroke
  const debouncedPath = useDebounce(path.trim(), 600);

  // ── Check picker capabilities on mount ─────────────────────────────────
  useEffect(() => {
    let alive = true;
    graphService.getLocalPickerCapabilities()
      .then(data => {
        if (!alive) return;
        setPickerReady(Boolean(data?.supported));
        setPickerMsg(data?.message ?? '');
      })
      .catch(() => {
        if (!alive) return;
        setPickerReady(false);
        setPickerMsg('Native folder picker unavailable — paste an absolute path.');
      });
    return () => { alive = false; };
  }, []);

  // ── Auto-validate when debounced path changes ───────────────────────────
  useEffect(() => {
    if (!debouncedPath) {
      setValidation('idle');
      setValidError('');
      return;
    }
    let alive = true;
    setValidation('loading');
    setValidError('');
    graphService.validateLocalPath(debouncedPath)
      .then(() => { if (alive) setValidation('ok'); })
      .catch(err => {
        if (!alive) return;
        setValidation('error');
        setValidError(
          err?.response?.data?.error ||
          err?.message ||
          'Path validation failed — check the path is an absolute git repository.',
        );
      });
    return () => { alive = false; };
  }, [debouncedPath]);

  // ── Browse handler ──────────────────────────────────────────────────────
  const handleBrowse = useCallback(async () => {
    if (!pickerReady) return;
    setBrowseState('loading');
    setBrowseError('');
    try {
      const result = await graphService.browseLocalPath();
      if (result?.path) {
        setPath(result.path);
        setValidation('idle'); // debounce will re-trigger validation
        setBrowseState('idle');
        inputRef.current?.focus();
      } else {
        setBrowseState('idle'); // cancelled
      }
    } catch (err) {
      const timedOut = err?.code === 'ECONNABORTED' || err?.response?.status === 408;
      setBrowseState('error');
      setBrowseError(
        timedOut
          ? 'Folder picker timed out — paste an absolute path manually.'
          : err?.response?.data?.error || err?.message || 'Could not open native folder picker.',
      );
    }
  }, [pickerReady]);

  // ── Submit handler ──────────────────────────────────────────────────────
  const handleAnalyse = useCallback(async () => {
    const trimmed = path.trim();
    if (!trimmed) {
      setValidation('error');
      setValidError('Enter an absolute path to a local repository.');
      return;
    }

    // If not yet validated, do a quick synchronous validate first
    if (validation !== 'ok') {
      setSubmitState('loading');
      setSubmitError('');
      try {
        await graphService.validateLocalPath(trimmed);
        setValidation('ok');
        setValidError('');
      } catch (err) {
        setValidation('error');
        setValidError(
          err?.response?.data?.error || err?.message || 'Invalid repository path.',
        );
        setSubmitState('idle');
        return;
      }
      setSubmitState('idle');
    }

    // Hand off to parent
    onReady(trimmed);
  }, [path, validation, onReady]);

  const pathTrimmed  = path.trim();
  const canAnalyse   = pathTrimmed.length > 0 && validation !== 'loading' && submitState !== 'loading';
  const isLoading    = disabled || submitState === 'loading' || validation === 'loading';

  return (
    <div
      className="flex flex-col gap-4 rounded-2xl p-6 animate-in fade-in slide-in-from-bottom-4 duration-500"
      style={{
        background: 'var(--card)',
        border:     '1px solid var(--border)',
        boxShadow:  'var(--shadow-neu-inset, none)',
      }}
    >
      {/* Info banner */}
      <div
        className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
        style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.20)', color: '#60a5fa' }}
      >
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          Enter an <strong>absolute path</strong> to a local git repository on this machine.
          The backend server must have read access to the path.
          {pickerMsg && !pickerReady && <> {pickerMsg}</>}
        </span>
      </div>

      {/* Path input row */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="local-path" className="text-[10px] uppercase font-bold tracking-widest" style={{ color: 'var(--text-muted)' }}>
          Repository path
        </Label>

        <div className="flex gap-2">
          {/* Text input */}
          <div className="relative flex-1">
            <FolderOpen
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-muted)' }}
            />
            <Input
              ref={inputRef}
              id="local-path"
              type="text"
              value={path}
              onChange={e => {
                setPath(e.target.value);
                setValidation('idle');
                setValidError('');
                setSubmitError('');
              }}
              onKeyDown={e => { if (e.key === 'Enter' && canAnalyse) handleAnalyse(); }}
              placeholder={
                navigator.platform?.startsWith('Win')
                  ? 'C:\\Users\\you\\my-project'
                  : '/home/you/my-project'
              }
              className="pl-9 font-mono text-sm"
              disabled={isLoading}
              autoComplete="off"
              spellCheck={false}
              style={{ color: 'var(--text)' }}
            />
          </div>

          {/* Browse button — shown when picker is available */}
          <Button
            type="button"
            variant="outline"
            onClick={handleBrowse}
            disabled={isLoading || browseState === 'loading' || !pickerReady}
            className="shrink-0 rounded-xl"
            title={pickerReady ? 'Open native folder picker' : pickerMsg}
            style={{
              opacity: pickerReady ? 1 : 0.4,
              cursor:  pickerReady ? 'pointer' : 'not-allowed',
            }}
          >
            {browseState === 'loading' ? (
              <><Loader2 size={14} className="animate-spin" /> Opening…</>
            ) : (
              <><FolderOpen size={14} /> Browse</>
            )}
          </Button>
        </div>
      </div>

      {/* Validation feedback */}
      {validation === 'loading' && pathTrimmed && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <Loader2 size={13} className="animate-spin" /> Validating path…
        </p>
      )}
      {validation === 'ok' && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: '#4ade80' }}>
          <CheckCircle2 size={13} /> Path is a valid git repository.
        </p>
      )}
      {validation === 'error' && validError && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: '#f87171' }}>
          <AlertCircle size={13} /> {validError}
        </p>
      )}

      {/* Browse error */}
      {browseState === 'error' && browseError && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: '#f87171' }}>
          <AlertCircle size={13} /> {browseError}
        </p>
      )}

      {/* Submit error */}
      {submitState === 'error' && submitError && (
        <p className="flex items-center gap-1.5 text-xs" style={{ color: '#f87171' }}>
          <AlertCircle size={13} /> {submitError}
        </p>
      )}

      {/* Path hint */}
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Use an absolute path (starting with <code>/</code> on Mac/Linux or a drive letter on Windows).
        Relative paths and <code>~</code> shortcuts are not supported.
      </p>

      {/* Analyse CTA */}
      <Button
        type="button"
        size="lg"
        className="mt-2 h-12 w-full rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-[0.98]"
        style={{
          background: canAnalyse ? '#3b82f6' : 'var(--bg-muted)',
          color:      canAnalyse ? '#fff'    : 'var(--text-muted)',
          cursor:     canAnalyse ? 'pointer' : 'not-allowed',
        }}
        disabled={!canAnalyse || isLoading}
        onClick={handleAnalyse}
      >
        {isLoading ? (
          <><Loader2 size={16} className="animate-spin mr-2" /> Analysing…</>
        ) : (
          <>Analyse Codebase <ArrowRight size={15} className="ml-2" /></>
        )}
      </Button>
    </div>
  );
}
```

---

### Step 3 — Verify Backend Endpoints Are Wired

The component above calls **three** existing endpoints. Confirm each is present in `server/src/analyze/routes/analyze.routes.js`:

```js
// These three must exist — they already do in your codebase:
router.get ('/local/picker-capabilities', analyzeLimiter, localPickerCapabilitiesController);
router.get ('/local/browse',              analyzeLimiter, browseLocalPathController);
router.post('/local/validate',            analyzeLimiter, validateLocalPathBody, validateLocalPathController);
```

And in `graphService.js` confirm these three calls are defined:

```js
getLocalPickerCapabilities: async () => {
  const { data } = await graphClient.get('/api/analyze/local/picker-capabilities');
  return data;
},

browseLocalPath: async () => {
  // 22 s timeout because the OS picker blocks the request
  const { data } = await graphClient.get('/api/analyze/local/browse', { timeout: 22000 });
  return data;
},

validateLocalPath: async (projectPath) => {
  const { data } = await graphClient.post('/api/analyze/local/validate', {
    path: projectPath.trim(),
  });
  return data;
},
```

All three are already present in your Phase 5 `graphService.js` — no changes required on the service layer.

**If the Browse button hangs on Linux servers:** the server doesn't have `zenity` or `kdialog` installed, so `pickerCapabilities.supported` comes back `false` and the button is automatically disabled with a clear message. The user sees the manual path input instead — which is the correct fallback.

---

## Testing Checklist

### Feature 1 — Dual Graph Tabs

- [ ] Navigating to `/graph` shows two tabs: **Flow Graph** and **Cytoscape View**.
- [ ] Clicking **Cytoscape View** renders the Cytoscape canvas without unmounting React Flow.
- [ ] Clicking back to **Flow Graph** restores the React Flow view; selected node and filters are preserved.
- [ ] Selecting a node in Cytoscape highlights direct + transitive impact with the correct colours (`#f97316`, `#eab308`).
- [ ] Cluster filter toggles hide/show nodes and re-run the fcose layout.
- [ ] Language filter toggles work correctly.
- [ ] Search focuses on matched nodes and shows the count badge.
- [ ] Zoom in/out/fit/reset buttons all work.
- [ ] Dark mode: canvas background switches to `#0f172a`, grid lines use slate-700.
- [ ] (Optional) Active tab persists after navigating away and back.

### Feature 2 — Local Repo Upload

- [ ] Navigating to the Upload page and selecting **Local Repository** shows the new `LocalRepoSection`.
- [ ] Typing a valid absolute path triggers auto-validation after 600 ms debounce and shows the green tick.
- [ ] Typing an invalid path shows a clear red error from the backend.
- [ ] Pressing **Browse** on macOS opens the OS picker; selecting a folder fills the input.
- [ ] Pressing **Browse** on a Linux server without `zenity` shows the button as visually disabled with a tooltip explaining why.
- [ ] Pressing **Analyse Codebase** with an unvalidated path runs a synchronous validation before handing off.
- [ ] Pressing **Analyse Codebase** with a validated path calls `onReady(path)` and triggers the Redux `analyzeCodebase` thunk.
- [ ] The parent form's **Analyse Codebase Structure** submit button is hidden while the local tab is active (child has its own).
- [ ] Re-analyze flow (`location.state.reanalyzeConfig.source === 'local'`) still pre-fills the path correctly via the parent.
