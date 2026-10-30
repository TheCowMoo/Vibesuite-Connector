import { describe, it, expect } from 'vitest';
import { assignVariants, campaignVariants, groupEmailsByVariant, mirrorPrimaryVariant } from '../../src/domain/campaignVariants';
import { CopyVariantsSchema, type CopyVariant } from '../../src/domain/campaign';

const variants: CopyVariant[] = [
  { id: 'A', summary: 'First', description: 'A description' },
  { id: 'B', summary: 'Second' },
  { id: 'C', summary: 'Third' },
  { id: 'D', summary: 'Fourth' },
];

describe('campaignVariants', () => {
  it('falls back to the event copy as variant A', () => {
    expect(campaignVariants({ event: { summary: 'Webinar', description: 'Join us' } })).toEqual([
      { id: 'A', summary: 'Webinar', description: 'Join us' },
    ]);
  });

  it('returns variants in A/B/C/D order', () => {
    const camp = { event: { summary: 'base' }, copyVariants: [variants[3], variants[1], variants[0]] };
    expect(campaignVariants(camp).map((v) => v.id)).toEqual(['A', 'B', 'D']);
  });
});

describe('assignVariants', () => {
  it('round-robins every email exactly once', () => {
    const emails = Array.from({ length: 8 }, (_, i) => `p${i}@x.com`);
    const assigned = assignVariants(emails, variants);
    expect(Object.keys(assigned)).toHaveLength(8);
    expect(Object.values(assigned)).toEqual(['A', 'B', 'C', 'D', 'A', 'B', 'C', 'D']);
  });

  it('gives an even split when the audience does not divide by the variant count', () => {
    const assigned = assignVariants(['a@x.com', 'b@x.com', 'c@x.com'], variants);
    expect(Object.values(assigned)).toEqual(['A', 'B', 'C']);
  });

  it('assigns everyone to A when there is only the implicit variant', () => {
    const assigned = assignVariants(['A@X.com'], campaignVariants({ event: { summary: 'One' } }));
    expect(assigned).toEqual({ 'a@x.com': 'A' });
  });
});

describe('groupEmailsByVariant', () => {
  it('groups in queue order and fills a missing assignment from the fallback', () => {
    const grouped = groupEmailsByVariant(
      ['a@x.com', 'b@x.com', 'c@x.com'],
      { 'a@x.com': 'B', 'b@x.com': 'B' },
      'A',
      variants,
    );
    expect(grouped.get('A')).toEqual(['c@x.com']);
    expect(grouped.get('B')).toEqual(['a@x.com', 'b@x.com']);
    expect(grouped.get('C')).toEqual([]);
  });

  it('falls back when the stored variant is no longer active', () => {
    const grouped = groupEmailsByVariant(['a@x.com'], { 'a@x.com': 'D' }, 'A', [variants[0], variants[1]]);
    expect(grouped.get('A')).toEqual(['a@x.com']);
  });
});

describe('mirrorPrimaryVariant', () => {
  it('copies variant A into the legacy event fields', () => {
    const camp = { event: { summary: 'old', description: 'old desc' }, copyVariants: variants };
    expect(mirrorPrimaryVariant(camp).event).toEqual({ summary: 'First', description: 'A description' });
  });

  it('leaves a single-copy campaign untouched', () => {
    const camp = { event: { summary: 'only' } };
    expect(mirrorPrimaryVariant(camp)).toBe(camp);
  });
});

describe('CopyVariantsSchema', () => {
  it('accepts A plus alternates', () => {
    expect(CopyVariantsSchema.safeParse([variants[0], variants[1]]).success).toBe(true);
  });

  it('requires variant A as the base', () => {
    expect(CopyVariantsSchema.safeParse([variants[1], variants[2]]).success).toBe(false);
  });

  it('rejects duplicate ids', () => {
    expect(CopyVariantsSchema.safeParse([variants[0], variants[0]]).success).toBe(false);
  });
});
