import React, { useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertCircle, MessageSquareText, Network, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatInput, ChatThread, QueryHistory, initConversation } from '@/features/ai';
import { useDispatch } from 'react-redux';
import ConversationHistory from '../components/ConversationHistory';
import { selectGraphData } from '@/features/graph';

export default function AskPage() {
  const dispatch = useDispatch();
  const [searchParams] = useSearchParams();
  const graphData = useSelector(selectGraphData);

  const activeJobId = useMemo(() => {
    const urlJobId = String(searchParams.get('jobId') || '').trim();
    if (urlJobId) return urlJobId;
    return graphData?.jobId || null;
  }, [graphData?.jobId, searchParams]);

  useEffect(() => {
    if (activeJobId) {
      dispatch(initConversation({ jobId: activeJobId }));
    }
  }, [activeJobId, dispatch]);

  return (
    <div className="mx-auto flex h-[calc(100vh-6.75rem)] w-full max-w-375 flex-col px-4 pb-4 pt-6">
      <section className="rounded-2xl border border-border/60 bg-card/60 p-5 shadow-sm backdrop-blur-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="inline-flex items-center gap-2 rounded-full border border-gold/30 bg-gold/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold/90">
              <Sparkles className="size-3.5" />
              Ask Workspace AI
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Ask questions about your codebase</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Use natural language to inspect architecture, dependencies, and design trade-offs.
              Responses are scoped to your active analysis and saved in query history.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link to={activeJobId ? `/graph?jobId=${encodeURIComponent(activeJobId)}` : '/graph'}>
              <Button variant="outline" className="gap-2">
                <Network className="size-4" />
                Open Graph
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {!activeJobId ? (
        <section className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-3">
              <p>
                No active analysis found. Load a saved graph or run a new analysis first to ask
                context-aware questions.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link to="/dashboard">
                  <Button variant="outline" size="sm">Open dashboard</Button>
                </Link>
                <Link to="/analyze">
                  <Button size="sm">Run analysis</Button>
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="mt-4 grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <article className="min-h-0 rounded-2xl border border-border/60 bg-card/40 p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Query
                </p>
                <p className="text-sm text-muted-foreground">
                  Active analysis: <span className="font-mono text-foreground/80">{activeJobId}</span>
                </p>
              </div>
              <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600">
                <span className="size-2 rounded-full bg-emerald-500" />
                Ready
              </span>
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                <ChatThread />
              </div>
              <div className="shrink-0 pt-4">
                <ChatInput jobId={activeJobId} />
              </div>
            </div>
          </article>

          <aside className="min-h-0 rounded-2xl border border-border/60 bg-card/30 p-4 shadow-sm">
            <div className="mb-3">
              <ConversationHistory jobId={activeJobId} />
            </div>
            <div className="mb-2 flex items-center gap-2">
              <MessageSquareText className="size-4 text-muted-foreground" />
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Query History
              </p>
            </div>
            <QueryHistory jobId={activeJobId} />
          </aside>
        </section>
      )}
    </div>
  );
}
