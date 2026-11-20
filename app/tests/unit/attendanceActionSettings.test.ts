import { describe, expect, it } from 'vitest';
import { parseAttendanceActionSettings } from '../../src/domain/attendanceActionSettings';
import type { AttendanceActionSnapshot } from '../../src/domain/connection';

const existing: AttendanceActionSnapshot = {
  deliveryMode: 'both',
  workflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
  workflowRules: [
    { id: 'r1', name: 'Attended', enabled: true, conditions: [], workflowId: 'flow-1' },
  ],
  aiWorkflow: { enabled: false, mode: 'preview', confidenceThreshold: 0.7, maxAttendees: 25 },
  rules: [],
  roster: { url: 'https://example.com/report', shape: 'flat' },
  rosterTokenSealed: 'sealed-token',
  copiedFromConnectionId: 'conn-1',
  updatedAt: 1,
};

describe('per-call attendance action validation', () => {
  it('accepts a full call action payload', () => {
    const parsed = parseAttendanceActionSettings(
      {
        attendanceDeliveryMode: 'api',
        attendanceTags: { attended: ' attended ', partial: '' },
        attendanceCustomFieldId: ' field-1 ',
        attendanceWorkflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
        attendanceWorkflowRules: [
          { id: 'r1', name: 'Attended', enabled: true, conditions: [], workflowId: 'flow-1' },
        ],
        attendanceAiWorkflow: { enabled: true, mode: 'auto', confidenceThreshold: 0.8, maxAttendees: 10 },
        attendanceRules: [],
        attendanceRoster: { url: 'https://example.com/new-report', shape: 'segments', token: '' },
      },
      existing,
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.deliveryMode).toBe('api');
    expect(parsed.value.tags).toEqual({ attended: 'attended' });
    expect(parsed.value.customFieldId).toBe('field-1');
    expect(parsed.value.roster?.shape).toBe('segments');
  });

  it('rejects a rule that points outside the call workflow list', () => {
    const parsed = parseAttendanceActionSettings(
      {
        attendanceWorkflows: [{ id: 'w1', workflowId: 'flow-1', name: 'Workflow one' }],
        attendanceWorkflowRules: [
          { id: 'r1', name: 'Missing', enabled: true, conditions: [], workflowId: 'flow-2' },
        ],
      },
      existing,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('not in the list');
  });

  it('rejects an unsafe report webhook URL', () => {
    const parsed = parseAttendanceActionSettings(
      { attendanceRoster: { url: 'javascript:alert(1)' } },
      existing,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('http');
  });

  it('allows clearing every tag', () => {
    const parsed = parseAttendanceActionSettings({ attendanceTags: {} }, existing);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tags).toBeUndefined();
  });

  it('preserves existing values when the patch omits them', () => {
    const parsed = parseAttendanceActionSettings({}, existing);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workflows).toHaveLength(1);
    expect(parsed.value.workflowRules).toHaveLength(1);
    expect(parsed.value.roster?.url).toBe('https://example.com/report');
    expect(parsed.value.rosterToken).toBeUndefined();
  });
});
