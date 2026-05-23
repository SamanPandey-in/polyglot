import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { X, AlertTriangle, Loader2, Zap, Wrench } from 'lucide-react';
import {
  analyzeImpact,
  resetAiState,
  selectAiImpactState,
} from '../slices/aiSlice';
import { selectGraphData } from '../../graph/slices/graphSlice';
import { aiService } from '../services/aiService';

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Converts a raw upstream error message into a user-actionable string.
 * BUG 1 FIX: previously the 429 from OpenAI was swallowed and shown as
 * "Failed to load explanation" with no guidance.
 */
function friendlyErrorMessage(rawMessage) {
  const msg = rawMessage || 'Failed to load explanation.';

  if (msg.includes('429') || msg.toLowerCase().includes('quota')) {
    return 'AI quota exceeded. Add credits at platform.openai.com/billing, or switch to Anthropic / Gemini in your server .env (AI_PROVIDER=anthropic).';
  }
  if (msg.includes('503') || msg.toLowerCase().includes('not configured')) {
    return 'AI provider is not configured. Check AI_API_KEY in your server .env file.';
  }
  if (msg.includes('401') && msg.toLowerCase().includes('api')) {
    return 'AI API key is invalid or expired. Check AI_API_KEY in your server .env file.';
  }
  return msg;
}

// ─── component ──────────────────────────────────────────────────────────────

export default function AiPanel({ nodeId, graph, onClose }) {
  const dispatch = useDispatch();
  const graphData = useSelector(selectGraphData);
  const impactState = useSelector(selectAiImpactState);
  const jobId = graphData?.jobId;

  const [streamedText, setStreamedText]       = useState('');
  const [isStreaming, setIsStreaming]          = useState(false);
  const [streamError, setStreamError]         = useState('');
  const [isLoadingRefactor, setIsLoadingRefactor] = useState(false);
  const [refactorError, setRefactorError]     = useState('');
  const [refactorSuggestion, setRefactorSuggestion] = useState(null);

  // BUG 9 FIX: debounce ref — prevents firing a stream on every rapid node click
  const debounceRef = useRef(null);

  const nodeData = nodeId ? graph?.[nodeId] : null;

  useEffect(() => {
    // BUG 6 FIX: clear stale impact data from the previous node immediately
    dispatch(resetAiState());
    setStreamedText('');
    setStreamError('');
    setRefactorSuggestion(null);
    setRefactorError('');

    if (!nodeId || !jobId) {
      setIsStreaming(false);
      clearTimeout(debounceRef.current);
      return;
    }

    // Cancel any in-flight debounce from a previous rapid click
    clearTimeout(debounceRef.current);

    let isCancelled = false;
    const controller = new AbortController();

    // BUG 9 FIX: wait 600 ms before firing the stream — if the user clicks
    // another node within that window the previous timeout is cancelled.
    debounceRef.current = setTimeout(() => {
      setIsStreaming(true);

      aiService
        .streamExplain({
          question: `Explain the file ${nodeId}: its purpose, key functions, dependencies, and architectural risks.`,
          jobId,
          signal: controller.signal,

          onChunk: (text) => {
            if (!isCancelled) setStreamedText((prev) => prev + text);
          },

          onDone: () => {
            if (!isCancelled) setIsStreaming(false);
          },

          // BUG 1 FIX: convert upstream error codes to actionable messages
          onError: (err) => {
            if (isCancelled) return;
            setStreamError(friendlyErrorMessage(err?.message));
            setIsStreaming(false);
          },
        })
        .catch(() => {
          // Errors are handled via onError above.
        });
    }, 600);

    return () => {
      isCancelled = true;
      controller.abort();
      clearTimeout(debounceRef.current);
    };
  }, [nodeId, jobId, dispatch]);

  // ─── guard: nothing selected ─────────────────────────────────────────────
  if (!nodeId || !nodeData) return null;

  const { deps = [], type, declarations = [], summary } = nodeData;

  const usedBy = Object.entries(graph || {})
    .filter(([, value]) => value.deps?.includes(nodeId))
    .map(([file]) => file);

  const impactedFiles = impactState?.data?.affectedFiles || [];
  const isImpacting   = impactState?.status === 'loading';

  // ─── handlers ────────────────────────────────────────────────────────────
  function handleRunImpact() {
    if (!jobId || !nodeId) return;
    dispatch(analyzeImpact({ jobId, filePath: nodeId }));
  }

  async function handleSuggestRefactor() {
    if (!jobId || !nodeId || isLoadingRefactor) return;
    setIsLoadingRefactor(true);
    setRefactorError('');
    setRefactorSuggestion(null);
    try {
      const result = await aiService.suggestRefactor({ jobId, filePath: nodeId });
      setRefactorSuggestion(result);
    } catch (err) {
      setRefactorError(friendlyErrorMessage(err?.message));
    } finally {
      setIsLoadingRefactor(false);
    }
  }

  // ─── render ──────────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full flex-col gap-4 overflow-y-auto rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Selected Node
          </p>
          <p className="truncate font-mono text-sm font-semibold text-foreground">
            {nodeId}
          </p>
          {type && (
            <span className="mt-1 inline-block rounded-full border border-border/40 bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground">
              {type}
            </span>
          )}
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close panel"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {/* AI Explanation */}
      <section>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          AI Explanation
        </p>
        <div className="min-h-[60px] rounded-lg border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground/80">
          {isStreaming && !streamedText && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Generating explanation…
            </span>
          )}
          {streamedText && <span>{streamedText}</span>}
          {isStreaming && streamedText && (
            <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-primary" />
          )}
          {!isStreaming && !streamedText && !streamError && (
            <span className="text-muted-foreground">No explanation yet.</span>
          )}
          {/* BUG 1 FIX: display the friendly error message */}
          {streamError && (
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>{streamError}</span>
            </div>
          )}
        </div>
      </section>

      {/* Graph metadata */}
      {summary && (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Summary
          </p>
          <p className="text-xs text-foreground/70">{summary}</p>
        </section>
      )}

      {/* Exports */}
      {declarations.length > 0 && (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Exports ({declarations.length})
          </p>
          <div className="flex flex-wrap gap-1">
            {declarations.slice(0, 12).map((d) => (
              <span
                key={d?.name}
                className="rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-foreground/70"
              >
                {d?.name}
              </span>
            ))}
            {declarations.length > 12 && (
              <span className="text-[10px] text-muted-foreground">
                +{declarations.length - 12} more
              </span>
            )}
          </div>
        </section>
      )}

      {/* Dependencies */}
      {deps.length > 0 && (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Imports ({deps.length})
          </p>
          <ul className="space-y-0.5">
            {deps.slice(0, 6).map((dep) => (
              <li key={dep} className="truncate font-mono text-[10px] text-muted-foreground">
                {dep}
              </li>
            ))}
            {deps.length > 6 && (
              <li className="text-[10px] text-muted-foreground">+{deps.length - 6} more</li>
            )}
          </ul>
        </section>
      )}

      {/* Used by */}
      {usedBy.length > 0 && (
        <section>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Used by ({usedBy.length})
          </p>
          <ul className="space-y-0.5">
            {usedBy.slice(0, 6).map((f) => (
              <li key={f} className="truncate font-mono text-[10px] text-muted-foreground">
                {f}
              </li>
            ))}
            {usedBy.length > 6 && (
              <li className="text-[10px] text-muted-foreground">+{usedBy.length - 6} more</li>
            )}
          </ul>
        </section>
      )}

      {/* Impact analysis */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Impact Analysis
          </p>
          <button
            onClick={handleRunImpact}
            disabled={isImpacting}
            className="flex items-center gap-1 rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-[10px] text-foreground/70 transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            {isImpacting ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <Zap className="size-2.5" />
            )}
            {isImpacting ? 'Analysing…' : 'Run'}
          </button>
        </div>
        {impactedFiles.length > 0 && (
          <ul className="space-y-0.5">
            {impactedFiles.slice(0, 8).map((f) => (
              <li key={f} className="truncate font-mono text-[10px] text-muted-foreground">
                {f}
              </li>
            ))}
            {impactedFiles.length > 8 && (
              <li className="text-[10px] text-muted-foreground">+{impactedFiles.length - 8} more</li>
            )}
          </ul>
        )}
        {impactState?.status === 'failed' && (
          <p className="text-[10px] text-destructive">{impactState?.error?.message || 'Impact analysis failed.'}</p>
        )}
      </section>

      {/* Refactor suggestions */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            Refactor Suggestions
          </p>
          <button
            onClick={handleSuggestRefactor}
            disabled={isLoadingRefactor}
            className="flex items-center gap-1 rounded-md border border-border/40 bg-muted/30 px-2 py-1 text-[10px] text-foreground/70 transition-colors hover:bg-muted/60 disabled:opacity-50"
          >
            {isLoadingRefactor ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <Wrench className="size-2.5" />
            )}
            {isLoadingRefactor ? 'Loading…' : 'Suggest'}
          </button>
        </div>
        {refactorError && (
          <p className="text-[10px] text-destructive">{refactorError}</p>
        )}
        {refactorSuggestion && (
          <div className="space-y-2 text-xs">
            {refactorSuggestion.concerns?.length > 0 && (
              <div>
                <p className="font-medium text-foreground/80">Concerns:</p>
                <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-muted-foreground">
                  {refactorSuggestion.concerns.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            {refactorSuggestion.suggestions?.length > 0 && (
              <div>
                <p className="font-medium text-foreground/80">Suggestions:</p>
                <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-muted-foreground">
                  {refactorSuggestion.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">
              Priority: {refactorSuggestion.priority} · Effort: {refactorSuggestion.estimatedEffort}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
