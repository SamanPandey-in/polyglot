import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/polyglot';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
delete process.env.OPENAI_API_KEY;
delete process.env.AI_API_KEY;

let app;
let pgPool;
let redisClient;
let server;
let baseUrl;

async function settleWithTimeout(promise, timeoutMs = 3000) {
  let timer;

  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

before(async () => {
  ({ default: app } = await import('../app.js'));
  ({ pgPool, redisClient } = await import('../src/infrastructure/connections.js'));

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });

  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await settleWithTimeout(
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) return reject(error);
        return resolve();
      });
    }),
  );

  await settleWithTimeout(redisClient.quit());
  await settleWithTimeout(pgPool.end());
});

test('POST /api/ai/snippet-impact requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/ai/snippet-impact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jobId: 'job-1',
      filePath: 'src/file.js',
      snippet: 'const x = 1;',
    }),
  });

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, 'Authentication required.');
});

test('POST /api/ai/snippet-impact validates required fields', async () => {
  const userId = '63a501be-d0e4-4570-a32d-7d8c61b65f31';
  const token = jwt.sign({ id: userId, username: 'snippet-user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'snippet-user', 'snippet@example.com'],
  );

  try {
    const response = await fetch(`${baseUrl}/api/ai/snippet-impact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jobId: 'job-1',
        filePath: 'src/file.js',
      }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'jobId, filePath, and snippet are required.');
  } finally {
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('POST /api/ai/snippet-impact returns 503 when AI provider is not configured', async () => {
  const userId = '9db9aabd-6818-445a-a361-6203c2f39c85';
  const repositoryId = 'dc9e2364-7a26-4f3f-9496-9f9070ec748f';
  const jobId = '38759f8c-e63e-49c4-ab95-c9fce4f31550';
  const token = jwt.sign({ id: userId, username: 'snippet-user-2' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'snippet-user-2', 'snippet2@example.com'],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'snippet/repo')
      ON CONFLICT DO NOTHING
    `,
    [repositoryId, userId],
  );

  await pgPool.query(
    `
      INSERT INTO analysis_jobs (id, repository_id, user_id, status)
      VALUES ($1, $2, $3, 'completed')
      ON CONFLICT (id) DO NOTHING
    `,
    [jobId, repositoryId, userId],
  );

  await pgPool.query(
    `
      INSERT INTO graph_nodes (job_id, file_path, file_type, declarations, metrics, summary)
      VALUES
        ($1, 'src/file-a.js', 'module', '[{"name":"runA"}]'::jsonb, '{"loc": 20, "inDegree": 1, "outDegree": 1}'::jsonb, 'Main unit'),
        ($1, 'src/file-b.js', 'module', '[{"name":"runB"}]'::jsonb, '{"loc": 42, "inDegree": 0, "outDegree": 0}'::jsonb, 'Dependent unit')
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    [jobId],
  );

  await pgPool.query(
    `
      INSERT INTO graph_edges (job_id, source_path, target_path, edge_type)
      VALUES ($1, 'src/file-b.js', 'src/file-a.js', 'import')
      ON CONFLICT DO NOTHING
    `,
    [jobId],
  );

  try {
    const response = await fetch(`${baseUrl}/api/ai/snippet-impact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jobId,
        filePath: 'src/file-a.js',
        snippet: 'export function runA() { return 1; }',
        lineStart: 1,
        lineEnd: 1,
      }),
    });

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'AI provider is not configured.');
  } finally {
    await pgPool.query('DELETE FROM graph_edges WHERE job_id = $1', [jobId]);
    await pgPool.query('DELETE FROM graph_nodes WHERE job_id = $1', [jobId]);
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});