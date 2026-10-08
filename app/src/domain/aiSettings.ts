import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import { seal, open } from '../lib/crypto';

export type AiProvider = 'openai' | 'claude' | 'gemini' | 'deepseek' | 'custom';

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export const AI_DEFAULTS: Record<AiProvider, { model: string; baseUrl: string }> = {
  openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  claude: { model: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { model: 'gemini-1.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
  custom: { model: '', baseUrl: '' },
};

export function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? '••••' : '';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

export async function getAiSettings(): Promise<AiSettings | null> {
  const raw = await redis.get(REDIS_KEYS.aiSettings());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AiSettings;
    parsed.apiKey = open(parsed.apiKey, env.CREDENTIALS_ENCRYPTION_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export async function saveAiSettings(s: AiSettings): Promise<void> {
  await redis.set(REDIS_KEYS.aiSettings(), JSON.stringify({ ...s, apiKey: seal(s.apiKey, env.CREDENTIALS_ENCRYPTION_KEY) }));
}

export async function deleteAiSettings(): Promise<void> {
  await redis.del(REDIS_KEYS.aiSettings());
}
