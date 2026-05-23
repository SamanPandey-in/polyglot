import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GraphBuilderAgent } from '../GraphBuilderAgent.js';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('GraphBuilderAgent', () => {
  it('builds file graph and keeps function-level nodes in output', async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), 'polyglot-vitest-graph-'));
    tempDirs.push(rootDir);

    const aFile = path.join(rootDir, 'src', 'a.js');
    const bFile = path.join(rootDir, 'src', 'b.js');

    await mkdir(path.join(rootDir, 'src'), { recursive: true });

    await writeFile(aFile, 'import { b } from "./b";\nexport const a = () => b();\n', 'utf8');
    await writeFile(bFile, 'export const b = () => 1;\n', 'utf8');

    const agent = new GraphBuilderAgent();

    const result = await agent.process(
      {
        extractedPath: rootDir,
        parsedFiles: [
          {
            relativePath: 'src/a.js',
            imports: ['./b'],
            declarations: [{ name: 'a', kind: 'variable' }],
            functionNodes: [{ name: 'a', kind: 'arrow', calls: ['b'], loc: 1 }],
            metrics: { loc: 2 },
          },
          {
            relativePath: 'src/b.js',
            imports: [],
            declarations: [{ name: 'b', kind: 'variable' }],
            functionNodes: [{ name: 'b', kind: 'arrow', calls: [], loc: 1 }],
            metrics: { loc: 1 },
          },
        ],
      },
      { jobId: 'job-graph' },
    );

    expect(result.status).toBe('success');
    expect(result.data.graph['src/a.js'].deps).toEqual(['src/b.js']);
    expect(result.data.edges).toEqual([{ source: 'src/a.js', target: 'src/b.js', type: 'import' }]);
    expect(result.data.functionNodes['src/a.js']).toEqual([
      { name: 'a', kind: 'arrow', calls: ['b'], loc: 1 },
    ]);
  });
});
