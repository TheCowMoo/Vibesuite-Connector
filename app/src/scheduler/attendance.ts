import { env } from '../config/env';
import { logger } from '../lib/logger';
import { listSessions } from '../domain/sessionStore';
import { syncSession, dispatchSession } from '../workers/attendance';

export async function checkAttendance(): Promise<void> {
  const sessions = await listSessions();
  const delayMs = env.ATTENDANCE_FETCH_DELAY_MIN * 60 * 1000;
  const now = Date.now();

  for (const s of sessions) {
    if (s.status === 'synced') continue;
    const endTime = Date.parse(s.endTime);
    if (Number.isNaN(endTime) || endTime + delayMs > now) continue;

    try {
      await syncSession(s.id);
      await dispatchSession(s.id);
    } catch (err) {
      logger.error({ sessionId: s.id, err: (err as Error).message }, 'attendance auto-sync failed');
    }
  }
}

export function startAttendancePolling(): NodeJS.Timeout {
  return setInterval(() => {
    void checkAttendance();
  }, env.ATTENDANCE_POLL_INTERVAL_MS);
}
