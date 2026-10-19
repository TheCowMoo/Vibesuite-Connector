import { describe, it, expect } from 'vitest';
import { labelPreviousInvite } from '../../src/domain/reinvite';

describe('labelPreviousInvite', () => {
  it('names the event and the day', () => {
    expect(labelPreviousInvite({ summary: 'Product webinar', start: '2026-10-12T10:00:00Z' })).toBe(
      'previously invited to Product webinar on 12 Oct 2026',
    );
  });

  it('names the event when no date is known', () => {
    expect(labelPreviousInvite({ summary: 'Product webinar' })).toBe('previously invited to Product webinar');
  });

  it('drops an unparseable date rather than printing it', () => {
    expect(labelPreviousInvite({ summary: 'Product webinar', start: 'not-a-date' })).toBe(
      'previously invited to Product webinar',
    );
  });

  /*
   * The case most likely to regress into something misleading: people invited before we started
   * recording metadata. It must read as a plain fact, not "previously invited to undefined".
   */
  it('says only "previously invited" when nothing is recorded', () => {
    expect(labelPreviousInvite()).toBe('previously invited');
    expect(labelPreviousInvite({})).toBe('previously invited');
    expect(labelPreviousInvite({ summary: '   ' })).toBe('previously invited');
  });

  it('is stable regardless of the machine timezone', () => {
    // UTC parts, so a server in any timezone words the same event the same way.
    expect(labelPreviousInvite({ summary: 'X', start: '2026-01-01T00:00:00Z' })).toBe('previously invited to X on 1 Jan 2026');
  });
});
