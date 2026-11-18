import { describe, expect, it } from 'vitest';
import { extractCopyFeatures } from '../../src/domain/copyFeatures';
import { aggregateCopyPatterns, type CopyPatternRow } from '../../src/domain/copyPatterns';

const rows: CopyPatternRow[] = [
  {
    campaignId: 'c1',
    variant: 'A',
    summary: 'Ready to join us?',
    description: '- A practical session\n- Bring your questions',
    sent: 10,
    accepted: 5,
    tentative: 2,
    attended: 3,
    hasAttendance: true,
  },
  {
    campaignId: 'c1',
    variant: 'B',
    summary: 'Join the webinar',
    description: 'A practical session.',
    sent: 10,
    accepted: 2,
    tentative: 1,
    attended: 1,
    hasAttendance: true,
  },
  {
    campaignId: 'c2',
    variant: 'A',
    summary: 'What should you do next?',
    description: 'See https://example.com',
    sent: 20,
    accepted: 8,
    tentative: 2,
    attended: 4,
    hasAttendance: true,
  },
  {
    campaignId: 'c2',
    variant: 'B',
    summary: 'A practical session',
    description: 'A short description.',
    sent: 20,
    accepted: 4,
    tentative: 2,
    attended: 2,
    hasAttendance: true,
  },
];

describe('extractCopyFeatures', () => {
  it('extracts subject and description features deterministically', () => {
    const out = extractCopyFeatures({
      summary: 'READY FOR YOUR NEXT STEP?',
      description: '- First point\n- Second point\nSee https://example.com',
    });

    expect(out.subject_question).toBe(true);
    expect(out.subject_you).toBe(true);
    expect(out.subject_all_caps).toBe(true);
    expect(out.description_bullets).toBe(true);
    expect(out.description_links).toBe(true);
    expect(out.description_personalization).toBe(false);
  });

  it('detects personalization tokens and guarantees', () => {
    const out = extractCopyFeatures({
      summary: 'Hello {{first_name}}',
      description: 'A guaranteed result.',
    });

    expect(out.description_personalization).toBe(true);
    expect(out.description_guarantee).toBe(true);
  });
});

describe('aggregateCopyPatterns', () => {
  it('compares outcomes by feature and keeps sample sizes', () => {
    const out = aggregateCopyPatterns(rows, 123, 20);

    expect(out.generatedAt).toBe(123);
    expect(out.campaigns).toBe(2);
    expect(out.variants).toBe(4);

    const question = out.patterns.find((p) => p.key === 'subject_question');
    expect(question).toBeDefined();
    expect(question?.present).toMatchObject({
      variants: 2,
      campaigns: 2,
      sent: 30,
      accepted: 13,
      acceptanceRate: 43.3,
      yesRate: 76.5,
      showUpRate: 41.2,
    });
    expect(question?.absent).toMatchObject({
      variants: 2,
      sent: 30,
      accepted: 6,
      acceptanceRate: 20,
      yesRate: 66.7,
      showUpRate: 33.3,
    });
    expect(out.note).toContain('Observational');
  });

  it('does not invent show-up when attendance was not tracked', () => {
    const out = aggregateCopyPatterns(
      rows.map((row) => ({ ...row, hasAttendance: false, attended: 0 })),
      1,
      20,
    );
    expect(out.patterns.every((p) => p.present.showUpRate === null && p.absent.showUpRate === null)).toBe(true);
  });

  it('caps the number of patterns returned', () => {
    const out = aggregateCopyPatterns(rows, 1, 2);
    expect(out.patterns).toHaveLength(2);
  });
});
