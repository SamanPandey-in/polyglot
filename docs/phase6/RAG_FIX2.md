# Polyglot Phase 6 — Gap Analysis & Fix Guide (Updated Codebase)

> **Audit date:** May 2026 · Against the uploaded `polyglot-phase-6__1_.zip`

The previous architectural gaps (no ChatAgent, no getContextForQuery, no Postgres migration
runner) are all resolved in this codebase. The remaining issues are **runtime correctness
bugs** — things that compile and look right but break or waste resources under realistic
conditions.

---

## Gap Map

| # | Severity | Location | What breaks |
|---|---|---|---|
| 1 | 🔴 Critical | `ChatAgent` + `/chat` route | Client disconnect doesn't stop LLM stream — server keeps generating, persisting, and billing |
| 2 | 🔴 Critical | `/chat` route | `agent.process()` failure sends `done` instead of `error` → blank streaming bubble |
| 3 | 🟠 High | `ChatAgent.process()` | Confidence never reaches `'high'` — always `'medium'` or `'low'` regardless of match quality |
| 4 | 🟠 High | `ChatAgent.process()` | Empty-context fallback answers are cached — next user gets a wrong cached answer |
| 5 | 🟠 High | `ConversationHistory` + `ChatInput` | History sidebar never auto-refreshes after first message — user must click Refresh manually |
| 6 | 🟠 High | `ChatAgent.process()` | Neo4j context retrieval fails silently when Neo4j is down — no Postgres fallback |
| 7 | 🟡 Medium | `startup.js` migration runner | Multi-statement SQL files run as one query — PL/pgSQL trigger definition may partially fail |
| 8 | 🟡 Medium | `LocalRepoSection` | Browse button loading state uses string equality — breaks if message text ever changes |

---

## Fix 1 — Stream Abort: Client Disconnect Must Stop the Agent

**Files:** `server/src/agents/query/ChatAgent.js`,
`server/src/api/ai/routes/ai.routes.js`

### Why it breaks

The `/chat` route sets `clientClosed = true` on `req.on('close')`, but this flag lives in the
route closure. `ChatAgent.process()` is a long-running async function that the route calls with
`await`. Once `process()` is running, the route has no handle on it. The result:

- Client browser disconnects (user navigates away, closes tab, presses Stop)
- `clientClosed = true` → route no longer writes SSE chunks ✅
- **BUT** `ChatAgent` continues: embedding API call, 3 DB queries, LLM stream, conversation INSERT, Redis SET — all still run and bill you

### Fix — add `AbortController` support to `ChatAgent`

**`server/src/agents/query/ChatAgent.js`** — change `process()` signature and add
`isAborted()` guard at each async checkpoint:

```js
// Add at the top of process():
async process(input, context = {}) {
  const start = Date.now();
  const errors   = [];
  const warnings = [];

  // ── NEW: wire up AbortSignal ─────────────────────────────────────────────
  const signal    = input?.signal instanceof AbortSignal ? input.signal : null;
  const isAborted = () => signal?.aborted === true;

  const question       = String(input?.question       || '').trim();
  const jobId          = String(input?.jobId          || context?.jobId || '').trim();
  const userId         = String(input?.userId         || '').trim();
  const conversationId = String(input?.conversationId || '').trim() || null;
  const historyLimit   = Math.min(10, Math.max(0, Number(input?.historyLimit ?? HISTORY_TURN_LIMIT)));
  const onToken        = typeof input?.onToken === 'function' ? input.onToken : null;

  if (!question || !jobId || !userId) { /* unchanged */ }
  if (!this.llmClient.isConfigured()) { /* unchanged */ }

  // ── Redis cache check (unchanged) ────────────────────────────────────────
  // ...

  // ── NEW: guard after each expensive step ─────────────────────────────────
  // Place this after conversation resolution:
  if (isAborted()) {
    return this.buildResult({ jobId, status: 'failed', confidence: 0, data: {},
      errors: [{ code: 499, message: 'Request aborted by client.' }],
      warnings, metrics: {}, processingTimeMs: Date.now() - start });
  }

  // ... conversation resolution code (unchanged) ...

  // Place this after history load:
  if (isAborted()) {
    return this.buildResult({ jobId, status: 'failed', confidence: 0, data: {},
      errors: [{ code: 499, message: 'Request aborted by client.' }],
      warnings, metrics: {}, processingTimeMs: Date.now() - start });
  }

  // ... embedding + vector search (unchanged) ...

  // Place this after context retrieval:
  if (isAborted()) {
    return this.buildResult({ jobId, status: 'failed', confidence: 0, data: {},
      errors: [{ code: 499, message: 'Request aborted by client.' }],
      warnings, metrics: {}, processingTimeMs: Date.now() - start });
  }

  // In the streaming block — pass signal so the underlying fetch can abort:
  try {
    const streamSession = await this.llmClient.createStream({
      model:     this.llmClient.model,
      maxTokens: 800,
      messages,
      signal,                // ← NEW: pass AbortSignal to the LLM client
      onText: (text) => {
        if (isAborted()) return;  // ← NEW: stop accumulating if aborted
        fullText += text;
        onToken?.(text);
      },
    });
    await streamSession.consume();
    completionTokens = Number(streamSession?.usage?.completion_tokens || 0);
  } catch (error) {
    if (isAborted()) {
      // Client disconnected — don't persist, don't cache
      return this.buildResult({ jobId, status: 'failed', confidence: 0, data: {},
        errors: [{ code: 499, message: 'Request aborted by client.' }],
        warnings, metrics: {}, processingTimeMs: Date.now() - start });
    }
    streamError = error;
    warnings.push(`LLM stream failed: ${error.message}`);
    fullText = buildProviderFallback(question, contextEntries);
    onToken?.(fullText);
  }

  // Guard before persistence — don't INSERT if aborted:
  if (!isAborted() && activeConversationId && fullText) {
    Promise.all([
      this.db.query(`INSERT INTO conversation_messages ...`, [...]),
      this.db.query(`INSERT INTO conversation_messages ...`, [...]),
    ]).catch((error) => console.error('[ChatAgent] turn persistence failed:', error.message));
  }

  // Guard before cache write:
  if (!isAborted() && fullText && !streamError) {
    const cachePayload = JSON.stringify({ ... });
    this.redis?.setex?.(cacheKey, CACHE_TTL_SECONDS, cachePayload).catch(() => {});
  }

  // ... rest of buildResult (unchanged) ...
}
```

**`server/src/api/ai/routes/ai.routes.js`** — create the `AbortController` and pass its
signal to the agent. Replace the `clientClosed` block:

```js
// REPLACE this block in the /chat route:
let clientClosed = false;
req.on('close', () => {
  clientClosed = true;
});

// WITH:
const abortController = new AbortController();
let clientClosed = false;

req.on('close', () => {
  clientClosed = true;
  abortController.abort();    // ← stops the ChatAgent pipeline immediately
});

// Then pass signal to agent.process():
const result = await agent.process({
  question,
  jobId,
  userId,
  conversationId,
  historyLimit,
  signal: abortController.signal,    // ← NEW
  onToken: (text) => {
    if (!clientClosed) writeSseEvent(res, { type: 'chunk', text });
  },
}, { jobId });
```

> **Also update `llmProvider.js`** — the `createStream` method should forward the signal
> to the OpenAI streaming call:
>
> ```js
> async createStream({ messages, model, maxTokens, temperature, onText, signal } = {}) {
>   // In the openai-compatible branch:
>   const stream = await this.openai.chat.completions.stream({
>     model: model || this.model,
>     max_tokens: maxTokens,
>     temperature,
>     messages,
>     signal,    // ← add this
>   });
>   // ...
> }
> ```

---

## Fix 2 — Route Sends `done` Even on Agent Failure

**File:** `server/src/api/ai/routes/ai.routes.js`

### Why it breaks

`ChatAgent.process()` never throws — it catches all errors internally and returns a result
object. If it returns `status: 'failed'` with empty `data`, the route blindly sends:

```js
writeSseEvent(res, { type: 'done', sources: [], conversationId: null, confidence: 'low' });
```

The frontend's `finalizeStream` fires, commits an empty `streamingText` as an assistant
message, and renders a blank bubble.

### Fix

```js
// In /chat route — REPLACE the block after agent.process():

if (!clientClosed) {
  if (result.status === 'failed') {
    // Emit an error event so the frontend shows the error UI, not a blank bubble
    const errMsg = result.errors?.[0]?.message || 'Chat failed.';
    writeSseEvent(res, { type: 'error', message: errMsg });
  } else {
    writeSseEvent(res, {
      type:           'done',
      sources:         result.data?.sources        || [],
      conversationId:  result.data?.conversationId || null,
      confidence:      result.data?.confidence     || 'low',
      fallback:        result.data?.fallback        || false,
      cached:          result.data?.cacheHit        || false,
    });
  }
}

if (!res.writableEnded) res.end();
```

---

## Fix 3 — Confidence Never Reaches `'high'`

**File:** `server/src/agents/query/ChatAgent.js`

### Why it breaks

```js
// Current code — line ~364:
const confidence = streamError ? 'low' : contextEntries.length >= 3 ? 'medium' : 'low';
```

`'high'` is never assigned. Every successful answer with ≥3 files is `'medium'`, even
when the top result has a cosine distance of 0.05 (near-perfect match). The confidence
stored in `conversation_messages.confidence` is permanently capped at `'medium'`.

### Fix

```js
// REPLACE the confidence line with:
function deriveConfidence(streamError, contextEntries) {
  if (streamError) return 'low';
  if (!contextEntries.length) return 'low';

  // 'high' = no stream error + top result is very close match + enough context
  const topDistance = Number(contextEntries[0]?.distance ?? 1);
  if (!streamError && topDistance < 0.20 && contextEntries.length >= 3) return 'high';

  // 'medium' = successful stream + some relevant context
  if (contextEntries.length >= 3) return 'medium';
  if (contextEntries.length >= 1) return 'medium';

  return 'low';
}

// Then use:
const confidence = deriveConfidence(streamError, contextEntries);
```

---

## Fix 4 — Empty-Context Fallback Answers Are Cached

**File:** `server/src/agents/query/ChatAgent.js`

### Why it breaks

If embedding fails (rate limit, misconfigured key, etc.) but the LLM fallback runs,
`ChatAgent` generates a response like:

```
Unable to reach the AI provider. Most relevant codebase context for: "how does auth work?"
- src/auth/middleware.js: No summary.
```

This fallback is then cached under `chat:{jobId}:new:{questionHash}`. Every subsequent
request for the same question hits the cache and returns this empty-context fallback, even
after the embedding service is restored.

### Fix — only cache when real context was retrieved

```js
// REPLACE the cache write block near the end of process():

// Only cache when the answer is based on real retrieved context
const shouldCache = fullText && !streamError && contextEntries.length > 0;
if (shouldCache) {
  const cachePayload = JSON.stringify({
    text: fullText,
    sources: sourcePaths,
    conversationId: activeConversationId,
    confidence,
  });
  this.redis?.setex?.(cacheKey, CACHE_TTL_SECONDS, cachePayload).catch(() => {});
}
```

---

## Fix 5 — ConversationHistory Doesn't Auto-Refresh After First Message

**Files:** `client/src/features/ai/components/ChatInput.jsx`,
`client/src/features/ai/slices/conversationSlice.js`,
`client/src/features/ai/components/ConversationHistory.jsx`

### Why it breaks

`ConversationHistory` fetches on `jobId` change only:
```js
useEffect(() => { run(); }, [dispatch, jobId]);
```

After the first message, `ChatAgent` creates a new conversation and `finalizeStream` is
dispatched. The history list never updates. The user sees "No saved chat threads" even
though one was just created. Only clicking "Refresh" manually fetches the new list.

### Fix — 3 steps

**Step A** — add a `conversationCreated` counter to `conversationSlice.js` that increments
whenever a new `conversationId` appears after `finalizeStream`:

```js
// In initialState — add:
conversationCreated: 0,

// In finalizeStream reducer — add:
finalizeStream(state, action) {
  const conversationId = action.payload?.conversationId || null;
  const sources = Array.isArray(action.payload?.sources) ? action.payload.sources : [];

  // Detect a newly-created conversation (previous state had null, now has a real id)
  if (conversationId && !state.conversationId) {
    state.conversationCreated += 1;   // ← signals ConversationHistory to refresh
  }

  state.isStreaming    = false;
  state.conversationId = conversationId || state.conversationId;
  state.messages.push({
    id:          `assistant-${Date.now()}`,
    role:        'assistant',
    content:     state.streamingText,
    sourceFiles: sources,
    isStreaming: false,
  });
  state.streamingText = '';
},

// Add selector:
export const selectConversationCreated = (state) => state.conversation.conversationCreated;
```

**Step B** — update `ConversationHistory.jsx` to watch `conversationCreated`:

```jsx
// Add import:
import { selectConversationCreated } from '../slices/conversationSlice';

// Inside ConversationHistory component — add selector:
const conversationCreated = useSelector(selectConversationCreated);

// Change useEffect dependency array to include conversationCreated:
useEffect(() => {
  let cancelled = false;
  run();                              // same function body as before
  return () => { cancelled = true; };
}, [dispatch, jobId, conversationCreated]);   // ← add conversationCreated
```

**Step C** — export the new selector from `ai/index.js`:

```js
// Add to the existing conversationSlice exports in ai/index.js:
export {
  // ... existing exports ...
  selectConversationCreated,
} from './slices/conversationSlice';
```

---

## Fix 6 — No Postgres Fallback When Neo4j Is Down During Query

**File:** `server/src/agents/query/ChatAgent.js`

### Why it breaks

When `db_type = 'neo4j'` (stored during analysis) but Neo4j is unavailable at query time,
`GraphRagExpander.getEnrichedContext()` calls `this.repo.getContextForQuery()` which calls
`Neo4jGraphRepository._withSession()` which throws when the driver can't connect. The outer
try/catch in `ChatAgent` catches the embedding block failure, sets `contextEntries = []`,
and the LLM answers with "context insufficient." The graph data in Postgres is never tried.

### Fix — add Postgres fallback in the context retrieval block

```js
// In ChatAgent.process(), inside the embedding try block, REPLACE:
const enriched = await this.expander.getEnrichedContext(seedPaths, jobId, {
  maxFiles: CONTEXT_FILE_LIMIT,
  seedLimit: 5,
});

// WITH:
let enriched;
try {
  enriched = await this.expander.getEnrichedContext(seedPaths, jobId, {
    maxFiles: CONTEXT_FILE_LIMIT,
    seedLimit: 5,
  });
} catch (expandError) {
  warnings.push(`Graph context retrieval failed (${expandError.message}); falling back to Postgres.`);

  // Postgres fallback: fetch seed metadata directly
  const fallbackResult = await this.db.query(
    `SELECT file_path, file_type, summary, declarations
     FROM graph_nodes
     WHERE job_id = $1 AND file_path = ANY($2)`,
    [jobId, seedPaths.slice(0, CONTEXT_FILE_LIMIT)],
  ).catch(() => ({ rows: [] }));

  enriched = fallbackResult.rows.map((row) => ({
    filePath:      row.file_path,
    fileType:      row.file_type || 'module',
    summary:       row.summary   || null,
    declarations:  Array.isArray(row.declarations) ? row.declarations : [],
    relationships: [],
    distance:      0,
  }));
}
```

---

## Fix 7 — Migration Runner: Use `pg` Client for Multi-Statement Safety

**File:** `server/src/infrastructure/db/startup.js`

### Why it's risky

`pgPool.query(sql)` with multi-statement SQL (no parameters) works via the simple query
protocol in `pg` v8. BUT there is an edge case: the `005_polyglot_statuses.sql` migration
(and others) define custom ENUM types and alter them. If two migrations are applied in
succession and a partial failure occurs between statements, there is no rollback — the
migration is marked as applied (in the `catch` block's fallback INSERT) even though some
statements may not have run.

Using a client with explicit transactions gives precise error reporting and atomicity.

### Fix — use client-per-migration with error statement detection

```js
// Replace the entire for-loop body in runPostgresMigrations():

for (const filename of files) {
  const check = await pgPool.query(
    `SELECT 1 FROM _pg_migrations WHERE filename = $1`,
    [filename],
  );
  if (check.rowCount > 0) {
    console.log(`[PostgresMigration] Skipping ${filename} (already applied)`);
    continue;
  }

  console.log(`[PostgresMigration] Applying ${filename}...`);
  const sql = await fs.readFile(path.join(PG_MIGRATIONS_DIR, filename), 'utf8');

  // Split on statement boundaries (semicolons not inside dollar-quoted blocks)
  const statements = splitSqlStatements(sql);

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      try {
        await client.query(trimmed);
      } catch (stmtError) {
        // Idempotent errors are safe to ignore
        if (
          stmtError.message?.includes('already exists') ||
          stmtError.message?.includes('duplicate key') ||
          stmtError.message?.includes('EquivalentSchemaRuleAlreadyExistsException')
        ) {
          console.log(`[PostgresMigration]   (idempotent) ${stmtError.message.split('\n')[0]}`);
        } else {
          throw stmtError;   // re-throw non-idempotent errors → triggers ROLLBACK
        }
      }
    }

    await client.query(
      `INSERT INTO _pg_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [filename],
    );
    await client.query('COMMIT');
    console.log(`[PostgresMigration] Applied ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`[PostgresMigration] FAILED ${filename}:`, error.message);
    throw error;   // fatal — stop server startup
  } finally {
    client.release();
  }
}
```

Add the `splitSqlStatements` helper at the top of `startup.js`:

```js
/**
 * Splits a SQL file into individual executable statements.
 * Handles dollar-quoted blocks ($$...$$) which may contain semicolons.
 */
function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  let i = 0;

  while (i < sql.length) {
    // Detect start/end of dollar-quoted block (e.g. $$ or $BODY$)
    if (!inDollarQuote && sql[i] === '$') {
      const tagEnd = sql.indexOf('$', i + 1);
      if (tagEnd !== -1) {
        const tag = sql.slice(i, tagEnd + 1);
        inDollarQuote = true;
        dollarTag = tag;
        current += tag;
        i = tagEnd + 1;
        continue;
      }
    } else if (inDollarQuote && sql.slice(i, i + dollarTag.length) === dollarTag) {
      current += dollarTag;
      i += dollarTag.length;
      inDollarQuote = false;
      dollarTag = '';
      continue;
    }

    if (!inDollarQuote && sql[i] === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }

  const remaining = current.trim();
  if (remaining) statements.push(remaining);

  return statements;
}
```

---

## Fix 8 — Browse Button Loading State Uses Fragile String Comparison

**File:** `client/src/features/graph/components/LocalRepoSection.jsx`

### Why it breaks

```jsx
pickerMessage === 'Checking folder picker availability...'
```

This shows the loading spinner inside the Browse button while capabilities are being
fetched. If this string is ever changed (typo fix, i18n, or copy update), the loading
spinner silently breaks — users see a non-loading Browse button that is disabled with no
visual feedback.

### Fix — use a dedicated boolean state

```jsx
// ADD state:
const [pickerChecking, setPickerChecking] = useState(false);

// REPLACE the capabilities useEffect:
useEffect(() => {
  let alive = true;
  setPickerChecking(true);

  graphService.getLocalPickerCapabilities()
    .then((data) => {
      if (!alive) return;
      setPickerSupported(Boolean(data?.supported));
      setPickerMessage(data?.message || 'Native folder picker unavailable, paste an absolute path manually.');
    })
    .catch(() => {
      if (!alive) return;
      setPickerSupported(false);
      setPickerMessage('Native folder picker unavailable, paste an absolute path manually.');
    })
    .finally(() => {
      if (alive) setPickerChecking(false);
    });

  return () => { alive = false; };
}, []);

// REPLACE the Browse button's children:
<Button
  type="button"
  variant="outline"
  onClick={handleBrowse}
  disabled={isBusy || (!pickerSupported && !pickerChecking)}
  title={pickerSupported ? 'Open native folder picker' : pickerMessage || 'Native folder picker unavailable'}
>
  {browseState === 'loading' || pickerChecking ? (
    <><Loader2 className="animate-spin" /> {browseState === 'loading' ? 'Opening' : 'Browse'}</>
  ) : (
    <><FolderOpen /> Browse</>
  )}
</Button>
```

---

## Summary: Files to Edit

| File | Fix |
|---|---|
| `server/src/agents/query/ChatAgent.js` | Fixes 1, 3, 4, 6 |
| `server/src/api/ai/routes/ai.routes.js` | Fixes 1, 2 |
| `server/src/services/ai/llmProvider.js` | Fix 1 (pass `signal` to OpenAI stream) |
| `server/src/infrastructure/db/startup.js` | Fix 7 |
| `client/src/features/ai/slices/conversationSlice.js` | Fix 5A |
| `client/src/features/ai/components/ConversationHistory.jsx` | Fix 5B |
| `client/src/features/ai/index.js` | Fix 5C |
| `client/src/features/graph/components/LocalRepoSection.jsx` | Fix 8 |

---

## Quick Regression Test After Fixes

```bash
# 1. Stream abort — open a question in Ask, immediately close the tab.
#    Check server logs: should see "[ChatAgent] 499 aborted" and NO conversation INSERT.

# 2. Agent failure → error event:
#    Temporarily set AI_API_KEY to an invalid key.
#    Ask a question. Frontend should show an error message, not a blank bubble.

# 3. High confidence:
#    Ask a question that exactly matches a file summary (copy words from it).
#    confidence in the done event should be 'high', not 'medium'.

# 4. Cache skip on empty context:
#    Set AI_API_KEY invalid, ask a question. Restore key, ask same question.
#    Second ask should hit real context (not cached fallback).

# 5. ConversationHistory auto-refresh:
#    Ask a question for the first time in a job. History sidebar should update
#    without clicking Refresh.

# 6. Neo4j fallback:
#    Set NEO4J_URI to a bad URL. Load a job that has db_type='neo4j'.
#    Ask a question. Should still return context (from Postgres fallback),
#    not "context insufficient."

# 7. Migration safety:
#    Drop the _pg_migrations table. Restart server. All migrations should apply.
#    Restart again. All migrations should skip cleanly.

# 8. Browse button:
#    On supported OS: button shows spinner while capabilities are checked,
#    then shows Browse icon when ready.
```