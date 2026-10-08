import { describe, it, expect } from 'vitest';
import { matchesCondition, ruleMatches, matchingRules, type ConditionContext } from '../../src/domain/condition';
import type { AutomationRule } from '../../src/domain/connection';

const ctx: ConditionContext = {
  responseStatus: 'accepted',
  email: 'person@example.com',
  eventSummary: 'Webinar — Q3 launch',
  eventId: 'abc123',
  calendarId: 'owner@domain.com',
};

function rule(partial: Partial<AutomationRule>): AutomationRule {
  return {
    id: 'r1',
    name: 'test',
    enabled: true,
    conditions: [],
    webhookUrl: 'https://example.com/hook',
    ...partial,
  };
}

describe('matchesCondition', () => {
  it('equals', () => {
    expect(matchesCondition({ field: 'responseStatus', operator: 'equals', value: 'accepted' }, ctx)).toBe(true);
    expect(matchesCondition({ field: 'responseStatus', operator: 'equals', value: 'declined' }, ctx)).toBe(false);
  });

  it('not_equals', () => {
    expect(matchesCondition({ field: 'responseStatus', operator: 'not_equals', value: 'declined' }, ctx)).toBe(true);
  });

  it('contains (case-insensitive)', () => {
    expect(matchesCondition({ field: 'eventSummary', operator: 'contains', value: 'webinar' }, ctx)).toBe(true);
    expect(matchesCondition({ field: 'eventSummary', operator: 'contains', value: 'conference' }, ctx)).toBe(false);
  });

  it('starts_with / ends_with', () => {
    expect(matchesCondition({ field: 'email', operator: 'starts_with', value: 'person' }, ctx)).toBe(true);
    expect(matchesCondition({ field: 'email', operator: 'ends_with', value: 'example.com' }, ctx)).toBe(true);
  });

  it('is_empty / not_empty', () => {
    expect(matchesCondition({ field: 'email', operator: 'not_empty' }, ctx)).toBe(true);
    expect(matchesCondition({ field: 'email', operator: 'is_empty' }, ctx)).toBe(false);
  });
});

describe('ruleMatches / matchingRules', () => {
  it('matches when all conditions match', () => {
    const r = rule({
      conditions: [
        { field: 'responseStatus', operator: 'equals', value: 'accepted' },
        { field: 'eventSummary', operator: 'contains', value: 'webinar' },
      ],
    });
    expect(ruleMatches(r, ctx)).toBe(true);
    expect(matchingRules([r], ctx)).toHaveLength(1);
  });

  it('does not match when any condition fails', () => {
    const r = rule({
      conditions: [
        { field: 'responseStatus', operator: 'equals', value: 'accepted' },
        { field: 'eventSummary', operator: 'contains', value: 'conference' },
      ],
    });
    expect(matchingRules([r], ctx)).toHaveLength(0);
  });

  it('skips disabled rules', () => {
    const r = rule({ enabled: false, conditions: [{ field: 'responseStatus', operator: 'equals', value: 'accepted' }] });
    expect(matchingRules([r], ctx)).toHaveLength(0);
  });

  it('requires a webhook url and at least one condition', () => {
    expect(matchingRules([rule({ webhookUrl: '', conditions: [{ field: 'responseStatus', operator: 'equals', value: 'accepted' }] })], ctx)).toHaveLength(0);
    expect(matchingRules([rule({ conditions: [] })], ctx)).toHaveLength(0);
  });
});
