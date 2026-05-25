import React, { useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Plus, SendHorizonal, Square } from 'lucide-react';
import { selectGraphData } from '../../graph/slices/graphSlice';
import { aiService } from '../services/aiService';
import {
  addUserMessage,
  beginStreaming,
  clearConversation,
  appendStreamChunk,
  finalizeStream,
  setStreamError,
  selectConversationId,
  selectIsStreaming,
} from '../slices/conversationSlice';

const MAX_ROWS = 6;

export default function ChatInput({ jobId: jobIdProp, placeholder }) {
  const dispatch = useDispatch();
  const graphData = useSelector(selectGraphData);
  const conversationId = useSelector(selectConversationId);
  const isStreaming = useSelector(selectIsStreaming);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const [text, setText] = useState('');

  const jobId = jobIdProp || graphData?.jobId || graphData?.job?.jobId || graphData?.job?.id || null;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS * 24)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !!jobId && !isStreaming;

  const handleSend = async () => {
    if (!canSend) return;

    const question = text.trim();
    setText('');
    textareaRef.current?.focus();

    dispatch(addUserMessage({ content: question }));
    dispatch(beginStreaming());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await aiService.streamChat({
        question,
        jobId,
        conversationId,
        signal: controller.signal,
        onChunk: (chunkText) => dispatch(appendStreamChunk({ text: chunkText })),
        onDone: (event) => dispatch(finalizeStream({ conversationId: event.conversationId, sources: event.sources })),
        onError: (err) => dispatch(setStreamError({ message: err?.message || 'Chat failed.' })),
      });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        dispatch(setStreamError({ message: error?.message || 'Chat failed.' }));
      }
    } finally {
      abortRef.current = null;
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    dispatch(setStreamError({ message: 'Response cancelled.' }));
  };

  const handleNewConversation = () => {
    abortRef.current?.abort();
    dispatch(clearConversation());
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex items-end gap-2 rounded-2xl px-3 py-2" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={handleNewConversation}
        title="Start new conversation"
        className="mb-0.5 shrink-0 rounded-lg p-1.5 transition-colors"
        style={{ color: 'var(--text-muted)' }}
        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--bg-muted)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
      >
        <Plus size={15} />
      </button>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || (jobId ? 'Ask about your codebase… (Shift+Enter for new line)' : 'Run an analysis first')}
        disabled={!jobId || isStreaming}
        rows={1}
        className="flex-1 resize-none bg-transparent py-1.5 text-sm outline-none"
        style={{ color: 'var(--text)', maxHeight: `${MAX_ROWS * 24}px`, lineHeight: '24px' }}
      />

      {isStreaming ? (
        <button
          type="button"
          onClick={handleStop}
          className="mb-0.5 shrink-0 rounded-xl p-2 transition-colors"
          style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}
          title="Stop generating"
        >
          <Square size={15} />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="mb-0.5 shrink-0 rounded-xl p-2 transition-all"
          style={{ background: canSend ? '#3b82f6' : 'var(--bg-muted)', color: canSend ? '#fff' : 'var(--text-muted)' }}
          title="Send"
        >
          <SendHorizonal size={15} />
        </button>
      )}
    </div>
  );
}