import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

// Attendance dispatch happens once per session (unlike RSVP toggling), so a long TTL is fine.
const TTL_SECONDS = 60 * 60 * 24 * 7;

export async function tryClaimAttendanceDispatch(sessionId: string, fingerprint: string): Promise<boolean> {
  const res = await redis.set(REDIS_KEYS.attendanceDispatched(sessionId, fingerprint), '1', 'EX', TTL_SECONDS, 'NX');
  return res === 'OK';
}

export async function releaseAttendanceDispatch(sessionId: string, fingerprint: string): Promise<void> {
  await redis.del(REDIS_KEYS.attendanceDispatched(sessionId, fingerprint));
}
