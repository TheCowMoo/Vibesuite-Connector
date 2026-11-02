import { describe, it, expect } from 'vitest';
import { behaviorFor, buildZoomBehavior, type BehaviorPerson } from '../../src/domain/zoomBehavior';

const SESSION_START = '2026-01-01T10:00:00.000Z';
const SESSION_END = '2026-01-01T11:00:00.000Z';

function people(): BehaviorPerson[] {
  return [
    {
      email: 'Ada@Example.com',
      name: 'Ada Lovelace',
      joinedAt: '2026-01-01T10:05:00.000Z',
      leftAt: '2026-01-01T10:50:00.000Z',
      durationSec: 2700,
      raw: { device: 'Mac', network_type: 'Wifi', share_desktop: true },
    },
    {
      email: 'grace@example.com',
      name: 'Grace Hopper',
      joinedAt: SESSION_START,
      leftAt: SESSION_END,
      durationSec: 3600,
      raw: { device: 'PC', share_desktop: 'false' },
    },
    { name: 'Same Name' },
    { name: 'Same Name' },
  ];
}

describe('buildZoomBehavior', () => {
  it('attributes polls, Q&A and registration answers by email', () => {
    const index = buildZoomBehavior({
      people: people(),
      polls: [
        {
          email: 'ada@example.com',
          name: 'Ada Lovelace',
          question_details: [
            { question: 'Which plan?', answer: 'Pro' },
            { question: 'Team size?', answer: '50' },
          ],
        },
        { email: 'grace@example.com', question_details: [{ question: 'Which plan?', answer: 'Starter' }] },
      ],
      qa: [
        { email: 'ada@example.com', question: 'Does it support SSO?', answer: 'Yes' },
        { email: 'ada@example.com', question: 'Does it support SSO?', answer: 'Yes' },
      ],
      registrants: [
        {
          email: 'ada@example.com',
          custom_questions: [
            { title: 'Company', value: 'Analytical Engines' },
            { title: 'Role', value: 'Founder' },
          ],
        },
      ],
      sessionStart: SESSION_START,
      sessionEnd: SESSION_END,
    });

    const ada = behaviorFor(index, 'ADA@example.com', 'Ada Lovelace');
    expect(ada).toBeDefined();
    expect(ada?.pollAnswers).toEqual([
      { question: 'Which plan?', answer: 'Pro' },
      { question: 'Team size?', answer: '50' },
    ]);
    expect(ada?.pollQuestionCount).toBe(2);
    expect(ada?.pollAnsweredCount).toBe(2);
    expect(ada?.pollAnsweredCount === ada?.pollQuestionCount).toBe(true);
    expect(ada?.qa).toEqual([{ question: 'Does it support SSO?', answer: 'Yes', at: undefined }]);
    expect(ada?.qaAskedCount).toBe(1);
    expect(ada?.qaAnsweredCount).toBe(1);
    expect(ada?.registrationAnswers).toHaveLength(2);
    expect(ada?.registrationAnswerText).toContain('Company: Analytical Engines');
    expect(ada?.joinedLateMinutes).toBe(5);
    expect(ada?.leftEarlyMinutes).toBe(10);
    expect(ada?.attendedPortionPct).toBe(75);
    expect(ada?.device).toBe('Mac');
    expect(ada?.networkType).toBe('Wifi');
    expect(ada?.shareDesktop).toBe(true);

    const grace = behaviorFor(index, 'grace@example.com', 'Grace Hopper');
    expect(grace?.pollAnswers).toEqual([{ question: 'Which plan?', answer: 'Starter' }]);
    expect(grace?.pollAnsweredCount).toBe(1);
    expect(grace?.pollQuestionCount).toBe(2);
    expect(grace?.shareDesktop).toBe(false);
  });

  it('does not use an ambiguous name to attribute answers', () => {
    const index = buildZoomBehavior({
      people: people(),
      polls: [
        { name: 'Same Name', question_details: [{ question: 'Which plan?', answer: 'Enterprise' }] },
        { name: 'Ada Lovelace', question_details: [{ question: 'Which plan?', answer: 'Pro' }] },
      ],
      sessionStart: SESSION_START,
      sessionEnd: SESSION_END,
    });

    expect(index.byName.has('same name')).toBe(false);
    expect(index.byName.get('ada lovelace')?.pollAnswers).toHaveLength(1);
    expect(index.pollQuestions).toEqual(['Which plan?']);
    expect(index.pollRespondentCount).toBe(2);
    expect(index.pollAnswerCount).toBe(2);
  });

  it('deduplicates repeated poll answers and session totals', () => {
    const poll = {
      email: 'ada@example.com',
      question_details: [{ question: 'Which plan?', answer: 'Pro' }],
    };
    const index = buildZoomBehavior({
      people: people(),
      polls: [poll, poll],
      sessionStart: SESSION_START,
      sessionEnd: SESSION_END,
    });

    expect(behaviorFor(index, 'ada@example.com', 'Ada')?.pollAnswers).toHaveLength(1);
    expect(index.pollRespondentCount).toBe(1);
    expect(index.pollAnswerCount).toBe(1);
  });

  it('returns session question counts even when nobody is matched', () => {
    const index = buildZoomBehavior({
      people: [],
      polls: [
        {
          email: 'unknown@example.com',
          question_details: [
            { question: 'Which plan?', answer: 'Pro' },
            { question: 'Team size?', answer: '10' },
          ],
        },
      ],
    });

    expect(index.byEmail.size).toBe(0);
    expect(index.pollQuestions).toEqual(['Team size?', 'Which plan?']);
    expect(index.pollRespondentCount).toBe(1);
    expect(index.pollAnswerCount).toBe(2);
  });
});
