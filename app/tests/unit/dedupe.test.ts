import { describe, it, expect } from 'vitest';
import { computeChanges, buildChangeFingerprint } from '../../src/domain/dedupe';
import type { GCalEvent } from '../../src/google/types';

function event(overrides: Partial<GCalEvent>): GCalEvent {
  return { id: 'e1', status: 'confirmed', attendees: [], ...overrides };
}

describe('computeChanges (change detection / dedupe)', () => {
  it('detects a responseStatus change for a known attendee', () => {
    const prev = new Map([['e1', { 'a@example.com': 'needsAction' }]]);
    const events = [event({ attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }] })];
    const changes = computeChanges(events, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0].newStatus).toBe('accepted');
    expect(changes[0].previousStatus).toBe('needsAction');
  });

  it('ignores attendees whose status did not change', () => {
    const prev = new Map([['e1', { 'a@example.com': 'accepted' }]]);
    const events = [event({ attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }] })];
    expect(computeChanges(events, prev)).toHaveLength(0);
  });

  it('treats a cancelled event as declined for every known attendee', () => {
    const prev = new Map([['e1', { 'a@example.com': 'accepted' }]]);
    const events = [event({ status: 'cancelled' })];
    const changes = computeChanges(events, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0].causedByCancellation).toBe(true);
    expect(changes[0].newStatus).toBe('declined');
  });

  it('does not emit a duplicate decline when attendee already declined', () => {
    const prev = new Map([['e1', { 'a@example.com': 'declined' }]]);
    const events = [event({ status: 'cancelled' })];
    expect(computeChanges(events, prev)).toHaveLength(0);
  });

  it('defaults missing responseStatus to needsAction', () => {
    const prev = new Map<string, Record<string, string>>();
    const events = [event({ attendees: [{ email: 'a@example.com' }] })];
    const changes = computeChanges(events, prev);
    expect(changes).toHaveLength(1);
    expect(changes[0].newStatus).toBe('needsAction');
  });
});

describe('buildChangeFingerprint (idempotency key)', () => {
  const base = {
    eventId: 'e1',
    email: 'a@example.com',
    previousStatus: 'needsAction',
    newStatus: 'accepted',
    causedByCancellation: false,
  };

  it('is stable for the same change', () => {
    const change = { ...base, event: event({ updated: '2024-01-01T00:00:00Z' }) };
    expect(buildChangeFingerprint('cal1', change)).toBe(buildChangeFingerprint('cal1', change));
  });

  it('differs when the underlying event update timestamp changes', () => {
    const a = buildChangeFingerprint('cal1', { ...base, event: event({ updated: '2024-01-01T00:00:00Z' }) });
    const b = buildChangeFingerprint('cal1', { ...base, event: event({ updated: '2024-01-02T00:00:00Z' }) });
    expect(a).not.toBe(b);
  });

  it('differs across calendars', () => {
    const change = { ...base, event: event({ updated: '2024-01-01T00:00:00Z' }) };
    expect(buildChangeFingerprint('cal1', change)).not.toBe(buildChangeFingerprint('cal2', change));
  });
});
