import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Github, Code2, GitBranch, Network, Zap, ArrowRight, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '../context/AuthContext';

const FEATURE_LIST = [
  {
    icon: <div className="flex size-10 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border-none group-hover:scale-110 transition-transform duration-300"><GitBranch className="size-5 text-gold" /></div>,
    title: 'Code Analysis',
    description: 'Deep insights into your codebase structure',
  },
  {
    icon: <div className="flex size-10 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border-none group-hover:scale-110 transition-transform duration-300"><Network className="size-5 text-gold" /></div>,
    title: 'Dependency Graphs',
    description: 'Visualize every import relationship interactively',
  },
  {
    icon: <div className="flex size-10 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border-none group-hover:scale-110 transition-transform duration-300"><Zap className="size-5 text-gold" /></div>,
    title: 'AI-Ready',
    description: 'Smart impact analysis coming in Phase 2',
  },
];

export default function SignupPage() {
  const { loginWithGithub, loginWithDemo, demoAuthEnabled } = useAuth();
  const navigate = useNavigate();
  const [githubLoading, setGithubLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const handleGithubSignup = () => {
    setGithubLoading(true);
    loginWithGithub();
  };

  const handleDemoSignup = () => {
    setDemoLoading(true);
    loginWithDemo();
    navigate('/dashboard', { replace: true });
  };

  return (
    <div className="flex min-h-screen bg-background font-sans selection:bg-gold/30 selection:text-gold items-center justify-center p-4 sm:p-8">
      <div className="flex w-full max-w-5xl h-[700px] overflow-hidden rounded-[2.5rem] shadow-neu-inset border-none bg-background/40 group/container">
        {/* Left Side: Form */}
        <div className="flex flex-col justify-center w-full lg:w-1/2 p-8 sm:p-12 relative animate-in fade-in slide-in-from-left-8 duration-1000">
          <div className="mb-10 flex items-center gap-2 group cursor-pointer">
            <div className="flex size-9 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border border-gold/20 group-hover:scale-110 transition-transform duration-300">
              <Code2 className="size-5 text-gold" />
            </div>
            <span className="font-display font-black text-xl tracking-tight text-foreground">
              PolyGlot
            </span>
          </div>

          <div className="space-y-2 mb-8 text-center lg:text-left">
            <h1 className="text-4xl font-display font-extrabold tracking-tight text-foreground">Join the Future</h1>
            <p className="text-sm text-muted-foreground font-medium">Create your account to start mapping your code complexity.</p>
          </div>

          <div className="space-y-4">
            <Button
              onClick={handleGithubSignup}
              disabled={githubLoading}
              className="w-full h-14 bg-[#24292f] hover:bg-[#1a1e22] text-white rounded-2xl font-bold tracking-wide text-sm shadow-xl transition-all active:scale-[0.98] flex items-center justify-center gap-3"
            >
              <Github className="size-5" />
              {githubLoading ? 'Connecting to GitHub...' : 'Sign up with GitHub'}
            </Button>

            {demoAuthEnabled && (
              <Button
                onClick={handleDemoSignup}
                disabled={demoLoading}
                variant="outline"
                className="w-full h-14 rounded-2xl border-none shadow-neu-inset bg-background/50 text-foreground font-bold hover:bg-muted/50 transition-all active:scale-[0.98]"
              >
                {demoLoading ? 'Authenticating...' : 'Try Demo Experience'}
              </Button>
            )}
          </div>

          <p className="mt-8 text-center text-xs text-muted-foreground font-medium">
            By signing up you agree to our{' '}
            <Link to="/terms" className="text-gold font-bold hover:underline underline-offset-4">Terms</Link>
            {' '}and{' '}
            <Link to="/privacy" className="text-gold font-bold hover:underline underline-offset-4">Privacy Policy</Link>
          </p>

          <p className="mt-4 text-center text-sm">
            <span className="text-muted-foreground font-medium">Already have an account? </span>
            <Link to="/login" className="text-gold font-black hover:underline underline-offset-4">Sign In</Link>
          </p>

          <div className="mt-10 lg:hidden">
            <Separator className="mb-6 opacity-50" />
            <ul className="grid grid-cols-1 gap-4">
              {FEATURE_LIST.map((f, i) => (
                <li key={f.title} className="flex items-center gap-3">
                  {f.icon}
                  <span className="text-xs font-bold text-foreground/70">{f.title}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Right Side: Visual Accent */}
        <div className="hidden lg:flex flex-col justify-end w-1/2 bg-[rgb(var(--auth-panel))] p-16 relative overflow-hidden animate-in fade-in slide-in-from-right-8 duration-1000">
          {/* Abstract Gold Art */}
          <div className="absolute inset-0 opacity-40">
            <div className="absolute top-[-10%] right-[-10%] size-[500px] rounded-full bg-gold/5 blur-[120px] animate-pulse" />
            <div className="absolute bottom-[-20%] left-[-10%] size-[500px] rounded-full bg-gold/5 blur-[130px]" />
          </div>

          <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-5" />

          <div className="relative z-10 space-y-10">
            <div>
              <h2 className="text-5xl font-display font-black text-white tracking-tight leading-[1.1]">
                Master your <span className="text-gradient-gold">architecture</span>.
              </h2>
              <p className="mt-6 text-xl text-gray-400 font-medium leading-relaxed">
                The technical intelligence layer for modern engineering teams.
              </p>
            </div>

            <ul className="space-y-6">
              {FEATURE_LIST.map((f, i) => (
                <li
                  key={f.title}
                  className="flex items-start gap-4 group/item animate-in fade-in slide-in-from-right-4 fill-mode-both"
                  style={{ animationDelay: `${1200 + i * 150}ms` }}
                >
                  <div className="mt-1">{f.icon}</div>
                  <div>
                    <p className="text-base font-bold text-white tracking-tight group-hover/item:text-gold transition-colors">{f.title}</p>
                    <p className="text-sm text-gray-500 font-medium leading-relaxed">{f.description}</p>
                  </div>
                </li>
              ))}
            </ul>

            <div className="pt-6 border-t border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="size-4 text-gold" />
                <span className="text-[10px] text-gray-400 font-black uppercase tracking-[0.2em]">Open Source Ready</span>
              </div>
              <div className="flex items-center gap-3 text-gold">
                <span className="text-[10px] font-black uppercase tracking-[0.2em]">Learn More</span>
                <ArrowRight className="size-4" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
