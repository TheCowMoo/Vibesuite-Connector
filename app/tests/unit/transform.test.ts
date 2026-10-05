import { describe, it, expect } from 'vitest';
import { toGhlAction } from '../../src/domain/transform';

describe('toGhlAction (RSVP -> GHL mapping matrix)', () => {
  it('maps accepted -> confirmed + rsvp-yes + confirmed webhook', () => {
    const a = toGhlAction('accepted');
    expect(a.appointmentStatus).toBe('confirmed');
    expect(a.tagsToAdd).toContain('rsvp-yes');
    expect(a.setDnd).toBe(false);
    expect(a.webhookBranch).toBe('confirmed');
  });

  it('maps tentative -> tentative + rsvp-maybe + tentative webhook', () => {
    const a = toGhlAction('tentative');
    expect(a.appointmentStatus).toBe('tentative');
    expect(a.tagsToAdd).toContain('rsvp-maybe');
    expect(a.webhookBranch).toBe('tentative');
  });

  it('maps declined -> cancelled + stop tags + dnd + declined webhook', () => {
    const a = toGhlAction('declined');
    expect(a.appointmentStatus).toBe('cancelled');
    expect(a.tagsToAdd).toEqual(expect.arrayContaining(['rsvp-no', 'communication-stopped']));
    expect(a.setDnd).toBe(true);
    expect(a.webhookBranch).toBe('declined');
  });

  it('maps needsAction -> pending + rsvp-pending + no webhook', () => {
    const a = toGhlAction('needsAction');
    expect(a.appointmentStatus).toBe('pending');
    expect(a.tagsToAdd).toContain('rsvp-pending');
    expect(a.webhookBranch).toBeNull();
  });

  it('falls back to needsAction for unknown statuses', () => {
    const a = toGhlAction('unexpected-value');
    expect(a.rsvp).toBe('needsAction');
  });

  it('removes conflicting tags on each transition', () => {
    const a = toGhlAction('accepted');
    expect(a.tagsToRemove).toEqual(expect.arrayContaining(['rsvp-no', 'rsvp-maybe', 'rsvp-pending']));
  });
});
