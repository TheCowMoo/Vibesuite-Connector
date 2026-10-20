import { describe, it, expect } from 'vitest';
import { campaignTickAction, resolveSendPlan, startBlockedByDeadline, stopTimeError } from '../../src/domain/campaignLifecycle';

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

  /*
   * If the worker was down through a scheduled campaign's whole window, activating it would freeze an
   * audience that is no longer allowed to receive anything. Ending it is the only correct answer.
   */
  it('ends a scheduled campaign whose deadline passed before it could start', () => {
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T - 100, sendByAt: T - 1 }, T)).toBe('end');
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T - 100, sendByAt: T }, T)).toBe('end');
  });

  it('still activates a scheduled campaign that is inside its window', () => {
    expect(campaignTickAction({ status: 'scheduled', scheduledStartAt: T - 100, sendByAt: T + 1 }, T)).toBe('activate');
  });
});

describe('resolveSendPlan', () => {
  const now = T;

  /*
   * The regression that made the feature look unfinished: choosing "as soon as I press Begin sending"
   * and filling in a stop time dropped the stop time entirely, because the wizard only read it on the
   * scheduled path.
   */
  it('keeps the stop time when the campaign is not scheduled', () => {
    const out = resolveSendPlan({ startMode: 'now', stopBy: now + 1000, now });
    expect(out.error).toBeUndefined();
    expect(out.sendByAt).toBe(now + 1000);
    expect(out.scheduledStartAt).toBeUndefined();
  });

  it('has no deadline when none was given', () => {
    const out = resolveSendPlan({ startMode: 'now', now });
    expect(out.error).toBeUndefined();
    expect(out.sendByAt).toBeUndefined();
  });

  it('accepts a start and a later stop', () => {
    const out = resolveSendPlan({ startMode: 'later', startAt: now + 1000, stopBy: now + 2000, now });
    expect(out).toEqual({ scheduledStartAt: now + 1000, sendByAt: now + 2000 });
  });

  it('requires a start time when scheduling', () => {
    expect(resolveSendPlan({ startMode: 'later', now }).error).toBe('a start time is required');
    expect(resolveSendPlan({ startMode: 'later', startAt: Number.NaN, now }).error).toBe('a start time is required');
  });

  it('rejects a start time in the past', () => {
    expect(resolveSendPlan({ startMode: 'later', startAt: now - 1, now }).error).toBe('the start time must be in the future');
    expect(resolveSendPlan({ startMode: 'later', startAt: now, now }).error).toBe('the start time must be in the future');
  });

  it('rejects a stop time that is not after the start', () => {
    expect(resolveSendPlan({ startMode: 'later', startAt: now + 1000, stopBy: now + 1000, now }).error)
      .toBe('the stop time must be after the start time');
    expect(resolveSendPlan({ startMode: 'later', startAt: now + 1000, stopBy: now + 500, now }).error)
      .toBe('the stop time must be after the start time');
  });

  it('rejects a stop time in the past on either path', () => {
    expect(resolveSendPlan({ startMode: 'now', stopBy: now - 1, now }).error).toBe('the stop time must be in the future');
    expect(resolveSendPlan({ startMode: 'later', startAt: now + 1000, stopBy: now - 1, now }).error)
      .toBe('the stop time must be in the future');
  });

  it('rejects a stop time that is not a number', () => {
    expect(resolveSendPlan({ startMode: 'now', stopBy: Number.NaN, now }).error).toBe('the stop time is not valid');
  });
});

describe('startBlockedByDeadline', () => {
  it('blocks a campaign whose stop time has passed', () => {
    expect(startBlockedByDeadline({ sendByAt: T }, T)).toBeTruthy();
    expect(startBlockedByDeadline({ sendByAt: T - 1 }, T)).toBeTruthy();
  });

  it('allows a campaign with time left, or no deadline at all', () => {
    expect(startBlockedByDeadline({ sendByAt: T + 1 }, T)).toBeUndefined();
    expect(startBlockedByDeadline({}, T)).toBeUndefined();
  });
});

describe('stopTimeError', () => {
  it('accepts no deadline and a future deadline', () => {
    expect(stopTimeError({}, T)).toBeUndefined();
    expect(stopTimeError({ sendByAt: T + 1 }, T)).toBeUndefined();
  });

  it('rejects a deadline that is not in the future', () => {
    expect(stopTimeError({ sendByAt: T }, T)).toBe('the stop time must be in the future');
    expect(stopTimeError({ sendByAt: T - 1 }, T)).toBe('the stop time must be in the future');
  });

  it('rejects a deadline at or before a scheduled start', () => {
    expect(stopTimeError({ sendByAt: T + 10, scheduledStartAt: T + 10 }, T)).toBe('the stop time must be after the start time');
    expect(stopTimeError({ sendByAt: T + 5, scheduledStartAt: T + 10 }, T)).toBe('the stop time must be after the start time');
  });
});
