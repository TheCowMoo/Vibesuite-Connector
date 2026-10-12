import type { AutomationRule, Condition } from './connection';

export interface ConditionContext {
  [key: string]: string | undefined;
}

function fieldValue(ctx: ConditionContext, field: string): string {
  return ctx[field] ?? '';
}

function num(v: string): number {
  return Number(v);
}

export function matchesCondition(cond: Condition, ctx: ConditionContext): boolean {
  const actual = fieldValue(ctx, cond.field);
  const expected = cond.value ?? '';

  switch (cond.operator) {
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return actual.toLowerCase().includes(expected.toLowerCase());
    case 'starts_with':
      return actual.toLowerCase().startsWith(expected.toLowerCase());
    case 'ends_with':
      return actual.toLowerCase().endsWith(expected.toLowerCase());
    case 'is_empty':
      return actual.trim() === '';
    case 'not_empty':
      return actual.trim() !== '';
    case 'greater_than':
      return expected !== '' && actual !== '' && Number.isFinite(num(actual)) && Number.isFinite(num(expected)) && num(actual) > num(expected);
    case 'greater_or_equal':
      return expected !== '' && actual !== '' && Number.isFinite(num(actual)) && Number.isFinite(num(expected)) && num(actual) >= num(expected);
    case 'less_than':
      return expected !== '' && actual !== '' && Number.isFinite(num(actual)) && Number.isFinite(num(expected)) && num(actual) < num(expected);
    case 'less_or_equal':
      return expected !== '' && actual !== '' && Number.isFinite(num(actual)) && Number.isFinite(num(expected)) && num(actual) <= num(expected);
    default:
      return false;
  }
}

export function ruleMatches(rule: AutomationRule, ctx: ConditionContext): boolean {
  if (!rule.enabled) return false;
  if (!rule.webhookUrl) return false;
  if (!rule.conditions || rule.conditions.length === 0) return false;
  return rule.conditions.every((c) => matchesCondition(c, ctx));
}

export function matchingRules(rules: AutomationRule[] | undefined, ctx: ConditionContext): AutomationRule[] {
  if (!rules || rules.length === 0) return [];
  return rules.filter((r) => ruleMatches(r, ctx));
}
