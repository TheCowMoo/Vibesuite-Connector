import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import { seal, open } from '../lib/crypto';

export interface VideoSettings {
  zoom?: { accountId: string; clientId: string; clientSecret: string };
  webinargeek?: { apiKey: string };
}

export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length < 8) return '••••';
  return secret.slice(0, 4) + '••••' + secret.slice(-4);
}

export async function getVideoSettings(): Promise<VideoSettings> {
  const raw = await redis.get(REDIS_KEYS.videoSettings());
  if (!raw) return {};
  try {
    return JSON.parse(open(raw, env.CREDENTIALS_ENCRYPTION_KEY)) as VideoSettings;
  } catch {
    return {};
  }
}

export async function saveVideoSettings(s: VideoSettings): Promise<void> {
  await redis.set(REDIS_KEYS.videoSettings(), seal(JSON.stringify(s), env.CREDENTIALS_ENCRYPTION_KEY));
}

export function publicVideoSettings(s: VideoSettings): Record<string, unknown> {
  return {
    zoom: s.zoom
      ? { accountId: s.zoom.accountId, clientId: s.zoom.clientId, clientSecretMasked: maskSecret(s.zoom.clientSecret) }
      : undefined,
    webinargeek: s.webinargeek ? { apiKeyMasked: maskSecret(s.webinargeek.apiKey) } : undefined,
  };
}
