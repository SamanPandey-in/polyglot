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

test('GET /api/repositories/cache/metrics requires authentication', async () => {
  const response = await fetch(`${baseUrl}/api/repositories/cache/metrics`);
  assert.equal(response.status, 401);

  const payload = await response.json();
  assert.equal(payload.error, 'Authentication required.');
});

test('GET /api/repositories/cache/metrics returns cache summary for authenticated requests', async () => {
  const token = jwt.sign({ id: 'f2f9b13d-0b65-4ac6-8309-227dd77f6a1a' }, process.env.JWT_SECRET);

  const response = await fetch(`${baseUrl}/api/repositories/cache/metrics`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(typeof payload.generatedAt, 'string');
  assert.equal(typeof payload.redis?.status, 'string');
  assert.equal(typeof payload.redis?.connected, 'boolean');
  assert.equal(typeof payload.summary?.readsTotal, 'number');
  assert.equal(typeof payload.summary?.writesTotal, 'number');
  assert.equal(typeof payload.summary?.invalidationsTotal, 'number');
  assert.equal(
    payload.summary?.hitRatePercent === null || typeof payload.summary?.hitRatePercent === 'number',
    true,
  );
  assert.equal(typeof payload.metrics?.readHit, 'number');
  assert.equal(typeof payload.metrics?.readMiss, 'number');
  assert.equal(typeof payload.metrics?.readError, 'number');
});
