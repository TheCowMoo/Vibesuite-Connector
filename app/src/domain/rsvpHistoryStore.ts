import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { GCalEvent } from '../google/types';
import { appendRsvpHistory, parseRsvpHistory, type RsvpHistoryEntry } from './rsvpHistory';

/** eventId -> email -> entries. */
export type RsvpHistoryIndex = Map<string, Map<string, RsvpHistoryEntry[]>>;

function historyMap(raw: Record<string, string> | undefined): Map<string, RsvpHistoryEntry[]> {
  const map = new Map<string, RsvpHistoryEntry[]>();
  for (const [email, json] of Object.entries(raw || {})) {
    map.set(email.trim().toLowerCase(), parseRsvpHistory(json));
  }
  return map;
}

export async function getRsvpHistory(connectionId: string, eventIds: string[]): Promise<RsvpHistoryIndex> {
  const unique = Array.from(new Set(eventIds.filter(Boolean)));
  const out: RsvpHistoryIndex = new Map();
  if (!unique.length) return out;

  const pipe = redis.pipeline();
  unique.forEach((eventId) => pipe.hgetall(REDIS_KEYS.rsvpHistory(connectionId, eventId)));
  const results = (await pipe.exec()) as unknown as Array<[Error | null, unknown]> | null;

  unique.forEach((eventId, index) => {
    const raw = results?.[index]?.[1];
    out.set(eventId, historyMap(raw && typeof raw === 'object' ? (raw as Record<string, string>) : undefined));
  });
  return out;
}

async function writeHistory(
  connectionId: string,
  updates: Array<{ eventId: string; email: string; entries: RsvpHistoryEntry[] }>,
  onlyIfMissing = false,
): Promise<void> {
  if (!updates.length) return;
  const pipe = redis.pipeline();
  for (const update of updates) {
    const key = REDIS_KEYS.rsvpHistory(connectionId, update.eventId);
    const value = JSON.stringify(update.entries);
    if (onlyIfMissing) pipe.hsetnx(key, update.email, value);
    else pipe.hset(key, update.email, value);
  }
  await pipe.exec();
}

/**
 * Record the statuses seen in a sync.
 *
 * The first observation is a tracking baseline; later changes append a real entry. Duplicate
 * attendee rows and unchanged statuses are ignored, so a repeated full sync is idempotent.
 */
export async function recordRsvpHistory(
  connectionId: string,
  events: GCalEvent[],
  at = Date.now(),
): Promise<void> {
  const relevant = events.filter(
    (event) => event.id && event.status !== 'cancelled' && (event.attendees?.length ?? 0) > 0,
  );
  if (!relevant.length) return;

  const current = await getRsvpHistory(connectionId, relevant.map((event) => event.id));
  const updates: Array<{ eventId: string; email: string; entries: RsvpHistoryEntry[] }> = [];

  for (const event of relevant) {
    const perEvent = current.get(event.id) ?? new Map<string, RsvpHistoryEntry[]>();
    for (const attendee of event.attendees ?? []) {
      const email = attendee.email?.trim().toLowerCase();
      if (!email) continue;
      const before = perEvent.get(email);
      const next = appendRsvpHistory(before, attendee.responseStatus ?? 'needsAction', at);
      if (next.length !== (before?.length ?? 0)) {
        perEvent.set(email, next);
        updates.push({ eventId: event.id, email, entries: next });
      }
    }
  }

  await writeHistory(connectionId, updates);
}

/**
 * Give existing campaigns a starting point when they first open the CRM.
 *
 * This never invents a response time: the entry is marked initial and the UI labels it
 * "Tracking started". Existing non-empty histories are left untouched.
 */
export async function ensureRsvpBaseline(
  connectionId: string,
  entries: Array<{ eventId: string; email: string; status?: string }>,
  at = Date.now(),
): Promise<void> {
  const byEvent = new Map<string, Map<string, string | undefined>>();
  for (const entry of entries) {
    const eventId = String(entry.eventId || '').trim();
    const email = String(entry.email || '').trim().toLowerCase();
    if (!eventId || !email) continue;
    let perEvent = byEvent.get(eventId);
    if (!perEvent) {
      perEvent = new Map();
      byEvent.set(eventId, perEvent);
    }
    if (!perEvent.has(email)) perEvent.set(email, entry.status);
  }
  if (!byEvent.size) return;

  const current = await getRsvpHistory(connectionId, Array.from(byEvent.keys()));
  const updates: Array<{ eventId: string; email: string; entries: RsvpHistoryEntry[] }> = [];
  for (const [eventId, emails] of byEvent) {
    const existing = current.get(eventId);
    for (const [email, status] of emails) {
      if (existing?.get(email)?.length) continue;
      updates.push({
        eventId,
        email,
        entries: appendRsvpHistory(undefined, status ?? 'needsAction', at),
      });
    }
  }
  await writeHistory(connectionId, updates, true);
}
