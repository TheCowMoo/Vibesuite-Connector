import { describe, it, expect } from 'vitest';
import { ADVISOR_ACTION_KINDS, clampAdvisorAction, isAdvisorActionKind } from '../../src/domain/advisorActions';

describe('isAdvisorActionKind', () => {
  it('accepts the whitelist and nothing else', () => {
    for (const kind of ADVISOR_ACTION_KINDS) expect(isAdvisorActionKind(kind)).toBe(true);
    expect(isAdvisorActionKind('delete_all_senders')).toBe(false);
    expect(isAdvisorActionKind('')).toBe(false);
  });
});

describe('clampAdvisorAction', () => {
  it('rejects unknown kinds and missing targets', () => {
    expect(clampAdvisorAction({ kind: 'nuke', target: 'Mailbox A' }).ok).toBe(false);
    expect(clampAdvisorAction({ kind: 'pause_sender' }).ok).toBe(false);
    expect(clampAdvisorAction({ kind: 'pause_sender', target: '   ' }).ok).toBe(false);
    expect(clampAdvisorAction(undefined).ok).toBe(false);
  });

  it('clamps a daily cap into range', () => {
    const high = clampAdvisorAction({ kind: 'set_sender_daily_cap', target: 'Mailbox A', value: 999999 });
    expect(high.ok && high.action.value).toBe(5000);

    const low = clampAdvisorAction({ kind: 'set_sender_daily_cap', target: 'Mailbox A', value: -10 });
    expect(low.ok && low.action.value).toBe(1);

    const rounded = clampAdvisorAction({ kind: 'set_sender_daily_cap', target: 'Mailbox A', value: 300.7 });
    expect(rounded.ok && rounded.action.value).toBe(301);
  });

  it('rejects a non-numeric value', () => {
    expect(clampAdvisorAction({ kind: 'set_sender_daily_cap', target: 'Mailbox A', value: 'lots' as never }).ok).toBe(false);
  });

  it('clamps the hourly cap and the delay', () => {
    // The hard clamp matches the sender profile schema (max 1000); the prompt's
    // 500/hour figure is only a guideline for the model.
    const hourly = clampAdvisorAction({ kind: 'set_sender_hourly_cap', target: 'Mailbox A', value: 9999 });
    expect(hourly.ok && hourly.action.value).toBe(1000);

    const delay = clampAdvisorAction({ kind: 'set_sender_min_delay_ms', target: 'Mailbox A', value: 9_000_000 });
    expect(delay.ok && delay.action.value).toBe(600000);

    const zero = clampAdvisorAction({ kind: 'set_sender_min_delay_ms', target: 'Mailbox A', value: -1 });
    expect(zero.ok && zero.action.value).toBe(0);
  });

  it('builds a window with clamped hours and clean days', () => {
    const res = clampAdvisorAction({
      kind: 'set_sender_window',
      target: 'Mailbox B',
      startHour: 30,
      endHour: -4,
      days: [1, 1, 9, 3, -2, 3.5],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action.startHour).toBe(23);
    expect(res.action.endHour).toBe(0);
    expect(res.action.days).toEqual([1, 3]);
  });

  it('defaults the window days to Mon–Fri', () => {
    const res = clampAdvisorAction({ kind: 'set_sender_window', target: 'Mailbox B', startHour: 9, endHour: 17 });
    expect(res.ok && res.action.days).toEqual([1, 2, 3, 4, 5]);
  });

  it('requires both window hours', () => {
    expect(clampAdvisorAction({ kind: 'set_sender_window', target: 'Mailbox B', startHour: 9 }).ok).toBe(false);
  });

  it('validates campaign status', () => {
    expect(clampAdvisorAction({ kind: 'set_campaign_status', target: 'Campaign 1', status: 'active' }).ok).toBe(true);
    expect(clampAdvisorAction({ kind: 'set_campaign_status', target: 'Campaign 1', status: 'paused' }).ok).toBe(true);
    expect(clampAdvisorAction({ kind: 'set_campaign_status', target: 'Campaign 1', status: 'deleted' }).ok).toBe(false);
  });

  it('clamps campaign priority to 0–10', () => {
    const high = clampAdvisorAction({ kind: 'set_campaign_priority', target: 'Campaign 1', value: 99 });
    expect(high.ok && high.action.value).toBe(10);
  });

  it('describes the change for the apply log', () => {
    const res = clampAdvisorAction({ kind: 'set_sender_daily_cap', target: 'Mailbox A', value: 450 });
    expect(res.ok && res.description).toContain('Mailbox A');
    expect(res.ok && res.description).toContain('450');
  });
});
