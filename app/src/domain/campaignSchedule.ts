export interface SenderClaim {
  campaignId: string;
  campaignPriority: number;
  createdAt: number;
  queued: number;
}

/** Highest campaign priority first, then the oldest campaign. Deterministic. */
export function orderClaims(claims: SenderClaim[]): SenderClaim[] {
  return [...claims].sort((a, b) => {
    if (b.campaignPriority !== a.campaignPriority) return b.campaignPriority - a.campaignPriority;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    if (a.campaignId === b.campaignId) return 0;
    return a.campaignId < b.campaignId ? -1 : 1;
  });
}

/**
 * Split a mailbox's allowance across the campaigns it is serving. Every campaign with
 * work gets an equal slice first (so a big high-priority campaign cannot starve the
 * rest), then leftover capacity flows back down the priority order.
 */
export function allocateBatch(allowance: number, claims: SenderClaim[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (allowance <= 0 || !claims.length) return out;

  const ordered = orderClaims(claims);
  const fair = Math.floor(allowance / ordered.length);
  let left = allowance;

  for (const c of ordered) {
    const take = Math.max(0, Math.min(c.queued, fair, left));
    out[c.campaignId] = take;
    left -= take;
  }

  for (const c of ordered) {
    if (left <= 0) break;
    const room = Math.max(0, Math.min(c.queued - out[c.campaignId], left));
    if (room > 0) {
      out[c.campaignId] += room;
      left -= room;
    }
  }
  return out;
}

export interface ReadinessInput {
  enabled: boolean;
  inWindow: boolean;
  coolingUntil?: number;
  now: number;
  capToday: number;
  sentToday: number;
  hourlyCap?: number;
  sentThisHour: number;
}

export interface Readiness {
  ready: boolean;
  reason?: string;
  allowance: number;
}

/** Can this mailbox send right now, and how much? */
export function senderReadiness(input: ReadinessInput): Readiness {
  if (!input.enabled) return { ready: false, allowance: 0, reason: 'paused' };
  if (input.coolingUntil && input.coolingUntil > input.now) return { ready: false, allowance: 0, reason: 'cooling down' };
  if (!input.inWindow) return { ready: false, allowance: 0, reason: 'outside send window' };

  const daily = Math.max(0, input.capToday - input.sentToday);
  const hourly = input.hourlyCap ? Math.max(0, input.hourlyCap - input.sentThisHour) : Number.POSITIVE_INFINITY;
  const allowance = Math.min(daily, hourly);

  if (allowance <= 0) {
    return { ready: false, allowance: 0, reason: daily <= 0 ? 'daily cap reached' : 'hourly cap reached' };
  }
  return { ready: true, allowance };
}

export function dueForNextBatch(lastSentAt: number | undefined, minDelayMs: number | undefined, now: number): boolean {
  if (!minDelayMs || !lastSentAt) return true;
  return now - lastSentAt >= minDelayMs;
}

/** Random pacing between batches: [minDelay, 1.5 × minDelay], never above 15 minutes. */
export function jitterDelay(minDelayMs: number | undefined, rand: () => number = Math.random): number {
  const base = Math.max(0, minDelayMs ?? 0);
  if (base <= 0) return 0;
  const extra = Math.floor(base * 0.5 * Math.max(0, Math.min(1, rand())));
  return Math.min(base + extra, 15 * 60 * 1000);
}

/** A mailbox that cannot make progress right now, so its queued work should move. */
export function isStranded(input: { enabled: boolean; cooling: boolean; queueLength: number }): boolean {
  return input.queueLength > 0 && (!input.enabled || input.cooling);
}
