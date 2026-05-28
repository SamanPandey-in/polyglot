import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';

import analyzeRouter from '../src/analyze/routes/analyze.routes.js';

describe('createPrCommitController', () => {
  let app;
  let server;

  beforeEach(() => {
    app = express();
    app.use(bodyParser.json());
    app.use(cookieParser());
    app.use('/api/analyze', analyzeRouter);
    server = http.createServer(app);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    server.close();
  });

  it('creates branch, uploads file, and creates PR (happy path)', async () => {
    const responses = [];

    // 1) GET head ref -> 404 (not found)
    responses.push({ ok: false, status: 404, text: async () => '' });
    // 2) GET base ref -> returns object.sha
    responses.push({ ok: true, status: 200, json: async () => ({ object: { sha: 'base-sha-123' } }) });
    // 3) POST create ref -> created
    responses.push({ ok: true, status: 201, json: async () => ({ ref: 'refs/heads/new-branch' }) });
    // 4) PUT file -> file content + commit
    responses.push({ ok: true, status: 201, json: async () => ({ content: { path: 'file.txt', sha: 'file-sha' }, commit: { sha: 'commit-sha' } }) });
    // 5) POST PR -> PR created
    responses.push({ ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/pr/1', number: 1 }) });

    const mockFetch = vi.fn(async () => {
      const r = responses.shift();
      return r;
    });

    global.fetch = mockFetch;

    await new Promise((res) => server.listen(0, res));
    const { port } = server.address();
    const baseUrl = `http://localhost:${port}`;

    const payload = {
      owner: 'octo',
      repo: 'repo',
      path: 'file.txt',
      content: 'hello',
      base: 'main',
      head: 'feature-branch',
      commitMessage: 'update file',
      prTitle: 'Update file',
      prBody: 'Please merge',
    };

    const res = await fetch(`${baseUrl}/api/analyze/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'github_token=test-token' },
      body: JSON.stringify(payload),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.prUrl).toBe('https://github.com/pr/1');
    expect(mockFetch).toHaveBeenCalled();
  });
});
