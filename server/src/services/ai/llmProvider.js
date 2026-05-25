import axios from 'axios';
import OpenAI from 'openai';

const DEFAULT_OPENAI_CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DEFAULT_GEMINI_CHAT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const DEFAULT_ANTHROPIC_CHAT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
const DEFAULT_CHAT_MODEL = process.env.AI_MODEL || null;
const DEFAULT_EMBEDDING_MODEL =
  process.env.AI_EMBEDDING_MODEL || process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

function normalizeProvider(value) {
  const provider = String(value || 'openai-compatible').trim().toLowerCase();

  if (['openai', 'compatible', 'openai-compatible'].includes(provider)) {
    return 'openai-compatible';
  }

  if (['google', 'gemini'].includes(provider)) {
    return 'gemini';
  }

  if (['anthropic', 'claude'].includes(provider)) {
    return 'anthropic';
  }

  return provider;
}

function resolveChatApiKey(provider) {
  return (
    process.env.AI_API_KEY
    || (provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null)
    || (provider === 'gemini' ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY : null)
    || process.env.OPENAI_API_KEY
    || null
  );
}

function resolveChatModel(provider) {
  if (DEFAULT_CHAT_MODEL) return DEFAULT_CHAT_MODEL;
  if (provider === 'gemini') return DEFAULT_GEMINI_CHAT_MODEL;
  if (provider === 'anthropic') return DEFAULT_ANTHROPIC_CHAT_MODEL;
  return DEFAULT_OPENAI_CHAT_MODEL;
}

function resolveChatBaseUrl(provider) {
  if (process.env.AI_BASE_URL) return process.env.AI_BASE_URL;
  if (process.env.OPENAI_BASE_URL) return process.env.OPENAI_BASE_URL;

  if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
  if (provider === 'gemini') return 'https://generativelanguage.googleapis.com/v1beta';
  return null;
}

function resolveEmbeddingProvider() {
  return normalizeProvider(process.env.AI_EMBEDDING_PROVIDER || process.env.AI_PROVIDER || 'openai-compatible');
}

function resolveEmbeddingApiKey(provider) {
  return (
    process.env.AI_EMBEDDING_API_KEY
    || process.env.AI_API_KEY
    || process.env.OPENAI_API_KEY
    || (provider === 'gemini' ? process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY : null)
    || null
  );
}

function resolveEmbeddingBaseUrl() {
  return process.env.AI_EMBEDDING_BASE_URL || process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || null;
}

function normalizeMessageText(content) {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part?.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }

  return String(content || '').trim();
}

function toAnthropicPayload(messages = []) {
  const systemPrompts = [];
  const mappedMessages = [];

  for (const message of messages) {
    const role = String(message?.role || 'user').trim().toLowerCase();
    const text = normalizeMessageText(message?.content);
    if (!text) continue;

    if (role === 'system') {
      systemPrompts.push(text);
      continue;
    }

    mappedMessages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: text,
    });
  }

  return {
    system: systemPrompts.join('\n\n').trim() || undefined,
    messages: mappedMessages,
  };
}

function toGeminiPayload(messages = []) {
  const contents = [];

  for (const message of messages) {
    const role = String(message?.role || 'user').trim().toLowerCase();
    if (role === 'system') continue;

    const text = normalizeMessageText(message?.content);
    if (!text) continue;

    contents.push({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  }

  return contents;
}

export class ChatClient {
  constructor() {
    this.provider = normalizeProvider(process.env.AI_PROVIDER || 'openai-compatible');
    this.apiKey = resolveChatApiKey(this.provider);
    this.baseUrl = resolveChatBaseUrl(this.provider);
    this.model = resolveChatModel(this.provider);

    this.openai =
      this.provider === 'openai-compatible' && this.apiKey
        ? new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl || undefined,
          })
        : null;
  }

  isConfigured() {
    if (!this.apiKey) return false;
    if (!this.model) return false;
    return true;
  }

  async createChatCompletion({ messages, model, temperature, maxTokens, responseFormat } = {}) {
    if (!this.isConfigured()) {
      throw new Error('AI provider is not configured. Set AI_API_KEY and AI_MODEL (or OPENAI_* fallbacks).');
    }

    const selectedModel = model || this.model;

    if (this.provider === 'openai-compatible') {
      const response = await this.openai.chat.completions.create({
        model: selectedModel,
        temperature,
        max_tokens: maxTokens,
        response_format: responseFormat,
        messages,
      });

      const content = response?.choices?.[0]?.message?.content;
      return {
        content: normalizeMessageText(content),
        usage: response?.usage || {},
        raw: response,
      };
    }

    if (this.provider === 'anthropic') {
      const payload = toAnthropicPayload(messages);

      const response = await axios.post(
        this.baseUrl,
        {
          model: selectedModel,
          max_tokens: maxTokens || 512,
          temperature,
          system: payload.system,
          messages: payload.messages,
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 60_000,
        },
      );

      const blocks = Array.isArray(response?.data?.content) ? response.data.content : [];
      const content = blocks
        .map((block) => (block?.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();

      return {
        content,
        usage: response?.data?.usage || {},
        raw: response?.data,
      };
    }

    if (this.provider === 'gemini') {
      const base = String(this.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const endpoint = `${base}/models/${encodeURIComponent(selectedModel)}:generateContent`;
      const contents = toGeminiPayload(messages);

      const generationConfig = {
        temperature,
        maxOutputTokens: maxTokens,
      };

      if (responseFormat?.type === 'json_object') {
        generationConfig.responseMimeType = 'application/json';
      }

      const response = await axios.post(
        endpoint,
        {
          contents,
          generationConfig,
        },
        {
          params: { key: this.apiKey },
          headers: { 'content-type': 'application/json' },
          timeout: 60_000,
        },
      );

      const parts = response?.data?.candidates?.[0]?.content?.parts || [];
      const content = parts.map((part) => part?.text || '').filter(Boolean).join('\n').trim();

      return {
        content,
        usage: response?.data?.usageMetadata || {},
        raw: response?.data,
      };
    }

    throw new Error(
      `Unsupported AI_PROVIDER '${this.provider}'. Supported providers: openai-compatible, anthropic, gemini.`,
    );
  }

  async createStream({ messages, model, maxTokens, temperature, onText } = {}) {
    if (!this.isConfigured()) {
      throw new Error('AI provider is not configured. Set AI_API_KEY and AI_MODEL (or OPENAI_* fallbacks).');
    }

    if (this.provider === 'openai-compatible') {
      const stream = await this.openai.chat.completions.stream({
        model: model || this.model,
        max_tokens: maxTokens,
        temperature,
        messages,
      });

      return {
        cancel: () => {
          if (typeof stream?.abort === 'function') {
            stream.abort();
          }

          if (typeof stream?.controller?.abort === 'function') {
            stream.controller.abort();
          }
        },
        consume: async () => {
          for await (const chunk of stream) {
            const text = chunk?.choices?.[0]?.delta?.content || '';
            if (text) onText?.(text);
          }
        },
      };
    }

    // Fallback for providers without native stream handling in this adapter.
    return {
      cancel: () => undefined,
      consume: async () => {
        const completion = await this.createChatCompletion({
          messages,
          model,
          maxTokens,
          temperature,
        });
        if (completion?.content) {
          onText?.(completion.content);
        }
      },
    };
  }
}

export class EmbeddingClient {
  constructor() {
    this.provider = resolveEmbeddingProvider();
    this.apiKey = resolveEmbeddingApiKey(this.provider);
    this.baseUrl = resolveEmbeddingBaseUrl();
    this.model = DEFAULT_EMBEDDING_MODEL;

    this.openai =
      this.provider === 'openai-compatible' && this.apiKey
        ? new OpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl || undefined,
          })
        : null;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.model);
  }

  async createEmbedding({ input, model } = {}) {
    if (!this.isConfigured()) {
      throw new Error('Embedding provider is not configured. Set AI_EMBEDDING_API_KEY and AI_EMBEDDING_MODEL.');
    }

    if (this.provider !== 'openai-compatible') {
      throw new Error(
        `AI_EMBEDDING_PROVIDER '${this.provider}' is not supported. Use openai-compatible for embeddings.`,
      );
    }

    return this.openai.embeddings.create({
      model: model || this.model,
      input,
    });
  }
}

export function createChatClient() {
  return new ChatClient();
}

export function createEmbeddingClient() {
  return new EmbeddingClient();
}
