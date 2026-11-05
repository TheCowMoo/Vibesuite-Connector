import { describe, it, expect } from 'vitest';
import { sessionJoinUrl, variantJoinUrl } from '../../src/domain/joinLink';

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

describe('variantJoinUrl', () => {
  it('prefers the variant registration link over the linked call', () => {
    expect(
      variantJoinUrl(
        { registrationUrl: 'https://zoom.us/webinar/register/WN_a' },
        zoom({ joinUrl: 'https://zoom.us/w/1' }),
      ),
    ).toBe('https://zoom.us/webinar/register/WN_a');
  });

  it('trims the variant link', () => {
    expect(variantJoinUrl({ registrationUrl: '  https://zoom.us/webinar/register/WN_a  ' })).toBe(
      'https://zoom.us/webinar/register/WN_a',
    );
  });

  it('falls through to the session when the variant link is blank', () => {
    expect(variantJoinUrl({ registrationUrl: '   ' }, zoom())).toBe('https://zoom.us/j/85412345678');
    expect(variantJoinUrl({}, zoom({ joinUrl: 'https://zoom.us/w/9' }))).toBe('https://zoom.us/w/9');
  });

  it('uses the campaign location when there is no session', () => {
    expect(variantJoinUrl({}, undefined, 'https://example.com/room')).toBe('https://example.com/room');
    expect(variantJoinUrl({}, undefined, '   ')).toBeUndefined();
    expect(variantJoinUrl({})).toBeUndefined();
  });
});
