import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  conversationId: null,
  messages: [],
  jobId: null,
  streamingText: '',
  isStreaming: false,
  streamError: null,
  history: [],
  historyStatus: 'idle',
};

const conversationSlice = createSlice({
  name: 'conversation',
  initialState,
  reducers: {
    initConversation(state, action) {
      const jobId = action.payload?.jobId || null;
      if (state.jobId !== jobId) {
        state.conversationId = null;
        state.messages = [];
        state.streamingText = '';
        state.isStreaming = false;
        state.streamError = null;
        state.jobId = jobId;
      }
    },
    clearConversation(state) {
      state.conversationId = null;
      state.messages = [];
      state.streamingText = '';
      state.isStreaming = false;
      state.streamError = null;
    },
    addUserMessage(state, action) {
      state.messages.push({
        id: `user-${Date.now()}`,
        role: 'user',
        content: action.payload?.content || '',
        sourceFiles: [],
        isStreaming: false,
      });
    },
    beginStreaming(state) {
      state.isStreaming = true;
      state.streamingText = '';
      state.streamError = null;
    },
    appendStreamChunk(state, action) {
      state.streamingText += action.payload?.text || '';
    },
    finalizeStream(state, action) {
      const conversationId = action.payload?.conversationId || null;
      const sources = Array.isArray(action.payload?.sources) ? action.payload.sources : [];

      state.isStreaming = false;
      state.conversationId = conversationId || state.conversationId;
      state.messages.push({
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: state.streamingText,
        sourceFiles: sources,
        isStreaming: false,
      });
      state.streamingText = '';
    },
    setStreamError(state, action) {
      state.isStreaming = false;
      state.streamError = action.payload?.message || 'Chat failed.';
      state.streamingText = '';
    },
    setHistoryStatus(state, action) {
      state.historyStatus = action.payload;
    },
    setHistory(state, action) {
      state.history = Array.isArray(action.payload) ? action.payload : [];
    },
    loadConversationMessages(state, action) {
      const conversationId = action.payload?.conversationId || null;
      const messages = Array.isArray(action.payload?.messages) ? action.payload.messages : [];

      state.conversationId = conversationId;
      state.messages = messages.map((message, index) => ({
        id: message.id || `loaded-${index}`,
        role: message.role,
        content: message.content,
        sourceFiles: Array.isArray(message.source_files) ? message.source_files : [],
        confidence: message.confidence || null,
        isStreaming: false,
      }));
      state.streamingText = '';
      state.isStreaming = false;
      state.streamError = null;
    },
  },
});

export const {
  initConversation,
  clearConversation,
  addUserMessage,
  beginStreaming,
  appendStreamChunk,
  finalizeStream,
  setStreamError,
  setHistoryStatus,
  setHistory,
  loadConversationMessages,
} = conversationSlice.actions;

export const selectConversationId = (state) => state.conversation.conversationId;
export const selectMessages = (state) => state.conversation.messages;
export const selectIsStreaming = (state) => state.conversation.isStreaming;
export const selectStreamingText = (state) => state.conversation.streamingText;
export const selectStreamError = (state) => state.conversation.streamError;
export const selectConversationHistory = (state) => state.conversation.history;
export const selectConversationHistoryStatus = (state) => state.conversation.historyStatus;

export default conversationSlice.reducer;