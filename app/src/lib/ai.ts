import axios from 'axios';
import { AI_DEFAULTS, type AiSettings } from '../domain/aiSettings';
import { extractJson } from './json';

function baseUrlFor(config: AiSettings): string {
  return (config.baseUrl || AI_DEFAULTS[config.provider].baseUrl).replace(/\/+$/, '');
}

async function generateOpenAi(config: AiSettings, system: string, prompt: string): Promise<string> {
  const res = await axios.post(
    `${baseUrlFor(config)}/chat/completions`,
    { model: config.model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
    { headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, timeout: 120000 }
  );
  return res.data?.choices?.[0]?.message?.content ?? '';
}

async function generateClaude(config: AiSettings, system: string, prompt: string): Promise<string> {
  const res = await axios.post(
    `${baseUrlFor(config)}/messages`,
    { model: config.model, max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] },
    { headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: 120000 }
  );
  const content = res.data?.content ?? [];
  return content.map((c: { text?: string }) => c.text ?? '').join('');
}

async function generateGemini(config: AiSettings, system: string, prompt: string): Promise<string> {
  const url = `${baseUrlFor(config)}/models/${config.model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
  const res = await axios.post(
    url,
    { systemInstruction: { parts: [{ text: system }] }, contents: [{ parts: [{ text: prompt }] }] },
    { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
  );
  const parts = res.data?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p: { text?: string }) => p.text ?? '').join('');
}

export async function generateText(config: AiSettings, system: string, prompt: string): Promise<string> {
  switch (config.provider) {
    case 'claude':
      return generateClaude(config, system, prompt);
    case 'gemini':
      return generateGemini(config, system, prompt);
    case 'openai':
    case 'deepseek':
    case 'custom':
    default:
      return generateOpenAi(config, system, prompt);
  }
}

export async function generateJson<T>(config: AiSettings, system: string, prompt: string): Promise<T> {
  const text = await generateText(
    config,
    system + '\n\nRespond with ONLY valid JSON (no markdown fences, no commentary).',
    prompt
  );
  return JSON.parse(extractJson(text)) as T;
}
