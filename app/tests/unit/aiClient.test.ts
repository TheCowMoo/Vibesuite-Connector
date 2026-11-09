import { describe, expect, it, vi, beforeEach } from 'vitest';

const { axiosPost } = vi.hoisted(() => ({ axiosPost: vi.fn() }));

vi.mock('axios', () => ({ default: { post: axiosPost } }));

vi.mock('../../src/domain/aiSettings', () => ({
  AI_DEFAULTS: {
    openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    claude: { model: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com/v1' },
    gemini: { model: 'gemini-1.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    custom: { model: '', baseUrl: '' },
  },
}));

import { AiJsonError, generateJson, generateText } from '../../src/lib/ai';
import type { AiSettings } from '../../src/domain/aiSettings';

const openai: AiSettings = { provider: 'openai', apiKey: 'key', model: 'gpt-4o-mini' };
const claude: AiSettings = { provider: 'claude', apiKey: 'key', model: 'claude-3-5-sonnet-latest' };
const gemini: AiSettings = { provider: 'gemini', apiKey: 'key', model: 'gemini-1.5-flash' };
const custom: AiSettings = { provider: 'custom', apiKey: 'key', model: 'local', baseUrl: 'http://localhost:1234/v1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AI provider options', () => {
  it('sends JSON mode and an output ceiling to OpenAI-compatible providers', async () => {
    axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":true}' } }] } });

    await generateJson(openai, 'system', 'prompt', { maxTokens: 1234, jsonMode: true });

    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        max_tokens: 1234,
        response_format: { type: 'json_object' },
      }),
      expect.any(Object),
    );
  });

  it('does not send response_format to a custom gateway', async () => {
    axiosPost.mockResolvedValue({ data: { choices: [{ message: { content: '{"ok":true}' } }] } });

    await generateJson(custom, 'system', 'prompt', { maxTokens: 1234, jsonMode: true });

    expect(axiosPost.mock.calls[0][1]).not.toHaveProperty('response_format');
  });

  it('passes the output ceiling to Claude', async () => {
    axiosPost.mockResolvedValue({ data: { content: [{ text: 'ok' }] } });

    await generateText(claude, 'system', 'prompt', { maxTokens: 2222 });

    expect(axiosPost).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({ max_tokens: 2222 }),
      expect.any(Object),
    );
  });

  it('passes JSON mode and the output ceiling to Gemini', async () => {
    axiosPost.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } });

    await generateJson(gemini, 'system', 'prompt', { maxTokens: 3333, jsonMode: true });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/models/gemini-1.5-flash:generateContent'),
      expect.objectContaining({
        generationConfig: { maxOutputTokens: 3333, responseMimeType: 'application/json' },
      }),
      expect.any(Object),
    );
  });

  it('turns a truncated JSON response into an actionable error type', async () => {
    axiosPost.mockResolvedValue({
      data: { choices: [{ message: { content: '{"segments":[{"name":"Hot","rowIndexes":[0,1' } }] },
    });

    await expect(generateJson(openai, 'system', 'prompt')).rejects.toBeInstanceOf(AiJsonError);
  });
});
