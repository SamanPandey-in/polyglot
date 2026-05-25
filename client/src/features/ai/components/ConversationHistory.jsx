import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChevronDown, History, Loader2, RotateCw } from 'lucide-react';
import { aiService } from '../services/aiService';
import {
  loadConversationMessages,
  setHistory,
  setHistoryStatus,
  selectConversationHistory,
  selectConversationHistoryStatus,
} from '../slices/conversationSlice';

const HISTORY_LIMIT = 8;

function formatRelativeDate(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / (60 * 1000));

  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export default function ConversationHistory({ jobId }) {
  const dispatch = useDispatch();
  const history = useSelector(selectConversationHistory);
  const historyStatus = useSelector(selectConversationHistoryStatus);
  const [isOpen, setIsOpen] = useState(false);
  const [error, setError] = useState('');

  const isLoading = historyStatus === 'loading';

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!jobId) {
        if (!cancelled) {
          dispatch(setHistory([]));
          dispatch(setHistoryStatus('idle'));
          setError('');
          setIsOpen(false);
        }
        return;
      }

      dispatch(setHistoryStatus('loading'));
      setError('');

      try {
        const data = await aiService.getConversations({ jobId });
        if (cancelled) return;

        dispatch(setHistory(Array.isArray(data?.conversations) ? data.conversations : []));
        dispatch(setHistoryStatus('succeeded'));
        if (!Array.isArray(data?.conversations) || data.conversations.length === 0) {
          setIsOpen(false);
        }
      } catch (loadError) {
        if (cancelled) return;

        dispatch(setHistory([]));
        dispatch(setHistoryStatus('failed'));
        setError(loadError?.response?.data?.error || loadError?.message || 'Failed to load conversation history.');
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [dispatch, jobId]);

  if (!jobId) return null;

  return (
    <div className="overflow-hidden rounded-xl border-none bg-background/20 shadow-neu-inset transition-all duration-500">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-all duration-300 hover:bg-background/40 active:scale-[0.99]"
      >
        <span className="flex items-center gap-2.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60">
          <History className="size-3.5" />
          Chat Threads
        </span>
        <span className="flex items-center gap-3">
          {isLoading && <Loader2 className="size-3.5 animate-spin text-gold/60" />}
          {history.length > 0 && (
            <span className="rounded-full border-none bg-background/50 px-2.5 py-0.5 text-[9px] font-bold shadow-neu-inset text-gold/80">
              {history.length}
            </span>
          )}
          <ChevronDown className={`size-3.5 text-muted-foreground/40 transition-transform duration-500 ease-out ${isOpen ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {isOpen && (
        <div className="border-t border-border/70 px-3 py-2">
          {error && <p className="text-xs text-destructive/80">{error}</p>}

          {!error && !isLoading && history.length === 0 && (
            <p className="text-xs text-muted-foreground">No saved chat threads for this analysis yet.</p>
          )}

          {!error && history.length > 0 && (
            <ul className="flex flex-col gap-1.5 animate-in fade-in slide-in-from-top-2 duration-500">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const data = await aiService.getConversationMessages({ conversationId: item.id });
                        dispatch(loadConversationMessages({ conversationId: item.id, messages: data?.messages || [] }));
                      } catch (loadMessagesError) {
                        setError(loadMessagesError?.response?.data?.error || loadMessagesError?.message || 'Failed to load conversation messages.');
                      }
                    }}
                    className="group flex w-full items-start justify-between gap-4 rounded-xl px-3 py-2.5 text-left transition-all duration-300 hover:bg-background shadow-neu-flat active:scale-[0.98]"
                  >
                    <span className="line-clamp-2 text-xs font-medium text-foreground/80 group-hover:text-gold transition-colors">
                      {item.title || 'Untitled conversation'}
                    </span>
                    <span className="shrink-0 text-[9px] font-bold uppercase tracking-tighter text-muted-foreground/30 mt-0.5">
                      {formatRelativeDate(item.updated_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!error && history.length > HISTORY_LIMIT && (
            <p className="mt-2 text-[10px] text-muted-foreground">Showing most recent {HISTORY_LIMIT} threads.</p>
          )}

          {!error && !isLoading && (
            <button
              type="button"
              onClick={async () => {
                dispatch(setHistoryStatus('loading'));
                setError('');

                try {
                  const data = await aiService.getConversations({ jobId });
                  dispatch(setHistory(Array.isArray(data?.conversations) ? data.conversations : []));
                  dispatch(setHistoryStatus('succeeded'));
                } catch (refreshError) {
                  dispatch(setHistoryStatus('failed'));
                  setError(refreshError?.response?.data?.error || refreshError?.message || 'Failed to refresh conversation history.');
                }
              }}
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <RotateCw className="size-3" />
              Refresh
            </button>
          )}
        </div>
      )}
    </div>
  );
}