/**
 * Global error handler middleware.
 *
 * BUG 7 FIX: normalises upstream AI provider errors (429, 503, 401) into
 * user-actionable messages. Previously raw provider error objects leaked to
 * the client with no guidance, and the status code defaulted to 500.
 */
export function errorHandler(err, _req, res, _next) {
  // Resolve status code — check all common locations upstream libs use
  const upstreamStatus =
    err?.status ??
    err?.statusCode ??
    err?.response?.status ??
    null;

  const statusCode = Number.isInteger(upstreamStatus) && upstreamStatus >= 100
    ? upstreamStatus
    : 500;

  let message = err?.message || 'Internal server error';

  // ── User-actionable messages for known upstream AI provider errors ────────
  if (statusCode === 429) {
    message =
      'AI provider quota exceeded. Add credits at platform.openai.com/billing, ' +
      'or switch to Anthropic / Gemini by setting AI_PROVIDER in your server .env.';
  } else if (statusCode === 503 || message.toLowerCase().includes('not configured')) {
    message =
      'AI provider is not configured. Set AI_API_KEY (and optionally AI_PROVIDER) ' +
      'in your server .env file, then restart the server.';
  } else if (statusCode === 401 && message.toLowerCase().includes('api')) {
    message =
      'AI API key is invalid or expired. Check AI_API_KEY in your server .env file.';
  }

  // Log server errors (exclude expected 4xx)
  if (statusCode >= 500) {
    console.error('[errorHandler]', {
      statusCode,
      message: err?.message,
      stack: err?.stack,
    });
  }

  return res.status(statusCode).json({
    error: message,
    // Stack trace only in development — never in production
    ...(process.env.NODE_ENV === 'development' && err?.stack
      ? { stack: err.stack }
      : {}),
  });
}