import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ParserAgent } from '../ParserAgent.js';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('ParserAgent', () => {
  it('routes Python and Go files to dedicated workers', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'polyglot-vitest-parser-'));
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
        'func (s Service) Handle() {',
        '  fmt.Println("ok")',
        '}',
      ].join('\n'),
      'utf8',
    );

    const parser = new ParserAgent();

    const result = await parser.process(
      {
        extractedPath: rootDir,
        manifest: [
          { absolutePath: pyPath, relativePath: 'service.py' },
          { absolutePath: goPath, relativePath: 'service.go' },
        ],
      },
      { jobId: 'job-parser' },
    );

    expect(result.status).toBe('success');
    expect(result.data.parsedFiles).toHaveLength(2);

    const pyResult = result.data.parsedFiles.find((entry) => entry.relativePath === 'service.py');
    const goResult = result.data.parsedFiles.find((entry) => entry.relativePath === 'service.go');

    expect(pyResult.parseError).toBe(null);
    expect(pyResult.imports).toEqual(['./pkg', 'requests']);
    expect(pyResult.declarations.some((entry) => entry.name === 'login' && entry.kind === 'function')).toBe(true);

    expect(goResult.parseError).toBe(null);
    expect(goResult.imports).toEqual(['fmt', 'net/http']);
    expect(goResult.declarations.some((entry) => entry.name === 'Handle' && entry.kind === 'function')).toBe(true);
  });
});
