export interface JoinLinkSource {
  provider: string;
  externalId: string;
  joinUrl?: string;
}

/**
 * Where a calendar invite's link comes from, in one place and in priority order:
 *
 *   1. whatever the operator typed on the session — they may be pasting a registration link or a
 *      per-guest URL that we should never second-guess
 *   2. whatever the provider resolved before the session started (`resolveJoinUrl`)
 *   3. a synthesised Zoom meeting link, for older sessions that have neither
 *
 * Dependency-free so the ordering is unit-testable, and so the synthesised fallback is one explicit
 * rule instead of an inline conditional buried in the dispatch loop.
 *
 * NOTE: step 3 always builds `/j/`, which is the meeting form. Whether Zoom accepts `/j/` for a
 * webinar is unverified, which is exactly why resolving step 2 matters — once a real link is stored
 * the fallback stops being used.
 */
export function sessionJoinUrl(session: JoinLinkSource): string | undefined {
  const explicit = session.joinUrl && session.joinUrl.trim();
  if (explicit) return explicit;

  if (session.provider === 'zoom' && session.externalId) {
    return `https://zoom.us/j/${encodeURIComponent(session.externalId)}`;
  }

  return undefined;
}

/**
 * The link one copy variant's calendar event should carry.
 *
 * A variant-specific registration link wins over the campaign's linked call, because that is the
 * whole point of testing copy against different Zoom registration pages. A blank variant link falls
 * through to the existing session rule, then to whatever manual location the campaign set — so a
 * campaign without a variant link behaves exactly as it did before.
 */
export function variantJoinUrl(
  variant: { registrationUrl?: string },
  session?: JoinLinkSource,
  fallbackLocation?: string,
): string | undefined {
  const own = variant.registrationUrl && variant.registrationUrl.trim();
  if (own) return own;

  const fromSession = session ? sessionJoinUrl(session) : undefined;
  if (fromSession) return fromSession;

  const fallback = fallbackLocation && fallbackLocation.trim();
  return fallback || undefined;
}
