export interface PrevInviteMeta {
  summary?: string;
  start?: string;
  at?: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * One line describing a past invitation, for the "previously invited" label.
 *
 * Written to be honest rather than tidy: with no record of the event it says so plainly instead of
 * rendering something like "previously invited to undefined", or implying a specific event we
 * cannot actually name. People invited before this metadata existed land in that branch.
 */
export function labelPreviousInvite(meta?: PrevInviteMeta): string {
  const summary = meta?.summary && meta.summary.trim();
  if (!summary) return 'previously invited';

  const when = formatDay(meta?.start);
  return when ? `previously invited to ${summary} on ${when}` : `previously invited to ${summary}`;
}

/**
 * UTC parts rather than `toLocaleDateString`, so the label is stable regardless of the server's
 * locale or timezone. It is a display approximation: an event stored as a local datetime near
 * midnight could land on the neighbouring day, which is acceptable for a "when was this" hint.
 */
function formatDay(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;

  const d = new Date(parsed);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
