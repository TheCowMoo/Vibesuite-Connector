import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { InviteEventPayload } from './inviteSend';

export type ScheduledInviteStatus = 'scheduled' | 'paused' | 'completed' | 'cancelled';

export interface ScheduledInviteEvent {
  connectionId: string;
  connectionName?: string;
  eventId: string;
  htmlLink?: string;
  count: number;
}

export interface ScheduledInviteRound {
  at: number;
  completedAt: number;
  sent: number;
  failed: number;
  events: ScheduledInviteEvent[];
  error?: string;
}

/**
 * A batched one-off invitation: the first round is sent by the API, later rounds by the worker.
 * `remaining` holds the emails that did not fit yet; it is re-checked against the list at each round.
 */
export interface ScheduledInviteRecord {
  id: string;
  inviteId: string;
  listId: string;
  listName: string;
  segments: string[];
  event: InviteEventPayload;
  connectionIds: string[];
  force: boolean;
  /** Maximum recipients per event, per account. */
  batchSize: number;
  delayMs: number;
  /** Event start; no round begins at or after this. */
  stopAt: number;
  remaining: string[];
  rounds: ScheduledInviteRound[];
  nextAt: number;
  status: ScheduledInviteStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export async function createScheduledInvite(
  input: Omit<ScheduledInviteRecord, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ScheduledInviteRecord> {
  const now = Date.now();
  const rec: ScheduledInviteRecord = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
  await redis
    .multi()
    .sadd(REDIS_KEYS.inviteSchedulesIndex(), rec.id)
    .set(REDIS_KEYS.inviteSchedule(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function getScheduledInvite(id: string): Promise<ScheduledInviteRecord | null> {
  const raw = await redis.get(REDIS_KEYS.inviteSchedule(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScheduledInviteRecord;
  } catch {
    return null;
  }
}

export async function saveScheduledInvite(rec: ScheduledInviteRecord): Promise<void> {
  rec.updatedAt = Date.now();
  await redis.set(REDIS_KEYS.inviteSchedule(rec.id), JSON.stringify(rec));
}

export async function listScheduledInvites(): Promise<ScheduledInviteRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.inviteSchedulesIndex());
  const recs = await Promise.all(ids.map((id) => getScheduledInvite(id)));
  return recs
    .filter((r): r is ScheduledInviteRecord => r !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function listDueScheduledInvites(now: number): Promise<ScheduledInviteRecord[]> {
  const all = await listScheduledInvites();
  return all
    .filter((r) => r.status === 'scheduled' && r.nextAt <= now)
    .sort((a, b) => a.nextAt - b.nextAt);
}

export async function setScheduledInviteStatus(
  id: string,
  status: ScheduledInviteStatus,
  error?: string,
): Promise<ScheduledInviteRecord | null> {
  const rec = await getScheduledInvite(id);
  if (!rec) return null;
  rec.status = status;
  rec.error = error;
  await saveScheduledInvite(rec);
  return rec;
}

/** Push a schedule's next attempt out after an unexpected failure, so a tick cannot hammer it. */
export async function deferScheduledInvite(id: string, until: number, error: string): Promise<void> {
  const rec = await getScheduledInvite(id);
  if (!rec) return;
  rec.nextAt = until;
  rec.error = error;
  await saveScheduledInvite(rec);
}
