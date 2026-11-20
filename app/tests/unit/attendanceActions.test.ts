import { describe, expect, it } from 'vitest';
import type { AttendanceActionSnapshot, StoredConnection } from '../../src/domain/connection';
import type { SessionRecord } from '../../src/domain/sessionStore';
import {
  actionsFromConnection,
  effectiveAttendanceActions,
  publicAttendanceActions,
  snapshotAttendanceActions,
} from '../../src/domain/attendanceActions';

const conn = {
  id: 'conn-1',
  name: 'Main GHL',
  status: 'active',
  googleCalendarId: 'primary',
  googleAuthType: 'oauth',
  ghlAuthType: 'api_token',
  ghlLocationId: 'loc-1',
  ghlApiToken: 'token',
  attendanceDeliveryMode: 'api',
  attendanceTags: { attended: 'attended' },
  attendanceCustomFieldId: 'field-1',
  attendanceWorkflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
  attendanceWorkflowRules: [
    { id: 'r1', name: 'Attended', enabled: true, conditions: [], workflowId: 'flow-1' },
  ],
  attendanceAiWorkflow: { enabled: true, mode: 'preview', confidenceThreshold: 0.7, maxAttendees: 10 },
  attendanceRules: [
    { id: 'hook-1', name: 'Hook', enabled: true, conditions: [], webhookUrl: 'https://example.com/hook' },
  ],
  attendanceRoster: { url: 'https://example.com/report', shape: 'flat' as const },
  attendanceRosterToken: 'secret',
  createdAt: 1,
  updatedAt: 1,
} as StoredConnection;

const session = {
  id: 'sess-1',
  provider: 'zoom',
  externalId: '123',
  title: 'Webinar',
  startTime: '2026-01-01T10:00:00.000Z',
  endTime: '2026-01-01T11:00:00.000Z',
  status: 'synced',
  createdAt: 1,
} as SessionRecord;

describe('attendance action snapshots', () => {
  it('copies the account template into a call snapshot', () => {
    const actions = actionsFromConnection(conn);
    expect(actions.deliveryMode).toBe('api');
    expect(actions.tags).toEqual({ attended: 'attended' });
    expect(actions.workflows).toHaveLength(1);
    expect(actions.workflowRules).toHaveLength(1);
    expect(actions.aiWorkflow.enabled).toBe(true);
    expect(actions.rules).toHaveLength(1);
    expect(actions.roster?.url).toBe('https://example.com/report');
    expect(actions.copiedFromConnectionId).toBe('conn-1');
  });

  it('prefers the call snapshot over the account template', () => {
    const snapshot: AttendanceActionSnapshot = {
      ...actionsFromConnection(conn),
      deliveryMode: 'webhook',
      workflows: [],
    };
    const effective = effectiveAttendanceActions({ ...session, attendanceActions: snapshot }, conn);
    expect(effective?.deliveryMode).toBe('webhook');
    expect(effective?.workflows).toEqual([]);
  });

  it('falls back to the account for calls created before snapshots', () => {
    const effective = effectiveAttendanceActions(session, conn);
    expect(effective?.deliveryMode).toBe('api');
    expect(effective?.copiedFromConnectionId).toBe('conn-1');
  });

  it('redacts the sealed roster token from the public snapshot', () => {
    const snapshot = snapshotAttendanceActions(conn);
    const publicActions = publicAttendanceActions(snapshot);
    expect(publicActions.rosterTokenSet).toBe(true);
    expect('rosterTokenSealed' in publicActions).toBe(false);
  });
});
