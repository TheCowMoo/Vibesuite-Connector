import type { SessionStatus } from './sessionStore';

/** How long after a call ends we keep retrying while the provider has no report for it. */
export const REPORT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum gap between *automatic* retries while a report is missing. The poll loop runs far more
 * often than a report appears, and each attempt costs several Zoom calls — an operator pressing
 * `Sync now` is not throttled.
 */
export const PENDING_RETRY_INTERVAL_MS = 60 * 60 * 1000;

export type SyncOutcome = Extract<SessionStatus, 'synced' | 'pending'>;

/**
 * Should this session be marked synced, or left pending for the scheduler to retry?
 *
 * Zoom publishes reports some time after a call ends, and webinars can take much longer than meetings.
 * Saving "0 attended" at that moment is worse than waiting: campaign stats would mark everyone who said
 * yes as a no-show, and the auto-sync only ever touches non-synced sessions. So a missing report stays
 * `pending` inside a bounded window; after it lapses we stop retrying and keep the explanation in the
 * warnings rather than retrying forever.
 *
 * An unreadable end time also means "synced": there is nothing to anchor retries to, and a loop with no
 * horizon is worse than one honest empty result.
 */
export function syncOutcome(input: {
  reportReady: boolean;
  endTime: string;
  now: number;
  retryWindowMs?: number;
}): SyncOutcome {
  if (input.reportReady) return 'synced';

  const end = Date.parse(input.endTime);
  if (Number.isNaN(end)) return 'synced';

  const windowMs = input.retryWindowMs ?? REPORT_RETRY_WINDOW_MS;
  return input.now <= end + windowMs ? 'pending' : 'synced';
}

/** Has enough time passed for the poll loop to try a pending session again? */
export function dueForPendingRetry(input: {
  lastSyncedAt?: number;
  now: number;
  intervalMs?: number;
}): boolean {
  if (!input.lastSyncedAt) return true;
  return input.now - input.lastSyncedAt >= (input.intervalMs ?? PENDING_RETRY_INTERVAL_MS);
}
