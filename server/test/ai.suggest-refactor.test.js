import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/polyglot';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
delete process.env.OPENAI_API_KEY;

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

test('POST /api/ai/suggest-refactor requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/ai/suggest-refactor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: 'x', filePath: 'src/file.js' }),
  });

  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error, 'Authentication required.');
});

test('POST /api/ai/suggest-refactor validates required fields', async () => {
  const userId = '7a28f1e2-4477-449b-8c89-963b6c4f7111';
  const token = jwt.sign({ id: userId, username: 'refactor-user' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'refactor-user', 'refactor@example.com'],
  );

  try {
    const response = await fetch(`${baseUrl}/api/ai/suggest-refactor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobId: 'job-only' }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'jobId and filePath are required.');
  } finally {
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('POST /api/ai/suggest-refactor returns 404 when file is not part of the graph job', async () => {
  const userId = 'd12f12de-94f9-4330-9414-25f4a4f07222';
  const repositoryId = 'a0f9d493-fb2a-4e89-9f4d-48448a7e4333';
  const jobId = '97ab3bb2-4ef6-4c3a-8df0-f4bf8f91a444';
  const token = jwt.sign({ id: userId, username: 'refactor-user-2' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'refactor-user-2', 'refactor2@example.com'],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'refactor/repo')
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

  try {
    const response = await fetch(`${baseUrl}/api/ai/suggest-refactor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobId, filePath: 'src/missing-file.js' }),
    });

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error, 'File not found.');
  } finally {
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('POST /api/ai/suggest-refactor returns 503 when AI provider is not configured', async () => {
  const userId = '97bcd6cf-eb90-40dc-a429-11eb45422555';
  const repositoryId = '5cd42d0d-e6d3-40dd-966e-5a2d4b0d3666';
  const jobId = '8085b4cb-1718-428e-9694-9e22cfb76777';
  const token = jwt.sign({ id: userId, username: 'refactor-user-3' }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'refactor-user-3', 'refactor3@example.com'],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'refactor/repo-3')
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
      VALUES ($1, 'src/high-risk.js', 'service', '[{"name":"runRisk"}]'::jsonb, '{"loc": 200, "inDegree": 8, "outDegree": 5}'::jsonb, 'Hot path orchestration')
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    [jobId],
  );

  try {
    const response = await fetch(`${baseUrl}/api/ai/suggest-refactor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jobId, filePath: 'src/high-risk.js' }),
    });

    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error, 'AI provider is not configured.');
  } finally {
    await pgPool.query('DELETE FROM graph_nodes WHERE job_id = $1', [jobId]);
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});
