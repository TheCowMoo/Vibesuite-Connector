import { describe, expect, it } from 'vitest';
import type { CopyEvidence } from '../../src/domain/copyEvidence';
import {
  buildCopySuggestionPrompt,
  sanitizeCopySuggestions,
} from '../../src/domain/copySuggestions';

const evidence: CopyEvidence = {
  objective: 'balanced',
  hasAttendance: true,
  aggregate: {
    sent: 60,
    failed: 0,
    accepted: 16,
    tentative: 6,
    declined: 4,
    noResponse: 34,
    attended: 8,
    noShow: 14,
    acceptanceRate: 26.7,
    yesRate: 72.7,
    showUpRate: 36.4,
    attendedPerSent: 13.3,
  },
  variants: [
    {
      id: 'A',
      summary: 'Join us',
      description: 'A practical session.',
      sent: 40,
      failed: 0,
      accepted: 10,
      tentative: 2,
      declined: 2,
      noResponse: 26,
      attended: 6,
      noShow: 6,
      acceptanceRate: 25,
      yesRate: 83.3,
      showUpRate: 50,
      attendedPerSent: 15,
      sampleLabel: 'directional',
      hasAttendance: true,
    },
    {
      id: 'B',
      summary: 'A working session for senior leaders',
      description: 'Bring your questions.',
      sent: 20,
      failed: 0,
      accepted: 6,
      tentative: 4,
      declined: 2,
      noResponse: 8,
      attended: 2,
      noShow: 8,
      acceptanceRate: 30,
      yesRate: 60,
      showUpRate: 20,
      attendedPerSent: 10,
      sampleLabel: 'small',
      hasAttendance: true,
    },
  ],
  dataQuality: ['Some variants have small samples.'],
  generatedAt: 1,
};

describe('buildCopySuggestionPrompt', () => {
  it('includes evidence, guidance and no recipient data', () => {
    const prompt = buildCopySuggestionPrompt({
      evidence,
      knowledgeContext: 'Brand voice: practical and warm.',
      mode: 'improve',
      objective: 'balanced',
      count: 2,
    });

    expect(prompt).toContain('acceptanceRate');
    expect(prompt).toContain('showUpRate');
    expect(prompt).toContain('Current campaign evidence outranks general guidance');
    expect(prompt).toContain('Brand voice: practical and warm.');
    expect(prompt).toContain('Curated guidance to weigh');
    expect(prompt).toContain('Historical patterns from other campaigns');
    expect(prompt).not.toContain('ada@example.com');
  });

  it('includes historical patterns as observational evidence when supplied', () => {
    const prompt = buildCopySuggestionPrompt({
      evidence,
      knowledgeContext: '',
      mode: 'improve',
      objective: 'replies',
      count: 1,
      historicalPatterns: {
        generatedAt: 1,
        campaigns: 3,
        variants: 8,
        note: 'Observational only.',
        patterns: [
          {
            key: 'subject_question',
            label: 'Subject asks a question',
            present: { variants: 4, campaigns: 3, sent: 100, accepted: 30, acceptanceRate: 30, yesBase: 40, yesRate: 75, showUpBase: 20, showUpRate: 40 },
            absent: { variants: 4, campaigns: 3, sent: 100, accepted: 20, acceptanceRate: 20, yesBase: 30, yesRate: 66.7, showUpBase: 15, showUpRate: 33.3 },
          },
        ],
      },
    });

    expect(prompt).toContain('Historical patterns from other campaigns');
    expect(prompt).toContain('subject_question');
    expect(prompt).toContain('Observational');
  });
});

describe('sanitizeCopySuggestions', () => {
  it('strips links/markup, warns about style and skips duplicates', () => {
    const raw = {
      suggestions: [
        {
          mode: 'challenger',
          summary: '<b>Save your seat</b> https://example.com',
          description: 'A guaranteed result 🚀',
          rationale: 'Variant B has 30% acceptance.',
          evidence: ['B: 20 sent, 6 accepted'],
          tradeoffs: ['Small sample.'],
          confidence: 'medium',
        },
        {
          summary: 'Join us',
          description: 'A practical session.',
          rationale: 'Duplicate of current copy',
        },
        {
          summary: 'X'.repeat(130),
          description: 'A long but valid description.',
          rationale: 'Long subject test',
        },
        {
          summary: 'Hello {{first_name}}',
          description: 'A personalized-sounding line.',
          rationale: 'Token test',
        },
      ],
    };

    const out = sanitizeCopySuggestions(
      raw,
      [{ summary: 'Join us', description: 'A practical session.' }],
      'improve',
      3,
    );

    expect(out).toHaveLength(3);
    expect(out[0].mode).toBe('rewrite');
    expect(out[0].summary).toBe('Save your seat');
    expect(out[0].warnings.join(' ')).toContain('Removed a link');
    expect(out[0].warnings.join(' ')).toContain('promotional or spammy');
    expect(out[0].warnings.join(' ')).toContain('emoji');
    expect(out[1].summary).toHaveLength(120);
    expect(out[1].warnings.join(' ')).toContain('shortened');
    expect(out[2].warnings.join(' ')).toContain('personalization token');
  });

  it('honours the requested mode and limit', () => {
    const out = sanitizeCopySuggestions(
      {
        suggestions: [
          { summary: 'One', description: 'First', rationale: 'r' },
          { summary: 'Two', description: 'Second', rationale: 'r' },
        ],
      },
      [],
      'challenger',
      1,
    );

    expect(out).toHaveLength(1);
    expect(out[0].mode).toBe('challenger');
  });

  it('returns an empty list when the model prefers not to change the copy', () => {
    expect(sanitizeCopySuggestions({ suggestions: [] }, [], 'improve')).toEqual([]);
    expect(sanitizeCopySuggestions({}, [], 'improve')).toEqual([]);
  });
});
