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
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) return reject(error);
      return resolve();
    });
  });

  await redisClient.quit();
  await pgPool.end();
});

test('GET /api/ai/queries requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/ai/queries`);
  assert.equal(response.status, 401);

  const payload = await response.json();
  assert.equal(payload.error, 'Authentication required.');
});

test('GET /api/ai/queries returns paginated history for authenticated owner and job', async () => {
  const userId = '8bb61d2f-0655-4db0-8c12-02dbf8b9e101';
  const repositoryId = '6b11f568-473f-4974-a14d-ad3f15ff53bf';
  const jobId = 'c77a0f11-208a-4c8d-a7dd-e525f9685f70';

  const token = jwt.sign(
    {
      id: userId,
      username: 'integration-user',
      email: 'integration@example.com',
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );

  await pgPool.query(
    `
      INSERT INTO users (id, username, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [userId, 'integration-user', 'integration@example.com'],
  );

  await pgPool.query(
    `
      INSERT INTO repositories (id, owner_id, source, full_name)
      VALUES ($1, $2, 'local', 'integration/repo')
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
      INSERT INTO saved_queries (user_id, job_id, question, answer, highlights, confidence, created_at)
      VALUES
        ($1, $2, 'How is auth wired?', 'Auth explanation', '["src/auth/index.js"]'::jsonb, 'high', NOW() - INTERVAL '10 minutes'),
        ($1, $2, 'Which files depend on graph?', 'Dependency answer', '["src/features/graph/GraphView.jsx"]'::jsonb, 'medium', NOW() - INTERVAL '2 minutes')
    `,
    [userId, jobId],
  );

  try {
    const response = await fetch(
      `${baseUrl}/api/ai/queries?jobId=${encodeURIComponent(jobId)}&page=1&limit=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.page, 1);
    assert.equal(payload.limit, 20);
    assert.equal(Array.isArray(payload.queries), true);
    assert.equal(payload.queries.length, 2);
    assert.equal(payload.queries[0].question, 'Which files depend on graph?');
    assert.equal(payload.queries[1].question, 'How is auth wired?');
    assert.deepEqual(payload.queries[0].highlights, ['src/features/graph/GraphView.jsx']);
  } finally {
    await pgPool.query('DELETE FROM saved_queries WHERE user_id = $1 AND job_id = $2', [userId, jobId]);
    await pgPool.query('DELETE FROM analysis_jobs WHERE id = $1', [jobId]);
    await pgPool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pgPool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});
