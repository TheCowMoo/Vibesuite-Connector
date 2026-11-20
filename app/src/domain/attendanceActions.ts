import { env } from '../config/env';
import { open, seal } from '../lib/crypto';
import type {
  AttendanceActionSnapshot,
  AttendanceAiWorkflowSettings,
  StoredConnection,
} from './connection';
import type { SessionRecord } from './sessionStore';

export const DEFAULT_ATTENDANCE_AI: AttendanceAiWorkflowSettings = {
  enabled: false,
  mode: 'preview',
  confidenceThreshold: 0.7,
  maxAttendees: 25,
};

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Copy a connection's non-secret after-call configuration. A call can start from this and then
 * diverge without changing the account template.
 */
export function actionsFromConnection(
  conn: StoredConnection,
  rosterTokenSealed?: string,
): AttendanceActionSnapshot {
  return {
    deliveryMode: conn.attendanceDeliveryMode ?? 'both',
    ...(conn.attendanceTags ? { tags: clone(conn.attendanceTags) } : {}),
    ...(conn.attendanceCustomFieldId ? { customFieldId: conn.attendanceCustomFieldId } : {}),
    workflows: clone(conn.attendanceWorkflows ?? []),
    workflowRules: clone(conn.attendanceWorkflowRules ?? []),
    aiWorkflow: clone(conn.attendanceAiWorkflow ?? DEFAULT_ATTENDANCE_AI),
    rules: clone(conn.attendanceRules ?? []),
    ...(conn.attendanceRoster ? { roster: clone(conn.attendanceRoster) } : {}),
    ...(rosterTokenSealed ? { rosterTokenSealed } : {}),
    copiedFromConnectionId: conn.id,
    updatedAt: Date.now(),
  };
}

/** Snapshot used when a call is created or explicitly reset to its action account. */
export function snapshotAttendanceActions(conn: StoredConnection): AttendanceActionSnapshot {
  const token = conn.attendanceRosterToken
    ? seal(conn.attendanceRosterToken, env.CREDENTIALS_ENCRYPTION_KEY)
    : undefined;
  return actionsFromConnection(conn, token);
}

/**
 * The call's own copy wins. Older calls that predate per-call actions keep using their account's
 * current settings, exactly as before.
 */
export function effectiveAttendanceActions(
  session: SessionRecord,
  conn: StoredConnection | null,
): AttendanceActionSnapshot | null {
  if (session.attendanceActions) return session.attendanceActions;
  return conn ? actionsFromConnection(conn) : null;
}

/** True only when the action connection can actually call GHL. A plain calendar connection is enough
 * for simple result webhooks, but not for tags/custom fields/workflows. */
export function hasGhlCredentials(conn: StoredConnection | null): boolean {
  return !!conn && !!conn.ghlLocationId && !!(conn.ghlApiToken || conn.ghlAccessToken || conn.ghlRefreshToken);
}

export function rosterTokenForActions(
  actions: AttendanceActionSnapshot,
  conn: StoredConnection | null,
): string | undefined {
  if (actions.rosterTokenSealed) {
    return open(actions.rosterTokenSealed, env.CREDENTIALS_ENCRYPTION_KEY);
  }
  return conn?.attendanceRosterToken;
}

export type PublicAttendanceActionSnapshot = Omit<AttendanceActionSnapshot, 'rosterTokenSealed'> & {
  rosterTokenSet: boolean;
};

/** Strip the encrypted token before a session is returned to the browser. */
export function publicAttendanceActions(
  actions: AttendanceActionSnapshot,
): PublicAttendanceActionSnapshot {
  const { rosterTokenSealed, ...rest } = actions;
  return { ...rest, rosterTokenSet: !!rosterTokenSealed };
}
