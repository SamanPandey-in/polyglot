import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Network } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
} from 'reactflow';
import 'reactflow/dist/style.css';
import dagre from 'dagre';
import { AiPanel } from '../../ai';
import { selectThemeMode } from '../../theme/slices/themeSlice';

// Fullscreen styles for theme support
const fullscreenStyles = `
  #graph-container:fullscreen {
    background-color: rgb(var(--background));
    color: rgb(var(--foreground));
  }
  #graph-container:fullscreen .reactflow {
    background-color: transparent;
  }
  #graph-container:fullscreen .dark {
    color-scheme: dark;
  }
  .dark #graph-container:fullscreen {
    background-color: #000000;
    color: #FFFFFF;
  }
`;

// Inject fullscreen styles into document
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = fullscreenStyles;
  document.head.appendChild(style);
}
import {
  selectNode,
  selectSelectedNodeId,
  selectGraphData,
  selectHeatmapMode,
  selectHeatmapHotspots,
} from '../slices/graphSlice';
import { selectDeadFiles, selectHighlightedNodeIds } from '../../ai/slices/aiSlice';
import { graphService } from '../services/graphService';

const THEME_COLORS = {
  dark: {
    component: { bg: '#1A1A1A', border: '#404040' },
    page:      { bg: '#0B0B0B', border: '#D4AF37' },
    hook:      { bg: '#262626', border: '#D4AF37' },
    service:   { bg: '#1A1A1A', border: '#404040' },
    util:      { bg: '#262626', border: '#404040' },
    config:    { bg: '#0B0B0B', border: '#666666' },
    module:    { bg: '#1A1A1A', border: '#404040' },
  },
  light: {
    component: { bg: '#F5F5F5', border: '#BFBFBF' },
    page:      { bg: '#FFFFFF', border: '#D4AF37' },
    hook:      { bg: '#F8F8F8', border: '#D4AF37' },
    service:   { bg: '#F5F5F5', border: '#BFBFBF' },
    util:      { bg: '#F8F8F8', border: '#BFBFBF' },
    config:    { bg: '#FFFFFF', border: '#999999' },
    module:    { bg: '#F5F5F5', border: '#BFBFBF' },
  },
};

const THEME_TEXT = {
  dark: '#E5E5E5',
  light: '#1A1A1A',
};

const FUNCTION_NODE_STYLE = {
  dark: {
    bg: '#111827',
    border: '#6B7280',
    text: '#E5E7EB',
  },
  light: {
    bg: '#FFFFFF',
    border: '#9CA3AF',
    text: '#111827',
  },
};

function getTypeColors(theme) {
  return THEME_COLORS[theme] || THEME_COLORS.dark;
}

function getTypeStyle(type, theme) {
  const colors = getTypeColors(theme);
  const { bg, border } = colors[type] || colors.module;
  return {
    background: bg,
    border: `1px solid ${border}`,
    color: THEME_TEXT[theme],
    borderRadius: 8,
    fontSize: 11,
    padding: '6px 10px',
    maxWidth: 200,
    wordBreak: 'break-all',
  };
}

const NODE_W = 200;
const NODE_H = 42;
const EMPTY_GRAPH = {};

function applyDagreLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 100, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const { x, y } = g.node(n.id);
    return { ...n, position: { x: x - NODE_W / 2, y: y - NODE_H / 2 } };
  });
}

function riskToColor(inDegree = 0, loc = 0, riskScore = null) {
  const hasRiskScore = Number.isFinite(Number(riskScore));
  const score = hasRiskScore ? Number(riskScore) : (Number(inDegree) || 0) * ((Number(loc) || 0) / 100);

  if (score > 20) return '#ef4444';
  if (score > 8) return '#f59e0b';
  return '#22c55e';
}

function graphToFlow(
  graph,
  highlightedNodeIds,
  deadFiles,
  theme = 'dark',
  heatmapMode = false,
  heatmapHotspots = {},
) {
  const highlightSet = new Set(highlightedNodeIds || []);
  const deadSet = new Set(deadFiles || []);
  const colors = getTypeColors(theme);

  const nodes = Object.entries(graph).map(([file, { type, metrics }]) => {
    const baseStyle = getTypeStyle(type, theme);
    const hotspot = heatmapHotspots[file] || null;
    const heatmapColor = heatmapMode
      ? riskToColor(hotspot?.inDegree ?? metrics?.inDegree, hotspot?.loc ?? metrics?.loc, hotspot?.riskScore)
      : null;

    return {
      id: file,
      data: { label: file },
      position: { x: 0, y: 0 },
      style: {
        ...baseStyle,
        background: heatmapColor ? `${heatmapColor}22` : baseStyle.background,
        boxShadow: highlightSet.has(file)
          ? '0 0 0 2px rgba(251,191,36,0.95), 0 0 20px rgba(251,191,36,0.45)'
          : undefined,
        border: deadSet.has(file)
          ? '1px dashed rgba(248,113,113,0.9)'
          : heatmapColor
            ? `1px solid ${heatmapColor}`
            : baseStyle.border,
        opacity: deadSet.has(file) ? 0.75 : 1,
      },
    };
  });

  const edges = [];
  for (const [source, { deps }] of Object.entries(graph)) {
    for (const target of deps) {
      if (graph[target] !== undefined) {
        const { border } = colors[graph[target].type] || colors.module;
        edges.push({
          id: `${source}>${target}`,
          source,
          target,
          animated: true,
          style: { stroke: border, strokeWidth: 1.5 },
        });
      }
    }
  }

  return { nodes: applyDagreLayout(nodes, edges), edges };
}

export default function GraphView() {
  const dispatch = useDispatch();
  const rawData = useSelector(selectGraphData);
  const selectedNodeId = useSelector(selectSelectedNodeId);
  const highlightedNodeIds = useSelector(selectHighlightedNodeIds);
  const deadFiles = useSelector(selectDeadFiles);
  const heatmapMode = useSelector(selectHeatmapMode);
  const heatmapHotspots = useSelector(selectHeatmapHotspots);
  const themeMode = useSelector(selectThemeMode);
  const graph = rawData?.graph ?? EMPTY_GRAPH;
  const jobId = rawData?.jobId || null;
  const emptyMessage =
    rawData?.message || 'No JS/TS files found in the selected directory.';

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => graphToFlow(graph, highlightedNodeIds, deadFiles, themeMode, heatmapMode, heatmapHotspots),
    [graph, highlightedNodeIds, deadFiles, themeMode, heatmapMode, heatmapHotspots],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const expandedNodesRef = useRef(new Set());

  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
    expandedNodesRef.current = new Set();
  }, [initialEdges, initialNodes, setEdges, setNodes]);

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const onNodeClick = useCallback(
    (_e, node) => {
      if (!graph[node.id]) return;
      dispatch(selectNode(node.id));
    },
    [dispatch, graph],
  );

  const onNodeDoubleClick = useCallback(
    async (_event, node) => {
      if (!jobId || !graph[node.id]) return;
      if (expandedNodesRef.current.has(node.id)) return;

      try {
        const functionDeclarations = await graphService.getFunctionNodes(jobId, node.id);

        if (functionDeclarations.length === 0) {
          // Visual feedback for files with no extractable function declarations.
          setNodes((prev) =>
            prev.map((n) =>
              n.id === node.id
                ? { ...n, style: { ...n.style, boxShadow: '0 0 0 2px #888, 0 0 8px #88888844' } }
                : n,
            ),
          );

          setTimeout(() => {
            setNodes((prev) =>
              prev.map((n) =>
                n.id === node.id
                  ? { ...n, style: { ...n.style, boxShadow: undefined } }
                  : n,
              ),
            );
          }, 800);

          return;
        }

        const baseStyle = FUNCTION_NODE_STYLE[themeMode] || FUNCTION_NODE_STYLE.dark;
        const createdNodes = [];
        const createdEdges = [];

        setNodes((previousNodes) => {
          const existingIds = new Set(previousNodes.map((existingNode) => existingNode.id));

          functionDeclarations.forEach((fn, index) => {
            if (!fn?.name) return;

            const childId = `${node.id}::${fn.name}`;
            if (existingIds.has(childId)) return;
            existingIds.add(childId);

            createdNodes.push({
              id: childId,
              data: {
                label: fn.name,
                kind: fn.kind || 'function',
              },
              position: {
                x: node.position.x + 56,
                y: node.position.y + 56 + index * 36,
              },
              draggable: true,
              style: {
                background: baseStyle.bg,
                border: `1px solid ${baseStyle.border}`,
                borderRadius: 6,
                color: baseStyle.text,
                fontSize: 10,
                padding: '3px 7px',
                maxWidth: 160,
              },
            });

            createdEdges.push({
              id: `${node.id}>${childId}`,
              source: node.id,
              target: childId,
              animated: false,
              style: { stroke: baseStyle.border, strokeWidth: 1 },
            });
          });

          if (createdNodes.length === 0) return previousNodes;
          return [...previousNodes, ...createdNodes];
        });

        if (createdEdges.length > 0) {
          setEdges((previousEdges) => {
            const existingIds = new Set(previousEdges.map((edge) => edge.id));
            const dedupedEdges = createdEdges.filter((edge) => !existingIds.has(edge.id));
            if (dedupedEdges.length === 0) return previousEdges;
            return [...previousEdges, ...dedupedEdges];
          });
        }

        expandedNodesRef.current.add(node.id);
      } catch (err) {
        console.warn('[GraphView] Failed to load function nodes:', err.message);
      }
    },
    [graph, jobId, setEdges, setNodes, themeMode],
  );

  if (nodes.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4">
        <div className="max-w-xl text-center">
          <Network className="mx-auto mb-3 size-8 text-muted-foreground" />
          <div className="font-medium text-lg">No nodes found</div>
          <p className="mt-2 text-sm text-muted-foreground">{emptyMessage}</p>
          <p className="mt-2 text-sm text-muted-foreground">Check that the analyzed repository has parseable files. Supported file types include .js, .ts, .py, .go, or .rs files.</p>
        </div>
      </div>
    );
  }

  return (
    <div id="graph-container" className="relative flex-1 min-h-0">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        style={{ background: 'transparent' }}
      >
        <MiniMap
          nodeColor={(n) => {
            if (heatmapMode) {
              const metrics = graph[n.id]?.metrics || {};
              const hotspot = heatmapHotspots[n.id] || null;
              return riskToColor(
                hotspot?.inDegree ?? metrics?.inDegree,
                hotspot?.loc ?? metrics?.loc,
                hotspot?.riskScore,
              );
            }
            const colors = getTypeColors(themeMode);
            return (colors[graph[n.id]?.type] || colors.module).border;
          }}
          maskColor="rgb(var(--background) / 0.7)"
          style={{ background: 'rgb(var(--card))', border: '1px solid rgb(var(--border) / 0.1)' }}
        />
        <Controls />
        <Background color="rgb(var(--foreground) / 0.05)" gap={20} />

        <div className="absolute bottom-14 left-3 z-10 rounded-lg border border-border bg-card/90 backdrop-blur-sm p-3 text-[11px] shadow-lg">
          {heatmapMode ? (
            <>
              <div className="mb-2 text-muted-foreground font-medium">Complexity heatmap</div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block size-2.5 rounded-sm shrink-0" style={{ background: '#22c55e' }} />
                <span className="text-muted-foreground">Low risk</span>
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="inline-block size-2.5 rounded-sm shrink-0" style={{ background: '#f59e0b' }} />
                <span className="text-muted-foreground">Medium risk</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block size-2.5 rounded-sm shrink-0" style={{ background: '#ef4444' }} />
                <span className="text-muted-foreground">High risk</span>
              </div>
            </>
          ) : (
            Object.entries(getTypeColors(themeMode)).map(([type, { border }]) => (
              <div key={type} className="flex items-center gap-2 mb-1 last:mb-0">
                <span className="inline-block size-2.5 rounded-sm shrink-0" style={{ background: border }} />
                <span className="text-muted-foreground capitalize">{type}</span>
              </div>
            ))
          )}
        </div>
      </ReactFlow>

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
  );
}
