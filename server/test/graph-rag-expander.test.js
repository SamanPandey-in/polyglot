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

test('GraphRagExpander delegates to graph repository context retrieval', async () => {
  const repo = {
    async getContextForQuery(jobId, seedPaths, options) {
      assert.equal(jobId, 'job-neo');
      assert.deepEqual(seedPaths, ['src/api/users.js']);
      assert.deepEqual(options, { maxFiles: 3, seedLimit: 1 });
      return [
        {
          filePath: 'src/api/users.js',
          relationships: [{ type: 'EXPOSES_API', target: '/users' }],
        },
        {
          filePath: 'src/db/users.sql',
          relationships: [],
        },
      ];
    },
  };

  const expander = new GraphRagExpander(repo);
  const paths = await expander.expand(['src/api/users.js'], 'job-neo', {
    maxExpanded: 3,
    seedLimit: 1,
  });
  const context = await expander.getEnrichedContext(['src/api/users.js'], 'job-neo', {
    maxFiles: 3,
    seedLimit: 1,
  });

  assert.deepEqual(paths, ['src/api/users.js', 'src/db/users.sql']);
  assert.equal(context[0].relationships[0].type, 'EXPOSES_API');
});
