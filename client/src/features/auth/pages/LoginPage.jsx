import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Github, Code2, Sparkles, Zap, Mail, Lock, User, ArrowRight } from 'lucide-react';
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

export default function LoginPage() {
  const { loginWithGithub, loginWithDemo, demoAuthEnabled, demoCredentials } =
    useAuth();
  const navigate = useNavigate();
  const [githubLoading, setGithubLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  const handleGithubLogin = () => {
    setGithubLoading(true);
    loginWithGithub();
  };

  const handleDemoLogin = () => {
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

          <div className="space-y-2 mb-10 text-center lg:text-left">
            <h1 className="text-4xl font-display font-extrabold tracking-tight text-foreground">Welcome Back</h1>
            <p className="text-sm text-muted-foreground font-medium">Access your intelligent codebase visualization engine.</p>
          </div>

          <div className="space-y-4">
            <Button
              onClick={handleGithubLogin}
              disabled={githubLoading}
              className="w-full h-14 bg-[#24292f] hover:bg-[#1a1e22] text-white rounded-2xl font-bold tracking-wide text-sm shadow-xl transition-all active:scale-[0.98] flex items-center justify-center gap-3"
            >
              <Github className="size-5" />
              {githubLoading ? 'Connecting to GitHub...' : 'Continue with GitHub'}
            </Button>

            {demoAuthEnabled && (
              <div className="space-y-4 pt-4 border-t border-border/10">
                <Button
                  onClick={handleDemoLogin}
                  disabled={demoLoading}
                  variant="outline"
                  className="w-full h-14 rounded-2xl border-none shadow-neu-inset bg-background/50 text-foreground font-bold hover:bg-muted/50 transition-all active:scale-[0.98]"
                >
                  {demoLoading ? 'Authenticating...' : 'Sign in as Demo User'}
                </Button>

                <div className="rounded-2xl bg-background/60 shadow-neu-inset border-none p-4 text-[10px] text-center">
                  <span className="uppercase font-black tracking-widest text-muted-foreground/60 block mb-1">Development Mode</span>
                  <span className="text-foreground/70 font-mono tracking-tight font-bold">
                    {demoCredentials.username} <span className="mx-2 opacity-30">|</span> {demoCredentials.password}
                  </span>
                </div>
              </div>
            )}
          </div>

          <p className="mt-12 text-center text-xs text-muted-foreground font-medium">
            By signing in you agree to our{' '}
            <Link to="/terms" className="text-gold font-bold hover:underline underline-offset-4">Terms</Link>
            {' '}and{' '}
            <Link to="/privacy" className="text-gold font-bold hover:underline underline-offset-4">Privacy Policy</Link>
          </p>

          <p className="mt-4 text-center text-sm">
            <span className="text-muted-foreground font-medium">Don't have an account? </span>
            <Link to="/signup" className="text-gold font-black hover:underline underline-offset-4">Sign Up</Link>
          </p>
        </div>

        {/* Right Side: Visual Accent */}
        <div className="hidden lg:flex flex-col justify-end w-1/2 bg-[rgb(var(--auth-panel))] p-16 relative overflow-hidden animate-in fade-in slide-in-from-right-8 duration-1000">
          {/* Abstract Gold Art */}
          <div className="absolute inset-0 opacity-40">
            <div className="absolute top-[-10%] right-[-10%] size-[500px] rounded-full bg-gold/5 blur-[120px] animate-pulse" />
            <div className="absolute bottom-[-20%] left-[-10%] size-[400px] rounded-full bg-gold/5 blur-[100px]" />
          </div>

          <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] opacity-5" />

          <div className="relative z-10 space-y-6">
            <div className="size-16 rounded-3xl bg-gold/10 border border-gold/30 flex items-center justify-center shadow-lg backdrop-blur-sm">
              <Zap className="size-8 text-gold animate-bounce-subtle" />
            </div>
            <div>
              <h2 className="text-5xl font-display font-black text-white tracking-tight leading-[1.1]">
                Visualize the <span className="text-gradient-gold">logic</span> of your code.
              </h2>
              <p className="mt-6 text-xl text-gray-400 font-medium leading-relaxed max-w-sm">
                Join the elite engineers using visual intelligence to master complex architectures.
              </p>
            </div>

            <div className="pt-10 flex items-center gap-6">
              <div className="flex -space-x-3">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="size-10 rounded-full border-2 border-[#0B0B0B] bg-gray-800 shadow-xl overflow-hidden ring-1 ring-gold/20">
                    <img src={`https://i.pravatar.cc/100?u=${i}`} alt="user" className="size-full object-cover opacity-80" />
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-gray-500 font-black uppercase tracking-[0.2em]">Trusted by 2k+ developers</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
