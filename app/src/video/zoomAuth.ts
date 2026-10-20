import type { ZoomAccountLink, ZoomAuthMode, ZoomTokenSet } from '../domain/connection';

/** Refresh this long before Zoom's stated expiry, so a call in flight cannot land on an expired token. */
export const TOKEN_SKEW_MS = 60_000;

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
  accounts: ZoomAccountLink[] | undefined,
  requestedUserId?: string,
): { account?: ZoomAccountLink; error?: string } {
  const list = accounts ?? [];

  if (requestedUserId) {
    const hit = list.find((a) => a.userId === requestedUserId);
    return hit
      ? { account: hit }
      : { error: 'that Zoom account is not connected for this Google account — reconnect it in Settings → Video conferencing' };
  }

  if (!list.length) return {};
  if (list.length === 1) return { account: list[0] };
  return { error: 'this Google account has more than one Zoom host — pick one for this call' };
}

export function upsertZoomAccount(accounts: ZoomAccountLink[] | undefined, next: ZoomAccountLink): ZoomAccountLink[] {
  const others = (accounts ?? []).filter((a) => a.userId !== next.userId);
  return [...others, next];
}

export function removeZoomAccount(accounts: ZoomAccountLink[] | undefined, userId: string): ZoomAccountLink[] {
  return (accounts ?? []).filter((a) => a.userId !== userId);
}

export function withoutZoomToken(tokens: Record<string, ZoomTokenSet> | undefined, userId: string): Record<string, ZoomTokenSet> {
  const next = { ...(tokens ?? {}) };
  delete next[userId];
  return next;
}

/**
 * What Zoom's answer to a report call means for this authorisation. 401/403 is the expected answer
 * for a non-admin host on a user-managed app, and must be remembered so we stop asking.
 */
export function reportAccessFromStatus(status: number): 'granted' | 'denied' | 'unknown' {
  if (status >= 200 && status < 300) return 'granted';
  if (status === 401 || status === 403) return 'denied';
  return 'unknown';
}

export interface ChooseZoomTokenParams {
  mode: ZoomAuthMode;
  requestedUserId?: string;
  accounts?: ZoomAccountLink[];
  tokens?: Record<string, ZoomTokenSet>;
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
