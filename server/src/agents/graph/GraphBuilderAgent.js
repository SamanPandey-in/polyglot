import path from "path";
import { existsSync } from "fs";
import { BaseAgent } from "../core/BaseAgent.js";
import { scoreGraphBuilder } from "../core/confidence.js";

const RESOLVE_EXTS = [".js", ".ts", ".jsx", ".tsx", ".py", ".go"];

function inferFileType(relPath) {
  const normalized = relPath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const filename = segments[segments.length - 1] || "";

  if (segments.some((s) => s === "components" || s === "component"))
    return "component";
  if (segments.some((s) => s === "pages" || s === "views" || s === "screens"))
    return "page";
  if (segments.some((s) => s === "hooks")) return "hook";
  if (segments.some((s) => s === "services" || s === "api" || s === "apis"))
    return "service";
  if (segments.some((s) => s === "utils" || s === "helpers" || s === "lib"))
    return "util";
  if (/config|\.conf\.|\.rc\./.test(filename)) return "config";
  return "module";
}

function normalizeRelative(filePath, rootDir) {
  return path.relative(rootDir, filePath).replace(/\\/g, "/");
}

function resolveToAbsolute(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const base = path.resolve(path.dirname(fromFile), specifier);

  if (path.extname(base) && existsSync(base)) return base;

  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate)) return candidate;
  }

  for (const ext of RESOLVE_EXTS) {
    const candidate = path.join(base, "index" + ext);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function isLocalSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    (specifier.startsWith(".") || specifier.startsWith("/"))
  );
}

function findStronglyConnectedComponents(adjacency) {
  const ids = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  let id = 0;
  const sccs = [];

  const dfs = (at) => {
    ids.set(at, id);
    low.set(at, id);
    id += 1;

    stack.push(at);
    onStack.add(at);

    for (const to of adjacency.get(at) || []) {
      if (!ids.has(to)) {
        dfs(to);
        low.set(at, Math.min(low.get(at), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(at, Math.min(low.get(at), ids.get(to)));
      }
    }

    if (ids.get(at) === low.get(at)) {
      const component = [];
      while (stack.length) {
        const node = stack.pop();
        onStack.delete(node);
        component.push(node);
        if (node === at) break;
      }
      sccs.push(component);
    }
  };

  for (const node of adjacency.keys()) {
    if (!ids.has(node)) dfs(node);
  }

  return sccs;
}

export class GraphBuilderAgent extends BaseAgent {
  agentId = "graph-builder-agent";
  maxRetries = 1;
  timeoutMs = 180_000;

  async process(input, context) {
    const start = Date.now();
    const errors = [];
    const warnings = [];

    const rootDir = input?.extractedPath || input?.rootDir;
    const parsedFiles = Array.isArray(input?.parsedFiles)
      ? input.parsedFiles
      : [];

    if (!rootDir || parsedFiles.length === 0) {
      return this.buildResult({
        jobId: context?.jobId,
        status: "failed",
        confidence: 0,
        data: {},
        errors: [
          {
            code: 400,
            message:
              "GraphBuilderAgent requires extractedPath/rootDir and parsedFiles.",
          },
        ],
        warnings,
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    const graph = {};
    const functionNodes = {};
    const adjacency = new Map();
    const reverse = new Map();
    const edges = [];
    const knownFiles = new Set(parsedFiles.map((f) => f.relativePath));

    let totalImportSpecifiers = 0;
    let localImportSpecifiers = 0;
    let externalImportSpecifiers = 0;
    let resolvedEdges = 0;
    let unresolvedLocalImports = 0;

    for (const parsed of parsedFiles) {
      const source = parsed.relativePath;
      const sourceAbs = path.join(rootDir, source);

      const resolvedDeps = [];
      for (const specifier of parsed.imports || []) {
        totalImportSpecifiers += 1;
        if (!isLocalSpecifier(specifier)) {
          externalImportSpecifiers += 1;
          continue;
        }

        localImportSpecifiers += 1;
        const abs = resolveToAbsolute(sourceAbs, specifier);
        if (!abs) {
          unresolvedLocalImports += 1;
          continue;
        }

        const rel = normalizeRelative(abs, rootDir);
        if (!knownFiles.has(rel)) {
          unresolvedLocalImports += 1;
          continue;
        }

        resolvedEdges += 1;
        resolvedDeps.push(rel);
      }

      const deps = [...new Set(resolvedDeps)];

      graph[source] = {
        deps,
        type: inferFileType(source),
        declarations: parsed.declarations || [],
        metrics: {
          ...(parsed.metrics || {}),
          inDegree: 0,
          outDegree: deps.length,
        },
      };

      functionNodes[source] = Array.isArray(parsed.functionNodes)
        ? parsed.functionNodes
        : [];

      adjacency.set(source, deps);
      if (!reverse.has(source)) reverse.set(source, []);

      for (const dep of deps) {
        if (!reverse.has(dep)) reverse.set(dep, []);
        reverse.get(dep).push(source);

        edges.push({
          source,
          target: dep,
          type: "import",
        });
      }
    }

    for (const [node, incoming] of reverse.entries()) {
      if (!graph[node]) continue;
      graph[node].metrics.inDegree = incoming.length;
    }

    const sccs = findStronglyConnectedComponents(adjacency);
    const cycles = sccs.filter((component) => component.length > 1);
    const relationshipTypeCount = new Set(
      edges.map((edge) => edge.type).filter(Boolean),
    ).size;
    const largestCycleSize = cycles.reduce(
      (max, component) => Math.max(max, component.length),
      0,
    );

    const topology = {
      nodeCount: Object.keys(graph).length,
      edgeCount: edges.length,
      cyclesDetected: cycles.length,
      cycles,
      relationshipTypeCount,
      distinctRelationshipTypes: relationshipTypeCount,
      largestCycleSize,
      maxCycleSize: largestCycleSize,
      unresolvedImports: unresolvedLocalImports,
      localImportSpecifiers,
      externalImportSpecifiers,
      deadCodeCandidates: Object.entries(graph)
        .filter(([_, node]) => (node.metrics?.inDegree || 0) === 0)
        .map(([filePath]) => filePath),
    };

    const confidence = scoreGraphBuilder({
      resolvedEdges,
      resolvedLocalEdges: resolvedEdges,
      totalImportSpecifiers,
      localImportSpecifiers,
      cyclesDetected: topology.cyclesDetected,
    });

    return this.buildResult({
      jobId: context?.jobId,
      status: "success",
      confidence,
      data: { graph, edges, topology, functionNodes },
      errors,
      warnings,
      metrics: {
        nodeCount: topology.nodeCount,
        edgeCount: topology.edgeCount,
        resolvedEdges,
        localImportSpecifiers,
        externalImportSpecifiers,
        totalImportSpecifiers,
        cyclesDetected: topology.cyclesDetected,
        unresolvedLocalImports,
      },
      processingTimeMs: Date.now() - start,
    });
  }
}
