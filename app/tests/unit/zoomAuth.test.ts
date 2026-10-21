import { describe, it, expect } from 'vitest';
import {
  chooseZoomTokenSource,
  classifyCapability,
  defaultZoomAuthMode,
  expiryFrom,
  isProbeEraDenial,
  isScopeDenied,
  pickZoomAccount,
  scopesFromDenial,
  shouldAttemptReports,
  tokenUsable,
  type ZoomAccountRecord,
} from '../../src/video/zoomAuth';

const T = 1_000_000;

function account(userId: string, extra: Partial<ZoomAccountRecord> = {}): ZoomAccountRecord {
  return {
    userId,
    email: `${userId}@example.com`,
    connectedAt: T,
    reportAccess: 'unknown',
    ...extra,
  };
}

describe('tokenUsable', () => {
  it('treats an expiring token as unusable inside the safety window', () => {
    expect(tokenUsable(T + 61_000, T)).toBe(true);
    expect(tokenUsable(T + 59_000, T)).toBe(false);
    expect(tokenUsable(undefined, T)).toBe(false);
  });
});

describe('expiryFrom', () => {
  it('uses the reported lifetime, and falls back to an hour', () => {
    expect(expiryFrom(T, 3600)).toBe(T + 3_600_000);
    expect(expiryFrom(T, undefined)).toBe(T + 3_600_000);
    expect(expiryFrom(T, Number.NaN)).toBe(T + 3_600_000);
  });
});

describe('pickZoomAccount', () => {
  it('uses the requested host', () => {
    const out = pickZoomAccount([account('a'), account('b')], 'b');
    expect(out.account?.userId).toBe('b');
    expect(out.error).toBeUndefined();
  });

  it('rejects a host that is not connected here', () => {
    expect(pickZoomAccount([account('a')], 'b').error).toBeTruthy();
  });

  it('accepts a single host without being told which one', () => {
    expect(pickZoomAccount([account('a')]).account?.userId).toBe('a');
  });

  /* Guessing "the first" would silently read the wrong person's meeting. */
  it('refuses to guess between several hosts', () => {
    const out = pickZoomAccount([account('a'), account('b')]);
    expect(out.account).toBeUndefined();
    expect(out.error).toBeTruthy();
  });

  it('returns nothing when none are connected', () => {
    expect(pickZoomAccount(undefined)).toEqual({});
    expect(pickZoomAccount([])).toEqual({});
  });
});

describe('isScopeDenied', () => {
  it('treats 401 and 403 as a refusal', () => {
    expect(isScopeDenied(401)).toBe(true);
    expect(isScopeDenied(403)).toBe(true);
  });

  /*
   * Zoom answers a missing scope with 400 code 4711, not 403. Reading only 401/403 left every
   * user-managed host stuck on "Report access unknown" forever.
   */
  it('treats Zoom\'s 400 scope error as a refusal', () => {
    expect(isScopeDenied(400, '400 Invalid access token, does not contain scopes:[report:read:admin].')).toBe(true);
    expect(isScopeDenied(400, 'Invalid access token, does not contain scopes:[report:read:admin]')).toBe(true);
  });

  it('does not treat an unrelated 400 as a refusal', () => {
    expect(isScopeDenied(400, '400 The date range is invalid')).toBe(false);
    expect(isScopeDenied(400)).toBe(false);
  });

  it('leaves rate limits and transport failures alone', () => {
    expect(isScopeDenied(429, 'Too Many Requests')).toBe(false);
    expect(isScopeDenied(0, 'timeout of 20000ms exceeded')).toBe(false);
  });
});

describe('classifyCapability', () => {
  it('reports data as available and no data as empty', () => {
    expect(classifyCapability(200, 3)).toEqual({ status: 'available' });
    expect(classifyCapability(200, 0)).toEqual({ status: 'empty' });
  });

  /* A 404 means "no such report for that call", e.g. Q&A on a plain meeting — not a permission problem. */
  it('treats 404 as missing rather than denied', () => {
    expect(classifyCapability(404, 0)).toEqual({ status: 'missing' });
  });

  it('treats a scope refusal as denied and names the scope', () => {
    expect(classifyCapability(403, 0)).toEqual({ status: 'denied', missingScopes: [] });
    expect(classifyCapability(400, 0, 'does not contain scopes:[report:read:list_absentees:admin]'))
      .toEqual({ status: 'denied', missingScopes: ['report:read:list_absentees:admin'] });
  });

  it('keeps rate limits and transport failures unknown, so they are retried', () => {
    expect(classifyCapability(429, 0).status).toBe('unknown');
    expect(classifyCapability(0, 0).status).toBe('unknown');
    expect(classifyCapability(502, 0).status).toBe('unknown');
  });
});

describe('scopesFromDenial', () => {
  it('extracts the scope Zoom names', () => {
    expect(scopesFromDenial('400 Invalid access token, does not contain scopes:[report:read:user:admin].'))
      .toEqual(['report:read:user:admin']);
  });

  it('handles several scopes and spacing', () => {
    expect(scopesFromDenial('does not contain scopes:[report:read:user:admin, meeting:read:meeting]'))
      .toEqual(['report:read:user:admin', 'meeting:read:meeting']);
  });

  it('returns nothing for unrelated messages', () => {
    expect(scopesFromDenial('400 The date range is invalid')).toEqual([]);
    expect(scopesFromDenial(undefined)).toEqual([]);
    expect(scopesFromDenial('')).toEqual([]);
  });
});

describe('shouldAttemptReports', () => {
  it('always tries when the verdict is granted or unknown', () => {
    expect(shouldAttemptReports('granted', false)).toBe(true);
    expect(shouldAttemptReports('unknown', false)).toBe(true);
    expect(shouldAttemptReports(undefined, false)).toBe(true);
  });

  /*
   * The probe asks /report/users/… while attendance needs /report/meetings/…/participants; a denial
   * there must not stop us checking the call that actually matters — but only once.
   */
  it('allows exactly one verification after a denial', () => {
    expect(shouldAttemptReports('denied', false)).toBe(true);
    expect(shouldAttemptReports('denied', true)).toBe(false);
  });
});

describe('isProbeEraDenial', () => {
  /* The retired probe's scope; a denial naming it says nothing about the participants call. */
  it('recognises a denial caused by the users-report scope', () => {
    expect(isProbeEraDenial('denied', ['report:read:user:admin'])).toBe(true);
    expect(isProbeEraDenial('denied', ['report:read:user:admin', 'meeting:read:meeting'])).toBe(true);
  });

  it('leaves a real participants-call denial alone', () => {
    expect(isProbeEraDenial('denied', ['report:read:list_past_participants:admin'])).toBe(false);
    expect(isProbeEraDenial('denied', [])).toBe(false);
    expect(isProbeEraDenial('denied')).toBe(false);
  });

  it('only applies to a denial', () => {
    expect(isProbeEraDenial('granted', ['report:read:user:admin'])).toBe(false);
    expect(isProbeEraDenial('unknown', ['report:read:user:admin'])).toBe(false);
  });
});

describe('defaultZoomAuthMode', () => {
  /* The General App is the default: it is the only mode where a Google account owns its Zoom identity. */
  it('defaults to the General App when nothing is stored', () => {
    expect(defaultZoomAuthMode()).toBe('user');
    expect(defaultZoomAuthMode(undefined)).toBe('user');
  });

  it('honours an explicit choice either way', () => {
    expect(defaultZoomAuthMode('user')).toBe('user');
    expect(defaultZoomAuthMode('s2s')).toBe('s2s');
  });
});

describe('chooseZoomTokenSource', () => {
  const base = { now: T, s2sConfigured: false };

  it('uses the account-wide app in s2s mode', () => {
    const out = chooseZoomTokenSource({ ...base, mode: 's2s', s2sConfigured: true });
    expect(out.kind).toBe('s2s');
  });

  it('explains what to configure when s2s has no credentials', () => {
    const out = chooseZoomTokenSource({ ...base, mode: 's2s' });
    expect(out.kind).toBe('error');
  });

  it('uses the host token in user mode', () => {
    const out = chooseZoomTokenSource({
      ...base,
      mode: 'user',
      accounts: [account('a')],
      tokens: { a: { refreshToken: 'ra', accessToken: 'aa', expiresAt: T + 3_600_000 } },
    });
    expect(out).toMatchObject({ kind: 'user', userId: 'a', refreshToken: 'ra', accessToken: 'aa' });
  });

  it('falls back to s2s when the tenant has no host authorised', () => {
    const out = chooseZoomTokenSource({ ...base, mode: 'user', accounts: [], s2sConfigured: true });
    expect(out.kind).toBe('s2s');
  });

  /*
   * A listed host whose token is gone must not fall back to s2s: that would silently read another
   * identity's meetings. It has to ask for a reconnect.
   */
  it('asks for a reconnect when a listed host has no token', () => {
    const out = chooseZoomTokenSource({ ...base, mode: 'user', accounts: [account('a')], tokens: {} });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error).toContain('reconnect');
  });

  it('asks for a reconnect rather than leaking a host token across tenants', () => {
    const out = chooseZoomTokenSource({
      ...base,
      mode: 'user',
      accounts: [account('a')],
      tokens: { b: { refreshToken: 'rb' } },
    });
    expect(out.kind).toBe('error');
  });

  it('requires a host when several are connected', () => {
    const out = chooseZoomTokenSource({
      ...base,
      mode: 'user',
      accounts: [account('a'), account('b')],
      tokens: { a: { refreshToken: 'ra' }, b: { refreshToken: 'rb' } },
    });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error).toContain('pick one');
  });

  it('picks the requested host out of several', () => {
    const out = chooseZoomTokenSource({
      ...base,
      mode: 'user',
      requestedUserId: 'b',
      accounts: [account('a'), account('b')],
      tokens: { a: { refreshToken: 'ra' }, b: { refreshToken: 'rb' } },
    });
    expect(out).toMatchObject({ kind: 'user', userId: 'b', refreshToken: 'rb' });
  });
});

