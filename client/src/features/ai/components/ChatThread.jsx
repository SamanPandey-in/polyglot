import React, { useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { AlertCircle, Bot, Loader2, User } from 'lucide-react';
import {
  selectMessages,
  selectIsStreaming,
  selectStreamingText,
  selectStreamError,
} from '../slices/conversationSlice';
import SourceCitations from './SourceCitations';

function UserBubble({ message }) {
  return (
    <div className="flex justify-end gap-2">
      <div className="max-w-[80%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm" style={{ background: '#3b82f6', color: '#fff' }}>
        {message.content}
      </div>
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: 'rgba(59,130,246,0.15)' }}>
        <User size={14} style={{ color: '#3b82f6' }} />
      </div>
    </div>
  );
}

function AssistantBubble({ message, isStreaming = false, onSourceClick }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: 'rgba(168,85,247,0.12)' }}>
        {isStreaming ? (
          <Loader2 size={14} className="animate-spin" style={{ color: '#a855f7' }} />
        ) : (
          <Bot size={14} style={{ color: '#a855f7' }} />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed" style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' }}>
          {message.content}
          {isStreaming && (
            <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm align-middle" style={{ background: '#a855f7' }} />
          )}
        </div>
        {!isStreaming && Array.isArray(message.sourceFiles) && message.sourceFiles.length > 0 && (
          <SourceCitations sources={message.sourceFiles} onSourceClick={onSourceClick} />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)' }}>
        <Bot size={22} style={{ color: '#a855f7' }} />
      </div>
      <div>
        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
          Ask anything about your codebase
        </p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Questions are answered using your active analysis context
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-1.5">
        {[
          'What are the most imported files?',
          'How does authentication flow through the app?',
          'Which files have the highest risk score?',
        ].map((hint) => (
          <p key={hint} className="rounded-lg px-3 py-1.5 text-left text-xs" style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>
            "{hint}"
          </p>
        ))}
      </div>
    </div>
  );
}

export default function ChatThread({ onSourceClick }) {
  const messages = useSelector(selectMessages);
  const isStreaming = useSelector(selectIsStreaming);
  const streamingText = useSelector(selectStreamingText);
  const streamError = useSelector(selectStreamError);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, streamingText]);

  if (!messages.length && !isStreaming) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-4 py-4 pr-1">
      {messages.map((message) => (
        message.role === 'user'
          ? <UserBubble key={message.id} message={message} />
          : <AssistantBubble key={message.id} message={message} onSourceClick={onSourceClick} />
      ))}

      {isStreaming && (
        <AssistantBubble message={{ content: streamingText || '', sourceFiles: [] }} isStreaming onSourceClick={onSourceClick} />
      )}

      {streamError && !isStreaming && (
        <div className="flex items-start gap-2 rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444' }}>
          <AlertCircle size={15} className="mt-0.5 shrink-0" />
          {streamError}
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}