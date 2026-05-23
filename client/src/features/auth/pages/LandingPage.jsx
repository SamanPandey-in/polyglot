import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, GitBranch, Network, Zap, Code2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const FEATURES = [
  {
    icon: <GitBranch className="size-5 text-primary" />,
    title: 'AST Parsing',
    description: 'Deep static analysis of your JS/TS codebase using Babel parser.',
  },
  {
    icon: <Network className="size-5 text-primary" />,
    title: 'Dependency Graph',
    description: 'Interactive visual graph of every import relationship.',
  },
  {
    icon: <Zap className="size-5 text-primary" />,
    title: 'AI-Ready',
    description: 'Built for Phase 2 AI features — impact analysis, dead code, Q&A.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border/10 bg-background/60 backdrop-blur-xl transition-colors duration-500">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3 group cursor-pointer active-scale transition-all">
            <div className="flex size-9 items-center justify-center rounded-xl bg-gold/10 shadow-neu-inset border border-gold/20 group-hover:scale-110 transition-transform duration-300">
              <Code2 className="size-5 text-gold" />
            </div>
            <span className="font-display font-bold text-lg tracking-tight text-foreground">
              PolyGlot
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/login">
              <Button variant="ghost" size="sm" className="font-bold tracking-tight text-muted-foreground hover:text-foreground active-scale transition-all">Log in</Button>
            </Link>
            <Link to="/signup">
              <Button size="sm" className="bg-gold text-white hover:bg-gold/90 shadow-md font-bold tracking-tight active-scale transition-all">Get started</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto flex w-full max-w-6xl flex-col items-center justify-center px-6 py-24 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full shadow-neu-inset border-none bg-background/60 px-4 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground/70 animate-in fade-in slide-in-from-top-4 duration-700">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          Phase 1 — Parsing &amp; Visualization active
        </div>

        <h1 className="text-5xl font-display font-black tracking-tight sm:text-7xl leading-[1.05] animate-in fade-in slide-in-from-bottom-8 duration-1000 fill-mode-both">
          Understand any <br />
          <span className="text-gradient-gold">codebase</span> in seconds
        </h1>

        <p className="mt-8 max-w-2xl text-lg text-muted-foreground leading-relaxed font-medium transition-all duration-700 animate-in fade-in slide-in-from-bottom-4 delay-300 fill-mode-both">
          Point PolyGlot at any local repository. It parses every import,
          builds a live dependency graph, and gives you a visual map you can
          actually navigate.
        </p>

        <div className="mt-12 flex flex-col items-center gap-4 sm:flex-row animate-in fade-in slide-in-from-bottom-4 delay-500 fill-mode-both">
          <Link to="/signup">
            <Button size="lg" className="h-14 px-8 gap-3 bg-gold text-white hover:bg-gold/90 shadow-xl rounded-2xl font-black uppercase tracking-widest text-xs active-scale transition-all">
              Start for free <ArrowRight className="size-4" />
            </Button>
          </Link>
          <Link to="/login">
            <Button size="lg" variant="outline" className="h-14 px-8 rounded-2xl shadow-neu-inset border-none bg-background/50 text-foreground font-black uppercase tracking-widest text-xs active-scale transition-all">
              Sign in
            </Button>
          </Link>
        </div>

        <div className="mt-24 grid w-full gap-6 sm:grid-cols-3">
          {FEATURES.map((f, idx) => (
            <Card 
              key={f.title} 
              className="text-left rounded-3xl shadow-neu-inset border-none bg-background/40 hover:bg-background/60 transition-all duration-500 active-scale group animate-in fade-in slide-in-from-bottom-4 fill-mode-both"
              style={{ animationDelay: `${700 + idx * 100}ms` }}
            >
              <CardContent className="pt-8 pb-10">
                <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-gold/10 shadow-neu-inset border border-gold/20 group-hover:scale-110 transition-transform duration-500">
                  {f.icon}
                </div>
                <h3 className="text-xl font-display font-bold text-foreground tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground/80 leading-relaxed font-medium">{f.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>

      <footer className="border-t border-border/10 py-10 text-center">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40">
          © {new Date().getFullYear()} PolyGlot · Advanced Parsing Engine
        </p>
      </footer>
    </div>
  );
}
