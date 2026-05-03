import express    from 'express';
import cors       from 'cors';
import cookieParser from 'cookie-parser';
import passport   from 'passport';
import * as Sentry from '@sentry/node';
import path       from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

import { analyzeRouter }                     from './src/analyze/index.js';
import { authRouter, configureGitHubPassport } from './src/auth/index.js';
import { jobsRouter }                        from './src/api/jobs/index.js';
import { graphRouter }                       from './src/api/graph/index.js';
import { aiRouter }                          from './src/api/ai/index.js';
import { repositoriesRouter }                from './src/api/repositories/index.js';
import { shareRouter }                       from './src/api/share/index.js';
import githubWebhookRouter                   from './src/api/webhooks/github.webhook.js';
import prCommentRouter                       from './src/api/webhooks/pr-comment.routes.js';

import { requestLogger }  from './src/utils/logger.js';
import { notFound }       from './src/middleware/notFound.middleware.js';
import { errorHandler }   from './src/middleware/errorHandler.middleware.js';
import { pgPool, redisClient } from './src/infrastructure/connections.js';
import { createChatClient } from './src/services/ai/llmProvider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const clientDistPath   = path.resolve(__dirname, '../client/dist');
const shouldServeClient =
  process.env.NODE_ENV === 'production' && existsSync(clientDistPath);

const app = express();

app.use(
  cors({
    origin:      process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true,
  }),
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

app.use(passport.initialize());
configureGitHubPassport();

app.get('/health', async (_req, res) => {
  const checks = {};
  try { await pgPool.query('SELECT 1'); checks.postgres = 'ok'; }
  catch { checks.postgres = 'error'; }

  try { await redisClient.ping(); checks.redis = 'ok'; }
  catch { checks.redis = 'unavailable'; }

  if (process.env.NEO4J_URI) {
    try {
      const { getNeo4jDriver } = await import('./src/infrastructure/db/neo4jDriver.js');
      await getNeo4jDriver().verifyConnectivity(); checks.neo4j = 'ok';
    } catch { checks.neo4j = 'unavailable'; }
  } else { checks.neo4j = 'disabled'; }

  checks.aiProvider = createChatClient().isConfigured() ? 'configured' : 'not configured';

  const allOk = checks.postgres === 'ok';
  return res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks });
});

app.use('/api/auth', authRouter);

app.use('/api/analyze', analyzeRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/graph', graphRouter);
app.use('/api/ai', aiRouter);
app.use('/api/repositories', repositoriesRouter);
app.use('/api', shareRouter);
app.use('/api/webhooks', githubWebhookRouter);
app.use('/api/webhooks/github', prCommentRouter);

if (shouldServeClient) {
  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (!req.accepts('html')) return next();
    if (req.path.startsWith('/api')) return next();
    if (req.path === '/health') return next();
    return res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

app.use(notFound);

if (process.env.SENTRY_DSN) {
  if (Sentry?.Handlers?.errorHandler) {
    app.use(Sentry.Handlers.errorHandler());
  } else if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app);
  }
}

app.use(errorHandler);

export default app;
