import { extractRecipients, type SegmentationResult } from './invite';

export interface AudienceSegment {
  name: string;
  emails: string[];
}

export interface Audience {
  /** Who will actually be invited — anyone already invited for this list is removed. */
  emails: string[];
  perSegment: AudienceSegment[];
  invalid: string[];
  duplicatesRemoved: number;
  /** People this list has already invited. Disjoint from `emails`. */
  alreadyInvited: string[];
}

/**
 * Split a segmentation result into "who to invite" and "who is already invited".
 *
 * This is the single place that decision is made. The single-invite preview, the single-invite send
 * and the campaign start all go through here, so their numbers can never disagree — which matters
 * because `list:{id}:invited` is shared between all of them, and a person may only ever be invited
 * once per contact list (not once per campaign).
 */
export function buildAudience(
  result: SegmentationResult | unknown,
  segmentNames: string[] | undefined,
  invited: Set<string>,
): Audience {
  const plan = extractRecipients(result, segmentNames);
  return {
    emails: plan.emails.filter((e) => !invited.has(e)),
    perSegment: plan.perSegment,
    invalid: plan.invalid,
    duplicatesRemoved: plan.duplicatesRemoved,
    alreadyInvited: plan.emails.filter((e) => invited.has(e)),
  };
}

/**
 * Plain-language reason an audience is empty, so the operator is told which of the three very
 * different causes actually applies instead of getting one generic message.
 */
export function describeEmptyAudience(audience: Audience): string {
  const invited = audience.alreadyInvited.length;
  const people = invited === 1 ? 'person' : 'people';
  if (invited > 0) {
    return `everyone on this list has already been invited (${invited} ${people})`;
  }
  if (audience.invalid.length > 0) {
    return `this list has no usable email addresses (${audience.invalid.length} could not be read)`;
  }
  return 'this list has nobody to invite yet';
}
