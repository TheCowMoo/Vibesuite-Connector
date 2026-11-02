import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

const CHOSEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const LOCK_TTL_SECONDS = 300;

/** The workflow already applied to this person in this session, if any. */
export async function getChosenWorkflow(sessionId: string, identity: string): Promise<string | undefined> {
  const value = await redis.get(REDIS_KEYS.attendanceWorkflowChosen(sessionId, identity));
  return value || undefined;
}

/** Short exclusive lock so two dispatch runs cannot apply a workflow to one person at once. */
export async function tryClaimWorkflowLock(sessionId: string, identity: string): Promise<boolean> {
  const result = await redis.set(
    REDIS_KEYS.attendanceWorkflowLock(sessionId, identity),
    '1',
    'EX',
    LOCK_TTL_SECONDS,
    'NX',
  );
  return result === 'OK';
}

export async function releaseWorkflowLock(sessionId: string, identity: string): Promise<void> {
  await redis.del(REDIS_KEYS.attendanceWorkflowLock(sessionId, identity));
}

export async function saveChosenWorkflow(
  sessionId: string,
  identity: string,
  workflowId: string,
): Promise<void> {
  await redis.set(
    REDIS_KEYS.attendanceWorkflowChosen(sessionId, identity),
    workflowId,
    'EX',
    CHOSEN_TTL_SECONDS,
  );
}

/** Used only by an explicit manual replace. */
export async function clearChosenWorkflow(sessionId: string, identity: string): Promise<void> {
  await redis.del(REDIS_KEYS.attendanceWorkflowChosen(sessionId, identity));
}
