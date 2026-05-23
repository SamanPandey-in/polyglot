import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import {
  RotateCcw,
  Code2,
  FolderOpen,
  FileCode2,
  GitBranch,
  Flame,
  Maximize2,
  Minimize2,
  Share2,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { graphService } from '../services/graphService';
import {
  clearGraph,
  selectGraphData,
  selectHeatmapMode,
  setHeatmapHotspots,
  setHeatmapMode,
} from '../slices/graphSlice';

async function copyToClipboard(value) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const element = document.createElement('textarea');
  element.value = value;
  element.setAttribute('readonly', '');
  element.style.position = 'absolute';
  element.style.left = '-9999px';
  document.body.appendChild(element);
  element.select();
  document.execCommand('copy');
  document.body.removeChild(element);
}

export default function GraphToolbar({ graphContainerId = 'graph-container' }) {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const data = useSelector(selectGraphData);
  const heatmapMode = useSelector(selectHeatmapMode);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isHeatmapLoading, setIsHeatmapLoading] = useState(false);
  const [shareFeedback, setShareFeedback] = useState(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!shareFeedback) return;

    const timeout = window.setTimeout(() => {
      setShareFeedback(null);
    }, 3500);

    return () => window.clearTimeout(timeout);
  }, [shareFeedback]);

  if (!data) return null;

  const { rootDir, fileCount, jobId } = data;

  const handleFullscreen = async () => {
    const element = document.getElementById(graphContainerId);
    if (!element) return;

    try {
      if (isFullscreen) {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
        setIsFullscreen(false);
      } else {
        await element.requestFullscreen();
        setIsFullscreen(true);
      }
    } catch (error) {
      console.error('Fullscreen request failed:', error);
    }
  };

  const handleShare = async () => {
    if (!jobId || isSharing) return;

    setIsSharing(true);

    try {
      const { shareUrl } = await graphService.shareGraph(jobId);
      if (!shareUrl) {
        throw new Error('Share URL was not returned by the server.');
      }

      await copyToClipboard(shareUrl);
      setShareFeedback({
        type: 'success',
        message: 'Share link copied to clipboard.',
      });
    } catch (error) {
      setShareFeedback({
        type: 'error',
        message: error?.response?.data?.error || error?.message || 'Failed to create share link.',
      });
    } finally {
      setIsSharing(false);
    }
  };

  const handleHeatmapToggle = async () => {
    if (!jobId || isHeatmapLoading) return;

    if (heatmapMode) {
      dispatch(setHeatmapMode(false));
      return;
    }

    setIsHeatmapLoading(true);

    try {
      const { hotspots } = await graphService.getHeatmap(jobId);
      dispatch(setHeatmapHotspots(hotspots));
      dispatch(setHeatmapMode(true));
    } catch (error) {
      setShareFeedback({
        type: 'error',
        message: error?.response?.data?.error || error?.message || 'Failed to load heatmap data.',
      });
    } finally {
      setIsHeatmapLoading(false);
    }
  };

  return (
    <header className="flex items-center justify-between gap-4 px-6 py-3 shadow-neu-inset border-none bg-background/60 backdrop-blur-md shrink-0 transition-all duration-500">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex size-8 items-center justify-center rounded-xl shadow-neu-inset border-none bg-background/50 text-gold scale-110">
            <Code2 className="size-4" />
          </div>
          <span className="font-display font-black text-sm tracking-tight">
            PolyGlot
          </span>
        </div>

        <span className="text-muted-foreground/20 hidden sm:inline">|</span>
        
        <div className="hidden sm:flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 min-w-0">
          <div className="flex size-6 items-center justify-center rounded-lg shadow-neu-inset bg-background/40">
            <FolderOpen className="size-3" />
          </div>
          <span className="truncate max-w-[200px] hover:text-foreground transition-colors cursor-default">{rootDir}</span>
        </div>

        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 shrink-0">
          <div className="flex size-6 items-center justify-center rounded-lg shadow-neu-inset bg-background/40">
            <FileCode2 className="size-3" />
          </div>
          <span>
            {fileCount} <span className="opacity-40">Files</span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {shareFeedback?.message && (
          <span
            className={`hidden text-xs md:inline ${
              shareFeedback.type === 'error' ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {shareFeedback.message}
          </span>
        )}
        <Button
          variant={heatmapMode ? 'neumo' : 'outline'}
          size="sm"
          onClick={handleHeatmapToggle}
          disabled={!jobId || isHeatmapLoading}
          title={heatmapMode ? 'Disable complexity heatmap' : 'Enable complexity heatmap'}
          className={`gap-2 h-9 px-4 rounded-xl transition-all duration-500 ${heatmapMode ? 'bg-gold/10 text-gold shadow-neu-flat' : ''}`}
        >
          {isHeatmapLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Flame className="size-3.5" />
          )}
          Heatmap
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleShare}
          disabled={!jobId || isSharing}
          title="Create share link"
          className="gap-2 h-9 px-4 rounded-xl"
        >
          {isSharing ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />}
          Share
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate('/impact')}
          disabled={!jobId}
          title="Open impact analysis"
          className="gap-2 h-9 px-4 rounded-xl"
        >
          <GitBranch className="size-3.5" />
          Impact
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          className="gap-2 h-9 px-4 rounded-xl"
        >
          {isFullscreen ? (
            <Minimize2 className="size-3.5" />
          ) : (
            <Maximize2 className="size-3.5" />
          )}
          {isFullscreen ? 'Exit' : 'Fullscreen'}
        </Button>
        <Button
          variant="neumo"
          size="sm"
          onClick={() => {
            dispatch(clearGraph());
            navigate('/upload-repo');
          }}
          className="gap-2 h-9 px-4 rounded-xl"
        >
          <RotateCcw className="size-3.5" />
          Restart
        </Button>
      </div>
    </header>
  );
}
