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
    return c.scheduledStartAt !== undefined && c.scheduledStartAt <= now ? 'activate' : 'skip';
  }

  if (c.status === 'active') {
    return c.sendByAt !== undefined && now >= c.sendByAt ? 'end' : 'send';
  }

  return 'skip';
}