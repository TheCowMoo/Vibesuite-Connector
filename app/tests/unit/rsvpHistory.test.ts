import { describe, expect, it } from 'vitest';
import { appendRsvpHistory, parseRsvpHistory, RSVP_HISTORY_LIMIT } from '../../src/domain/rsvpHistory';

describe('appendRsvpHistory', () => {
  it('marks the first observation as a tracking baseline', () => {
    expect(appendRsvpHistory(undefined, 'accepted', 100)).toEqual([
      { status: 'accepted', at: 100, initial: true },
    ]);
  });

  it('does not append the same status twice', () => {
    const first = appendRsvpHistory(undefined, 'accepted', 100);
    expect(appendRsvpHistory(first, 'accepted', 200)).toEqual(first);
  });

  it('appends a real status change without the initial flag', () => {
    const first = appendRsvpHistory(undefined, 'needsAction', 100);
    expect(appendRsvpHistory(first, 'declined', 200)).toEqual([
      { status: 'needsAction', at: 100, initial: true },
      { status: 'declined', at: 200 },
    ]);
  });

  it('normalizes unknown values to no reply', () => {
    expect(appendRsvpHistory(undefined, 'something-else', 100)[0].status).toBe('needsAction');
  });

  it('caps history at the configured limit', () => {
    let entries = appendRsvpHistory(undefined, 'needsAction', 0);
    for (let i = 1; i <= RSVP_HISTORY_LIMIT + 5; i += 1) {
      entries = appendRsvpHistory(entries, i % 2 ? 'accepted' : 'declined', i);
    }
    expect(entries).toHaveLength(RSVP_HISTORY_LIMIT);
    expect(entries[0].initial).toBeUndefined();
  });
});

describe('parseRsvpHistory', () => {
  it('ignores corrupt or malformed rows', () => {
    expect(parseRsvpHistory('not json')).toEqual([]);
    expect(parseRsvpHistory('{"status":"accepted"}')).toEqual([]);
    expect(parseRsvpHistory('[{"status":"accepted","at":"bad"}]')).toEqual([]);
  });

  it('keeps valid entries and normalizes their status', () => {
    expect(parseRsvpHistory('[{"status":"accepted","at":10,"initial":true}]')).toEqual([
      { status: 'accepted', at: 10, initial: true },
    ]);
  });
});
