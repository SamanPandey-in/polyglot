import { readFile } from 'fs/promises';
import { parentPort, workerData } from 'worker_threads';
import { parse } from '@babel/parser';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);

  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object') walk(child, visit);
      }
      continue;
    }
    if (value && typeof value === 'object') {
      walk(value, visit);
    }
  }
}

function pushDeclaration(declarations, seen, name, kind) {
  if (!name) return;
  const key = `${kind}:${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  declarations.push({ name, kind });
}

function declarationNameFromNode(node) {
  if (node?.type === 'Identifier') return node.name;
  return null;
}

function collectCallsInNode(node, declarationNames, selfName = null) {
  if (!node) return [];

  const calls = new Set();

  walk(node, (current) => {
    let calledName = null;

    if (current.type === 'CallExpression' || current.type === 'OptionalCallExpression') {
      if (current.callee?.type === 'Identifier') {
        calledName = current.callee.name;
      } else if (
        current.callee?.type === 'MemberExpression' &&
        !current.callee.computed &&
        current.callee.property?.type === 'Identifier'
      ) {
        calledName = current.callee.property.name;
      }
    }

    if (
      !calledName &&
      current.type === 'NewExpression' &&
      current.callee?.type === 'Identifier'
    ) {
      calledName = current.callee.name;
    }

    if (!calledName) return;
    if (!declarationNames.has(calledName)) return;
    if (selfName && calledName === selfName) return;

    calls.add(calledName);
  });

  return [...calls];
}

function declarationLoc(node) {
  const start = node?.loc?.start?.line;
  const end = node?.loc?.end?.line;

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(1, end - start + 1);
}

function pushFunctionNode(functionNodes, seenNames, declarationNames, { name, kind, body, locNode }) {
  if (!name) return;
  if (seenNames.has(name)) return;

  seenNames.add(name);

  let bodySource = null;
  try {
    const start = locNode?.loc?.start?.line;
    const end = locNode?.loc?.end?.line;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const lines = code.split(/\r?\n/);
      bodySource = lines.slice(start - 1, end).join('\n');
    }
  } catch (e) {
    bodySource = null;
  }

  functionNodes.push({
    name,
    kind,
    calls: collectCallsInNode(body, declarationNames, name),
    loc: declarationLoc(locNode),
    bodySource,
  });
}

function extractFromAst(ast) {
  const imports = [];
  const declarations = [];
  const seenDecl = new Set();
  const declarationNames = new Set();
  const functionNodes = [];
  const seenFunctionNames = new Set();

  walk(ast, (node) => {
    if (node.type === 'ImportDeclaration' && typeof node.source?.value === 'string') {
      imports.push(node.source.value);
    }

    if (
      (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      typeof node.source?.value === 'string'
    ) {
      imports.push(node.source.value);
    }

    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments?.length === 1 &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      imports.push(node.arguments[0].value);
    }

    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      pushDeclaration(declarations, seenDecl, node.id.name, 'function');
      declarationNames.add(node.id.name);
    }

    if (node.type === 'ClassDeclaration' && node.id?.name) {
      pushDeclaration(declarations, seenDecl, node.id.name, 'class');
      declarationNames.add(node.id.name);
    }

    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
      pushDeclaration(declarations, seenDecl, node.id.name, 'variable');
      declarationNames.add(node.id.name);
    }

    if (node.type === 'TSInterfaceDeclaration' && node.id?.name) {
      pushDeclaration(declarations, seenDecl, node.id.name, 'interface');
      declarationNames.add(node.id.name);
    }

    if (node.type === 'TSTypeAliasDeclaration' && node.id?.name) {
      pushDeclaration(declarations, seenDecl, node.id.name, 'type');
      declarationNames.add(node.id.name);
    }
  });

  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      pushFunctionNode(functionNodes, seenFunctionNames, declarationNames, {
        name: node.id.name,
        kind: 'function',
        body: node.body,
        locNode: node,
      });
      return;
    }

    if (node.type === 'ClassDeclaration' && node.id?.name) {
      pushFunctionNode(functionNodes, seenFunctionNames, declarationNames, {
        name: node.id.name,
        kind: 'class',
        body: node.body,
        locNode: node,
      });
      return;
    }

    if (node.type !== 'VariableDeclarator') return;

    const name = declarationNameFromNode(node.id);
    if (!name) return;

    const init = node.init;
    if (!init) return;

    if (init.type === 'ArrowFunctionExpression') {
      pushFunctionNode(functionNodes, seenFunctionNames, declarationNames, {
        name,
        kind: 'arrow',
        body: init.body,
        locNode: init.loc ? init : node,
      });
      return;
    }

    if (init.type === 'FunctionExpression') {
      pushFunctionNode(functionNodes, seenFunctionNames, declarationNames, {
        name,
        kind: 'function',
        body: init.body,
        locNode: init.loc ? init : node,
      });
    }
  });

  return { imports, declarations, functionNodes };
}

async function run() {
  const { filePath, relativePath } = workerData;
  const code = await readFile(filePath, 'utf8');

  const ast = parse(code, {
    sourceType: 'module',
    errorRecovery: true,
    plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties', 'dynamicImport'],
  });

  const { imports, declarations, functionNodes } = extractFromAst(ast);

  return {
    relativePath,
    imports,
    declarations,
    functionNodes,
    rawContent: code,
    metrics: {
      loc: code.split(/\r?\n/).length,
      importCount: imports.length,
      declarationCount: declarations.length,
    },
    parseError: null,
  };
}

run()
  .then((result) => {
    parentPort.postMessage(result);
  })
  .catch((error) => {
    parentPort.postMessage({
      relativePath: workerData.relativePath,
      imports: [],
      declarations: [],
      metrics: {},
      parseError: error.message,
    });
  });
