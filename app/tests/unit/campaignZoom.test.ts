import { describe, it, expect } from 'vitest';
import { planSessionZoomStamp } from '../../src/domain/campaignZoomPlan';

describe('planSessionZoomStamp', () => {
  it('stamps a newly chosen host onto the session', () => {
    expect(planSessionZoomStamp({ nextCampaignHost: 'a', sessionHost: undefined }))
      .toEqual({ changed: true, host: 'a' });
  });

  it('rewrites a session that points at a different host', () => {
    expect(planSessionZoomStamp({ previousCampaignHost: 'a', nextCampaignHost: 'b', sessionHost: 'a' }))
      .toEqual({ changed: true, host: 'b' });
  });

  it('does not write when the session already matches', () => {
    expect(planSessionZoomStamp({ nextCampaignHost: 'a', sessionHost: 'a' }))
      .toEqual({ changed: false, host: 'a' });
  });

  it('clears the session when the campaign releases the host it owned', () => {
    expect(planSessionZoomStamp({ previousCampaignHost: 'a', sessionHost: 'a' }))
      .toEqual({ changed: true, host: undefined });
  });

  /* A session may carry its own override; clearing a campaign that never had a host must not touch it. */
  it('leaves a session override alone when the campaign had no host', () => {
    expect(planSessionZoomStamp({ nextCampaignHost: undefined, sessionHost: 'b' }))
      .toEqual({ changed: false, host: 'b' });
  });
});
