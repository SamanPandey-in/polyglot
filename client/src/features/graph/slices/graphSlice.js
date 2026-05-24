import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { graphService } from '../services/graphService';

const ACTIVE_GRAPH_TAB_KEY = 'activeGraphTab';
const DEFAULT_ACTIVE_GRAPH_TAB = 'reactflow';

function readStoredActiveGraphTab() {
  if (typeof window === 'undefined') return DEFAULT_ACTIVE_GRAPH_TAB;

  const storedValue = window.localStorage.getItem(ACTIVE_GRAPH_TAB_KEY);
  return storedValue === 'cytoscape' ? 'cytoscape' : DEFAULT_ACTIVE_GRAPH_TAB;
}

function describeAnalysisTarget(analyzeConfig) {
  if (analyzeConfig?.source === 'local') {
    return analyzeConfig.localPath;
  }

  const github = analyzeConfig?.github || {};
  const repository = github.owner && github.repo
    ? `${github.owner}/${github.repo}`
    : github.url || 'GitHub repository';

  return github.branch ? `github:${repository}#${github.branch}` : `github:${repository}`;
}

export const analyzeCodebase = createAsyncThunk(
  'graph/analyzeCodebase',
  async (analyzeConfig, { dispatch, rejectWithValue, signal }) => {
    try {
      const queuedJob = await graphService.analyze(analyzeConfig);
      const jobId = queuedJob?.jobId;

      if (!jobId) {
        throw new Error('Analysis job was created without a job id.');
      }

      dispatch(updateAnalysisJob({ jobId, status: 'queued' }));

      const job = await graphService.waitForJobCompletion(jobId, {
        signal,
        onUpdate: (payload) => {
          dispatch(updateAnalysisJob(payload));
        },
      });

      const rootDir = describeAnalysisTarget(analyzeConfig);
      const fileCount = Number.isFinite(job?.fileCount) ? job.fileCount : 0;

      if ((job?.nodeCount || 0) === 0) {
        return {
          jobId,
          job,
          rootDir,
          fileCount,
          graph: {},
          edges: [],
          topology: {
            nodeCount: 0,
            edgeCount: 0,
            deadCodeCandidates: [],
          },
          message: 'No JS/TS files found in the selected repository and branch.',
        };
      }

      const graph = await graphService.getGraph(jobId);

      return {
        ...graph,
        jobId,
        job,
        rootDir,
        fileCount,
      };
    } catch (err) {
      const message =
        err.payload?.errorSummary ||
        err.payload?.error ||
        err.response?.data?.error ||
        err.message ||
        'Analysis failed. Is the server running?';
      return rejectWithValue(message);
    }
  },
);

export const loadSavedGraph = createAsyncThunk(
  'graph/loadSavedGraph',
  async ({ jobId, rootDir = null, fileCount = null, analyzedAt = null } = {}, { rejectWithValue }) => {
    try {
      if (!jobId) {
        throw new Error('A job id is required to load a saved analysis graph.');
      }

      const graph = await graphService.getGraph(jobId);

      return {
        ...graph,
        jobId,
        rootDir: rootDir || graph?.rootDir || `saved-analysis:${jobId}`,
        fileCount:
          Number.isFinite(fileCount)
            ? fileCount
            : Number.isFinite(graph?.topology?.nodeCount)
              ? graph.topology.nodeCount
              : 0,
        analyzedAt,
        message: graph?.message || null,
        job: {
          jobId,
          status: 'completed',
          nodeCount: graph?.topology?.nodeCount ?? null,
          edgeCount: graph?.topology?.edgeCount ?? null,
        },
      };
    } catch (err) {
      const message =
        err.response?.data?.error ||
        err.message ||
        'Failed to load saved analysis graph.';
      return rejectWithValue(message);
    }
  },
);

export const loadSharedGraph = createAsyncThunk(
  'graph/loadSharedGraph',
  async ({ token } = {}, { rejectWithValue }) => {
    try {
      const normalizedToken = String(token || '').trim();
      if (!normalizedToken) {
        throw new Error('A share token is required to load a shared graph.');
      }

      const graph = await graphService.getSharedGraph(normalizedToken);
      const jobId = graph?.jobId || null;

      return {
        ...graph,
        jobId,
        rootDir: graph?.rootDir || `shared:${normalizedToken}`,
        fileCount:
          Number.isFinite(graph?.topology?.nodeCount)
            ? graph.topology.nodeCount
            : 0,
        message: graph?.message || null,
        job: {
          jobId,
          status: 'completed',
          nodeCount: graph?.topology?.nodeCount ?? null,
          edgeCount: graph?.topology?.edgeCount ?? null,
        },
      };
    } catch (err) {
      const message =
        err.response?.data?.error ||
        err.message ||
        'Failed to load shared analysis graph.';
      return rejectWithValue(message);
    }
  },
);

const graphSlice = createSlice({
  name: 'graph',
  initialState: {
    data: null,
    job: null,
    lastAnalyzeConfig: null,
    heatmapMode: false,
    heatmapHotspots: {},
    selectedNodeId: null,
    activeGraphTab: readStoredActiveGraphTab(),
    status: 'idle',
    error: null,
  },
  reducers: {
    updateAnalysisJob(state, action) {
      state.job = {
        ...(state.job || {}),
        ...action.payload,
      };
    },
    selectNode(state, action) {
      state.selectedNodeId = action.payload;
    },
    setActiveGraphTab(state, action) {
      state.activeGraphTab = action.payload === 'cytoscape' ? 'cytoscape' : DEFAULT_ACTIVE_GRAPH_TAB;
    },
    setHeatmapMode(state, action) {
      state.heatmapMode = Boolean(action.payload);
    },
    setHeatmapHotspots(state, action) {
      const hotspots = Array.isArray(action.payload) ? action.payload : [];
      state.heatmapHotspots = hotspots.reduce((acc, hotspot) => {
        const filePath = String(hotspot?.filePath || '').trim();
        if (!filePath) return acc;
        acc[filePath] = {
          riskScore: Number(hotspot?.riskScore) || 0,
          inDegree: Number(hotspot?.inDegree) || 0,
          loc: Number(hotspot?.loc) || 0,
        };
        return acc;
      }, {});
    },
    clearGraph(state) {
      state.data = null;
      state.job = null;
      state.lastAnalyzeConfig = null;
      state.heatmapMode = false;
      state.heatmapHotspots = {};
      state.selectedNodeId = null;
      state.status = 'idle';
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(analyzeCodebase.pending, (state, action) => {
        state.status = 'loading';
        state.error = null;
        state.data = null;
        state.job = null;
        state.lastAnalyzeConfig = action.meta?.arg || null;
        state.heatmapMode = false;
        state.heatmapHotspots = {};
        state.selectedNodeId = null;
      })
      .addCase(analyzeCodebase.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.data = action.payload;
        state.job = action.payload.job || state.job;
        state.heatmapMode = false;
        state.heatmapHotspots = {};
      })
      .addCase(analyzeCodebase.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(loadSavedGraph.pending, (state) => {
        state.status = 'loading';
        state.error = null;
        state.selectedNodeId = null;
      })
      .addCase(loadSavedGraph.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.data = action.payload;
        state.job = action.payload.job || state.job;
        state.heatmapMode = false;
        state.heatmapHotspots = {};
      })
      .addCase(loadSavedGraph.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      })
      .addCase(loadSharedGraph.pending, (state) => {
        state.status = 'loading';
        state.error = null;
        state.selectedNodeId = null;
      })
      .addCase(loadSharedGraph.fulfilled, (state, action) => {
        state.status = 'succeeded';
        state.data = action.payload;
        state.job = action.payload.job || null;
        state.heatmapMode = false;
        state.heatmapHotspots = {};
      })
      .addCase(loadSharedGraph.rejected, (state, action) => {
        state.status = 'failed';
        state.error = action.payload;
      });
  },
});

export const {
  updateAnalysisJob,
  selectNode,
  setActiveGraphTab,
  setHeatmapMode,
  setHeatmapHotspots,
  clearGraph,
} = graphSlice.actions;

export const selectGraphData = (state) => state.graph.data;
export const selectAnalysisJob = (state) => state.graph.job;
export const selectGraphStatus = (state) => state.graph.status;
export const selectGraphError = (state) => state.graph.error;
export const selectLastAnalyzeConfig = (state) => state.graph.lastAnalyzeConfig;
export const selectSelectedNodeId = (state) => state.graph.selectedNodeId;
export const selectActiveGraphTab = (state) => state.graph.activeGraphTab;
export const selectHeatmapMode = (state) => state.graph.heatmapMode;
export const selectHeatmapHotspots = (state) => state.graph.heatmapHotspots;

export default graphSlice.reducer;
