import path from 'path';
import { readFile } from 'fs/promises';
import pLimit from 'p-limit';
import { BaseAgent } from '../core/BaseAgent.js';
import { scoreRelationshipExtractor } from '../core/confidence.js';

const EXPOSES_API_RE = /\.(get|post|put|patch|delete|head|options)\s*\(\s*['"`]([^'"` \t]+)/gi;
const SPRING_MAPPING_RE = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)/gi;
const FLASK_ROUTE_RE = /@(?:app|bp|blueprint)\.route\s*\(\s*['"]([^'"]+)/gi;
const FASTAPI_ROUTE_RE = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)/gi;

const FETCH_RE = /\bfetch\s*\(\s*['"`]([^'"` \t]+)/g;
const AXIOS_RE = /axios\.(?:get|post|put|delete|patch)\s*\(\s*['"`]([^'"` \t]+)/g;
const REQUESTS_RE = /requests\.(?:get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)/g;
const HTTP_RE = /http(?:s)?\.request\s*\(\s*\{[^}]*path:\s*['"]([^'"]+)/g;

const SQL_SELECT_RE = /(?:FROM|JOIN)\s+(\w+)/gi;
const SQL_INSERT_RE = /INSERT\s+INTO\s+(\w+)/gi;
const SQL_UPDATE_RE = /UPDATE\s+(\w+)\s+SET/gi;

const PRISMA_FIELD_RE = /\.\s*(\w+)\s*:/g;
const KNEX_FIELD_RE = /\.where\s*\(\s*['"](\w+)['"]/g;

const EMIT_RE = /(?:emit|publish|dispatch|trigger)\s*\(\s*['"`]([^'"` \t]+)/g;
const LISTEN_RE = /(?:\.on|\.subscribe|\.addEventListener)\s*\(\s*['"`]([^'"` \t]+)/g;

function extractPatterns(content, regex) {
  const results = [];
  const local = new RegExp(regex.source, regex.flags);
  let match;
  while ((match = local.exec(content)) !== null) {
    const value = match[2] || match[1];
    if (value) results.push(value);
  }
  return [...new Set(results)];
}

function addEdge(acc, dedupe, source, target, type, meta = {}) {
  const key = `${source}|${target}|${type}`;
  if (dedupe.has(key)) return;
  dedupe.add(key);
  const edge = { source, target, type };
  if (meta && typeof meta === 'object') {
    if (meta.source_lines) edge.source_lines = meta.source_lines;
    if (meta.target_lines) edge.target_lines = meta.target_lines;
  }
  acc.push(edge);
}

async function classifyFile(absolutePath, relativePath, parsedNode, fileFunctionNodes = []) {
  const ext = path.extname(absolutePath).toLowerCase();
  const typedEdges = [];
  const dedupe = new Set();
  let content = '';
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch {
    // leave content empty if file read fails
    content = '';
  }

  for (const dep of parsedNode?.deps || []) {
    try {
      const idx = content.indexOf(dep);
      let srcLines = null;
      if (idx >= 0) {
        const start = content.slice(0, idx).split('\n').length;
        srcLines = [start, start];
      }
      addEdge(typedEdges, dedupe, relativePath, dep, 'IMPORTS', { source_lines: srcLines });
    } catch (e) {
      addEdge(typedEdges, dedupe, relativePath, dep, 'IMPORTS');
    }
  }
  for (const fn of Array.isArray(fileFunctionNodes) ? fileFunctionNodes : []) {
    const fnBody = fn?.bodySource || null;
    for (const callee of fn?.calls || []) {
      try {
        let srcLines = null;
        if (fnBody && fnBody.length > 0) {
          const bodyIndex = content.indexOf(fnBody);
          if (bodyIndex >= 0) {
            const idxInBody = fnBody.indexOf(callee);
            if (idxInBody >= 0) {
              const absoluteOffset = bodyIndex + idxInBody;
              const startLine = content.slice(0, absoluteOffset).split('\n').length;
              srcLines = [startLine, startLine];
            }
          }
        }

        // Fallback: search whole file for callee occurrence
        if (!srcLines) {
          const idx = content.indexOf(callee);
          if (idx >= 0) {
            const start = content.slice(0, idx).split('\n').length;
            srcLines = [start, start];
          }
        }

        addEdge(typedEdges, dedupe, relativePath, `symbol:${callee}`, 'CALLS', { source_lines: srcLines });
      } catch (e) {
        addEdge(typedEdges, dedupe, relativePath, `symbol:${callee}`, 'CALLS');
      }
    }
  }

  const routes = [
    ...extractPatterns(content, EXPOSES_API_RE),
    ...extractPatterns(content, SPRING_MAPPING_RE),
    ...extractPatterns(content, FLASK_ROUTE_RE),
    ...extractPatterns(content, FASTAPI_ROUTE_RE),
  ];
  for (const route of routes) {
    addEdge(typedEdges, dedupe, relativePath, `api:${route}`, 'EXPOSES_API');
  }

  const apiCalls = [
    ...extractPatterns(content, FETCH_RE),
    ...extractPatterns(content, AXIOS_RE),
    ...extractPatterns(content, REQUESTS_RE),
    ...extractPatterns(content, HTTP_RE),
  ].filter((url) => url.startsWith('/') || url.startsWith('http'));
  for (const url of apiCalls) {
    addEdge(typedEdges, dedupe, relativePath, `api:${url}`, 'CONSUMES_API');
  }

  if (['.sql', '.py', '.java', '.go', '.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
    const tables = [
      ...extractPatterns(content, SQL_SELECT_RE),
      ...extractPatterns(content, SQL_INSERT_RE),
      ...extractPatterns(content, SQL_UPDATE_RE),
    ].filter((table) => table.length > 1 && !/^(from|where|join|select|and|or|not|null|true|false)$/i.test(table));
    for (const table of tables) {
      addEdge(typedEdges, dedupe, relativePath, `table:${table}`, 'USES_TABLE');
    }

    const fields = [
      ...extractPatterns(content, PRISMA_FIELD_RE),
      ...extractPatterns(content, KNEX_FIELD_RE),
    ];
    for (const field of fields) {
      addEdge(typedEdges, dedupe, relativePath, `field:${field}`, 'USES_FIELD');
    }
  }

  const events = extractPatterns(content, EMIT_RE);
  for (const eventName of events) {
    addEdge(typedEdges, dedupe, relativePath, `event:${eventName}`, 'EMITS_EVENT');
  }

  const listeners = extractPatterns(content, LISTEN_RE);
  for (const eventName of listeners) {
    addEdge(typedEdges, dedupe, relativePath, `event:${eventName}`, 'LISTENS_EVENT');
  }

  return typedEdges;
}

export class RelationshipExtractorAgent extends BaseAgent {
  agentId = 'relationship-extractor-agent';
  maxRetries = 1;
  timeoutMs = 120_000;

  async process(input, context) {
    const start = Date.now();
    const graph = input?.graph || {};
    const functionNodes = input?.functionNodes || {};
    const extractedPath = input?.extractedPath || '';
    const entries = Object.entries(graph);

    if (entries.length === 0) {
      return this.buildResult({
        jobId: context?.jobId,
        status: 'failed',
        confidence: 0,
        data: {},
        errors: [{ code: 400, message: 'RelationshipExtractorAgent requires a non-empty graph.' }],
        warnings: [],
        metrics: {},
        processingTimeMs: Date.now() - start,
      });
    }

    const limit = pLimit(8);
    const allEdges = [];
    const typeCounts = {};

    const results = await Promise.all(
      entries.map(([filePath, node]) =>
        limit(async () => {
          const absolute = extractedPath ? path.join(extractedPath, filePath) : filePath;
          return classifyFile(absolute, filePath, node, functionNodes[filePath]);
        }),
      ),
    );

    for (const fileEdges of results) {
      for (const edge of fileEdges) {
        allEdges.push(edge);
        typeCounts[edge.type] = (typeCounts[edge.type] || 0) + 1;
      }
    }

    const filesWithEdges = results.filter((edgesForFile) => edgesForFile.length > 0).length;
    const confidence = scoreRelationshipExtractor({
      filesWithEdges,
      totalFiles: entries.length,
    });

    return this.buildResult({
      jobId: context?.jobId,
      status: 'success',
      confidence,
      data: { typedEdges: allEdges, typeCounts },
      errors: [],
      warnings: [],
      metrics: { totalEdges: allEdges.length, filesWithEdges, typeCounts },
      processingTimeMs: Date.now() - start,
    });
  }
}
