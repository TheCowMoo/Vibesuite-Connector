import { describe, it, expect } from 'vitest';
import {
  buildWorkflowAiPrompt,
  firstMatchingWorkflowRule,
  matchesPollCondition,
  validateAiWorkflowResponse,
  workflowRuleMatches,
} from '../../src/domain/workflowRules';
import { buildZoomBehavior } from '../../src/domain/zoomBehavior';
import type { AttendanceWorkflowRule } from '../../src/domain/connection';
import type { ConditionContext } from '../../src/domain/condition';

function behavior() {
  return buildZoomBehavior({
    people: [{ email: 'ada@example.com', name: 'Ada Lovelace' }],
    polls: [
      {
        email: 'ada@example.com',
        question_details: [
          { question: 'Which plan?', answer: 'Pro' },
          { question: 'Team size?', answer: '50' },
        ],
      },
    ],
  }).byEmail.get('ada@example.com');
}

function rule(over: Partial<AttendanceWorkflowRule> = {}): AttendanceWorkflowRule {
  return {
    id: 'r1',
    name: 'Pro buyers',
    enabled: true,
    conditions: [],
    workflowId: 'wf-pro',
    ...over,
  };
}

describe('matchesPollCondition', () => {
  const b = behavior();

  it('matches equals and contains case-insensitively', () => {
    expect(matchesPollCondition({ question: 'which plan?', operator: 'equals', answer: 'pro' }, b)).toBe(true);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'equals', answer: 'starter' }, b)).toBe(false);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'contains', answer: 'ro' }, b)).toBe(true);
  });

  it('matches answered / not_answered only for questions present in the session', () => {
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'answered' }, b)).toBe(true);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_answered' }, b)).toBe(false);
    expect(matchesPollCondition({ question: 'Not asked', operator: 'not_answered' }, b)).toBe(false);
    expect(matchesPollCondition({ question: 'Not asked', operator: 'answered' }, b)).toBe(false);
  });

  it('treats not_equals and not_contains as negatives of a present answer', () => {
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_equals', answer: 'Starter' }, b)).toBe(true);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_equals', answer: 'Pro' }, b)).toBe(false);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_contains', answer: 'Starter' }, b)).toBe(true);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_contains', answer: 'Pro' }, b)).toBe(false);
  });

  it('never matches without behavior', () => {
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_answered' }, undefined)).toBe(false);
  });

  it('treats "did not answer" as true for a question that ran but this person skipped', () => {
    const index = buildZoomBehavior({
      people: [{ email: 'grace@example.com', name: 'Grace Hopper' }],
      polls: [
        {
          email: 'ada@example.com',
          question_details: [{ question: 'Which plan?', answer: 'Pro' }],
        },
      ],
    });
    const nonResponder = index.byEmail.get('grace@example.com');

    expect(matchesPollCondition({ question: 'Which plan?', operator: 'not_answered' }, nonResponder)).toBe(true);
    expect(matchesPollCondition({ question: 'Which plan?', operator: 'answered' }, nonResponder)).toBe(false);
    expect(matchesPollCondition({ question: 'Not asked', operator: 'not_answered' }, nonResponder)).toBe(false);
  });
});

describe('workflowRuleMatches / firstMatchingWorkflowRule', () => {
  const ctx: ConditionContext = { attendanceStatus: 'attended', attendanceMinutes: '45' };
  const b = behavior();

  it('requires every condition and poll condition (AND)', () => {
    const good = rule({
      conditions: [{ field: 'attendanceStatus', operator: 'equals', value: 'attended' }],
      pollConditions: [{ question: 'Which plan?', operator: 'equals', answer: 'Pro' }],
    });
    const badStatus = rule({
      conditions: [{ field: 'attendanceStatus', operator: 'equals', value: 'partial' }],
      pollConditions: [{ question: 'Which plan?', operator: 'equals', answer: 'Pro' }],
    });
    const badPoll = rule({
      conditions: [{ field: 'attendanceStatus', operator: 'equals', value: 'attended' }],
      pollConditions: [{ question: 'Which plan?', operator: 'equals', answer: 'Starter' }],
    });

    expect(workflowRuleMatches(good, ctx, b)).toBe(true);
    expect(workflowRuleMatches(badStatus, ctx, b)).toBe(false);
    expect(workflowRuleMatches(badPoll, ctx, b)).toBe(false);
  });

  it('uses the first enabled match and skips disabled rules', () => {
    const rules = [
      rule({ id: 'disabled', enabled: false, workflowId: 'wf-disabled' }),
      rule({
        id: 'first',
        conditions: [{ field: 'attendanceStatus', operator: 'equals', value: 'attended' }],
        workflowId: 'wf-first',
      }),
      rule({ id: 'second', workflowId: 'wf-second' }),
    ];

    expect(firstMatchingWorkflowRule(rules, ctx, b)?.id).toBe('first');
  });

  it('allows a catch-all rule with no conditions', () => {
    expect(workflowRuleMatches(rule(), ctx, b)).toBe(true);
    expect(firstMatchingWorkflowRule([rule()], {}, undefined)?.workflowId).toBe('wf-pro');
  });

  it('ignores a rule without a workflow id', () => {
    expect(workflowRuleMatches(rule({ workflowId: '  ' }), ctx, b)).toBe(false);
  });
});

describe('validateAiWorkflowResponse', () => {
  const ids = new Set(['p1', 'p2']);
  const workflows = new Set(['wf-a', 'wf-b']);

  it('drops unknown ids and workflows', () => {
    const out = validateAiWorkflowResponse(
      {
        assignments: [
          { id: 'p1', workflowId: 'wf-a', confidence: 0.9 },
          { id: 'p9', workflowId: 'wf-a', confidence: 0.9 },
          { id: 'p2', workflowId: 'wf-nope', confidence: 0.9 },
        ],
      },
      ids,
      workflows,
      0.7,
    );

    expect(out.choices).toHaveLength(1);
    expect(out.choices[0]).toMatchObject({ id: 'p1', workflowId: 'wf-a', eligible: true });
    expect(out.rejected.join(' ')).toContain('p9');
    expect(out.rejected.join(' ')).toContain('wf-nope');
  });

  it('marks low-confidence proposals ineligible but keeps them for review', () => {
    const out = validateAiWorkflowResponse(
      { assignments: [{ id: 'p1', workflowId: 'wf-a', confidence: 0.4, reason: 'weak' }] },
      ids,
      workflows,
      0.7,
    );

    expect(out.choices[0]).toMatchObject({ eligible: false, confidence: 0.4, reason: 'weak' });
  });

  it('accepts null for "no clear fit" and deduplicates by highest confidence', () => {
    const out = validateAiWorkflowResponse(
      {
        assignments: [
          { id: 'p1', workflowId: null, confidence: 0.2 },
          { id: 'p2', workflowId: 'wf-a', confidence: 0.5 },
          { id: 'p2', workflowId: 'wf-b', confidence: 0.8 },
        ],
      },
      ids,
      workflows,
      0.7,
    );

    expect(out.choices.find((c) => c.id === 'p1')).toMatchObject({ workflowId: null, eligible: false });
    expect(out.choices.find((c) => c.id === 'p2')).toMatchObject({ workflowId: 'wf-b', eligible: true });
  });

  it('reports a non-list response instead of crashing', () => {
    const out = validateAiWorkflowResponse({ nope: true }, ids, workflows, 0.7);
    expect(out.choices).toEqual([]);
    expect(out.rejected.join(' ')).toContain('no assignments');
  });
});

describe('buildWorkflowAiPrompt', () => {
  it('includes anonymous behavior but no email or name', () => {
    const prompt = buildWorkflowAiPrompt({
      sessionTitle: 'Launch',
      sessionType: 'webinar',
      sessionDate: '2026-01-01T10:00:00.000Z',
      workflows: [{ workflowId: 'wf-pro', name: 'Pro buyers', criteria: 'Plan is Pro' }],
      attendees: [
        {
          id: 'p1',
          segment: 'attended',
          status: 'attended',
          minutes: 45,
          behavior: behavior(),
        },
      ],
    });

    expect(prompt).toContain('wf-pro');
    expect(prompt).toContain('Which plan?');
    expect(prompt).not.toContain('ada@example.com');
    expect(prompt).not.toContain('Ada Lovelace');
  });
});
