import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RelationshipExtractorAgent } from '../RelationshipExtractorAgent.js';

describe('RelationshipExtractorAgent line capture', () => {
  let tmpDir;

  afterEach(async () => {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {}
      tmpDir = null;
    }
  });

  it('captures source_lines for imports and calls when possible', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rel-lines-'));
    const filePath = path.join(tmpDir, 'a.js');
    const content = `import b from './b.js';\n\nfunction a() {\n  b();\n}\n`;
    await fs.writeFile(filePath, content, 'utf8');

    const graph = {
      'a.js': { deps: ["./b.js"] },
    };

    const functionNodes = {
      'a.js': [
        { name: 'a', calls: ['b'], bodySource: 'function a() {\n  b();\n}' },
      ],
    };

    const agent = new RelationshipExtractorAgent();
    const result = await agent.process({ graph, functionNodes, extractedPath: tmpDir }, { jobId: 'test-job' });

    expect(result.status).toBe('success');
    const edges = result.data.typedEdges || [];

    const hasImportWithLines = edges.some((e) => e.type === 'IMPORTS' && Array.isArray(e.source_lines));
    const hasCallWithLines = edges.some((e) => e.type === 'CALLS' && Array.isArray(e.source_lines));

    expect(hasImportWithLines).toBe(true);
    expect(hasCallWithLines).toBe(true);
  });
});
