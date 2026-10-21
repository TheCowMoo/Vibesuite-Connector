import type { CapabilityStatus, ZoomAccountRecord, ZoomAuthMode, ZoomTokenRecord } from '../domain/zoomStore';

export type { ZoomAccountRecord, ZoomAuthMode, ZoomTokenRecord } from '../domain/zoomStore';

/** Refresh this long before Zoom's stated expiry, so a call in flight cannot land on an expired token. */
export const TOKEN_SKEW_MS = 60_000;

/**
 * Which authorisation mode an install runs in when nothing is stored.
 *
 * The General App is the default because it is the only mode where each Google account can own its
 * Zoom identity. Server-to-server remains available as an explicit choice — and as an automatic
 * fallback for a connection with no authorised hosts — so an existing S2S install keeps working
 * unchanged even though the default moved.
 */
export function defaultZoomAuthMode(stored?: ZoomAuthMode): ZoomAuthMode {
  return stored ?? 'user';
}

/** One Zoom identity's token, or the account-wide server-to-server app, or a reason neither is possible. */
export type ZoomTokenSource =
  | {
      kind: 'user';
      userId: string;
      email: string;
      refreshToken: string;
      accessToken?: string;
      expiresAt?: number;
    }
  | { kind: 's2s' }
  | { kind: 'error'; error: string };

export function tokenUsable(expiresAt: number | undefined, now: number, skewMs = TOKEN_SKEW_MS): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt - skewMs > now;
}

export function expiryFrom(now: number, expiresInSeconds: number | undefined, fallbackSeconds = 3600): number {
  const seconds = Number.isFinite(expiresInSeconds) && (expiresInSeconds as number) > 0
    ? (expiresInSeconds as number)
    : fallbackSeconds;
  return now + seconds * 1000;
}

/**
 * Which of the connection's authorised Zoom hosts a session belongs to.
 *
 * Ambiguity is an error rather than a guess: picking "the first" would silently read the wrong
 * person's meeting and report it as empty.
 */
export function pickZoomAccount(
  accounts: ZoomAccountRecord[] | undefined,
  requestedUserId?: string,
): { account?: ZoomAccountRecord; error?: string } {
  const list = accounts ?? [];

  if (requestedUserId) {
    const hit = list.find((a) => a.userId === requestedUserId);
    return hit
      ? { account: hit }
      : { error: 'that Zoom account is not connected — connect it in Settings → Video conferencing' };
  }

  if (!list.length) return {};
  if (list.length === 1) return { account: list[0] };
  return { error: 'more than one Zoom host is connected — pick one for this campaign' };
}

/**
 * Whether Zoom's answer means "this authorisation may not read reports".
 *
 * 401/403 is the obvious case. The one that used to be misread: a missing scope comes back as **400
 * with code 4711** ("Invalid access token, does not contain scopes:[report:read:admin]"), which is why
 * a user-managed app used to sit on "Report access unknown" forever instead of saying it had no
 * report scope.
 */
export function isScopeDenied(status: number, detail?: string): boolean {
  if (status === 401 || status === 403) return true;
  return status === 400 && !!detail && /scope/i.test(detail);
}

/**
 * What one report endpoint's answer means for that capability.
 *
 * The five answers are deliberately distinct, because they call for different actions: add a scope
 * (`denied`), accept that the plan or the call has no such report (`missing`), accept that nothing was
 * recorded (`empty`), or retry later (`unknown`). Collapsing them into "reports broken" is what made
 * this take so long to diagnose.
 */
export function classifyCapability(
  status: number,
  rowCount: number,
  detail?: string,
): { status: CapabilityStatus; missingScopes?: string[] } {
  if (status >= 200 && status < 300) {
    return { status: rowCount > 0 ? 'available' : 'empty' };
  }
  if (status === 404) return { status: 'missing' };
  if (isScopeDenied(status, detail)) {
    return { status: 'denied', missingScopes: scopesFromDenial(detail) };
  }
  return { status: 'unknown' };
}

/**
 * The scopes Zoom names when it refuses: `… does not contain scopes:[report:read:user:admin].`
 *
 * Quoting them back as "add this in Zoom → Scopes" is the difference between a 400 string and an
 * actionable instruction.
 */
export function scopesFromDenial(detail?: string): string[] {
  const match = /scopes?:\s*\[([^\]]*)\]/i.exec(detail ?? '');
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether a sync should still try the report endpoints.
 *
 * The connect-time probe asks a *different* endpoint (`/report/users/{userId}/meetings`, scope
 * `report:read:user:admin`) from the one attendance needs (`/report/meetings/{id}/participants`), so
 * its "denied" can be wrong about the call that matters. A denial therefore buys one verification
 * attempt per host per process: if participants work, the verdict flips to granted; if not, the host
 * is marked and we stop asking.
 */
export function shouldAttemptReports(
  access: 'granted' | 'denied' | 'unknown' | undefined,
  alreadyAttempted: boolean,
): boolean {
  if (access !== 'denied') return true;
  return !alreadyAttempted;
}

/**
 * Was this denial produced by the old connect-time probe?
 *
 * That probe asked `/report/users/{userId}/meetings` (scope `report:read:user:admin`), an endpoint
 * attendance never uses. Its verdicts are stale and must not keep a host marked as refusing reports,
 * so they are presented as `unknown` until a real participants call decides.
 */
export function isProbeEraDenial(access: string | undefined, missingScopes?: string[]): boolean {
  return access === 'denied' && !!missingScopes?.includes('report:read:user:admin');
}

export interface ChooseZoomTokenParams {
  mode: ZoomAuthMode;
  requestedUserId?: string;
  accounts?: ZoomAccountRecord[];
  tokens?: Record<string, ZoomTokenRecord>;
  s2sConfigured: boolean;
  now: number;
}

export function chooseZoomTokenSource(p: ChooseZoomTokenParams): ZoomTokenSource {
  if (p.mode !== 'user') {
    return p.s2sConfigured
      ? { kind: 's2s' }
      : { kind: 'error', error: 'Zoom is not configured. Set it in Settings → Video conferencing.' };
  }

  const pick = pickZoomAccount(p.accounts, p.requestedUserId);
  if (pick.error) return { kind: 'error', error: pick.error };

  if (!pick.account) {
    // Nothing authorised for this tenant yet — the account-wide app is still a valid fallback.
    return p.s2sConfigured
      ? { kind: 's2s' }
      : {
          kind: 'error',
          error: 'No Zoom account is connected for this Google account. Connect one in Settings → Video conferencing, or switch Zoom back to server-to-server.',
        };
  }

  const token = p.tokens?.[pick.account.userId];
  if (!token?.refreshToken) {
    // Deliberately no fallback here: the host is listed, so silently using another identity's token
    // would read the wrong meetings.
    return { kind: 'error', error: `Zoom needs reconnecting for ${pick.account.email}` };
  }

  return {
    kind: 'user',
    userId: pick.account.userId,
    email: pick.account.email,
    refreshToken: token.refreshToken,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
  };
}
