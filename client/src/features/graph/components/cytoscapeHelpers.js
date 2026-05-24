export const CLUSTER_CONFIG = {
  component: { border: '#38bdf8', bg: 'rgba(14,165,233,0.06)' },
  page: { border: '#60a5fa', bg: 'rgba(96,165,250,0.06)' },
  hook: { border: '#c084fc', bg: 'rgba(168,85,247,0.06)' },
  service: { border: '#4ade80', bg: 'rgba(34,197,94,0.06)' },
  util: { border: '#2dd4bf', bg: 'rgba(20,184,166,0.06)' },
  config: { border: '#94a3b8', bg: 'rgba(148,163,184,0.06)' },
  module: { border: '#64748b', bg: 'rgba(100,116,139,0.06)' },
};

function getClusterId(type) {
  return `cluster:${type || 'module'}`;
}

function normalizeType(type) {
  const safeType = String(type || 'module').toLowerCase();
  return Object.prototype.hasOwnProperty.call(CLUSTER_CONFIG, safeType) ? safeType : 'module';
}

export function buildCyElements(graph, { hiddenTypes = new Set(), filterQuery = '' } = {}) {
  if (!graph || typeof graph !== 'object') return [];

  const query = String(filterQuery || '').trim().toLowerCase();
  const visibleFiles = Object.keys(graph).filter((filePath) => {
    const entry = graph[filePath] || {};
    const type = normalizeType(entry.type);

    if (hiddenTypes.has(type)) return false;
    if (query && !filePath.toLowerCase().includes(query)) return false;
    return true;
  });

  const visibleSet = new Set(visibleFiles);
  const usedTypes = new Set(visibleFiles.map((filePath) => normalizeType(graph[filePath]?.type)));
  const elements = [];

  usedTypes.forEach((type) => {
    const config = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
    elements.push({
      data: {
        id: getClusterId(type),
        label: type,
        type: 'cluster',
        borderColor: config.border,
        bgColor: config.bg,
      },
      classes: 'cluster-parent',
    });
  });

  visibleFiles.forEach((filePath) => {
    const entry = graph[filePath] || {};
    const type = normalizeType(entry.type);
    const config = CLUSTER_CONFIG[type] || CLUSTER_CONFIG.module;
    const metrics = entry.metrics || {};
    const nodeSize = Math.min(72, Math.max(24, 24 + (Number(metrics.inDegree) || 0) * 4));

    elements.push({
      data: {
        id: filePath,
        label: filePath.split('/').pop() || filePath,
        fullPath: filePath,
        type,
        nodeSize,
        borderColor: config.border,
        bgColor: config.bg,
        inDegree: Number(metrics.inDegree) || 0,
        loc: Number(metrics.loc) || 0,
        parent: getClusterId(type),
      },
    });
  });

  visibleFiles.forEach((source) => {
    const dependencies = Array.isArray(graph[source]?.deps) ? graph[source].deps : [];

    dependencies.forEach((target) => {
      if (!visibleSet.has(target) || source === target) return;

      elements.push({
        data: {
          id: `${source}→${target}`,
          source,
          target,
          count: 1,
        },
      });
    });
  });

  return elements;
}

export function computeLocalImpact(selectedFile, graph) {
  if (!selectedFile || !graph || typeof graph !== 'object') {
    return { direct: new Set(), transitive: new Set() };
  }

  const reverseAdjacency = new Map();

  Object.entries(graph).forEach(([filePath, entry]) => {
    const dependencies = Array.isArray(entry?.deps) ? entry.deps : [];
    dependencies.forEach((dependency) => {
      if (!reverseAdjacency.has(dependency)) {
        reverseAdjacency.set(dependency, new Set());
      }

      reverseAdjacency.get(dependency).add(filePath);
    });
  });

  const forwardDeps = new Set(Array.isArray(graph[selectedFile]?.deps) ? graph[selectedFile].deps : []);
  const reverseDeps = reverseAdjacency.get(selectedFile) || new Set();
  const direct = new Set([...forwardDeps, ...reverseDeps]);
  const visited = new Set([selectedFile, ...direct]);
  const queue = [...direct];
  const transitive = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const currentForward = Array.isArray(graph[current]?.deps) ? graph[current].deps : [];
    const currentReverse = reverseAdjacency.get(current) || new Set();

    [...currentForward, ...currentReverse].forEach((neighbor) => {
      if (visited.has(neighbor)) return;
      visited.add(neighbor);
      transitive.add(neighbor);
      queue.push(neighbor);
    });
  }

  return { direct, transitive };
}

export function buildCyStylesheet() {
  return [
    {
      selector: 'node.cluster-parent',
      style: {
        shape: 'round-rectangle',
        'background-opacity': 0.04,
        'border-width': '1.5px',
        'border-style': 'dashed',
        'border-color': 'data(borderColor)',
        'background-color': 'data(bgColor)',
        label: 'data(label)',
        'text-valign': 'top',
        'text-halign': 'center',
        'font-size': '11px',
        'font-weight': 'bold',
        'font-family': 'monospace',
        color: 'data(borderColor)',
        padding: '40px',
        'min-width': '120px',
        'min-height': '80px',
        'compound-sizing-wrt-labels': 'include',
      },
    },
    {
      selector: 'node[type != "cluster"]',
      style: {
        shape: 'round-rectangle',
        width: 'data(nodeSize)',
        height: 'data(nodeSize)',
        'background-opacity': 0,
        'border-width': '1.5px',
        'border-color': 'data(borderColor)',
        label: '',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'font-size': '8px',
        'font-family': 'monospace',
        color: '#94a3b8',
        'text-margin-y': '4px',
        'overlay-opacity': 0,
      },
    },
    { selector: 'node.show-label', style: { label: 'data(label)' } },
    {
      selector: 'edge',
      style: {
        width: 'mapData(count, 1, 5, 1.2, 3.5)',
        'line-color': '#2563eb',
        'target-arrow-color': '#2563eb',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        opacity: 0.45,
      },
    },
    { selector: 'node.selected', style: { 'border-width': '3px', 'border-color': '#ef4444', 'overlay-color': '#ef4444', 'overlay-opacity': 0.08 } },
    { selector: 'node.direct-impact', style: { 'border-width': '3px', 'border-color': '#f97316', 'overlay-color': '#f97316', 'overlay-opacity': 0.08 } },
    { selector: 'node.transitive-impact', style: { 'border-width': '2px', 'border-color': '#eab308', 'overlay-color': '#eab308', 'overlay-opacity': 0.06 } },
    { selector: 'node.search-match', style: { 'border-width': '3px', 'border-color': '#38bdf8', 'overlay-color': '#38bdf8', 'overlay-opacity': 0.06 } },
    { selector: 'node.dimmed', style: { opacity: 0.15 } },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
  ];
}