import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';

export interface TeamSettings {
  inviteWebhookUrl?: string;
}

export async function getTeamSettings(): Promise<TeamSettings> {
  const raw = await redis.get(REDIS_KEYS.teamSettings());
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TeamSettings;
  } catch {
    return {};
  }
}

export async function saveTeamSettings(s: TeamSettings): Promise<void> {
  await redis.set(REDIS_KEYS.teamSettings(), JSON.stringify(s));
}

/** Stored value wins; env var is the default. */
export async function resolveInviteWebhookUrl(): Promise<string | undefined> {
  const s = await getTeamSettings();
  return s.inviteWebhookUrl || env.TEAM_INVITE_WEBHOOK_URL;
}
