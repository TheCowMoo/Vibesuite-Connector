import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getList: vi.fn(),
  getConnection: vi.fn(),
  getListVerificationStatus: vi.fn(),
  saveListVerificationStatus: vi.fn(),
  getListVerificationResults: vi.fn(),
  saveListVerificationResults: vi.fn(),
  getCachedEmailVerifications: vi.fn(),
  saveCachedEmailVerifications: vi.fn(),
  verifyEmailWithGhl: vi.fn(),
}));

vi.mock('../../src/domain/listStore', () => ({ getList: mocks.getList }));
vi.mock('../../src/domain/connectionStore', () => ({ getConnection: mocks.getConnection }));
vi.mock('../../src/domain/listVerificationStore', () => ({
  getListVerificationStatus: mocks.getListVerificationStatus,
  saveListVerificationStatus: mocks.saveListVerificationStatus,
  getListVerificationResults: mocks.getListVerificationResults,
  saveListVerificationResults: mocks.saveListVerificationResults,
}));
vi.mock('../../src/domain/emailVerificationStore', () => ({
  getCachedEmailVerifications: mocks.getCachedEmailVerifications,
  saveCachedEmailVerifications: mocks.saveCachedEmailVerifications,
  normalizeVerificationEmail: (email: string) => String(email || '').trim().toLowerCase(),
}));
vi.mock('../../src/ghl/emailVerification', () => ({
  verifyEmailWithGhl: mocks.verifyEmailWithGhl,
  isGhlVerificationFatalError: (err: { response?: { status?: number } }) =>
    [400, 401, 402, 403, 404, 429].includes(err?.response?.status ?? 0),
  describeGhlVerificationError: (err: { response?: { status?: number } }) =>
    err?.response?.status === 403
      ? 'GHL email-verification scope is missing — add lc-email.readonly.'
      : 'GHL email verification failed.',
}));

import { processListVerification } from '../../src/workers/emailVerification';

const baseStatus = {
  status: 'queued',
  runId: 'run1',
  listId: 'list1',
  connectionId: 'conn1',
  locationId: 'loc1',
  maxChecks: 10,
  total: 2,
  checked: 0,
  cached: 0,
  deliverable: 0,
  undeliverable: 0,
  doNotSend: 0,
  catchAll: 0,
  unknown: 0,
  errors: 0,
  unchecked: 2,
  billableChecks: 0,
  estimatedCostUsd: 0.005,
  createdAt: 1,
};

let current: typeof baseStatus;

function result(address: string, value: 'deliverable' | 'undeliverable') {
  return {
    address,
    result: value,
    risk: value === 'deliverable' ? 'low' : 'high',
    reasons: value === 'deliverable' ? [] : ['mailbox_does_not_exist'],
    isEmailValid: value === 'deliverable',
    locationId: 'loc1',
    checkedAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  current = { ...baseStatus };
  mocks.getList.mockResolvedValue({
    result: {
      segments: [{ name: 'All', rows: [{ email: 'a@x.com' }, { email: 'b@x.com' }] }],
    },
  });
  mocks.getConnection.mockResolvedValue({
    id: 'conn1',
    ghlAuthType: 'api_token',
    ghlApiToken: 'token',
    ghlLocationId: 'loc1',
  });
  mocks.getListVerificationStatus.mockImplementation(async () => current);
  mocks.saveListVerificationStatus.mockImplementation(async (_id: string, next: typeof current) => {
    current = next;
  });
  mocks.getListVerificationResults.mockResolvedValue(new Map());
  mocks.saveListVerificationResults.mockResolvedValue(undefined);
  mocks.getCachedEmailVerifications.mockResolvedValue(new Map());
  mocks.saveCachedEmailVerifications.mockResolvedValue(undefined);
});

describe('processListVerification', () => {
  it('checks uncached addresses and finalizes the counts', async () => {
    mocks.verifyEmailWithGhl.mockImplementation(async (_conn: unknown, email: string) =>
      result(email, email === 'a@x.com' ? 'deliverable' : 'undeliverable'),
    );

    await processListVerification('list1', 'run1');

    expect(mocks.verifyEmailWithGhl).toHaveBeenCalledTimes(2);
    expect(current).toMatchObject({
      status: 'done',
      total: 2,
      checked: 2,
      cached: 0,
      deliverable: 1,
      undeliverable: 1,
      unchecked: 0,
      billableChecks: 2,
      estimatedCostUsd: 0.005,
    });
  });

  it('reuses cached results without spending another check', async () => {
    const cached = new Map([['a@x.com', result('a@x.com', 'deliverable')]]);
    mocks.getCachedEmailVerifications.mockResolvedValue(cached);
    mocks.verifyEmailWithGhl.mockResolvedValue(result('b@x.com', 'deliverable'));

    await processListVerification('list1', 'run1');

    expect(mocks.verifyEmailWithGhl).toHaveBeenCalledTimes(1);
    expect(mocks.verifyEmailWithGhl).toHaveBeenCalledWith(expect.anything(), 'b@x.com');
    expect(current).toMatchObject({
      status: 'done',
      checked: 2,
      cached: 1,
      deliverable: 2,
      billableChecks: 1,
      estimatedCostUsd: 0.0025,
    });
  });

  it('honours the per-run cap and leaves the rest unchecked', async () => {
    current = { ...baseStatus, maxChecks: 1 };
    mocks.verifyEmailWithGhl.mockResolvedValue(result('a@x.com', 'deliverable'));

    await processListVerification('list1', 'run1');

    expect(mocks.verifyEmailWithGhl).toHaveBeenCalledTimes(1);
    expect(current).toMatchObject({ status: 'done', checked: 1, unchecked: 1, billableChecks: 1 });
    expect(current.warnings?.join(' ')).toContain('per-run cap');
  });

  it('fails the run with an actionable message when GHL refuses the scope', async () => {
    mocks.verifyEmailWithGhl.mockRejectedValue(
      Object.assign(new Error('forbidden'), { response: { status: 403 } }),
    );

    await processListVerification('list1', 'run1');

    expect(current.status).toBe('failed');
    expect(current.error).toContain('lc-email.readonly');
  });
});
