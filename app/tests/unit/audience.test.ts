import { describe, it, expect } from 'vitest';
import { buildAudience, describeEmptyAudience } from '../../src/domain/audience';

const list = (...emails: string[]) => ({ segments: [{ name: 'all', rows: emails.map((email) => ({ email })) }] });

describe('buildAudience', () => {
  it('invites everyone when nothing has been sent for this list yet', () => {
    const a = buildAudience(list('a@x.com', 'b@x.com'), undefined, new Set());
    expect(a.emails).toEqual(['a@x.com', 'b@x.com']);
    expect(a.alreadyInvited).toEqual([]);
  });

  it('moves anyone already invited for the list out of the send list', () => {
    const a = buildAudience(list('a@x.com', 'b@x.com', 'c@x.com'), undefined, new Set(['b@x.com']));
    expect(a.emails).toEqual(['a@x.com', 'c@x.com']);
    expect(a.alreadyInvited).toEqual(['b@x.com']);
  });

  it('leaves nothing to send when the whole list has already been invited', () => {
    const a = buildAudience(list('a@x.com'), undefined, new Set(['a@x.com']));
    expect(a.emails).toEqual([]);
    expect(a.alreadyInvited).toEqual(['a@x.com']);
  });

  /*
   * The property that stops anyone being invited twice. `list:{id}:invited` is shared between the
   * one-off Invitations tab and every campaign on that list, so the two lists must never overlap
   * and must together account for everyone the segmentation produced.
   */
  it('keeps the send list and the already-invited list disjoint and complete', () => {
    const a = buildAudience(list('a@x.com', 'b@x.com', 'c@x.com'), undefined, new Set(['b@x.com']));
    expect(a.emails.filter((e) => a.alreadyInvited.includes(e))).toEqual([]);
    expect(a.emails.length + a.alreadyInvited.length).toBe(3);
  });

  it('ignores invited addresses that are not on this list', () => {
    const a = buildAudience(list('a@x.com'), undefined, new Set(['someone-else@x.com']));
    expect(a.emails).toEqual(['a@x.com']);
    expect(a.alreadyInvited).toEqual([]);
  });

  it('still reports duplicates across segments', () => {
    // `collectFromRows` already de-dupes inside a single segment, so a duplicate can only be
    // counted across two segments — hence the two-segment fixture rather than one row list.
    const result = {
      segments: [
        { name: 'a', rows: [{ email: 'Dup@X.com' }] },
        { name: 'b', rows: [{ email: 'dup@x.com' }] },
      ],
    };
    const a = buildAudience(result, undefined, new Set());
    expect(a.emails).toEqual(['dup@x.com']);
    expect(a.duplicatesRemoved).toBe(1);
  });

  it('honours a segment selection', () => {
    const result = {
      segments: [
        { name: 'hot', rows: [{ email: 'hot@x.com' }] },
        { name: 'cold', rows: [{ email: 'cold@x.com' }] },
      ],
    };
    expect(buildAudience(result, ['hot'], new Set()).emails).toEqual(['hot@x.com']);
    expect(buildAudience(result, undefined, new Set()).emails).toEqual(['hot@x.com', 'cold@x.com']);
  });

  it('survives a list that was never segmented', () => {
    const a = buildAudience(undefined, undefined, new Set());
    expect(a.emails).toEqual([]);
    expect(a.alreadyInvited).toEqual([]);
  });
});

describe('describeEmptyAudience', () => {
  it('says the list was already used when that is the reason', () => {
    const a = buildAudience(list('a@x.com'), undefined, new Set(['a@x.com']));
    expect(describeEmptyAudience(a)).toBe('everyone on this list has already been invited (1 person)');
  });

  it('pluralises the count', () => {
    const a = buildAudience(list('a@x.com', 'b@x.com'), undefined, new Set(['a@x.com', 'b@x.com']));
    expect(describeEmptyAudience(a)).toBe('everyone on this list has already been invited (2 people)');
  });

  it('names unreadable addresses when that is the reason', () => {
    // `invalid` only fills for something the email scan matched but the validator rejected, and the
    // only realistic way in is an address over 254 characters — hence the odd-looking fixture.
    const tooLong = `${'a'.repeat(250)}@x.com`;
    const a = buildAudience({ segments: [{ name: 'all', rows: [tooLong] }] }, undefined, new Set());
    expect(a.emails).toEqual([]);
    expect(a.invalid).toHaveLength(1);
    expect(describeEmptyAudience(a)).toMatch(/no usable email addresses/);
  });

  it('falls back to "nobody to invite" for a genuinely empty list', () => {
    expect(describeEmptyAudience(buildAudience({ segments: [] }, undefined, new Set()))).toBe(
      'this list has nobody to invite yet',
    );
  });
});
