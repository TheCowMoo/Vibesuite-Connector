import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { getActiveConnections } from '../domain/connectionStore';
import { reconcileConnections } from '../domain/reconcile';
import { processSync } from '../workers/pipeline';

/**
 * Catch-up pass over every active connection.
 *
 * Google push notifications are not guaranteed, and `webhook.ts` replies `200` to Google *before* it
 * enqueues the job — so a dropped notification, or a failed enqueue, would leave that RSVP unsynced
 * until some *other* event on the calendar happened to produce another notification. Nothing else in
 * the system reconciles: `scheduler/renewal.ts` only renews the watch channel itself.
 *
 * `processSync()` is the entire implementation, because it is already idempotent — it takes a
 * per-connection lock, diffs against stored state, and claims every dispatch with `SET NX`. So
 * sweeping on a timer is a cheap no-op when nothing changed, and a sweep that overlaps a
 * webhook-driven sync simply skips that connection (the lock is held) rather than double-sending.
 * A connection that has never synced takes the full-sync branch, which stores a baseline and
 * dispatches nothing — so sweeping a fresh connection cannot spam GoHighLevel.
 */
export async function reconcileAll(): Promise<{ attempted: number; failed: number }> {
  const conns = await getActiveConnections();
  const outcome = await reconcileConnections(
    conns.map((c) => c.id),
    processSync,
  );

  for (const failure of outcome.failures) {
    logger.error(
      { connectionId: failure.connectionId, err: failure.message },
      'reconcile sweep failed for connection',
    );
  }

  inc('reconcile_runs_total');
  if (outcome.failed) inc('reconcile_errors_total', {}, outcome.failed);
  if (outcome.attempted) {
    logger.info({ attempted: outcome.attempted, failed: outcome.failed }, 'reconcile sweep complete');
  }

  return { attempted: outcome.attempted, failed: outcome.failed };
}

/**
 * Self-rescheduling catch-up sweep.
 *
 * It runs once at startup on purpose: a worker restart then doubles as a recovery point for
 * anything missed while it was down, which is exactly when notifications go missing. A tick is
 * never started while the previous one is still running, matching `startCampaignScheduler`.
 * `SYNC_RECONCILE_INTERVAL_MS=0` disables it entirely.
 */
export function startReconciliation(): NodeJS.Timeout | undefined {
  const interval = env.SYNC_RECONCILE_INTERVAL_MS;
  if (interval <= 0) {
    logger.info('reconciliation sweep disabled (SYNC_RECONCILE_INTERVAL_MS=0)');
    return undefined;
  }

  let running = false;
  const run = (): void => {
    if (running) {
      logger.debug('reconcile sweep still running; skipping this tick');
      return;
    }
    running = true;
    void reconcileAll()
      .then(
        () => undefined,
        (err) => logger.error({ err: (err as Error).message }, 'reconcile sweep failed'),
      )
      .then(() => {
        running = false;
      });
  };

  run();
  return setInterval(run, interval);
}
