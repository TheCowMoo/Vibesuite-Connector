import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import { seal, open } from '../lib/crypto';

/**
 * Credentials and template for platform email, sent through GoHighLevel.
 *
 * Scope is deliberately narrow: team invites and account notices. Calendar invitations are never
 * sent from here — those go out through each connection's own Google account.
 */
export interface SystemEmailSettings {
  apiToken?: string;
  locationId?: string;
  fromEmail?: string;
  fromName?: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
}

export const DEFAULT_FROM_EMAIL = 'info@connect.vibesuite.io';
export const DEFAULT_FROM_NAME = 'Vibesuite';

export async function getSystemEmailSettings(): Promise<SystemEmailSettings> {
  const raw = await redis.get(REDIS_KEYS.systemEmailSettings());
  if (!raw) return {};
  try {
    return JSON.parse(open(raw, env.CREDENTIALS_ENCRYPTION_KEY)) as SystemEmailSettings;
  } catch {
    return {};
  }
}

export async function saveSystemEmailSettings(s: SystemEmailSettings): Promise<void> {
  await redis.set(REDIS_KEYS.systemEmailSettings(), seal(JSON.stringify(s), env.CREDENTIALS_ENCRYPTION_KEY));
}

export interface ResolvedSystemEmail {
  apiToken?: string;
  locationId?: string;
  fromEmail: string;
  fromName: string;
  subjectTemplate?: string;
  bodyTemplate?: string;
}

/** Stored value wins; env vars are defaults; then the built-in ones. */
export async function resolveSystemEmailSettings(): Promise<ResolvedSystemEmail> {
  const s = await getSystemEmailSettings();
  return {
    apiToken: s.apiToken || env.SYSTEM_EMAIL_GHL_TOKEN || undefined,
    locationId: s.locationId || env.SYSTEM_EMAIL_GHL_LOCATION_ID || undefined,
    fromEmail: s.fromEmail || env.SYSTEM_EMAIL_FROM || DEFAULT_FROM_EMAIL,
    fromName: s.fromName || DEFAULT_FROM_NAME,
    subjectTemplate: s.subjectTemplate,
    bodyTemplate: s.bodyTemplate,
  };
}

export function systemEmailConfigured(s: { apiToken?: string; locationId?: string }): boolean {
  return Boolean(s.apiToken && s.locationId);
}

function mask(secret?: string): string {
  if (!secret) return '';
  if (secret.length < 8) return '••••';
  return secret.slice(0, 4) + '••••' + secret.slice(-4);
}

/** Never returns the token in full. */
export function publicSystemEmailSettings(s: SystemEmailSettings): Record<string, unknown> {
  return {
    apiTokenMasked: mask(s.apiToken),
    locationId: s.locationId || '',
    fromEmail: s.fromEmail || '',
    fromName: s.fromName || '',
    subjectTemplate: s.subjectTemplate || '',
    bodyTemplate: s.bodyTemplate || '',
  };
}