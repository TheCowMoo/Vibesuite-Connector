import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/lib/passwords';
import { randomToken, sha256 } from '../../src/lib/tokens';
import { readCookie } from '../../src/lib/cookies';
import { isPublicPath } from '../../src/lib/authPaths';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const h = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', h)).toBe(false);
  });

  it('salted — same input yields different stored values', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
  });

  it('rejects malformed stored values', () => {
    expect(verifyPassword('x', 'nonsense')).toBe(false);
    expect(verifyPassword('x', 'scrypt$1$2$3$bad')).toBe(false);
  });
});

describe('tokens', () => {
  it('generates url-safe tokens', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThan(30);
  });

  it('sha256 is deterministic and 64 hex chars', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).toHaveLength(64);
  });
});

describe('isPublicPath', () => {
  it('keeps webhook, OAuth callbacks and auth endpoints public', () => {
    expect(isPublicPath('/webhooks/google/calendar')).toBe(true);
    expect(isPublicPath('/oauth/google/callback')).toBe(true);
    expect(isPublicPath('/oauth/ghl/callback')).toBe(true);
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/me')).toBe(true);
    expect(isPublicPath('/static/app.js')).toBe(true);
    expect(isPublicPath('/healthz')).toBe(true);
    expect(isPublicPath('/invite')).toBe(true);
    expect(isPublicPath('/')).toBe(true);
  });

  it('protects data APIs', () => {
    expect(isPublicPath('/api/connections')).toBe(false);
    expect(isPublicPath('/api/team')).toBe(false);
    expect(isPublicPath('/api/video/settings')).toBe(false);
    expect(isPublicPath('/api/auth/change-password')).toBe(false);
    expect(isPublicPath('/api/sessions')).toBe(false);
  });
});

describe('readCookie', () => {
  const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as never;

  it('reads a named cookie', () => {
    expect(readCookie(req('a=1; vibesuite_session=abc'), 'vibesuite_session')).toBe('abc');
  });

  it('decodes values', () => {
    expect(readCookie(req('t=a%20b'), 't')).toBe('a b');
  });

  it('returns null when absent', () => {
    expect(readCookie(req('a=1'), 'nope')).toBeNull();
    expect(readCookie(req(), 'x')).toBeNull();
  });
});
