import React from 'react';
import { GitBranch, Network } from 'lucide-react';

const TABS = [
  { id: 'reactflow', label: 'Flow Graph', icon: GitBranch },
  { id: 'cytoscape', label: 'Cytoscape View', icon: Network },
];

export default function GraphTabBar({ activeTab, onChange }) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-xl p-1 self-start"
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
      }}
      role="tablist"
      aria-label="Graph view switcher"
    >
      {TABS.map(({ id, label, icon: TabIcon }) => {
        const isActive = activeTab === id;
        const TabIconComponent = TabIcon;

        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-200"
            style={{
              background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
              color: isActive ? '#3b82f6' : 'var(--text-muted)',
              border: isActive ? '1px solid rgba(59,130,246,0.25)' : '1px solid transparent',
            }}
          >
            <TabIconComponent size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}