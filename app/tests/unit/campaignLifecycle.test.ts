import { describe, it, expect } from 'vitest';
import { campaignTickAction } from '../../src/domain/campaignLifecycle';

const T = 1_000_000;

describe('campaignTickAction', () => {
  it('activates a scheduled campaign once its start time arrives', () => {
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T }, T)).toBe('activate');
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T - 1 }, T)).toBe('activate');
  });

  it('leaves a scheduled campaign alone until then', () => {
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T + 1 }, T)).toBe('skip');
  });

  /*
   * A campaign marked scheduled with no start time must never fire, or it would begin sending the
   * moment it was created and the operator would have no idea why.
   */
  it('never activates a scheduled campaign with no start time', () => {
    expect(campaignTickAction({ status: 'scheduled' }, T)).toBe('skip');
  });

  it('sends an active campaign that has no deadline', () => {
    expect(campaignTickAction({ status: 'active' }, T)).toBe('send');
    expect(campaignTickAction({ status: 'active', sendByAt: T + 1 }, T)).toBe('send');
  });

  it('ends an active campaign at its deadline', () => {
    expect(campaignTickAction({ status: 'active', sendByAt: T }, T)).toBe('end');
    expect(campaignTickAction({ status: 'active', sendByAt: T - 1 }, T)).toBe('end');
  });

  /* A deadline only applies while running — it must not end a draft or a paused campaign. */
  it('does not end a paused campaign that is past its deadline', () => {
    expect(campaignTickAction({ status: 'paused', sendByAt: T - 1 }, T)).toBe('skip');
  });

  it('ignores every other status', () => {
    expect(campaignTickAction({ status: 'draft' }, T)).toBe('skip');
    expect(campaignTickAction({ status: 'completed' }, T)).toBe('skip');
    expect(campaignTickAction({ status: 'ended' }, T)).toBe('skip');
  });
});
