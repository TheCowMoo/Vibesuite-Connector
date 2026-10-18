import { describe, it, expect } from 'vitest';
import { sessionJoinUrl } from '../../src/domain/joinLink';

const zoom = (over: Partial<Parameters<typeof sessionJoinUrl>[0]> = {}) => ({
  provider: 'zoom',
  externalId: '85412345678',
  ...over,
});

describe('sessionJoinUrl', () => {
  it('prefers a link the operator typed', () => {
    expect(sessionJoinUrl(zoom({ joinUrl: 'https://zoom.us/w/999?tk=abc' }))).toBe('https://zoom.us/w/999?tk=abc');
  });

  it('falls back to a synthesised Zoom link when nothing was stored', () => {
    expect(sessionJoinUrl(zoom())).toBe('https://zoom.us/j/85412345678');
  });

  it('ignores a blank or whitespace-only stored link', () => {
    expect(sessionJoinUrl(zoom({ joinUrl: '   ' }))).toBe('https://zoom.us/j/85412345678');
  });

  it('trims a stored link', () => {
    expect(sessionJoinUrl(zoom({ joinUrl: '  https://zoom.us/w/1  ' }))).toBe('https://zoom.us/w/1');
  });

  it('encodes the meeting id', () => {
    expect(sessionJoinUrl(zoom({ externalId: 'a/b c' }))).toBe('https://zoom.us/j/a%2Fb%20c');
  });

  it('returns nothing for a provider we cannot build a link for', () => {
    expect(sessionJoinUrl({ provider: 'webinargeek', externalId: 'xyz' })).toBeUndefined();
    expect(sessionJoinUrl({ provider: 'google_meet', externalId: 'xyz' })).toBeUndefined();
  });

  it('still returns a stored link for a non-Zoom provider', () => {
    expect(sessionJoinUrl({ provider: 'webinargeek', externalId: 'xyz', joinUrl: 'https://x.test/join' })).toBe(
      'https://x.test/join',
    );
  });
});
