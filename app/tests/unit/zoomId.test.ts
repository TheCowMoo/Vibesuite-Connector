import { describe, it, expect } from 'vitest';
import { normalizeZoomCallId, otherType } from '../../src/video/zoomId';

describe('normalizeZoomCallId', () => {
  it('accepts a bare meeting ID, with or without separators', () => {
    expect(normalizeZoomCallId('12345678901')).toEqual({ id: '12345678901', fromUrl: false });
    expect(normalizeZoomCallId(' 123 456 789 ')).toEqual({ id: '123456789', fromUrl: false });
    expect(normalizeZoomCallId('123-456-789')).toEqual({ id: '123456789', fromUrl: false });
  });

  it('reduces a join link and leaves a /j/ link kind-unknown', () => {
    expect(normalizeZoomCallId('https://us02web.zoom.us/j/123456789?pwd=abc')).toEqual({
      id: '123456789',
      kind: undefined,
      fromUrl: true,
    });
  });

  it('marks /w/ and /register/ links as webinars', () => {
    expect(normalizeZoomCallId('https://us02web.zoom.us/w/987654321?tk=xyz')).toEqual({
      id: '987654321',
      kind: 'webinar',
      fromUrl: true,
    });
    expect(normalizeZoomCallId('https://us02web.zoom.us/webinar/register/987654321/abc')).toEqual({
      id: '987654321',
      kind: 'webinar',
      fromUrl: true,
    });
  });

  it('finds the ID in a link with extra segments', () => {
    expect(normalizeZoomCallId('https://zoom.us/j/1234567890?pwd=1&uname=2')).toEqual({
      id: '1234567890',
      kind: undefined,
      fromUrl: true,
    });
  });

  it('accepts a UUID as-is, because recurring calls need it', () => {
    const uuid = '/aj2xQ7pS6m+AbCdEfGh==';
    expect(normalizeZoomCallId(uuid)).toEqual({ id: uuid, fromUrl: false });
  });

  it('rejects registration-token links, other hosts and junk', () => {
    expect(normalizeZoomCallId('https://us02web.zoom.us/webinar/register/WN_abc')).toBeNull();
    expect(normalizeZoomCallId('https://example.com/j/123456789')).toBeNull();
    expect(normalizeZoomCallId('not an id')).toBeNull();
    expect(normalizeZoomCallId('')).toBeNull();
    expect(normalizeZoomCallId(undefined)).toBeNull();
  });
});

describe('otherType', () => {
  it('flips the kind', () => {
    expect(otherType('meeting')).toBe('webinar');
    expect(otherType('webinar')).toBe('meeting');
  });
});
