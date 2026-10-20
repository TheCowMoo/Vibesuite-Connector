import type { ZoomAccountRecord, ZoomAuthMode, ZoomTokenRecord } from '../domain/zoomStore';

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
 * What Zoom's answer to a report probe means. Anything genuinely unexplained (429, a timeout, an odd
 * 5xx) stays `unknown` so it is retried rather than cached as a refusal.
 */
export function reportAccessFromProbe(status: number, detail?: string): 'granted' | 'denied' | 'unknown' {
  if (status >= 200 && status < 300) return 'granted';
  if (isScopeDenied(status, detail)) return 'denied';
  return 'unknown';
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
