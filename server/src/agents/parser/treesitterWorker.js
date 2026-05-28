import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { Language, Parser, Query } from 'web-tree-sitter';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const QUERIES = {
  python: {
    imports: `
      (import_statement (dotted_name) @import)
      (import_from_statement module_name: (dotted_name) @import)
    `,
    declarations: `
      (function_definition name: (identifier) @name) @fn
      (class_definition name: (identifier) @name) @cls
    `,
  },
  java: {
    imports: `(import_declaration (scoped_identifier) @import)`,
    declarations: `
      (method_declaration name: (identifier) @name) @fn
      (class_declaration name: (identifier) @name) @cls
      (interface_declaration name: (identifier) @name) @iface
    `,
  },
  go: {
    imports: `(import_spec path: (interpreted_string_literal) @import)`,
    declarations: `
      (function_declaration name: (identifier) @name) @fn
      (type_declaration (type_spec name: (type_identifier) @name)) @type
    `,
  },
  rust: {
    imports: `(use_declaration argument: (_) @import)`,
    declarations: `
      (function_item name: (identifier) @name) @fn
      (struct_item name: (type_identifier) @name) @struct
      (enum_item name: (type_identifier) @name) @enum
    `,
  },
  ruby: {
    imports: `(call method: (identifier) @method (#match? @method "^require")) @import`,
    declarations: `
      (method name: (identifier) @name) @fn
      (singleton_method name: (identifier) @name) @fn
      (class name: (constant) @name) @cls
    `,
  },
  c_sharp: {
    imports: `(using_directive (identifier) @import)`,
    declarations: `
      (method_declaration name: (identifier) @name) @fn
      (class_declaration name: (identifier) @name) @cls
      (interface_declaration name: (identifier) @name) @iface
    `,
  },
  kotlin: {
    imports: `(import_header (identifier) @import)`,
    declarations: `
      (function_declaration (simple_identifier) @name) @fn
      (class_declaration (type_identifier) @name) @cls
    `,
  },
  php: {
    imports: `(include_expression (string) @import)`,
    declarations: `
      (function_definition name: (name) @name) @fn
      (class_declaration name: (name) @name) @cls
    `,
  },
};

function emptyResult(relativePath, parseError) {
  return {
    relativePath,
    imports: [],
    declarations: [],
    functionNodes: [],
    metrics: {},
    parseError,
  };
}

function declarationKindFromCaptures(captures) {
  const marker = captures.find((capture) => capture.name !== 'name' && capture.name !== 'import');
  return marker?.name || 'fn';
}

function resolveWasmPath(language) {
  const wasmFile = `tree-sitter-${language}.wasm`;
  const configuredWasmDir = process.env.PARSER_WASM_DIR;

  const candidates = [
    configuredWasmDir ? path.resolve(configuredWasmDir, wasmFile) : null,
    path.resolve(__dirname, '../../../wasm', wasmFile),
    path.resolve(__dirname, '../../../node_modules/tree-sitter-wasms/out', wasmFile),
    path.resolve(process.cwd(), 'wasm', wasmFile),
    path.resolve(process.cwd(), 'node_modules/tree-sitter-wasms/out', wasmFile),
  ].filter(Boolean);

  const located = candidates.find((candidate) => existsSync(candidate));
  if (located) return located;

  throw new Error(
    `Missing Tree-sitter WASM for ${language}. Looked in: ${candidates.join(', ')}`,
  );
}

async function run() {
  const { filePath, relativePath, language } = workerData;

  if (!filePath || !relativePath || !language) {
    parentPort.postMessage(emptyResult(relativePath || 'unknown', 'Worker missing required filePath, relativePath, or language.'));
    return;
  }

  const queries = QUERIES[language] || { imports: '', declarations: '' };

  await Parser.init();

  const wasmPath = resolveWasmPath(language);
  const lang = await Language.load(wasmPath);

  const parser = new Parser();
  parser.setLanguage(lang);

  const source = await readFile(filePath, 'utf8');
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const imports = [];
  const declarations = [];
  const functionNodes = [];
  const seenImports = new Set();
  const seenDecls = new Set();

  if (queries.imports) {
    const query = new Query(lang, queries.imports);
    for (const match of query.matches(root)) {
      for (const capture of match.captures) {
        if (capture.name !== 'import') continue;
        const value = capture.node.text.replace(/['"]/g, '');
        if (!value || seenImports.has(value)) continue;
        seenImports.add(value);
        imports.push(value);
      }
    }
  }

  if (queries.declarations) {
    const query = new Query(lang, queries.declarations);
    for (const match of query.matches(root)) {
      const kind = declarationKindFromCaptures(match.captures);

      // Find the node capture that represents the whole declaration (e.g., @fn or @cls)
      const markerCapture = match.captures.find((c) => c.name !== 'name' && c.name !== 'import');
      const declNode = markerCapture ? markerCapture.node : null;

      for (const capture of match.captures) {
        if (capture.name !== 'name') continue;

        const name = capture.node.text;
        const key = `${kind}:${name}`;
        if (!name || seenDecls.has(key)) continue;

        seenDecls.add(key);
        declarations.push({ name, kind });

        let loc = null;
        let bodySource = null;
        if (declNode) {
          const startLine = declNode.startPosition.row + 1;
          const endLine = declNode.endPosition.row + 1;
          loc = { startLine, endLine };
          const lines = source.split(/\r?\n/);
          bodySource = lines.slice(startLine - 1, endLine).join('\n');
        }

        functionNodes.push({ name, kind, calls: [], loc, bodySource });
      }
    }
  }

  parentPort.postMessage({
    relativePath,
    imports,
    declarations,
    functionNodes,
    metrics: {
      loc: source.split(/\r?\n/).length,
      importCount: imports.length,
      declarationCount: declarations.length,
    },
    parseError: null,
  });
}

run().catch((error) => {
  parentPort.postMessage(emptyResult(workerData?.relativePath || 'unknown', error.message));
});
