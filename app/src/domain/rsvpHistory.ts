import { normalizeRsvp, type RsvpStatus } from './campaignStats';

export interface RsvpHistoryEntry {
  status: RsvpStatus;
  /** When our sync first observed this status. Google does not expose a response time. */
  at: number;
  /** True for the first observation, which is a tracking baseline, not a reply time. */
  initial?: boolean;
}

export const RSVP_HISTORY_LIMIT = 20;

/** Append only a real change, keeping the first observation marked as a baseline. */
export function appendRsvpHistory(
  existing: RsvpHistoryEntry[] | undefined,
  status: string,
  at: number,
  limit = RSVP_HISTORY_LIMIT,
): RsvpHistoryEntry[] {
  const entries = Array.isArray(existing) ? existing.slice() : [];
  const normalized = normalizeRsvp(status);
  const last = entries[entries.length - 1];
  if (last && last.status === normalized) return entries;

  entries.push({
    status: normalized,
    at,
    ...(entries.length ? {} : { initial: true }),
  });
  return entries.slice(-Math.max(1, limit));
}

export function parseRsvpHistory(raw: string | undefined): RsvpHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RsvpHistoryEntry => {
        if (!entry || typeof entry !== 'object') return false;
        const e = entry as Record<string, unknown>;
        return typeof e.status === 'string' && typeof e.at === 'number';
      })
      .map((entry) => ({
        status: normalizeRsvp(entry.status),
        at: entry.at,
        ...(entry.initial ? { initial: true } : {}),
      }));
  } catch {
    return [];
  }
}
