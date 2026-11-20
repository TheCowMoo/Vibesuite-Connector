import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttendanceReport } from '../../src/domain/attendance';
import type { SessionRecord } from '../../src/domain/sessionStore';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  saveSession: vi.fn(),
  getAttendance: vi.fn(),
  getConnection: vi.fn(),
  tryClaim: vi.fn(),
  releaseClaim: vi.fn(),
  postWebhook: vi.fn(),
}));

vi.mock('../../src/domain/sessionStore', () => ({
  getSession: mocks.getSession,
  saveSession: mocks.saveSession,
}));
vi.mock('../../src/domain/attendanceStore', () => ({ getAttendance: mocks.getAttendance }));
vi.mock('../../src/domain/connectionStore', () => ({ getConnection: mocks.getConnection }));
vi.mock('../../src/domain/attendanceWorkflows', () => ({
  applyWorkflowRules: vi.fn(),
  autoAssignAiWorkflows: vi.fn(),
}));
vi.mock('../../src/domain/attendanceDispatch', () => ({
  tryClaimAttendanceDispatch: mocks.tryClaim,
  releaseAttendanceDispatch: mocks.releaseClaim,
}));
vi.mock('../../src/ghl/webhooks', () => ({ postWebhook: mocks.postWebhook }));
vi.mock('../../src/ghl/contacts', () => ({
  lookupContactByEmail: vi.fn(),
  addTags: vi.fn(),
  updateCustomField: vi.fn(),
  addContactToWorkflow: vi.fn(),
}));
vi.mock('../../src/video', () => ({ getProvider: vi.fn() }));

import { dispatchSession } from '../../src/workers/attendance';

const session: SessionRecord = {
  id: 'sess-1',
  provider: 'zoom',
  externalId: '123',
  title: 'November webinar',
  startTime: '2026-01-01T10:00:00.000Z',
  endTime: '2026-01-01T11:00:00.000Z',
  status: 'synced',
  attendanceResultWebhooks: {
    attended: 'https://hooks.example.com/attended',
    noShow: 'https://hooks.example.com/no-show',
  },
  createdAt: 1,
};

const report: AttendanceReport = {
  sessionId: session.id,
  provider: 'zoom',
  sessionTitle: session.title,
  sessionType: 'webinar',
  invitedCount: 2,
  attendedCount: 1,
  noShowCount: 1,
  attended: [{ email: 'ada@example.com', name: 'Ada', status: 'attended', durationSec: 3600 }],
  noShow: ['absent@example.com'],
  attendedNotInvited: [],
  absentees: ['absent@example.com'],
  registrantCount: 2,
  attendanceRate: 50,
  sessionStats: {},
  polls: [],
  qa: [],
  pollQuestionCount: 0,
  pollRespondentCount: 0,
  pollAnswerCount: 0,
  generatedAt: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSession.mockResolvedValue({ ...session });
  mocks.saveSession.mockResolvedValue(undefined);
  mocks.getAttendance.mockResolvedValue(report);
  mocks.getConnection.mockResolvedValue(null);
  mocks.tryClaim.mockResolvedValue(true);
  mocks.releaseClaim.mockResolvedValue(undefined);
  mocks.postWebhook.mockResolvedValue(undefined);
});

describe('simple result webhook dispatch', () => {
  it('sends result webhooks even when the call has no GHL action account', async () => {
    const result = await dispatchSession(session.id);

    expect(mocks.getConnection).not.toHaveBeenCalled();
    expect(mocks.postWebhook).toHaveBeenCalledTimes(2);
    expect(mocks.postWebhook).toHaveBeenCalledWith(
      'https://hooks.example.com/attended',
      expect.objectContaining({ email: 'ada@example.com', segment: 'attended' }),
    );
    expect(mocks.postWebhook).toHaveBeenCalledWith(
      'https://hooks.example.com/no-show',
      expect.objectContaining({ email: 'absent@example.com', segment: 'no_show' }),
    );
    expect(result.webhooks).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(result.dispatched).toBe(2);
    expect(result.failed).toBe(0);
  });

  it('retries a transient result-webhook failure without requiring a GHL account', async () => {
    mocks.postWebhook.mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);

    const result = await dispatchSession(session.id);

    expect(mocks.postWebhook).toHaveBeenCalledTimes(3);
    expect(result.webhooks).toEqual({ sent: 2, failed: 0, skipped: 0 });
  });
});
