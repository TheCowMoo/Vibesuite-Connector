/**
 * Plan the Calendar events for one account's blast.
 *
 * One event is the norm: every recipient that account is allowed to send goes on it. The only
 * split is the provider safety ceiling — Google rejects a guest list larger than its per-event
 * maximum, so a slice past `maxAttendees` becomes a second event with a `(1/2)` suffix.
 *
 * `batchSize` is the explicit scheduled-round size. It caps the slice; it is not a default split.
 */
export function planEventGroups(
  emails: string[],
  options: { batchSize?: number; maxAttendees: number },
): string[][] {
  const max = Math.max(1, Math.floor(options.maxAttendees) || 1);
  const limit =
    options.batchSize && options.batchSize > 0
      ? Math.min(Math.floor(options.batchSize), emails.length)
      : emails.length;

  const slice = emails.slice(0, Math.max(0, limit));
  const groups: string[][] = [];
  for (let i = 0; i < slice.length; i += max) {
    groups.push(slice.slice(i, i + max));
  }
  return groups;
}
