import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import os from 'os';
import path from 'path';
import { PolyglotParserAgent } from '../src/agents/parser/PolyglotParserAgent.js';

const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

test('PolyglotParserAgent parses Python and Go files via tree-sitter worker', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'polyglot-parser-'));
  tempDirs.push(rootDir);

  const pyPath = path.join(rootDir, 'service.py');
  const goPath = path.join(rootDir, 'service.go');

  await mkdir(path.join(rootDir, 'pkg'), { recursive: true });

  await writeFile(
    pyPath,
    [
      'from .pkg import auth',
      'import requests',
      '',
      'class AuthService:',
      '    pass',
      '',
      'async def login(user):',
      '    return user',
    ].join('\n'),
    'utf8',
  );

  await writeFile(
    goPath,
    [
      'package service',
      '',
      'import (',
      '  "fmt"',
      '  alias "net/http"',
      ')',
      '',
      'type Service struct {}',
      '',
      'func Handle() {',
      '  fmt.Println("ok")',
      '}',
    ].join('\n'),
    'utf8',
  );

  const parser = new PolyglotParserAgent();

  const result = await parser.process(
    {
      extractedPath: rootDir,
      manifest: [
        { absolutePath: pyPath, relativePath: 'service.py' },
        { absolutePath: goPath, relativePath: 'service.go' },
      ],
    },
    { jobId: 'test-job' },
  );

  assert.equal(result.status, 'success');
  assert.equal(result.data.parsedFiles.length, 2);

  const pyResult = result.data.parsedFiles.find((file) => file.relativePath === 'service.py');
  assert.ok(pyResult);
  assert.equal(pyResult.parseError, null);
  assert.equal(pyResult.imports.includes('requests'), true);
  assert.equal(pyResult.declarations.some((entry) => entry.name === 'login' && entry.kind === 'fn'), true);
  assert.equal(pyResult.declarations.some((entry) => entry.name === 'AuthService' && entry.kind === 'cls'), true);

  const goResult = result.data.parsedFiles.find((file) => file.relativePath === 'service.go');
  assert.ok(goResult);
  assert.equal(goResult.parseError, null);
  assert.deepEqual(goResult.imports, ['fmt', 'net/http']);
  assert.equal(goResult.declarations.some((entry) => entry.name === 'Handle' && entry.kind === 'fn'), true);
  assert.equal(goResult.declarations.some((entry) => entry.name === 'Service' && entry.kind === 'type'), true);
});
