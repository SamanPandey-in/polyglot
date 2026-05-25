import React, { useEffect, useMemo, useRef, useState } from 'react';
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

function buildLocalExplanation({ nodeId, type, summary, declarations, deps, usedBy }) {
  const exportCount = Array.isArray(declarations) ? declarations.length : 0;
  const importCount = Array.isArray(deps) ? deps.length : 0;
  const usedByCount = Array.isArray(usedBy) ? usedBy.length : 0;

  const parts = [
    `${nodeId} is a ${type || 'repository'} node.`,
    exportCount > 0
      ? `It exposes ${exportCount} export${exportCount === 1 ? '' : 's'} and imports ${importCount} module${importCount === 1 ? '' : 's'}.`
      : `It imports ${importCount} module${importCount === 1 ? '' : 's'} and is referenced by ${usedByCount} file${usedByCount === 1 ? '' : 's'}.`,
  ];

  if (summary) {
    parts.push(`Summary: ${summary}`);
  }

  if (usedByCount > 0) {
    parts.push(`It is used by ${usedByCount} file${usedByCount === 1 ? '' : 's'}, so changes here can have wide impact.`);
  }

  return parts.join(' ');
}

function buildLocalRefactorSuggestion({ type, summary, declarations, deps, usedBy }) {
  const concerns = [];
  const suggestions = [];
  const exportCount = Array.isArray(declarations) ? declarations.length : 0;
  const importCount = Array.isArray(deps) ? deps.length : 0;
  const usedByCount = Array.isArray(usedBy) ? usedBy.length : 0;

  if (usedByCount > 8) {
    concerns.push('This file has a high fan-in, so changes can ripple across many dependents.');
    suggestions.push('Split high-impact responsibilities into smaller units with clearer boundaries.');
  }

  if (importCount > 8) {
    concerns.push('The file has a large dependency surface, which can make it harder to test and reuse.');
    suggestions.push('Extract shared helpers or adapters to reduce direct coupling.');
  }

  if (exportCount > 6) {
    concerns.push('The file exposes many exports, which can indicate mixed responsibilities.');
    suggestions.push('Group related exports into focused modules and keep each file centered on one concern.');
  }

  if (String(type || '').toLowerCase() === 'service') {
    suggestions.push('Keep orchestration thin and move parsing or transformation logic into reusable helpers.');
  }

  if (summary) {
    suggestions.push(`Review the current summary and extract the parts that are most likely to change independently: ${summary}`);
  }

  return {
    concerns: concerns.length > 0 ? concerns : ['No strong structural smell was detected from the static graph metadata alone.'],
    suggestions: suggestions.length > 0 ? suggestions : ['Prefer smaller, testable functions and keep dependencies localized.'],
    priority: usedByCount > 8 || importCount > 8 ? 'high' : exportCount > 6 ? 'medium' : 'low',
    estimatedEffort: usedByCount > 8 || importCount > 8 ? '1-3 hours' : 'under 1 hour',
  };
}

function stripCodeFence(value) {
  const text = String(value || '').trim();
  if (!text.startsWith('```')) return text;

  const match = text.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] || text.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/i, '')).trim();
}

function tryParseSuggestionJson(value) {
  const text = stripCodeFence(value);
  if (!text || !(text.startsWith('{') || text.startsWith('['))) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeRefactorSuggestion(result) {
  const concerns = Array.isArray(result?.concerns) ? result.concerns.filter(Boolean) : [];
  let suggestions = Array.isArray(result?.suggestions) ? result.suggestions.filter(Boolean) : [];
  let priority = String(result?.priority || '').trim() || 'medium';
  let estimatedEffort = String(result?.estimatedEffort || '').trim() || 'unknown';

  const parsedFromText = suggestions.length === 1 ? tryParseSuggestionJson(suggestions[0]) : null;
  const parsedFromRaw = parsedFromText || tryParseSuggestionJson(result?.raw?.content || result?.raw?.text);

  if (parsedFromRaw && typeof parsedFromRaw === 'object' && !Array.isArray(parsedFromRaw)) {
    const parsedConcerns = Array.isArray(parsedFromRaw.concerns) ? parsedFromRaw.concerns.filter(Boolean) : [];
    const parsedSuggestions = Array.isArray(parsedFromRaw.suggestions) ? parsedFromRaw.suggestions.filter(Boolean) : [];

    if (parsedConcerns.length > 0) {
      concerns.splice(0, concerns.length, ...parsedConcerns);
    }

    if (parsedSuggestions.length > 0) {
      suggestions = parsedSuggestions;
    } else if (suggestions.length === 1) {
      suggestions = [stripCodeFence(suggestions[0])];
    }

    if (['high', 'medium', 'low'].includes(String(parsedFromRaw.priority).trim())) {
      priority = String(parsedFromRaw.priority).trim();
    }

    if (String(parsedFromRaw.estimatedEffort || '').trim()) {
      estimatedEffort = String(parsedFromRaw.estimatedEffort).trim();
    }
  } else if (suggestions.length === 1) {
    suggestions = [stripCodeFence(suggestions[0])];
  }

  const cleanedSuggestions = suggestions
    .map((item) => stripCodeFence(item))
    .filter(Boolean);

  return {
    concerns: concerns.length > 0 ? concerns : ['No strong structural smell was detected from the static graph metadata alone.'],
    suggestions: cleanedSuggestions.length > 0 ? cleanedSuggestions : ['Prefer smaller, testable functions and keep dependencies localized.'],
    priority: ['high', 'medium', 'low'].includes(priority) ? priority : 'medium',
    estimatedEffort: estimatedEffort || 'unknown',
  };
}

function InlineText({ text }) {
  const parts = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);

  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith('`') && part.endsWith('`')) {
          return (
            <code
              key={`${index}-${part}`}
              className="rounded border border-border/40 bg-background/70 px-1 py-0.5 font-mono text-[0.92em] text-foreground"
            >
              {part.slice(1, -1)}
            </code>
          );
        }

        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
        }

        return <span key={`${index}-${part}`}>{part}</span>;
      })}
    </>
  );
}

function MarkdownText({ text }) {
  const source = String(text || '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (code) {
      if (line.trim().startsWith('```')) {
        blocks.push(code);
        code = null;
      } else {
        code.content.push(rawLine);
      }
      continue;
    }

    const fenceMatch = line.trim().match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      flushParagraph();
      flushList();
      code = { type: 'code', language: fenceMatch[1] || '', content: [] };
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2].trim() });
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { type: 'list', ordered: false, items: [] };
      }
      list.items.push(bulletMatch[1].trim());
      continue;
    }

    const orderedMatch = line.match(/^\d+[.)]\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { type: 'list', ordered: true, items: [] };
      }
      list.items.push(orderedMatch[1].trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();

  if (code) blocks.push(code);

  return (
    <div className="space-y-3 leading-relaxed text-foreground/80">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const sizeClass = block.level === 1 ? 'text-sm' : block.level === 2 ? 'text-[13px]' : 'text-[12px]';
          return (
            <div key={`${block.type}-${index}`} className={`${sizeClass} font-semibold text-foreground`}>
              <InlineText text={block.text} />
            </div>
          );
        }

        if (block.type === 'paragraph') {
          return (
            <p key={`${block.type}-${index}`} className="whitespace-pre-wrap">
              <InlineText text={block.text} />
            </p>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={`${block.type}-${index}`}
              className={`space-y-1 ${block.ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${index}-${itemIndex}`}>
                  <InlineText text={item} />
                </li>
              ))}
            </ListTag>
          );
        }

        if (block.type === 'code') {
          return (
            <pre
              key={`${block.type}-${index}`}
              className="overflow-x-auto rounded-lg border border-border/40 bg-background/80 p-3 text-[11px] leading-relaxed text-foreground"
            >
              <code>
                {block.language ? `${block.language}\n` : ''}
                {block.content.join('\n')}
              </code>
            </pre>
          );
        }

        return null;
      })}
    </div>
  );
}

function RefactorSuggestionView({ suggestion }) {
  const normalized = useMemo(() => normalizeRefactorSuggestion(suggestion), [suggestion]);

  return (
    <div className="space-y-3 text-xs">
      <div>
        <p className="mb-1 font-medium text-foreground/80">Concerns</p>
        <ul className="space-y-1 text-muted-foreground">
          {normalized.concerns.map((item, index) => (
            <li key={`${item}-${index}`} className="rounded-md border border-border/30 bg-background/40 px-2 py-1">
              <InlineText text={item} />
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1 font-medium text-foreground/80">Suggestions</p>
        <ul className="space-y-1 text-muted-foreground">
          {normalized.suggestions.map((item, index) => (
            <li key={`${item}-${index}`} className="rounded-md border border-border/30 bg-background/40 px-2 py-1">
              <InlineText text={item} />
            </li>
          ))}
        </ul>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Priority: {normalized.priority} · Effort: {normalized.estimatedEffort}
      </p>
    </div>
  );
}

// ─── component ──────────────────────────────────────────────────────────────

export default function AiPanel({ nodeId, graph, onClose }) {
  const dispatch = useDispatch();
  const graphData = useSelector(selectGraphData);
  const impactState = useSelector(selectAiImpactState);
  const jobId = graphData?.jobId || graphData?.job?.jobId || graphData?.job?.id || null;

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
      setRefactorSuggestion(
        buildLocalRefactorSuggestion({
          type,
          summary,
          declarations,
          deps,
          usedBy,
        }),
      );
      setRefactorError('AI refactor suggestions are unavailable right now. Showing a local graph-based fallback instead.');
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
        <div className="min-h-15 rounded-lg border border-border/40 bg-muted/20 p-3 text-xs leading-relaxed text-foreground/80">
          {isStreaming && !streamedText && (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Generating explanation…
            </span>
          )}
          {streamedText && <MarkdownText text={streamedText} />}
          {isStreaming && streamedText && (
            <span className="ml-1 inline-block size-1.5 animate-pulse rounded-full bg-primary" />
          )}
          {!isStreaming && !streamedText && !streamError && (
            <span className="text-muted-foreground">No explanation yet.</span>
          )}
          {/* BUG 1 FIX: display the friendly error message */}
          {streamError && (
            <div className="space-y-2">
              <div className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{streamError}</span>
              </div>
              <div className="rounded-md border border-border/40 bg-background/60 p-2 text-foreground/75">
                {buildLocalExplanation({
                  nodeId,
                  type,
                  summary,
                  declarations,
                  deps,
                  usedBy,
                })}
              </div>
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
          <p className="text-[10px] text-muted-foreground">{refactorError}</p>
        )}
        {refactorSuggestion && <RefactorSuggestionView suggestion={refactorSuggestion} />}
      </section>
    </div>
  );
}
