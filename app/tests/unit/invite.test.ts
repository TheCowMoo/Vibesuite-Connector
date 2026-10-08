import { describe, it, expect } from 'vitest';
import { extractRecipients, chunk } from '../../src/domain/invite';

describe('extractRecipients', () => {
  it('extracts emails from object rows via an email-ish key', () => {
    const result = {
      segments: [{ name: 'hot', rows: [{ name: 'A', email: 'a@x.com' }, { name: 'B', 'e-mail': 'b@x.com' }] }],
    };
    const plan = extractRecipients(result);
    expect(plan.emails).toEqual(['a@x.com', 'b@x.com']);
  });

  it('extracts emails from plain string rows', () => {
    const result = { segments: [{ name: 's', rows: ['a@x.com, B <b@x.com>', 'not an email'] }] };
    const plan = extractRecipients(result);
    expect(plan.emails).toEqual(['a@x.com', 'b@x.com']);
  });

  it('dedupes across segments and lowercases', () => {
    const result = {
      segments: [
        { name: 'a', rows: [{ email: 'Dup@X.com' }] },
        { name: 'b', rows: [{ email: 'dup@x.com' }] },
      ],
    };
    const plan = extractRecipients(result);
    expect(plan.emails).toEqual(['dup@x.com']);
    expect(plan.duplicatesRemoved).toBe(1);
  });

  it('filters to selected segments', () => {
    const result = {
      segments: [
        { name: 'one', rows: [{ email: 'a@x.com' }] },
        { name: 'two', rows: [{ email: 'b@x.com' }] },
      ],
    };
    const plan = extractRecipients(result, ['two']);
    expect(plan.emails).toEqual(['b@x.com']);
  });

  it('ignores values without a valid email', () => {
    const result = { segments: [{ name: 's', rows: ['junk', 'no-email', 'x@y', 'real@x.com'] }] };
    const plan = extractRecipients(result);
    expect(plan.emails).toEqual(['real@x.com']);
  });
});

describe('chunk', () => {
  it('splits arrays into fixed-size chunks', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
