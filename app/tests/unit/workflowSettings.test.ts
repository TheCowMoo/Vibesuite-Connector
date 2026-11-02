import { describe, it, expect } from 'vitest';
import { parseWorkflowSettings } from '../../src/domain/workflowSettings';

function target(over: Record<string, unknown> = {}) {
  return { id: 'w1', workflowId: 'wf-1', name: 'Pro buyers', ...over };
}

function rule(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    name: 'Pro plan',
    enabled: true,
    conditions: [],
    pollConditions: [{ question: 'Which plan?', operator: 'equals', answer: 'Pro' }],
    workflowId: 'wf-1',
    ...over,
  };
}

const ai = { enabled: true, mode: 'preview', confidenceThreshold: 0.7, maxAttendees: 0 };

describe('parseWorkflowSettings', () => {
  it('accepts a target, a matching rule and AI settings', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target()],
      attendanceWorkflowRules: [rule()],
      attendanceAiWorkflow: ai,
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.attendanceWorkflows).toHaveLength(1);
      expect(out.value.attendanceWorkflowRules).toHaveLength(1);
      expect(out.value.attendanceAiWorkflow?.mode).toBe('preview');
    }
  });

  it('rejects a rule that points outside the workflow list', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target()],
      attendanceWorkflowRules: [rule({ workflowId: 'wf-other' })],
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain('not in the list');
  });

  it('rejects duplicate workflow ids', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target(), target({ id: 'w2' })],
    });

    expect(out.ok).toBe(false);
  });

  it('requires an answer for a comparison poll condition', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target()],
      attendanceWorkflowRules: [rule({ pollConditions: [{ question: 'Which plan?', operator: 'equals' }] })],
    });

    expect(out.ok).toBe(false);
  });

  it('allows answered / not_answered without an answer', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target()],
      attendanceWorkflowRules: [
        rule({
          pollConditions: [
            { question: 'Which plan?', operator: 'answered' },
            { question: 'Team size?', operator: 'not_answered' },
          ],
        }),
      ],
    });

    expect(out.ok).toBe(true);
  });

  it('rejects an out-of-range confidence threshold', () => {
    const out = parseWorkflowSettings({
      attendanceWorkflows: [target()],
      attendanceAiWorkflow: { ...ai, confidenceThreshold: 1.5 },
    });

    expect(out.ok).toBe(false);
  });

  it('accepts an empty workflow list and no rules', () => {
    const out = parseWorkflowSettings({ attendanceWorkflows: [], attendanceWorkflowRules: [] });
    expect(out.ok).toBe(true);
  });
});
