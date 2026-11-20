import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { SessionRecord } from '../../src/domain/sessionStore';
import type { StoredConnection } from '../../src/domain/connection';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getConnection: vi.fn(),
  getAttendance: vi.fn(),
  dispatchSession: vi.fn(),
  syncSession: vi.fn(),
}));

vi.mock('../../src/domain/sessionStore', async () => {
  const actual = await vi.importActual<typeof import('../../src/domain/sessionStore')>(
    '../../src/domain/sessionStore',
  );
  return {
    ...actual,
    getSession: mocks.getSession,
    saveSession: mocks.saveSession,
    listSessions: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(),
  };
});
vi.mock('../../src/domain/connectionStore', () => ({ getConnection: mocks.getConnection }));
vi.mock('../../src/domain/attendanceStore', () => ({ getAttendance: mocks.getAttendance }));
vi.mock('../../src/workers/attendance', () => ({
  dispatchSession: mocks.dispatchSession,
  syncSession: mocks.syncSession,
}));
vi.mock('../../src/video', () => ({ getProvider: vi.fn() }));
vi.mock('../../src/domain/attendanceWorkflows', () => ({
  applyWorkflowPreview: vi.fn(),
  assignWorkflowToPerson: vi.fn(),
  previewWorkflowAssignments: vi.fn(),
  WorkflowRoutingError: class WorkflowRoutingError extends Error {},
}));

import { sessionRoutes } from '../../src/api/routes/sessions';

const session: SessionRecord = {
  id: 'sess-1',
  provider: 'zoom',
  externalId: '123',
  title: 'November webinar',
  connectionId: 'call-conn',
  startTime: '2026-01-01T10:00:00.000Z',
  endTime: '2026-01-01T11:00:00.000Z',
  status: 'synced',
  createdAt: 1,
};

const conn = {
  id: 'action-conn',
  name: 'Main GHL',
  status: 'active',
  googleCalendarId: 'primary',
  googleAuthType: 'oauth',
  ghlAuthType: 'api_token',
  ghlLocationId: 'loc-1',
  attendanceDeliveryMode: 'both',
  attendanceTags: { attended: 'old-tag' },
  attendanceWorkflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
  attendanceWorkflowRules: [],
  attendanceAiWorkflow: { enabled: false, mode: 'preview', confidenceThreshold: 0.7, maxAttendees: 25 },
  attendanceRules: [],
  attendanceRoster: { url: 'https://example.com/report', shape: 'flat' },
  attendanceRosterToken: 'account-token',
  createdAt: 1,
  updatedAt: 1,
} as StoredConnection;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ ...session });
  mocks.saveSession.mockResolvedValue(undefined);
  mocks.getConnection.mockResolvedValue({ ...conn });
});

describe('session after-call action routes', () => {
  it('saves a call-specific copy and never returns the sealed token', async () => {
    const app = Fastify();
    await app.register(sessionRoutes);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/sessions/sess-1/attendance-actions',
      payload: {
        attendanceDeliveryMode: 'api',
        attendanceTags: { attended: 'november' },
        attendanceWorkflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
        attendanceWorkflowRules: [
          { id: 'r1', name: 'Attended', enabled: true, conditions: [], workflowId: 'flow-1' },
        ],
        attendanceAiWorkflow: { enabled: false, mode: 'preview', confidenceThreshold: 0.7, maxAttendees: 25 },
        attendanceRules: [],
        attendanceRoster: { url: 'https://example.com/report', shape: 'flat', token: '' },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.session.attendanceActions.deliveryMode).toBe('api');
    expect(body.session.attendanceActions.tags.attended).toBe('november');
    expect(body.session.attendanceActions.rosterTokenSet).toBe(true);
    expect(body.session.attendanceActions.rosterTokenSealed).toBeUndefined();
    expect(mocks.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        attendanceActionConnectionId: 'action-conn',
        attendanceActions: expect.objectContaining({ tags: { attended: 'november' } }),
      }),
    );
  });

  it('reloads the template when the action account changes', async () => {
    const app = Fastify();
    await app.register(sessionRoutes);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/sessions/sess-1',
      payload: { attendanceActionConnectionId: 'action-conn' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.session.attendanceActionConnectionId).toBe('action-conn');
    expect(body.session.attendanceActions.tags.attended).toBe('old-tag');
    expect(mocks.saveSession).toHaveBeenCalled();
  });
});
