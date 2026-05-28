import React, { useEffect, useMemo, useRef, useState } from 'react';
import Prism from 'prismjs';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import { useDispatch, useSelector } from 'react-redux';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  AlertTriangle,
  Check,
  Edit3,
  ExternalLink,
  GitBranch,
  Loader2,
  Pin,
  Save,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchRepositoryFile,
  fetchRepositoryStructure,
  saveRepositoryFile,
  selectAnalyzeFile,
  selectAnalyzeSelectedRepository,
  selectAnalyzeStructure,
} from '../slices/analyzeSlice';
import { AiPanel } from '@/features/ai';
import { loadSavedGraph, selectGraphData } from '@/features/graph';
import { aiService } from '@/features/ai/services/aiService';

function detectPrismLanguage(filePath = '') {
  const normalized = String(filePath).toLowerCase();

  if (normalized.endsWith('.ts')) return 'typescript';
  if (normalized.endsWith('.tsx')) return 'tsx';
  if (normalized.endsWith('.js')) return 'javascript';
  if (normalized.endsWith('.jsx')) return 'jsx';
  if (normalized.endsWith('.json')) return 'json';
  if (normalized.endsWith('.css')) return 'css';
  if (normalized.endsWith('.html')) return 'markup';
  if (normalized.endsWith('.md')) return 'markdown';
  if (normalized.endsWith('.yml') || normalized.endsWith('.yaml')) return 'yaml';
  if (normalized.endsWith('.py')) return 'python';
  if (normalized.endsWith('.sh')) return 'bash';

  return 'clike';
}

const SNIPPET_MIN_CHARS = 10;
const SNIPPET_MAX_AUTO_CHARS = 1200;

function isMeaningfulSnippet(snippet = '') {
  const normalized = String(snippet || '').trim();
  if (!normalized) return false;
  if (normalized.length < SNIPPET_MIN_CHARS) return false;

  const withoutComments = normalized
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/.*$/gm, '')
    .trim();

  if (!withoutComments) return false;
  if (/^[{}()[\];,\s]+$/.test(withoutComments)) return false;

  return true;
}

function normalizeConfidenceScore(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }

  const parsed = Number.parseFloat(String(value || '').replace('%', '').trim());
  if (Number.isNaN(parsed)) return null;
  const score = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, score));
}

function confidenceTone(score) {
  if (typeof score !== 'number') return 'text-muted-foreground';
  if (score >= 0.85) return 'text-emerald-600';
  if (score >= 0.65) return 'text-amber-600';
  return 'text-rose-600';
}

export default function AnalyzeFilePage() {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();

  const selectedRepository = useSelector(selectAnalyzeSelectedRepository);
  const structure = useSelector(selectAnalyzeStructure);
  const fileState = useSelector(selectAnalyzeFile);
  const graphData = useSelector(selectGraphData);

  const [editorValue, setEditorValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isAutoSnippetAnalyze, setIsAutoSnippetAnalyze] = useState(true);
  const [snippetState, setSnippetState] = useState({
    status: 'idle',
    error: '',
    notice: '',
    selectedSnippet: '',
    lineStart: null,
    lineEnd: null,
    data: null,
  });
  const [isSnippetDrawerOpen, setIsSnippetDrawerOpen] = useState(false);
  const [isMobileSnippetSheetOpen, setIsMobileSnippetSheetOpen] = useState(false);
  const [isSnippetPopoverPinned, setIsSnippetPopoverPinned] = useState(false);
  const [snippetPopoverAnchor, setSnippetPopoverAnchor] = useState({
    x: 0,
    y: 0,
    visible: false,
  });

  const editorGutterRef = useRef(null);
  const editorTextareaRef = useRef(null);
  const viewerGutterRef = useRef(null);
  const viewerCodeRef = useRef(null);
  const snippetAbortRef = useRef(null);
  const snippetDebounceRef = useRef(null);
  const snippetPanelRef = useRef(null);

  const routeDirectory = useMemo(() => {
    const raw = params.dir_name ? decodeURIComponent(params.dir_name) : '';
    return raw.trim();
  }, [params.dir_name]);

  const currentPath = useMemo(() => {
    const queryPath = String(searchParams.get('path') || '').trim();
    if (queryPath) return queryPath;
    return routeDirectory;
  }, [routeDirectory, searchParams]);

  const selectedFilePath = useMemo(() => {
    return String(searchParams.get('file') || '').trim();
  }, [searchParams]);

  useEffect(() => {
    dispatch(fetchRepositoryStructure());
  }, [dispatch]);

  useEffect(() => {
    if (!selectedFilePath) return;
    dispatch(fetchRepositoryFile({ path: selectedFilePath }));
  }, [dispatch, selectedFilePath]);

  const analysisJobId = selectedRepository?.jobId || selectedRepository?.latestJobId || graphData?.jobId || null;

  useEffect(() => {
    if (!analysisJobId) return;
    if (graphData?.jobId === analysisJobId) return;

    dispatch(
      loadSavedGraph({
        jobId: analysisJobId,
        rootDir: selectedRepository?.fullName || null,
      }),
    );
  }, [analysisJobId, dispatch, graphData?.jobId, selectedRepository?.fullName]);

  useEffect(() => {
    const fileContent = fileState.data?.content;
    if (typeof fileContent !== 'string') return;
    setEditorValue(fileContent);
    setIsEditing(false);
    setSnippetState({
      status: 'idle',
      error: '',
      notice: '',
      selectedSnippet: '',
      lineStart: null,
      lineEnd: null,
      data: null,
    });
    setSnippetPopoverAnchor((prev) => ({ ...prev, visible: false }));
  }, [fileState.data?.content, fileState.data?.path]);

  useEffect(() => {
    return () => {
      if (snippetDebounceRef.current) {
        clearTimeout(snippetDebounceRef.current);
      }
      if (snippetAbortRef.current) {
        snippetAbortRef.current.abort();
      }
    };
  }, []);

  const codeLanguage = useMemo(
    () => detectPrismLanguage(fileState.data?.path || selectedFilePath),
    [fileState.data?.path, selectedFilePath],
  );

  const highlightedContent = useMemo(() => {
    const value = String(fileState.data?.content || '');
    const grammar = Prism.languages[codeLanguage] || Prism.languages.clike;
    return Prism.highlight(value, grammar, codeLanguage);
  }, [codeLanguage, fileState.data?.content]);

  const highlightedLines = useMemo(() => {
    const raw = String(fileState.data?.content || '');
    const grammar = Prism.languages[codeLanguage] || Prism.languages.clike;
    return raw.split('\n').map((line) => Prism.highlight(line || '\n', grammar, codeLanguage));
  }, [codeLanguage, fileState.data?.content]);

  const viewerLineCount = useMemo(() => {
    const value = String(fileState.data?.content || '');
    return Math.max(1, value.split('\n').length);
  }, [fileState.data?.content]);

  const editorLineCount = useMemo(() => {
    return Math.max(1, String(editorValue || '').split('\n').length);
  }, [editorValue]);

  const hasUnsavedChanges =
    typeof fileState.data?.content === 'string' &&
    editorValue !== fileState.data.content;

  const handleSaveFile = async () => {
    if (!fileState.data?.path || !fileState.data?.sha) return;

    await dispatch(
      saveRepositoryFile({
        path: fileState.data.path,
        content: editorValue,
        sha: fileState.data.sha,
        message: `Update ${fileState.data.path} via PolyGlot editor`,
      }),
    );

    setIsEditing(false);
  };



  const backToExplorer = `/analyze/${encodeURIComponent(routeDirectory)}?path=${encodeURIComponent(currentPath)}`;

  const aiGraph = useMemo(() => {
    const graphObject = graphData?.graph;

    if (graphObject && typeof graphObject === 'object' && !Array.isArray(graphObject)) {
      return graphObject;
    }

    const fallbackNodes = Array.isArray(graphData?.nodes) ? graphData.nodes : [];
    return fallbackNodes.reduce((acc, node) => {
      if (!node?.id) return acc;
      acc[node.id] = {
        deps: Array.isArray(node.deps) ? node.deps : [],
        type: node.type || 'file',
        summary: node.summary || null,
        declarations: Array.isArray(node.declarations) ? node.declarations : [],
      };
      return acc;
    }, {});
  }, [graphData?.graph, graphData?.nodes]);

  const hasNodeInsights = Boolean(selectedFilePath && aiGraph?.[selectedFilePath]);

  const snippetConfidenceScore = useMemo(() => {
    return normalizeConfidenceScore(snippetState.data?.confidenceScore);
  }, [snippetState.data?.confidenceScore]);

  const quickSnippetSummary = useMemo(() => {
    if (!snippetState.data?.whatItDoes) return '';
    const raw = String(snippetState.data.whatItDoes).replace(/\s+/g, ' ').trim();
    if (raw.length <= 140) return raw;
    return `${raw.slice(0, 137)}...`;
  }, [snippetState.data?.whatItDoes]);

  const snippetStatusMeta = useMemo(() => {
    if (snippetState.status === 'loading') {
      return {
        label: 'Analyzing',
        dotClass: 'bg-amber-500 animate-pulse',
      };
    }

    if (snippetState.status === 'succeeded') {
      return {
        label: 'Ready',
        dotClass: 'bg-emerald-500',
      };
    }

    if (snippetState.status === 'failed') {
      return {
        label: 'Error',
        dotClass: 'bg-rose-500',
      };
    }

    return {
      label: 'Idle',
      dotClass: 'bg-slate-400',
    };
  }, [snippetState.status]);

  const getLineNumberFromOffset = (value, offset) => {
    const safeOffset = Math.max(0, Math.min(String(value || '').length, offset));
    const upToOffset = String(value || '').slice(0, safeOffset);
    return upToOffset.split('\n').length;
  };

  const getOffsetsForLineRange = (lineStart, lineEnd) => {
    const raw = String(fileState.data?.content || '');
    const lines = raw.split('\n');
    const maxLine = Math.max(1, lines.length);
    const startLine = Math.max(1, Math.min(maxLine, Number(lineStart) || 1));
    const endLine = Math.max(startLine, Math.min(maxLine, Number(lineEnd) || startLine));

    let start = 0;
    for (let i = 0; i < startLine - 1; i += 1) start += lines[i].length + 1;

    let end = start;
    for (let i = startLine - 1; i < endLine; i += 1) {
      end += lines[i].length;
      if (i < endLine - 1) end += 1; // newline
    }

    return {
      start,
      end,
      text: raw.slice(start, end),
    };
  };

  const handleLineSelectionClick = (lineStart, lineEnd, event) => {
    const offsets = getOffsetsForLineRange(lineStart, lineEnd);
    if (!offsets || offsets.end <= offsets.start) {
      triggerSnippetAnalysis({ snippet: '', lineStart: null, lineEnd: null, shouldAnalyze: false });
      return;
    }

    const clientX = event?.clientX || 0;
    const clientY = event?.clientY || 0;
    updateSnippetPopoverAnchor({ x: clientX + 12, y: clientY - 12, visible: true });

    triggerSnippetAnalysis({
      snippet: offsets.text,
      lineStart,
      lineEnd,
      shouldAnalyze: isAutoSnippetAnalyze,
      triggerSource: isAutoSnippetAnalyze ? 'auto' : 'manual-ready',
    });
  };

  const openSnippetDrawer = () => {
    setIsSnippetDrawerOpen(true);
    if (window.matchMedia('(max-width: 1279px)').matches) {
      setIsMobileSnippetSheetOpen(true);
    }
    window.setTimeout(() => {
      snippetPanelRef.current?.focus();
    }, 20);
  };

  const updateSnippetPopoverAnchor = ({ x, y, visible = true }) => {
    setSnippetPopoverAnchor({
      x: Number.isFinite(x) ? Math.max(16, x) : 16,
      y: Number.isFinite(y) ? Math.max(16, y) : 16,
      visible,
    });
  };

  const triggerSnippetAnalysis = ({
    snippet,
    lineStart,
    lineEnd,
    shouldAnalyze = true,
    triggerSource = 'auto',
  }) => {
    const normalizedSnippet = String(snippet || '').trim();

    const basePayload = {
      selectedSnippet: normalizedSnippet,
      lineStart: Number.isInteger(lineStart) ? lineStart : null,
      lineEnd: Number.isInteger(lineEnd) ? lineEnd : null,
    };

    if (!shouldAnalyze) {
      if (snippetDebounceRef.current) {
        clearTimeout(snippetDebounceRef.current);
      }
      if (snippetAbortRef.current) {
        snippetAbortRef.current.abort();
      }

      setSnippetState((prev) => ({
        ...prev,
        status: 'idle',
        error: '',
        notice: normalizedSnippet ? 'Selection captured. Click Analyze Snippet to run.' : '',
        ...basePayload,
      }));
      return;
    }

    if (!normalizedSnippet) {
      if (snippetAbortRef.current) {
        snippetAbortRef.current.abort();
      }

      setSnippetState((prev) => ({
        ...prev,
        status: 'idle',
        error: '',
        notice: '',
        ...basePayload,
        data: null,
      }));
      return;
    }

    if (!isMeaningfulSnippet(normalizedSnippet)) {
      setSnippetState((prev) => ({
        ...prev,
        status: 'idle',
        error: '',
        notice: `Select at least ${SNIPPET_MIN_CHARS} meaningful characters for snippet analysis.`,
        ...basePayload,
      }));
      return;
    }

    if (triggerSource === 'auto' && normalizedSnippet.length > SNIPPET_MAX_AUTO_CHARS) {
      setSnippetState((prev) => ({
        ...prev,
        status: 'idle',
        error: '',
        notice: 'Large selection detected. Use Analyze Snippet for a manual run.',
        ...basePayload,
      }));
      return;
    }

    if (!analysisJobId || !selectedFilePath) {
      setSnippetState((prev) => ({
        ...prev,
        status: 'failed',
        error: 'Analysis context is not ready yet. Load repository graph data and try again.',
        notice: '',
        ...basePayload,
      }));
      return;
    }

    if (snippetDebounceRef.current) {
      clearTimeout(snippetDebounceRef.current);
    }

    snippetDebounceRef.current = setTimeout(async () => {
      if (snippetAbortRef.current) {
        snippetAbortRef.current.abort();
      }

      const controller = new AbortController();
      snippetAbortRef.current = controller;

      setSnippetState((prev) => ({
        ...prev,
        status: 'loading',
        error: '',
        notice: '',
        ...basePayload,
      }));

      try {
        const result = await aiService.analyzeSnippetImpact({
          jobId: analysisJobId,
          filePath: selectedFilePath,
          snippet: normalizedSnippet,
          lineStart,
          lineEnd,
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        setSnippetState({
          status: 'succeeded',
          error: '',
          notice: '',
          ...basePayload,
          data: result,
        });
        if (!isSnippetPopoverPinned) {
          setSnippetPopoverAnchor((prev) => ({ ...prev, visible: true }));
        }
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'CanceledError' || error?.name === 'AbortError') {
          return;
        }

        setSnippetState((prev) => ({
          ...prev,
          status: 'failed',
          error:
            error?.response?.data?.error ||
            error?.message ||
            'Failed to analyze selected snippet.',
          notice: '',
        }));
      }
    }, 450);
  };

  const handleTextareaSelection = (event) => {
    const target = event?.target;
    const value = String(target?.value || '');
    const start = Number.isInteger(target?.selectionStart) ? target.selectionStart : 0;
    const end = Number.isInteger(target?.selectionEnd) ? target.selectionEnd : 0;

    if (!value || end <= start) {
      triggerSnippetAnalysis({ snippet: '', lineStart: null, lineEnd: null, shouldAnalyze: false });
      if (!isSnippetPopoverPinned) {
        setSnippetPopoverAnchor((prev) => ({ ...prev, visible: false }));
      }
      return;
    }

    const selectedSnippet = value.slice(start, end).trim();
    const lineStart = getLineNumberFromOffset(value, start);
    const lineEnd = getLineNumberFromOffset(value, end);

    const targetRect = target?.getBoundingClientRect?.();
    const clientX = event?.nativeEvent?.clientX;
    const clientY = event?.nativeEvent?.clientY;
    updateSnippetPopoverAnchor({
      x: Number.isFinite(clientX) ? clientX + 12 : (targetRect?.right || 300) - 24,
      y: Number.isFinite(clientY) ? clientY - 12 : (targetRect?.top || 80) + 18,
      visible: true,
    });

    triggerSnippetAnalysis({
      snippet: selectedSnippet,
      lineStart,
      lineEnd,
      shouldAnalyze: isAutoSnippetAnalyze,
      triggerSource: isAutoSnippetAnalyze ? 'auto' : 'manual-ready',
    });
  };

  const getRangeOffsetsFromCodeElement = (codeElement, selectionRange) => {
    if (!codeElement || !selectionRange) return null;

    const preRange = selectionRange.cloneRange();
    preRange.selectNodeContents(codeElement);
    preRange.setEnd(selectionRange.startContainer, selectionRange.startOffset);

    const selectionText = selectionRange.toString();
    const start = preRange.toString().length;
    const end = start + selectionText.length;

    return {
      start,
      end,
      text: selectionText,
    };
  };

  const handleViewerSelection = () => {
    const selection = window.getSelection();
    const codeContainer = viewerCodeRef.current;
    if (!selection || !codeContainer || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    if (!codeContainer.contains(range.commonAncestorContainer)) {
      return;
    }

    const codeElement = codeContainer.querySelector('code');
    const rawContent = String(fileState.data?.content || '');
    const rangeOffsets = getRangeOffsetsFromCodeElement(codeElement, range);

    if (!rangeOffsets || rangeOffsets.end <= rangeOffsets.start) {
      triggerSnippetAnalysis({ snippet: '', lineStart: null, lineEnd: null, shouldAnalyze: false });
      if (!isSnippetPopoverPinned) {
        setSnippetPopoverAnchor((prev) => ({ ...prev, visible: false }));
      }
      return;
    }

    const selectedSnippet = rawContent.slice(rangeOffsets.start, rangeOffsets.end).trim();
    const lineStart = getLineNumberFromOffset(rawContent, rangeOffsets.start);
    const lineEnd = getLineNumberFromOffset(rawContent, rangeOffsets.end);
    const rangeRect = range.getBoundingClientRect();
    updateSnippetPopoverAnchor({
      x: (rangeRect?.right || 300) + 10,
      y: rangeRect?.top || 80,
      visible: true,
    });

    triggerSnippetAnalysis({
      snippet: selectedSnippet,
      lineStart,
      lineEnd,
      shouldAnalyze: isAutoSnippetAnalyze,
      triggerSource: isAutoSnippetAnalyze ? 'auto' : 'manual-ready',
    });
  };

  const handleManualSnippetAnalyze = () => {
    if (!snippetState.selectedSnippet) return;

    triggerSnippetAnalysis({
      snippet: snippetState.selectedSnippet,
      lineStart: snippetState.lineStart,
      lineEnd: snippetState.lineEnd,
      shouldAnalyze: true,
      triggerSource: 'manual',
    });
    openSnippetDrawer();
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        if (!snippetState.selectedSnippet) return;
        event.preventDefault();
        handleManualSnippetAnalyze();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key || '').toLowerCase() === 'i') {
        event.preventDefault();
        openSnippetDrawer();
        return;
      }

      if (event.key === 'Escape' && !isSnippetPopoverPinned) {
        setSnippetPopoverAnchor((prev) => ({ ...prev, visible: false }));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isSnippetPopoverPinned, snippetState.selectedSnippet]);

  const showSnippetPopover =
    snippetPopoverAnchor.visible &&
    Boolean(snippetState.selectedSnippet) &&
    !isMobileSnippetSheetOpen;

  const renderSnippetImpactDetails = ({ compact = false } = {}) => (
    <div className={compact ? 'space-y-2 text-[11px]' : 'space-y-3 text-xs'}>
      {snippetState.data?.whatItDoes && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            What It Does
                      <pre
                        ref={viewerCodeRef}
                        onMouseUp={handleViewerSelection}
                        onKeyUp={handleViewerSelection}
                        className="min-w-max px-4 py-3 font-mono text-xs leading-5 overflow-visible whitespace-pre"
                      >
                        <code className={`language-${codeLanguage}`}>
                          {highlightedLines.map((html, idx) => (
                            <div
                              key={`line-${idx + 1}`}
                              data-line={idx + 1}
                              onMouseUp={(e) => handleLineSelectionClick(idx + 1, idx + 1, e.nativeEvent || e)}
                              className="selectable-code-line block w-full cursor-text"
                              dangerouslySetInnerHTML={{ __html: html || '' }}
                            />
                          ))}
                        </code>
                      </pre>
          </p>
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {snippetState.data.fileImpact}
          </p>
        </div>
      )}

      {snippetState.data?.codebaseImpact && !compact && (
        <div>
          <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
            Codebase Impact
          </p>
          <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">
            {snippetState.data.codebaseImpact}
          </p>
        </div>
      )}

      {(typeof snippetConfidenceScore === 'number' || snippetState.data?.confidence) && (
        <div className="rounded-lg border border-border/60 bg-background/70 px-2 py-2 text-[11px]">
          <span className="text-muted-foreground">Confidence: </span>
          <span className={confidenceTone(snippetConfidenceScore)}>
            {snippetState.data?.confidence || 'unknown'}
          </span>
          {typeof snippetConfidenceScore === 'number' && (
            <span className="text-muted-foreground"> ({snippetConfidenceScore.toFixed(2)})</span>
          )}
          {snippetState.data?.rerunTriggered && (
            <span className="text-amber-600"> - Re-analyzed for low confidence</span>
          )}
        </div>
      )}

      {!compact &&
        Array.isArray(snippetState.data?.directlyImpactedFiles) &&
        snippetState.data.directlyImpactedFiles.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
              Directly Impacted Files ({snippetState.data.directlyImpactedFiles.length})
            </p>
            <ul className="space-y-1">
              {snippetState.data.directlyImpactedFiles.slice(0, 8).map((file) => (
                <li key={`direct-${file}`} className="font-mono text-foreground/90 break-all">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        )}

      {!compact &&
        Array.isArray(snippetState.data?.transitivelyImpactedFiles) &&
        snippetState.data.transitivelyImpactedFiles.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
              Transitively Impacted Files ({snippetState.data.transitivelyImpactedFiles.length})
            </p>
            <ul className="space-y-1">
              {snippetState.data.transitivelyImpactedFiles.slice(0, 8).map((file) => (
                <li key={`transitive-${file}`} className="font-mono text-foreground/90 break-all">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        )}
    </div>
  );

  return (
    <section className="mx-auto w-full max-w-475 px-4 pb-10 pt-7 2xl:px-6">
      <div className="mb-5">
        <Link
          to={backToExplorer}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground/80 hover:text-foreground active-scale transition-all"
        >
          <ArrowLeft className="size-4" />
          Back to Explorer
        </Link>
      </div>

      <header className="rounded-2xl shadow-neu-inset border-none bg-background/40 px-5 py-6">
        {structure.repository?.fullName && (
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs font-bold tracking-tight">
            <span className="rounded-xl shadow-neu-inset border-none bg-background/60 px-3 py-1.5 ">
              {structure.repository.fullName}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-xl shadow-neu-inset border-none bg-background/60 px-3 py-1.5 ">
              <GitBranch className="size-3.5 text-primary" />
              {structure.repository.branch || structure.repository.defaultBranch || 'default'}
            </span>
            {fileState.data?.htmlUrl && (
              <a
                href={fileState.data.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-muted-foreground/80 hover:text-foreground active-scale transition-all"
              >
                View on GitHub
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        )}
      </header>

      {!selectedFilePath && (
        <div className="mt-6 rounded-xl border border-border/60 bg-card/60 px-4 py-4 text-sm text-muted-foreground">
          No file selected. Open a file from repository explorer first.
        </div>
      )}

      {selectedFilePath && (
        <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(21rem,1fr)]">
          <div className="rounded-2xl shadow-neu-inset border-none bg-background/40">
            <div className="flex items-center justify-between gap-3 border-b border-border/10 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">File</p>
                <p className="truncate text-sm font-display font-bold tracking-tight">{selectedFilePath}</p>
                <p className="mt-1 text-[11px] text-muted-foreground/80">
                  Select code to analyze. Ctrl/Cmd+Enter runs snippet analysis.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <div className="hidden xl:flex items-center gap-2 rounded-xl border border-border/50 bg-background/55 p-1 shadow-neu-inset">
                  <div className="inline-flex items-center rounded-lg border border-border/60 bg-background/70 p-0.5">
                    <button
                      type="button"
                      onClick={() => setIsAutoSnippetAnalyze(true)}
                      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors ${isAutoSnippetAnalyze
                          ? 'bg-primary/12 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      Auto
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsAutoSnippetAnalyze(false)}
                      className={`rounded-md px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors ${!isAutoSnippetAnalyze
                          ? 'bg-primary/12 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                        }`}
                    >
                      Manual
                    </button>
                  </div>

                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
                    <span className={`size-1.5 rounded-full ${snippetStatusMeta.dotClass}`} />
                    {snippetStatusMeta.label}
                  </span>

                  {!isAutoSnippetAnalyze && (
                    <Button
                      size="sm"
                      type="button"
                      onClick={handleManualSnippetAnalyze}
                      disabled={!snippetState.selectedSnippet || snippetState.status === 'loading'}
                      className="h-7 rounded-lg bg-gold px-2.5 text-[10px] text-white"
                    >
                      {snippetState.status === 'loading' ? 'Analyzing...' : 'Analyze'}
                    </Button>
                  )}
                </div>

                {!isEditing ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsEditing(true)}
                    disabled={!fileState.canEdit || fileState.status === 'loading'}
                    className="rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
                  >
                    <Edit3 className="size-3.5" />
                    Edit
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditorValue(fileState.data?.content || '');
                        setIsEditing(false);
                      }}
                      className="rounded-xl shadow-neu-inset border-none bg-background/50 active-scale"
                    >
                      <X className="size-3.5" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSaveFile}
                      disabled={!hasUnsavedChanges || fileState.saveStatus === 'loading'}
                      className="rounded-xl bg-gold text-white shadow-md active-scale"
                    >
                      <Save className="size-3.5" />
                      {fileState.saveStatus === 'loading' ? 'Saving...' : 'Save'}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {fileState.status === 'loading' && (
              <div className="px-4 py-6 text-sm text-muted-foreground">Loading file content...</div>
            )}

            {fileState.status === 'failed' && fileState.error && (
              <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {fileState.error}
              </div>
            )}

            {fileState.status === 'succeeded' && fileState.data && (
              <div className="p-4">
                {isEditing ? (
                  <div className="flex rounded-2xl shadow-neu-inset border-none bg-background/60 overflow-x-auto custom-scrollbar">
                    <div className="flex min-w-full">
                      <pre
                        ref={editorGutterRef}
                        aria-hidden="true"
                        className="sticky left-0 z-10 w-14 shrink-0 border-r border-border/10 bg-background/20 px-2 py-3 text-right font-mono text-xs leading-5 text-muted-foreground/60"
                      >
                        {Array.from({ length: editorLineCount }, (_, i) => i + 1).join('\n')}
                      </pre>
                      <textarea
                        ref={editorTextareaRef}
                        value={editorValue}
                        onChange={(e) => setEditorValue(e.target.value)}
                        onSelect={handleTextareaSelection}
                        onKeyUp={handleTextareaSelection}
                        onMouseUp={handleTextareaSelection}
                        spellCheck={false}
                        rows={editorLineCount}
                        className="min-w-max flex-1 resize-none bg-transparent px-3 py-3 font-mono text-xs leading-5 outline-none whitespace-pre overflow-hidden text-foreground/90"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex rounded-2xl shadow-neu-inset border-none bg-background/60 overflow-x-auto custom-scrollbar">
                    <div className="flex min-w-full">
                      <pre
                        ref={viewerGutterRef}
                        aria-hidden="true"
                        className="sticky left-0 z-10 w-14 shrink-0 border-r border-border/10 bg-background/20 px-2 py-3 text-right font-mono text-xs leading-5 text-muted-foreground/60"
                      >
                        {Array.from({ length: viewerLineCount }, (_, i) => i + 1).join('\n')}
                      </pre>
                      <pre
                        ref={viewerCodeRef}
                        onMouseUp={handleViewerSelection}
                        onKeyUp={handleViewerSelection}
                        className="min-w-max flex-1 px-4 py-3 font-mono text-xs leading-5 overflow-visible whitespace-pre"
                      >
                        <code
                          className={`language-${codeLanguage}`}
                          dangerouslySetInnerHTML={{ __html: highlightedContent }}
                        />
                      </pre>
                    </div>
                  </div>
                )}

                {!fileState.canEdit && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Read-only mode: sign in with GitHub and select an owned repository to edit files.
                  </p>
                )}

                {fileState.saveStatus === 'succeeded' && (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-emerald-600">
                    <Check className="size-3.5" />
                    Changes saved successfully.
                  </p>
                )}

                {fileState.saveStatus === 'failed' && fileState.saveError && (
                  <p className="mt-2 text-xs text-destructive">{fileState.saveError}</p>
                )}

              </div>
            )}
          </div>

          <div className="relative min-h-104 xl:justify-self-end xl:w-full xl:max-w-120">
            {hasNodeInsights ? (
              <AiPanel
                nodeId={selectedFilePath}
                graph={aiGraph}
                onClose={() => navigate(backToExplorer)}
              />
            ) : (
              <div className="rounded-xl border border-border/50 bg-background/40 p-3 text-xs text-muted-foreground">
                Insight panel is available after graph data is loaded for this repository/job.
              </div>
            )}
          </div>
        </div>
      )}

      {isSnippetDrawerOpen && (
        <div className="fixed right-4 top-24 z-40 hidden w-104 max-w-[calc(100vw-2rem)] xl:block animate-in fade-in slide-in-from-right-2 duration-200">
          <div
            ref={snippetPanelRef}
            tabIndex={-1}
            className="rounded-2xl border border-border/70 bg-background/95 p-4 shadow-2xl backdrop-blur-sm outline-none animate-in zoom-in-95 duration-200"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
                  Snippet Impact
                </p>
                <p className="text-xs text-muted-foreground">
                  {snippetState.lineStart && snippetState.lineEnd
                    ? `Lines ${snippetState.lineStart}-${snippetState.lineEnd}`
                    : 'Select a snippet to inspect impact'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsSnippetPopoverPinned((prev) => !prev)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] transition-colors ${isSnippetPopoverPinned
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/60 bg-background/70 text-muted-foreground hover:text-foreground'
                    }`}
                >
                  <Pin className="size-3" />
                  {isSnippetPopoverPinned ? 'Pinned' : 'Pin'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsSnippetDrawerOpen(false)}
                  className="inline-flex items-center rounded-lg border border-border/60 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            </div>

            <div className="space-y-3 max-h-[70vh] overflow-auto pr-1 custom-scrollbar">
              {snippetState.selectedSnippet ? (
                <pre className="max-h-32 overflow-auto rounded-lg border border-border/60 bg-background/80 px-2 py-2 font-mono text-[11px] leading-5 text-foreground/90 custom-scrollbar">
                  {snippetState.selectedSnippet}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Select a meaningful snippet to view purpose and impact insights.
                </p>
              )}

              {snippetState.notice && (
                <p className="rounded-lg border border-border/60 bg-background/70 px-2 py-2 text-xs text-muted-foreground">
                  {snippetState.notice}
                </p>
              )}

              {snippetState.status === 'loading' && (
                <div className="rounded-lg border border-border/60 bg-background/70 px-2 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    {snippetState.data ? 'Updating analysis...' : 'Analyzing snippet impact...'}
                  </div>
                </div>
              )}

              {snippetState.status === 'failed' && snippetState.error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5" />
                  <span>{snippetState.error}</span>
                </div>
              )}

              {snippetState.data && renderSnippetImpactDetails()}
            </div>
          </div>
        </div>
      )}

      {showSnippetPopover && (
        <div
          className="pointer-events-none fixed z-50 hidden w-88 max-w-[calc(100vw-2rem)] origin-top-left xl:block animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-200"
          style={{
            left: `${snippetPopoverAnchor.x}px`,
            top: `${snippetPopoverAnchor.y}px`,
          }}
        >
          <div className="pointer-events-auto rounded-2xl border border-border/70 bg-background/95 p-3 shadow-2xl backdrop-blur-sm">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
                Snippet Insight
              </p>
              <div className="flex items-center gap-1.5">
                <span className="rounded-md border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {isAutoSnippetAnalyze ? 'Auto Analysis' : 'Manual Analysis'}
                </span>
                <span className="rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                  Analysis
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSnippetPopoverAnchor((prev) => ({ ...prev, visible: false }))}
                className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {snippetState.status === 'loading' && (
              <div className="mb-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {snippetState.data ? 'Updating analysis...' : 'Analyzing...'}
              </div>
            )}

            {quickSnippetSummary ? (
              <p className="text-xs leading-relaxed text-foreground/90">{quickSnippetSummary}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {snippetState.notice || 'Selection captured. Run analysis for impact details.'}
              </p>
            )}

            {snippetState.data && (
              <div className="mt-2">{renderSnippetImpactDetails({ compact: true })}</div>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={openSnippetDrawer}
                className="rounded-lg border border-border/60 bg-background/70 px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
              >
                Open Full Impact
              </button>
              <button
                type="button"
                onClick={() => setIsSnippetPopoverPinned((prev) => !prev)}
                className={`rounded-lg border px-2.5 py-1 text-[10px] ${isSnippetPopoverPinned
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border/60 bg-background/70 text-muted-foreground hover:text-foreground'
                  }`}
              >
                {isSnippetPopoverPinned ? 'Unpin' : 'Pin'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-4 right-4 z-40 xl:hidden">
        <Button
          type="button"
          onClick={() => setIsMobileSnippetSheetOpen((prev) => !prev)}
          className="rounded-xl bg-background/95 px-3 text-xs text-foreground shadow-xl"
          variant="outline"
        >
          {isMobileSnippetSheetOpen ? 'Hide Snippet Impact' : 'Snippet Impact'}
        </Button>
      </div>

      {isMobileSnippetSheetOpen && (
        <div className="fixed inset-x-3 bottom-16 z-40 rounded-2xl border border-border/70 bg-background/95 p-3 shadow-2xl xl:hidden">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground/60">
              Snippet Impact
            </p>
            <button
              type="button"
              onClick={() => setIsMobileSnippetSheetOpen(false)}
              className="rounded-md border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>

          {snippetState.selectedSnippet ? (
            <pre className="mb-2 max-h-24 overflow-auto rounded-lg border border-border/60 bg-background/80 px-2 py-2 font-mono text-[10px] leading-4 text-foreground/90 custom-scrollbar">
              {snippetState.selectedSnippet}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">Select a snippet to open impact details.</p>
          )}

          {snippetState.notice && (
            <p className="mb-2 rounded-lg border border-border/60 bg-background/70 px-2 py-2 text-xs text-muted-foreground">
              {snippetState.notice}
            </p>
          )}

          {snippetState.status === 'loading' && (
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {snippetState.data ? 'Updating analysis...' : 'Analyzing snippet impact...'}
            </div>
          )}

          {snippetState.status === 'failed' && snippetState.error && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5" />
              <span>{snippetState.error}</span>
            </div>
          )}

          {snippetState.data && renderSnippetImpactDetails({ compact: true })}
        </div>
      )}
    </section>
  );
}
