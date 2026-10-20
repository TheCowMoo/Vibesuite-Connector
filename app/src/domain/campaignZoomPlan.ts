/**
 * What to write onto a campaign's linked session when the campaign's Zoom host changes.
 *
 * The campaign is the operator-facing choice, and `syncSession()` only reads the session, so the
 * session has to carry a stamped copy. Kept pure (and in its own module, so tests do not drag in
 * Redis) because the interesting cases are the edges: a host that did not change must not cause a
 * pointless write, and clearing the campaign's host must only clear the session when the session was
 * still holding *that* host — a session may carry its own override, which a campaign edit must not
 * silently stomp on.
 */
export function planSessionZoomStamp(input: {
  previousCampaignHost?: string;
  nextCampaignHost?: string;
  sessionHost?: string;
}): { changed: boolean; host?: string } {
  const { previousCampaignHost, nextCampaignHost, sessionHost } = input;

  if (nextCampaignHost) {
    return sessionHost === nextCampaignHost
      ? { changed: false, host: sessionHost }
      : { changed: true, host: nextCampaignHost };
  }

  if (previousCampaignHost && sessionHost === previousCampaignHost) {
    return { changed: true, host: undefined };
  }

  return { changed: false, host: sessionHost };
}
