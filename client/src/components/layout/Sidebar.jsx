import React from 'react';
import { NavLink, Link } from 'react-router-dom';
import {
  Code2,
  LayoutDashboard,
  Network,
  Share2,
  ChevronLeft,
  ChevronRight,
  UploadIcon,
  GitGraphIcon,
  MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV_ITEMS = [
  {
    to: '/dashboard',
    icon: <LayoutDashboard className="size-4 shrink-0" />,
    label: 'Dashboard',
  },
  {
    to: '/upload-repo',
    icon: <UploadIcon className="size-4 shrink-0" />,
    label: 'Upload Repo',
  },
  {
    to: '/analyze',
    icon: <GitGraphIcon className="size-4 shrink-0" />,
    label: 'Analyze',
  },
  {
    to: '/graph',
    icon: <Network className="size-4 shrink-0" />,
    label: 'Graph',
  },
  {
    to: '/ask',
    icon: <MessageSquare className="size-4 shrink-0" />,
    label: 'Ask',
  },
];

export default function Sidebar({
  isOpen,
  isCollapsed,
  onClose,
  onToggleCollapse,
}) {
  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border/40 glass-premium',
            'transition-all duration-500 ease-in-out',
            isCollapsed ? 'lg:w-20' : 'lg:w-64',
            isOpen ? 'translate-x-0 w-64' : '-translate-x-full lg:translate-x-0',
          )}
        >
          <div className="flex h-16 items-center gap-2 border-b border-border/20 px-6 shrink-0">
            <Link
              to="/dashboard"
              onClick={onClose}
              className="flex items-center gap-3 min-w-0 group"
            >
              <div className="flex size-8 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border border-gold/20 group-hover:scale-110 transition-transform duration-300">
                <Code2 className="size-5 text-gold" />
              </div>
              {!isCollapsed && (
                <span className="font-display font-bold text-base tracking-tight text-foreground">
                  PolyGlot
                </span>
              )}
            </Link>
          </div>
  
          <nav className="flex-1 overflow-y-auto py-8 px-4">
            <ul className="flex flex-col gap-3">
              {NAV_ITEMS.map(({ to, icon, label }, index) => (
                <li 
                  key={to}
                  style={{ animationDelay: `${index * 50}ms` }}
                  className="animate-in fade-in slide-in-from-left-4 duration-500 fill-mode-both"
                >
                  <NavLink
                    to={to}
                    onClick={onClose}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition-all duration-300 group',
                        isActive
                          ? 'shadow-neu-inset text-gold bg-muted/40'
                          : 'text-muted-foreground hover:bg-muted/30 hover:text-foreground',
                        isCollapsed && 'justify-center px-2',
                      )
                    }
                    title={isCollapsed ? label : undefined}
                  >
                    <span className={cn(
                      "shrink-0 transition-transform duration-300 group-hover:scale-110",
                      isCollapsed ? "size-6" : "size-5"
                    )}>
                      {icon}
                    </span>
                    {!isCollapsed && <span className="truncate tracking-wide">{label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

        <div className="hidden lg:flex border-t border-border p-2 justify-end">
          <button
            onClick={onToggleCollapse}
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isCollapsed ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronLeft className="size-4" />
            )}
          </button>
        </div>
      </aside>
    </>
  );
}
