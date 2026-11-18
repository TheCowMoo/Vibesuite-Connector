import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAudience: vi.fn(),
  getRecipients: vi.fn(),
  loadResults: vi.fn(),
}));

vi.mock('../../src/domain/listVerificationStore', () => ({
  getCampaignVerificationAudience: mocks.getAudience,
}));
vi.mock('../../src/domain/campaignStore', () => ({ getRecipients: mocks.getRecipients }));
vi.mock('../../src/domain/emailVerificationLookup', () => ({
  loadCampaignVerificationResults: mocks.loadResults,
}));

import { collectCampaignVerification, verificationRates } from '../../src/domain/campaignVerification';
import type { Campaign } from '../../src/domain/campaign';

const campaign = { id: 'camp1', listId: 'list1' } as Campaign;

function result(address: string, value: 'deliverable' | 'undeliverable') {
  return {
    address,
    result: value,
    risk: 'low',
    reasons: [],
    isEmailValid: value === 'deliverable',
    locationId: 'loc1',
    checkedAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAudience.mockResolvedValue([]);
  mocks.getRecipients.mockResolvedValue([]);
  mocks.loadResults.mockResolvedValue(new Map());
});

describe('collectCampaignVerification', () => {
  it('summarizes the frozen audience and returns rates', async () => {
    mocks.getAudience.mockResolvedValue(['a@x.com', 'b@x.com', 'c@x.com']);
    mocks.loadResults.mockResolvedValue(
      new Map([
        ['a@x.com', result('a@x.com', 'deliverable')],
        ['b@x.com', result('b@x.com', 'undeliverable')],
      ]),
    );

    const out = await collectCampaignVerification(campaign);

    expect(out).toMatchObject({
      total: 3,
      checked: 2,
      deliverable: 1,
      undeliverable: 1,
      unchecked: 1,
      rates: { undeliverable: 50, catchAll: 0, unknown: 0, unchecked: 33.3 },
    });
  });

  it('falls back to recipient rows for a campaign without a frozen audience', async () => {
    mocks.getRecipients.mockResolvedValue([{ email: 'x@x.com' }]);

    const out = await collectCampaignVerification(campaign);

    expect(out.total).toBe(1);
    expect(out.unchecked).toBe(1);
  });

  it('calculates the rates with safe empty denominators', () => {
    expect(
      verificationRates({
        total: 0,
        checked: 0,
        deliverable: 0,
        undeliverable: 0,
        doNotSend: 0,
        catchAll: 0,
        unknown: 0,
        unchecked: 0,
      }),
    ).toEqual({ undeliverable: 0, catchAll: 0, unknown: 0, unchecked: 0 });
  });
});
