import { createAsyncThunk, createSlice } from '@reduxjs/toolkit';
import { analyzeService } from '../services/analyzeService';

function normalizeRepository(input) {
  if (!input) return null;

  if (input.source === 'local') {
    return {
      source: 'local',
      localPath: input.localPath || '',
    };
  }

  const github = input.github || input;
  if (!github.owner || !github.repo) {
    return null;
  }

  return {
    source: 'github',
    mode: github.mode === 'owned' ? 'owned' : 'public',
    owner: github.owner,
    repo: github.repo,
    branch: github.branch || null,
    url: github.url || null,
    fullName: github.fullName || `${github.owner}/${github.repo}`,
    jobId: github.jobId || null,
    latestJobId: github.latestJobId || null,
  };
}

function buildRepositoryFromGraphConfig(graphConfig) {
  if (!graphConfig) return null;
  if (graphConfig.source === 'local') {
    return normalizeRepository({
      source: 'local',
      localPath: graphConfig.localPath,
    });
  }

  if (graphConfig.source === 'github' && graphConfig.github) {
    return normalizeRepository({
      source: 'github',
      ...graphConfig.github,
    });
  }

  return null;
}

function resolveRepository(getState, inputRepository = null) {
  const explicit = normalizeRepository(inputRepository);
  if (explicit) return explicit;

  const selected = normalizeRepository(getState().analyze?.selectedRepository);
  if (selected) return selected;

  return buildRepositoryFromGraphConfig(getState().graph?.lastAnalyzeConfig);
}

export const fetchRepositoryStructure = createAsyncThunk(
  'analyze/fetchRepositoryStructure',
  async ({ repository } = {}, { rejectWithValue, getState }) => {
    const targetRepository = resolveRepository(getState, repository);

    if (!targetRepository) {
      return rejectWithValue('Select a repository from Upload Repo first.');
    }

    if (targetRepository.source !== 'github') {
      return rejectWithValue('Only GitHub repositories are supported in Analyze Repository view.');
    }

    try {
      const payload = await analyzeService.getRepositoryStructure(targetRepository);

      return {
        repository: {
          ...targetRepository,
          ...(payload.repository || {}),
        },
        truncated: payload.truncated,
        directories: payload.directories,
        files: payload.files,
      };
    } catch (err) {
      return rejectWithValue(
        err?.response?.data?.error || err?.message || 'Failed to load repository structure.',
      );
    }
  },
);

export const fetchDirectoryContents = createAsyncThunk(
  'analyze/fetchDirectoryContents',
  async ({ repository, path = '' } = {}, { rejectWithValue, getState }) => {
    const targetRepository = resolveRepository(getState, repository);

    if (!targetRepository) {
      return rejectWithValue('Select a repository from Upload Repo first.');
    }

    if (targetRepository.source !== 'github') {
      return rejectWithValue('Only GitHub repositories are supported in Analyze Repository view.');
    }

    try {
      const payload = await analyzeService.getDirectoryContents(targetRepository, path);
      return {
        repository: {
          ...targetRepository,
          ...(payload.repository || {}),
        },
        path: payload.path || path,
        entries: payload.entries,
      };
    } catch (err) {
      return rejectWithValue(
        err?.response?.data?.error || err?.message || 'Failed to load directory contents.',
      );
    }
  },
);

export const fetchRepositoryFile = createAsyncThunk(
  'analyze/fetchRepositoryFile',
  async ({ repository, path = '' } = {}, { rejectWithValue, getState }) => {
    const targetRepository = resolveRepository(getState, repository);

    if (!targetRepository) {
      return rejectWithValue('Select a repository from Upload Repo first.');
    }

    if (targetRepository.source !== 'github') {
      return rejectWithValue('Only GitHub repositories are supported in Analyze Repository view.');
    }

    try {
      const payload = await analyzeService.getFileContent(targetRepository, path);

      return {
        repository: {
          ...targetRepository,
          ...(payload.repository || {}),
        },
        file: payload.file,
        canEdit: payload.canEdit,
      };
    } catch (err) {
      return rejectWithValue(
        err?.response?.data?.error || err?.message || 'Failed to load file content.',
      );
    }
  },
);

export const saveRepositoryFile = createAsyncThunk(
  'analyze/saveRepositoryFile',
  async ({ repository, path, content, sha, message } = {}, { rejectWithValue, getState }) => {
    const targetRepository = resolveRepository(getState, repository);

    if (!targetRepository) {
      return rejectWithValue('Select a repository from Upload Repo first.');
    }

    if (targetRepository.source !== 'github') {
      return rejectWithValue('Only GitHub repositories are supported in Analyze Repository view.');
    }

    try {
      const payload = await analyzeService.saveFileContent(targetRepository, {
        path,
        content,
        sha,
        message,
      });

      return {
        repository: targetRepository,
        file: payload.file,
        path,
        content,
      };
    } catch (err) {
      return rejectWithValue(
        err?.response?.data?.error || err?.message || 'Failed to save file changes.',
      );
    }
  },
);

export const commitFile = createAsyncThunk(
  'analyze/commitFile',
  async (
    { repository, path, content, sha, base, head, commitMessage, prTitle, prBody } = {},
    { rejectWithValue, getState },
  ) => {
    const targetRepository = resolveRepository(getState, repository);

    if (!targetRepository) {
      return rejectWithValue('Select a repository from Upload Repo first.');
    }

    if (targetRepository.source !== 'github') {
      return rejectWithValue('Only GitHub repositories are supported in Analyze Repository view.');
    }

    try {
      const payload = await analyzeService.commitCreatePR(targetRepository, {
        path,
        content,
        sha,
        base,
        head,
        commitMessage,
        prTitle,
        prBody,
      });

      return payload;
    } catch (err) {
      return rejectWithValue(err?.response?.data?.error || err?.message || 'Failed to create PR.');
    }
  },
);

const analyzeSlice = createSlice({
  name: 'analyze',
  initialState: {
    selectedRepository: null,
    structure: {
      status: 'idle',
      error: null,
      truncated: false,
      directories: [],
      files: [],
      repository: null,
    },
    contents: {
      status: 'idle',
      error: null,
      path: '',
      entries: [],
      repository: null,
    },
    file: {
      status: 'idle',
      saveStatus: 'idle',
      error: null,
      saveError: null,
      canEdit: false,
      data: null,
    },
  },
  reducers: {
    setSelectedAnalyzeRepository(state, action) {
      state.selectedRepository = normalizeRepository(action.payload);
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchRepositoryStructure.pending, (state) => {
        state.structure.status = 'loading';
        state.structure.error = null;
      })
      .addCase(fetchRepositoryStructure.fulfilled, (state, action) => {
        state.selectedRepository = action.payload.repository;
        state.structure.status = 'succeeded';
        state.structure.error = null;
        state.structure.truncated = action.payload.truncated;
        state.structure.directories = action.payload.directories;
        state.structure.files = action.payload.files;
        state.structure.repository = action.payload.repository;
      })
      .addCase(fetchRepositoryStructure.rejected, (state, action) => {
        state.structure.status = 'failed';
        state.structure.error = action.payload || 'Could not load repository directories.';
      })
      .addCase(fetchDirectoryContents.pending, (state) => {
        state.contents.status = 'loading';
        state.contents.error = null;
      })
      .addCase(fetchDirectoryContents.fulfilled, (state, action) => {
        state.selectedRepository = action.payload.repository;
        state.contents.status = 'succeeded';
        state.contents.error = null;
        state.contents.path = action.payload.path;
        state.contents.entries = action.payload.entries;
        state.contents.repository = action.payload.repository;
      })
      .addCase(fetchDirectoryContents.rejected, (state, action) => {
        state.contents.status = 'failed';
        state.contents.error = action.payload || 'Could not load directory contents.';
      })
      .addCase(fetchRepositoryFile.pending, (state) => {
        state.file.status = 'loading';
        state.file.error = null;
      })
      .addCase(fetchRepositoryFile.fulfilled, (state, action) => {
        state.selectedRepository = action.payload.repository;
        state.file.status = 'succeeded';
        state.file.error = null;
        state.file.canEdit = action.payload.canEdit;
        state.file.data = action.payload.file;
      })
      .addCase(fetchRepositoryFile.rejected, (state, action) => {
        state.file.status = 'failed';
        state.file.error = action.payload || 'Could not load file content.';
      })
      .addCase(saveRepositoryFile.pending, (state) => {
        state.file.saveStatus = 'loading';
        state.file.saveError = null;
      })
      .addCase(saveRepositoryFile.fulfilled, (state, action) => {
        state.file.saveStatus = 'succeeded';
        state.file.saveError = null;

        if (state.file.data && state.file.data.path === action.payload.path) {
          state.file.data = {
            ...state.file.data,
            content: action.payload.content,
            sha: action.payload.file?.sha || state.file.data.sha,
            htmlUrl: action.payload.file?.htmlUrl || state.file.data.htmlUrl,
          };
        }
      })
      .addCase(saveRepositoryFile.rejected, (state, action) => {
        state.file.saveStatus = 'failed';
        state.file.saveError = action.payload || 'Could not save file changes.';
      });
    builder
      .addCase(commitFile.pending, (state) => {
        state.file.saveStatus = 'loading';
        state.file.saveError = null;
      })
      .addCase(commitFile.fulfilled, (state, action) => {
        state.file.saveStatus = 'succeeded';
        state.file.saveError = null;
        // Optionally update file sha if returned
        const file = action.payload?.file;
        if (file && state.file.data && state.file.data.path === file.path) {
          state.file.data = {
            ...state.file.data,
            sha: file.sha || state.file.data.sha,
            htmlUrl: file.htmlUrl || state.file.data.htmlUrl,
          };
        }
      })
      .addCase(commitFile.rejected, (state, action) => {
        state.file.saveStatus = 'failed';
        state.file.saveError = action.payload || 'Could not create PR.';
      });
  },
});

export const { setSelectedAnalyzeRepository } = analyzeSlice.actions;
export { commitFile };

export const selectAnalyzeSelectedRepository = (state) => state.analyze.selectedRepository;
export const selectAnalyzeStructure = (state) => state.analyze.structure;
export const selectAnalyzeContents = (state) => state.analyze.contents;
export const selectAnalyzeFile = (state) => state.analyze.file;

export default analyzeSlice.reducer;
