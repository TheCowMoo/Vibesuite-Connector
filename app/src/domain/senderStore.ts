import { env } from '../config/env';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import {
  DEFAULT_WINDOW,
  SenderProfileSchema,
  dailyCapFor,
  isWithinWindow,
  isoDate,
  rampDayIndex,
  type SenderProfile,
  type SenderState,
} from './senderLoad';

export function defaultSenderProfile(connectionId: string): SenderProfile {
  return {
    connectionId,
    enabled: true,
    mode: 'flat',
    dailyCap: env.CAMPAIGN_DEFAULT_DAILY_CAP,
    hourlyCap: env.CAMPAIGN_DEFAULT_HOURLY_CAP,
    minDelayMs: env.CAMPAIGN_DEFAULT_MIN_DELAY_MS,
    window: { ...DEFAULT_WINDOW },
  };
}

export function parseSenderProfile(input: unknown, connectionId: string) {
  return SenderProfileSchema.safeParse({ ...(input as Record<string, unknown>), connectionId });
}

export async function getSenderProfile(connectionId: string): Promise<SenderProfile> {
  const base = defaultSenderProfile(connectionId);
  const raw = await redis.get(REDIS_KEYS.senderProfile(connectionId));
  if (!raw) return base;
  try {
    return { ...base, ...(JSON.parse(raw) as Partial<SenderProfile>), connectionId };
  } catch {
    return base;
  }
}

export async function saveSenderProfile(profile: SenderProfile): Promise<void> {
  await redis
    .multi()
    .sadd(REDIS_KEYS.senderProfiles(), profile.connectionId)
    .set(REDIS_KEYS.senderProfile(profile.connectionId), JSON.stringify(profile))
    .exec();
}

/* ---- counters (keyed by mailbox, global across campaigns) ---- */

export function isoHour(at: Date = new Date()): string {
  return at.toISOString().slice(0, 13);
}

export async function getSenderDay(connectionId: string, date: string): Promise<{ sent: number; failed: number }> {
  const h = await redis.hgetall(REDIS_KEYS.senderDay(connectionId, date));
  return { sent: Number(h?.sent ?? 0) || 0, failed: Number(h?.failed ?? 0) || 0 };
}

export async function bumpSenderDay(connectionId: string, date: string, field: 'sent' | 'failed', by = 1): Promise<void> {
  const key = REDIS_KEYS.senderDay(connectionId, date);
  await redis.multi().hincrby(key, field, by).expire(key, 60 * 60 * 24 * 35).exec();
}

export async function getSenderHour(connectionId: string, hour: string): Promise<number> {
  const v = await redis.get(REDIS_KEYS.senderHour(connectionId, hour));
  return v ? Number(v) || 0 : 0;
}

/** Oldest-first daily counters, used by the Advisor snapshot. */
export async function getSenderHistory(connectionId: string, days = 14, at: Date = new Date()): Promise<Array<{ date: string; sent: number; failed: number }>> {
  const out: Array<{ date: string; sent: number; failed: number }> = [];
  for (let i = Math.max(1, days) - 1; i >= 0; i -= 1) {
    const date = new Date(at.getTime() - i * 86400000).toISOString().slice(0, 10);
    const day = await getSenderDay(connectionId, date);
    out.push({ date, sent: day.sent, failed: day.failed });
  }
  return out;
}

export async function bumpSenderHour(connectionId: string, hour: string, by = 1): Promise<void> {
  const key = REDIS_KEYS.senderHour(connectionId, hour);
  await redis.multi().incrby(key, by).expire(key, 60 * 60 * 3).exec();
}

/* ---- state ---- */
export async function getSenderState(connectionId: string): Promise<SenderState> {
  const raw = await redis.get(REDIS_KEYS.senderState(connectionId));
  if (!raw) return { errorStreak: 0 };
  try {
    return JSON.parse(raw) as SenderState;
  } catch {
    return { errorStreak: 0 };
  }
}

export async function saveSenderState(connectionId: string, state: SenderState): Promise<void> {
  await redis.set(REDIS_KEYS.senderState(connectionId), JSON.stringify(state));
}

export async function clearSenderCooldown(connectionId: string): Promise<void> {
  const state = await getSenderState(connectionId);
  state.cooldownUntil = undefined;
  state.errorStreak = 0;
  state.lastError = undefined;
  await saveSenderState(connectionId, state);
}

/* ---- live gauge ---- */

export interface SenderGauge {
  connectionId: string;
  profile: SenderProfile;
  state: SenderState;
  todayISO: string;
  capToday: number;
  sentToday: number;
  failedToday: number;
  sentThisHour: number;
  headroom: number;
  rampDayIndex: number;
  inWindow: boolean;
  cooling: boolean;
}

export async function getSenderGauge(connectionId: string, at: Date = new Date()): Promise<SenderGauge> {
  const profile = await getSenderProfile(connectionId);
  const state = await getSenderState(connectionId);
  const todayISO = isoDate(at);
  const [day, sentThisHour] = await Promise.all([
    getSenderDay(connectionId, todayISO),
    getSenderHour(connectionId, isoHour(at)),
  ]);
  const capToday = dailyCapFor(profile, todayISO);

  return {
    connectionId,
    profile,
    state,
    todayISO,
    capToday,
    sentToday: day.sent,
    failedToday: day.failed,
    sentThisHour,
    headroom: Math.max(0, capToday - day.sent),
    rampDayIndex: rampDayIndex(profile, todayISO),
    inWindow: isWithinWindow(profile.window, at),
    cooling: !!state.cooldownUntil && state.cooldownUntil > Date.now(),
  };
}
