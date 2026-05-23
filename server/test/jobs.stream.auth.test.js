import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/polyglot';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

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

test('GET /api/jobs/:jobId/stream requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/jobs/non-existent-job/stream`);
  assert.equal(response.status, 401);

  const payload = await response.json();
  assert.equal(payload.error, 'Authentication required.');
});

test('GET /api/jobs/:jobId/stream only allows owner access', async () => {
  const ownerId = '2d390801-1e29-4ef7-846f-3da7df0ec101';
  const otherUserId = 'f663e0fd-11a9-49aa-a1ff-4f978854c102';
  const repositoryId = '69770f5f-0f5e-4f62-b15d-6d198efef103';
  const jobId = 'ef2b2093-f421-4f2e-b32f-29de662f8104';

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3), ($4, $5, $6)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      ownerId,
      'stream-owner',
      'stream-owner@example.com',
      otherUserId,
      'stream-other',
      'stream-other@example.com',
    ],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'jobs/stream-owner-repo')
        ON CONFLICT DO NOTHING
    `,
    [repositoryId, ownerId],
  );

  await pgPool.query(
    `
      INSERT INTO analysis_jobs (id, repository_id, user_id, status)
      VALUES ($1, $2, $3, 'queued')
      ON CONFLICT (id) DO NOTHING
    `,
    [jobId, repositoryId, ownerId],
  );

  try {
    const otherUserToken = jwt.sign({ id: otherUserId }, process.env.JWT_SECRET);
    const response = await fetch(`${baseUrl}/api/jobs/${jobId}/stream`, {
      headers: {
        Authorization: `Bearer ${otherUserToken}`,
      },
    });

    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error, 'Job not found.');
  } finally {
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerId, otherUserId]);
  }
});
