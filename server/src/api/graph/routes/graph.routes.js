import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { pgPool } from '../../../infrastructure/connections.js';
import { loadGraphPayloadByJobId } from '../services/graphPayload.service.js';
import { ImpactAnalysisAgent } from '../../../agents/analysis/ImpactAnalysisAgent.js';
import { getAuthUser, isUuid, resolveDatabaseUserId } from '../../../utils/authUser.js';

const router = Router();
const impactAgent = new ImpactAnalysisAgent();

const SHARE_VISIBILITY = new Set(['unlisted', 'public']);

const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many share requests. Please try again later.' },
});

const functionNodesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

function buildShareUrl(token) {
  const baseUrl = String(process.env.CLIENT_URL || 'http://localhost:5173').trim();

  try {
    const url = new URL('/graph', baseUrl);
    url.searchParams.set('share', token);
    return url.toString();
  } catch {
    return `/graph?share=${encodeURIComponent(token)}`;
  }
}

async function ensureOwnedJobAccess(req, res) {
  const authUser = getAuthUser(req);
  if (!authUser?.id) {
    res.status(401).json({ error: 'Authentication required.' });
    return null;
  }

  const userId = await resolveDatabaseUserId(authUser);
  if (!userId) {
    const error = new Error('Failed to resolve authenticated user record.');
    error.statusCode = 500;
    throw error;
  }

  const jobId = String(req.params?.jobId || '').trim();

  if (!isUuid(jobId)) {
    res.status(404).json({ error: 'Analysis job not found.' });
    return null;
  }

  const jobCheck = await pgPool.query(
    `
      SELECT id
      FROM analysis_jobs
      WHERE id = $1 AND user_id = $2
      LIMIT 1
    `,
    [jobId, userId],
  );

  if (jobCheck.rowCount === 0) {
    res.status(404).json({ error: 'Analysis job not found.' });
    return null;
  }

  return { userId, authUser };
}

router.get('/:jobId/functions/*filePath', functionNodesLimiter, async (req, res, next) => {
  const { jobId } = req.params;
  const wildcardPath = req.params.filePath;
  const rawFilePath = String(wildcardPath || '').trim();

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required.' });
  }

  if (!rawFilePath) {
    return res.status(400).json({ error: 'filePath is required.' });
  }

  if (rawFilePath.includes('../') || rawFilePath.includes('..\\')) {
    return res.status(400).json({ error: 'Invalid file path.' });
  }

  let filePath = rawFilePath;

  try {
    filePath = decodeURIComponent(rawFilePath);
  } catch {
    filePath = rawFilePath;
  }

  try {
    const access = await ensureOwnedJobAccess(req, res);
    if (!access) return;

    const result = await pgPool.query(
      `
        SELECT name, kind, calls, loc
        FROM function_nodes
        WHERE job_id = $1 AND file_path = $2
        ORDER BY name ASC
      `,
      [jobId, filePath],
    );

    return res.status(200).json(
      result.rows.map((row) => ({
        name: row.name,
        kind: row.kind,
        calls: Array.isArray(row.calls) ? row.calls : [],
        loc: Number.isFinite(row.loc) ? row.loc : null,
      })),
    );
  } catch (error) {
    return next(error);
  }
});

router.get('/:jobId/impact', async (req, res, next) => {
  const { jobId } = req.params;
  const nodePath = String(req.query.node || '').trim();
  const maxHops = Math.min(6, Math.max(1, Number.parseInt(req.query.hops || '6', 10)));

  if (!nodePath) {
    return res.status(400).json({ error: 'node query parameter is required.' });
  }

  try {
    const access = await ensureOwnedJobAccess(req, res);
    if (!access) return;

    const result = await impactAgent.process({ jobId, nodePath, maxHops }, { jobId });

    if (result.status === 'failed') {
      return res.status(500).json({ error: result.errors?.[0]?.message || 'BFS failed.' });
    }

    return res.status(200).json(result.data);
  } catch (error) {
    return next(error);
  }
});

router.post('/:jobId/share', shareLimiter, async (req, res, next) => {
  const authUser = getAuthUser(req);
  if (!authUser?.id) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { jobId } = req.params;
  const visibility = String(req.body?.visibility || 'unlisted').trim().toLowerCase();
  const expiresAtInput = req.body?.expiresAt;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required.' });
  }

  if (!SHARE_VISIBILITY.has(visibility)) {
    return res.status(400).json({ error: 'visibility must be either unlisted or public.' });
  }

  let expiresAt = null;
  if (expiresAtInput !== undefined && expiresAtInput !== null && String(expiresAtInput).trim() !== '') {
    const parsed = new Date(expiresAtInput);
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ error: 'expiresAt must be a valid ISO date string.' });
    }
    expiresAt = parsed.toISOString();
  }

  const token = crypto.randomBytes(24).toString('base64url');

  try {
    const userId = await resolveDatabaseUserId(authUser);
    if (!userId) {
      const error = new Error('Failed to resolve authenticated user record.');
      error.statusCode = 500;
      throw error;
    }

    // Verify the job belongs to the authenticated user
    const jobCheck = await pgPool.query(
      `
        SELECT id
        FROM analysis_jobs
        WHERE id = $1 AND user_id = $2
        LIMIT 1
      `,
      [jobId, userId],
    );

    if (jobCheck.rowCount === 0) {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }

    const inserted = await pgPool.query(
      `
        INSERT INTO graph_shares (job_id, token, visibility, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING token, visibility, expires_at
      `,
      [jobId, token, visibility, expiresAt],
    );

    return res.status(201).json({
      token: inserted.rows[0].token,
      visibility: inserted.rows[0].visibility,
      expiresAt: inserted.rows[0].expires_at,
      shareUrl: buildShareUrl(inserted.rows[0].token),
    });
  } catch (error) {
    if (error?.code === '23503') {
      return res.status(404).json({ error: 'Analysis job not found.' });
    }
    return next(error);
  }
});

router.get('/:jobId/heatmap', async (req, res, next) => {
  const { jobId } = req.params;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required.' });
  }

  try {
    const access = await ensureOwnedJobAccess(req, res);
    if (!access) return;

    const result = await pgPool.query(
      `
        SELECT file_path, file_type, metrics,
               COALESCE((metrics->>'inDegree')::numeric, 0)
                 * COALESCE((metrics->>'complexity')::numeric, 1.0) AS risk_score
        FROM graph_nodes
        WHERE job_id = $1
        ORDER BY risk_score DESC
        LIMIT 50
      `,
      [jobId],
    );

    return res.status(200).json({
      hotspots: result.rows.map((row) => ({
        filePath: row.file_path,
        type: row.file_type,
        riskScore: Number.parseFloat(row.risk_score) || 0,
        inDegree: Number(row.metrics?.inDegree) || 0,
        loc: Number(row.metrics?.loc) || 0,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

router.get('/:jobId', async (req, res, next) => {
  const { jobId } = req.params;

  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required.' });
  }

  try {
    const access = await ensureOwnedJobAccess(req, res);
    if (!access) return;

    const { payload, cacheStatus } = await loadGraphPayloadByJobId(jobId);

    if (!payload) {
      return res.status(404).json({ error: 'No graph data found for this job.' });
    }

    res.setHeader('X-Cache', cacheStatus);
    return res.status(200).json(payload);
  } catch (error) {
    return next(error);
  }
});

export default router;
