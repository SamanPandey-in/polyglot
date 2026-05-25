import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphRagExpander } from '../src/agents/query/GraphRagExpander.js';

test('GraphRagExpander expands seed files with graph neighbours', async () => {
  const db = {
    async query(sql, params) {
      assert.match(sql, /FROM graph_edges/);
      assert.deepEqual(params[0], ['src/auth/middleware.js']);
      assert.equal(params[1], 'job-1');

      return {
        rows: [
          { neighbour: 'src/auth/routes.js' },
          { neighbour: 'src/auth/controller.js' },
        ],
      };
    },
  };

  const expander = new GraphRagExpander(db);
  const result = await expander.expand(['src/auth/middleware.js', 'src/auth/guards.js'], 'job-1', {
    maxExpanded: 4,
    seedLimit: 1,
  });

  assert.deepEqual(result, [
    'src/auth/middleware.js',
    'src/auth/guards.js',
    'src/auth/routes.js',
    'src/auth/controller.js',
  ]);
});
