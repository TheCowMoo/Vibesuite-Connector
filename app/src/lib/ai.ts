import axios from 'axios';
import { AI_DEFAULTS, type AiSettings } from '../domain/aiSettings';
import { extractJson } from './json';

export interface GenerateOptions {
  /** Provider output-token ceiling. Index-only JSON stays far below this. */
  maxTokens?: number;
  /** Ask providers that support it to force a JSON response. */
  jsonMode?: boolean;
}

export class AiJsonError extends Error {
  constructor(message = 'The AI returned incomplete or malformed JSON.') {
    super(message);
    this.name = 'AiJsonError';
  }
}

function baseUrlFor(config: AiSettings): string {
  return (config.baseUrl || AI_DEFAULTS[config.provider].baseUrl).replace(/\/+$/, '');
}

async function generateOpenAi(
  config: AiSettings,
  system: string,
  prompt: string,
  options: GenerateOptions
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  // Custom OpenAI-compatible gateways do not all understand response_format.
  if (options.jsonMode && config.provider !== 'custom') body.response_format = { type: 'json_object' };

  const res = await axios.post(`${baseUrlFor(config)}/chat/completions`, body, {
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  return res.data?.choices?.[0]?.message?.content ?? '';
}

async function generateClaude(
  config: AiSettings,
  system: string,
  prompt: string,
  options: GenerateOptions
): Promise<string> {
  const res = await axios.post(
    `${baseUrlFor(config)}/messages`,
    {
      model: config.model,
      max_tokens: options.maxTokens ?? 4096,
      system,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 120000,
    }
  );
  const content = res.data?.content ?? [];
  return content.map((c: { text?: string }) => c.text ?? '').join('');
}

async function generateGemini(
  config: AiSettings,
  system: string,
  prompt: string,
  options: GenerateOptions
): Promise<string> {
  const url = `${baseUrlFor(config)}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const generationConfig: Record<string, unknown> = {};
  if (options.maxTokens) generationConfig.maxOutputTokens = options.maxTokens;
  if (options.jsonMode) generationConfig.responseMimeType = 'application/json';

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? '').join('');
}

export async function generateText(
  config: AiSettings,
  system: string,
  prompt: string,
  options: GenerateOptions = {}
): Promise<string> {
  switch (config.provider) {
    case 'claude':
      return generateClaude(config, system, prompt, options);
    case 'gemini':
      return generateGemini(config, system, prompt, options);
    case 'openai':
    case 'deepseek':
    case 'custom':
    default:
      return generateOpenAi(config, system, prompt, options);
  }
}

export async function generateJson<T>(
  config: AiSettings,
  system: string,
  prompt: string,
  options: GenerateOptions = {}
): Promise<T> {
  const text = await generateText(
    config,
    system + '\n\nRespond with ONLY valid JSON (no markdown fences, no commentary).',
    prompt,
    options
  );
  try {
    return JSON.parse(extractJson(text)) as T;
  } catch {
    throw new AiJsonError();
  }
}
