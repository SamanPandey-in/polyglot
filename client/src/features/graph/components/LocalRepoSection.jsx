import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, FolderOpen, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { graphService } from '../services/graphService';

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);

  return debouncedValue;
}

export default function LocalRepoSection({ disabled, initialPath = '', onReady }) {
  const inputRef = useRef(null);
  const [path, setPath] = useState(initialPath);
  const [validationState, setValidationState] = useState('idle');
  const [validationError, setValidationError] = useState('');
  const [browseState, setBrowseState] = useState('idle');
  const [browseError, setBrowseError] = useState('');
  const [pickerSupported, setPickerSupported] = useState(false);
  const [pickerMessage, setPickerMessage] = useState('');
  const [submitState, setSubmitState] = useState('idle');
  const [submitError, setSubmitError] = useState('');

  const debouncedPath = useDebounce(path.trim(), 600);

  useEffect(() => {
    setPath(initialPath || '');
    setValidationState('idle');
    setValidationError('');
    setBrowseState('idle');
    setBrowseError('');
    setSubmitState('idle');
    setSubmitError('');
  }, [initialPath]);

  useEffect(() => {
    let alive = true;

    setPickerMessage('Checking folder picker availability...');
    graphService.getLocalPickerCapabilities()
      .then((data) => {
        if (!alive) return;
        setPickerSupported(Boolean(data?.supported));
        setPickerMessage(data?.message || 'Native folder picker unavailable, paste an absolute path manually.');
      })
      .catch(() => {
        if (!alive) return;
        setPickerSupported(false);
        setPickerMessage('Native folder picker unavailable, paste an absolute path manually.');
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!debouncedPath) {
      setValidationState('idle');
      setValidationError('');
      return;
    }

    let alive = true;
    setValidationState('loading');
    setValidationError('');

    graphService.validateLocalPath(debouncedPath)
      .then(() => {
        if (!alive) return;
        setValidationState('succeeded');
      })
      .catch((error) => {
        if (!alive) return;
        setValidationState('failed');
        setValidationError(error?.response?.data?.error || error?.message || 'Path validation failed.');
      });

    return () => {
      alive = false;
    };
  }, [debouncedPath]);

  const handleBrowse = useCallback(async () => {
    if (!pickerSupported || disabled) return;

    setBrowseState('loading');
    setBrowseError('');

    try {
      const result = await graphService.browseLocalPath();
      if (!result?.path) {
        // User cancelled the native picker.
        setBrowseState('idle');
        return;
      }

      setPath(result.path);
      setValidationState('idle');
      setValidationError('');
      setBrowseState('idle');
      inputRef.current?.focus();
    } catch (error) {
      const status = error?.response?.status;
      const serverMessage = error?.response?.data?.error || error?.message || '';

      if (status === 400 || serverMessage.toLowerCase().includes('cancel')) {
        setBrowseState('idle');
        return;
      }

      if (status === 408 || error?.code === 'ECONNABORTED') {
        setBrowseState('failed');
        setBrowseError('Folder picker timed out. Please paste the path manually.');
        return;
      }

      if (status === 501) {
        setBrowseState('idle');
        setPickerSupported(false);
        setPickerMessage(serverMessage || 'Native folder picker unavailable, paste an absolute path manually.');
        return;
      }

      setBrowseState('failed');
      setBrowseError(serverMessage || 'Could not open native folder picker.');
    }
  }, [disabled, pickerSupported]);

  const handleAnalyze = useCallback(async () => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setValidationState('failed');
      setValidationError('Enter an absolute path to a local repository.');
      return;
    }

    setSubmitState('loading');
    setSubmitError('');

    try {
      if (validationState !== 'succeeded') {
        await graphService.validateLocalPath(trimmedPath);
        setValidationState('succeeded');
        setValidationError('');
      }

      onReady(trimmedPath);
    } catch (error) {
      setValidationState('failed');
      setValidationError(error?.response?.data?.error || error?.message || 'Invalid repository path.');
      setSubmitError(error?.response?.data?.error || error?.message || 'Invalid repository path.');
    } finally {
      setSubmitState('idle');
    }
  }, [onReady, path, validationState]);

  const canAnalyze = Boolean(path.trim()) && validationState !== 'loading' && submitState !== 'loading';
  const isBusy = disabled || validationState === 'loading' || browseState === 'loading' || submitState === 'loading';
  const isWindows = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Win');

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 shadow-neu-inset animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-xs text-primary">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          Enter an absolute path to a local git repository on this machine. The backend server must have read access to the path.
          {!pickerSupported && pickerMessage && <span> {pickerMessage}</span>}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="local-repo-path" className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground/70">
          Repository path
        </Label>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              id="local-repo-path"
              type="text"
              value={path}
              onChange={(event) => {
                setPath(event.target.value);
                setValidationState('idle');
                setValidationError('');
                setSubmitError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canAnalyze) {
                  handleAnalyze();
                }
              }}
              placeholder={isWindows ? 'C:\\Users\\you\\my-project' : '/home/you/my-project'}
              className="pl-9 font-mono text-sm"
              disabled={isBusy}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={handleBrowse}
            disabled={isBusy || !pickerSupported}
            className="shrink-0 rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
            title={pickerSupported ? 'Open native folder picker' : pickerMessage || 'Native folder picker unavailable'}
          >
            {browseState === 'loading' ? (
              <>
                <Loader2 className="animate-spin" />
                Opening
              </>
            ) : pickerMessage === 'Checking folder picker availability...' ? (
              <>
                <Loader2 className="animate-spin" size={14} />
                Browse
              </>
            ) : (
              <>
                <FolderOpen />
                Browse
              </>
            )}
          </Button>
        </div>
      </div>

      {validationState === 'loading' && path.trim() && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Validating path...
        </p>
      )}

      {validationState === 'succeeded' && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <CheckCircle2 className="size-3.5" />
          Path is a valid git repository.
        </p>
      )}

      {validationState === 'failed' && validationError && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          {validationError}
        </p>
      )}

      {browseState === 'failed' && browseError && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          {browseError}
        </p>
      )}

      {submitState === 'idle' && submitError && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          {submitError}
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Use an absolute path. Relative paths and ~ shortcuts are not supported.
      </p>

      <Button
        type="button"
        size="lg"
        className="mt-2 h-12 w-full rounded-2xl font-black uppercase tracking-widest text-xs transition-all active:scale-[0.98]"
        style={{
          background: canAnalyze ? '#3b82f6' : 'var(--bg-muted)',
          color: canAnalyze ? '#fff' : 'var(--text-muted)',
          cursor: canAnalyze ? 'pointer' : 'not-allowed',
        }}
        disabled={!canAnalyze || isBusy}
        onClick={handleAnalyze}
      >
        {submitState === 'loading' ? (
          <>
            <Loader2 className="mr-2 animate-spin" />
            Analysing...
          </>
        ) : (
          <>
            Analyse Codebase
            <ArrowRight className="ml-2 size-4" />
          </>
        )}
      </Button>
    </div>
  );
}
