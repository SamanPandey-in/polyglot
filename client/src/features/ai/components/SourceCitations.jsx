import React, { useState } from 'react';
import { ChevronDown, ChevronUp, FileCode2 } from 'lucide-react';

function getFileLabel(path) {
  const value = String(path || '').trim();
  if (!value) return 'file';
  return value.split('/').pop() || value;
}

function getFileCluster(path) {
  const value = String(path || '').toLowerCase();
  if (/test|spec/.test(value)) return { label: 'Test', color: '#94a3b8' };
  if (/component|page|view/.test(value)) return { label: 'UI', color: '#38bdf8' };
  if (/controller|route/.test(value)) return { label: 'API', color: '#4ade80' };
  if (/service|util|lib/.test(value)) return { label: 'Service', color: '#2dd4bf' };
  if (/db|model|schema/.test(value)) return { label: 'Data', color: '#fbbf24' };
  return { label: 'File', color: '#94a3b8' };
}

export default function SourceCitations({ sources = [], onSourceClick }) {
  const [expanded, setExpanded] = useState(false);
  if (!sources.length) return null;

  const shown = expanded ? sources : sources.slice(0, 3);
  const hidden = Math.max(0, sources.length - shown.length);

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase font-semibold tracking-widest" style={{ color: 'var(--text-muted)' }}>
        Sources ({sources.length})
      </p>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((path) => {
          const cluster = getFileCluster(path);

          return (
            <button
              type="button"
              key={path}
              title={path}
              onClick={() => onSourceClick?.(path)}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-mono transition-colors hover:brightness-105"
              style={{
                background: `${cluster.color}15`,
                border: `1px solid ${cluster.color}40`,
                color: cluster.color,
              }}
            >
              <FileCode2 size={10} />
              {getFileLabel(path)}
            </button>
          );
        })}

        {!expanded && hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px]"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            +{hidden} more <ChevronDown size={10} />
          </button>
        )}
        {expanded && hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[10px]"
            style={{ background: 'var(--bg-muted)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
          >
            Show less <ChevronUp size={10} />
          </button>
        )}
      </div>
    </div>
  );
}