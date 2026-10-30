import { env } from '../config/env';
import { logger } from '../lib/logger';
import { listDueScheduledInvites, deferScheduledInvite } from '../domain/scheduledInviteStore';
import { runScheduledInviteRound, SCHEDULE_RETRY_MS } from '../domain/scheduledInviteRunner';

let running = false;

/** Send every scheduled invite round that is due. A tick never overlaps the previous one. */
export async function checkScheduledInvites(now = Date.now()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await listDueScheduledInvites(now);
    for (const schedule of due) {
      try {
        await runScheduledInviteRound(schedule.id, now);
      } catch (err) {
        const message = (err as Error).message;
        logger.error({ scheduleId: schedule.id, err: message }, 'scheduled invite round failed');
        await deferScheduledInvite(schedule.id, now + SCHEDULE_RETRY_MS, `retry after error: ${message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startInviteScheduler(): NodeJS.Timeout {
  void checkScheduledInvites();
  return setInterval(() => {
    void checkScheduledInvites();
  }, env.INVITE_SCHEDULE_TICK_INTERVAL_MS);
}
