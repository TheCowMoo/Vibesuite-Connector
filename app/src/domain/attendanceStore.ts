import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { AttendanceReport } from './attendance';

export async function saveAttendance(report: AttendanceReport): Promise<void> {
  await redis.set(REDIS_KEYS.attendance(report.sessionId), JSON.stringify(report));
}

export async function getAttendance(sessionId: string): Promise<AttendanceReport | null> {
  const raw = await redis.get(REDIS_KEYS.attendance(sessionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AttendanceReport;
  } catch {
    return null;
  }
}
