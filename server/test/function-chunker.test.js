import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FunctionChunker } from '../src/agents/parser/FunctionChunker.js';

test('FunctionChunker embeds in-memory function nodes and writes rows', async () => {
  const inserts = [];
  const db = {
    async query(sql, params) {
      inserts.push({ sql, params });
      return { rows: [] };
    },
  };

  const embeddingClient = {
    isConfigured() {
      return true;
    },
    async createEmbedding({ input }) {
      return {
        data: input.map((_, index) => ({ embedding: [index + 0.1, index + 0.2] })),
      };
    },
  };

  const chunker = new FunctionChunker({ db, embeddingClient });
  const result = await chunker.run('job-1', {
    graph: {
      'src/a.js': { summary: 'Alpha file', type: 'module' },
    },
    functionNodes: {
      'src/a.js': [
        { name: 'first', kind: 'function', calls: [] },
        { name: 'second', kind: 'arrow_function', calls: [{ name: 'helper' }] },
      ],
    },
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 0);
  assert.equal(inserts.length, 2);
  assert.match(inserts[0].sql, /INSERT INTO function_embeddings/);
  assert.deepEqual(inserts[0].params.slice(0, 3), ['job-1', 'src/a.js', 'first']);
});
