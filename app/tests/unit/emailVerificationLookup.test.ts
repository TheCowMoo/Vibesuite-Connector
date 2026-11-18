import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedEmailVerifications: vi.fn(),
  getListVerificationResults: vi.fn(),
  getCampaignVerificationResults: vi.fn(),
  saveCampaignVerificationResults: vi.fn(),
  saveCampaignVerificationAudience: vi.fn(),
}));

vi.mock('../../src/domain/emailVerificationStore', () => ({
  getCachedEmailVerifications: mocks.getCachedEmailVerifications,
  normalizeVerificationEmail: (email: string) => String(email || '').trim().toLowerCase(),
}));
vi.mock('../../src/domain/listVerificationStore', () => ({
  getListVerificationResults: mocks.getListVerificationResults,
  getCampaignVerificationResults: mocks.getCampaignVerificationResults,
  saveCampaignVerificationResults: mocks.saveCampaignVerificationResults,
  saveCampaignVerificationAudience: mocks.saveCampaignVerificationAudience,
}));

import {
  loadCampaignVerificationResults,
  loadListVerificationResults,
  snapshotCampaignVerification,
} from '../../src/domain/emailVerificationLookup';

function result(address: string, value: 'deliverable' | 'undeliverable' = 'deliverable') {
  return {
    address,
    result: value,
    risk: 'low',
    reasons: [],
    isEmailValid: value === 'deliverable',
    locationId: 'loc-1',
    checkedAt: 1,
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCachedEmailVerifications.mockResolvedValue(new Map());
  mocks.getListVerificationResults.mockResolvedValue(new Map());
  mocks.getCampaignVerificationResults.mockResolvedValue(new Map());
  mocks.saveCampaignVerificationResults.mockResolvedValue(undefined);
  mocks.saveCampaignVerificationAudience.mockResolvedValue(undefined);
});

describe('email verification lookup', () => {
  it('merges the list snapshot over the global cache', async () => {
    mocks.getCachedEmailVerifications.mockResolvedValue(
      new Map([['a@x.com', result('a@x.com')], ['b@x.com', result('b@x.com')]]),
    );
    mocks.getListVerificationResults.mockResolvedValue(
      new Map([['b@x.com', result('b@x.com', 'undeliverable')], ['c@x.com', result('c@x.com')]]),
    );

    const out = await loadListVerificationResults('list1', ['A@X.com', 'b@x.com', 'c@x.com']);

    expect(out.get('a@x.com')?.result).toBe('deliverable');
    expect(out.get('b@x.com')?.result).toBe('undeliverable');
    expect(out.get('c@x.com')?.result).toBe('deliverable');
  });

  it('merges the campaign snapshot over the list/cache fallback', async () => {
    mocks.getListVerificationResults.mockResolvedValue(
      new Map([['a@x.com', result('a@x.com')], ['c@x.com', result('c@x.com')]]),
    );
    mocks.getCampaignVerificationResults.mockResolvedValue(
      new Map([['a@x.com', result('a@x.com', 'undeliverable')]]),
    );

    const out = await loadCampaignVerificationResults('camp1', 'list1', ['a@x.com', 'c@x.com']);

    expect(out.get('a@x.com')?.result).toBe('undeliverable');
    expect(out.get('c@x.com')?.result).toBe('deliverable');
  });

  it('freezes the audience and only stores the results it has', async () => {
    mocks.getListVerificationResults.mockResolvedValue(
      new Map([['a@x.com', result('a@x.com')]]),
    );

    await snapshotCampaignVerification('camp1', 'list1', ['a@x.com', 'b@x.com']);

    expect(mocks.saveCampaignVerificationAudience).toHaveBeenCalledWith('camp1', ['a@x.com', 'b@x.com']);
    expect(mocks.saveCampaignVerificationResults).toHaveBeenCalledWith('camp1', [
      expect.objectContaining({ address: 'a@x.com' }),
    ]);
  });

  it('does not write an empty campaign result snapshot', async () => {
    await snapshotCampaignVerification('camp1', 'list1', []);

    expect(mocks.saveCampaignVerificationAudience).toHaveBeenCalledWith('camp1', []);
    expect(mocks.saveCampaignVerificationResults).not.toHaveBeenCalled();
  });
});
