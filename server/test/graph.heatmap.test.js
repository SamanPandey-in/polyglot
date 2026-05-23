import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import request from 'supertest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/polyglot';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

let app;
let pgPool;
let redisClient;

async function settleWithTimeout(promise, timeoutMs = 3000) {
  let timer;

  try {
    await Promise.race([
      promise.catch((error) => {
        throw error;
      }),
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
});

after(async () => {
  await settleWithTimeout(redisClient.quit());
  await settleWithTimeout(pgPool.end());
});

test('GET /api/graph/:jobId/heatmap', async () => {
  const userId = '9e4f6d7a-31e1-4d9f-8575-b9e5428eb111';
  const repositoryId = '2c4ef2f5-019e-41fd-b6f1-9652d4a7c222';
  const jobId = '14882a4f-f885-4488-8afb-7b15a2c3d333';

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'heatmap-user', 'heatmap@example.com'],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'heatmap/repo')
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
      INSERT INTO graph_nodes (job_id, file_path, file_type, declarations, metrics)
      VALUES
        ($1, 'src/high-risk.js', 'service', '[]'::jsonb, '{"inDegree": 4, "complexity": 7, "loc": 240}'::jsonb),
        ($1, 'src/medium-risk.js', 'module', '[]'::jsonb, '{"inDegree": 3, "complexity": 3, "loc": 150}'::jsonb),
        ($1, 'src/low-risk.js', 'util', '[]'::jsonb, '{"inDegree": 1, "complexity": 1, "loc": 40}'::jsonb)
      ON CONFLICT (job_id, file_path) DO NOTHING
    `,
    [jobId],
  );

  try {
    const token = jwt.sign({ id: userId }, process.env.JWT_SECRET);
    const authResponse = await request(app)
      .get(`/api/graph/${jobId}/heatmap`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(authResponse.status, 200);

    const authPayload = authResponse.body;
    assert.equal(Array.isArray(authPayload.hotspots), true);
    assert.equal(authPayload.hotspots.length, 3);

    assert.equal(authPayload.hotspots[0].filePath, 'src/high-risk.js');
    assert.equal(authPayload.hotspots[0].riskScore, 28);
    assert.equal(authPayload.hotspots[1].filePath, 'src/medium-risk.js');
    assert.equal(authPayload.hotspots[1].riskScore, 9);
    assert.equal(authPayload.hotspots[2].filePath, 'src/low-risk.js');
    assert.equal(authPayload.hotspots[2].riskScore, 1);

    const unauthResponse = await request(app).get('/api/graph/unknown-job/heatmap');
    assert.equal(unauthResponse.status, 401);

    assert.equal(unauthResponse.body.error, 'Authentication required.');
  } finally {
    await pgPool.query('DELETE FROM graph_nodes WHERE job_id = $1', [jobId]);
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});
