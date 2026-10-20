import { describe, it, expect } from 'vitest';
import {
  chooseZoomTokenSource,
  expiryFrom,
  pickZoomAccount,
  removeZoomAccount,
  reportAccessFromStatus,
  tokenUsable,
  upsertZoomAccount,
  withoutZoomToken,
  type ZoomAccountLink,
} from '../../src/video/zoomAuth';

const T = 1_000_000;

function account(userId: string, extra: Partial<ZoomAccountLink> = {}): ZoomAccountLink {
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

describe('upsertZoomAccount / removeZoomAccount', () => {
  it('replaces an existing host instead of duplicating it', () => {
    const out = upsertZoomAccount([account('a', { email: 'old@example.com' })], account('a', { email: 'new@example.com' }));
    expect(out).toHaveLength(1);
    expect(out[0].email).toBe('new@example.com');
  });

  it('adds a new host alongside the others', () => {
    const out = upsertZoomAccount([account('a')], account('b'));
    expect(out.map((a) => a.userId)).toEqual(['a', 'b']);
  });

  it('removes only the named host', () => {
    expect(removeZoomAccount([account('a'), account('b')], 'a').map((a) => a.userId)).toEqual(['b']);
  });

  it('drops only the named token', () => {
    const tokens = { a: { refreshToken: 'ra' }, b: { refreshToken: 'rb' } };
    expect(Object.keys(withoutZoomToken(tokens, 'a'))).toEqual(['b']);
    expect(withoutZoomToken(undefined, 'a')).toEqual({});
  });
});

describe('reportAccessFromStatus', () => {
  it('treats a successful report call as granted', () => {
    expect(reportAccessFromStatus(200)).toBe('granted');
  });

  /* 401/403 is the expected answer for a non-admin host on a user-managed app. */
  it('treats a refusal as denied', () => {
    expect(reportAccessFromStatus(401)).toBe('denied');
    expect(reportAccessFromStatus(403)).toBe('denied');
  });

  it('leaves anything else unknown, so it is retried', () => {
    expect(reportAccessFromStatus(404)).toBe('unknown');
    expect(reportAccessFromStatus(0)).toBe('unknown');
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

