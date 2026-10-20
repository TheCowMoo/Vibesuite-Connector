import type { CampaignStatus } from './campaign';

export type TickAction = 'activate' | 'end' | 'send' | 'skip';

export interface LifecycleState {
  status: CampaignStatus;
  scheduledStartAt?: number;
  sendByAt?: number;
}

/**
 * What the scheduler should do with a campaign on this tick.
 *
 * Kept pure so the whole start/stop rule lives in one place instead of being spread through the
 * tick. The two cases that are easy to get wrong are pinned by tests: a `scheduled` campaign with
 * no start time must never fire, and an `active` campaign with no deadline must never auto-end.
 */
export function campaignTickAction(c: LifecycleState, now: number): TickAction {
  if (c.status === 'scheduled') {
    // A scheduled campaign whose deadline slipped past while the worker was down can never send,
    // so it is ended rather than activated — activating it would only freeze an audience that is
    // not allowed to receive anything.
    if (c.sendByAt !== undefined && now >= c.sendByAt) return 'end';
    return c.scheduledStartAt !== undefined && c.scheduledStartAt <= now ? 'activate' : 'skip';
  }

  if (c.status === 'active') {
    return c.sendByAt !== undefined && now >= c.sendByAt ? 'end' : 'send';
  }

  return 'skip';
}

/**
 * Why a stop time cannot be stored, or `undefined` when it can.
 *
 * The one rule behind create, patch, the deadline route and `resolveSendPlan()`. When these were
 * separate copies the wizard and the API disagreed, which is how "begin now, stop on Friday" ended up
 * dropping Friday.
 */
export function stopTimeError(c: { sendByAt?: number; scheduledStartAt?: number }, now: number): string | undefined {
  if (c.sendByAt === undefined) return undefined;
  if (c.sendByAt <= now) return 'the stop time must be in the future';
  if (c.scheduledStartAt !== undefined && c.sendByAt <= c.scheduledStartAt) {
    return 'the stop time must be after the start time';
  }
  return undefined;
}

export interface SendPlanInput {
  /** `now` means "create it and start when I press Begin sending"; `later` puts it on a timer. */
  startMode: 'now' | 'later';
  startAt?: number | null;
  stopBy?: number | null;
  now: number;
}

export interface SendPlanResult {
  scheduledStartAt?: number;
  sendByAt?: number;
  error?: string;
}

/**
 * Validate and normalise the start/stop pair the wizard and the API both accept.
 *
 * This exists because the two used to disagree: the wizard dropped a stop time entirely whenever the
 * start mode was "right away", so "begin now, stop on Friday" silently lost Friday. Keeping the rule
 * pure means that case is pinned by a test instead of being discovered in production.
 */
export function resolveSendPlan(input: SendPlanInput): SendPlanResult {
  const now = input.now;
  const stopBy = input.stopBy === undefined || input.stopBy === null ? undefined : Number(input.stopBy);

  if (stopBy !== undefined && !Number.isFinite(stopBy)) return { error: 'the stop time is not valid' };

  if (input.startMode !== 'later') {
    // Deliberately still returns sendByAt: a draft created "right away" keeps its deadline so the
    // later Begin sending press is bounded by it.
    const error = stopTimeError({ sendByAt: stopBy }, now);
    return error ? { error } : { sendByAt: stopBy };
  }

  const startAt = input.startAt === undefined || input.startAt === null ? Number.NaN : Number(input.startAt);
  if (!Number.isFinite(startAt)) return { error: 'a start time is required' };
  if (startAt <= now) return { error: 'the start time must be in the future' };

  const error = stopTimeError({ sendByAt: stopBy, scheduledStartAt: startAt }, now);
  return error ? { error } : { scheduledStartAt: startAt, sendByAt: stopBy };
}

/**
 * Why a campaign cannot begin right now, or `undefined` when it can.
 *
 * A deadline in the past would otherwise freeze the whole audience, queue it, and get ended on the
 * next tick — work that can never turn into an invitation. Pure so the rule is testable without Redis.
 */
export function startBlockedByDeadline(c: { sendByAt?: number }, now: number): string | undefined {
  if (c.sendByAt !== undefined && c.sendByAt <= now) {
    return 'the stop time has already passed — clear it or choose a new one';
  }
  return undefined;
}
