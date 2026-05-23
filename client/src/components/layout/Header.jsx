import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Menu, X, Code2, LogOut, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/context/AuthContext';
import { ThemeToggle } from '@/features/theme';

export default function Header({ isSidebarOpen, onSidebarToggle }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-border/20 glass-premium px-6">
      <Button
        variant="ghost"
        size="icon"
        className="size-10 lg:hidden text-muted-foreground hover:text-gold hover:bg-gold/10 transition-colors"
        onClick={onSidebarToggle}
        aria-label={isSidebarOpen ? 'Close menu' : 'Open menu'}
      >
        {isSidebarOpen ? <X className="size-5" /> : <Menu className="size-5" />}
      </Button>

      <Link
        to="/dashboard"
        className="flex items-center gap-2 font-display font-bold text-base lg:hidden group"
      >
        <div className="flex size-7 items-center justify-center rounded-lg bg-gold/10 shadow-neu-inset border border-gold/20">
          <Code2 className="size-4 text-gold" />
        </div>
        <span className="text-foreground tracking-tight">PolyGlot</span>
      </Link>

      <div className="flex-1" />

      <div className="flex items-center gap-3">
        <ThemeToggle />

        {user && (
          <div className="flex items-center gap-3 ml-2">
            <div className="hidden sm:flex items-center gap-2 rounded-2xl border border-border/40 bg-background/40 px-4 py-1.5 shadow-neu-inset backdrop-blur-sm">
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.username}
                  className="size-6 rounded-full ring-2 ring-gold/20 shadow-sm"
                />
              ) : (
                <div className="flex size-6 items-center justify-center rounded-full bg-gold/10 border border-gold/20">
                  <User className="size-3.5 text-gold" />
                </div>
              )}
              <span className="text-xs font-semibold text-foreground/80 tracking-wide">
                {user.username || user.email}
              </span>
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="size-10 text-muted-foreground hover:text-gold hover:bg-gold/10 transition-all rounded-xl"
              onClick={handleLogout}
              aria-label="Sign out"
            >
              <LogOut className="size-5" />
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
