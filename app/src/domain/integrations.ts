import type { ConditionField, ConditionOperator } from './connection';

export interface CatalogField {
  key: ConditionField;
  label: string;
  operators: ConditionOperator[];
  values?: string[];
  sample?: string;
}

export interface IntegrationCatalog {
  key: string;
  label: string;
  scope: 'calendar' | 'attendance';
  fields: CatalogField[];
}

const ALL_STRING_OPERATORS: ConditionOperator[] = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'ends_with',
  'is_empty',
  'not_empty',
];

const NUMERIC_OPERATORS: ConditionOperator[] = ['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal'];

export const INTEGRATION_CATALOG: IntegrationCatalog[] = [
  {
    key: 'google_calendar',
    label: 'Google Calendar RSVP',
    scope: 'calendar',
    fields: [
      {
        key: 'responseStatus',
        label: 'Response status',
        operators: ['equals', 'not_equals'],
        values: ['accepted', 'tentative', 'declined', 'needsAction'],
        sample: 'accepted',
      },
      { key: 'email', label: 'Attendee email', operators: ALL_STRING_OPERATORS, sample: 'person@example.com' },
      { key: 'eventSummary', label: 'Event summary', operators: ALL_STRING_OPERATORS, sample: 'Webinar — Q3 launch' },
      { key: 'eventId', label: 'Event ID', operators: ['equals', 'contains', 'starts_with', 'ends_with'], sample: 'abc123…' },
      { key: 'calendarId', label: 'Calendar ID', operators: ['equals', 'contains'], sample: 'owner@domain.com' },
    ],
  },
  {
    key: 'video_attendance',
    label: 'Video attendance',
    scope: 'attendance',
    fields: [
      {
        key: 'attendanceStatus',
        label: 'Attendance status',
        operators: ['equals', 'not_equals'],
        values: ['attended', 'no_show', 'partial'],
        sample: 'attended',
      },
      {
        key: 'attendanceMinutes',
        label: 'Minutes watched',
        operators: NUMERIC_OPERATORS,
        sample: '10',
      },
      {
        key: 'provider',
        label: 'Video provider',
        operators: ['equals', 'not_equals'],
        values: ['zoom', 'google_meet', 'webinargeek'],
        sample: 'zoom',
      },
      { key: 'sessionTitle', label: 'Session title', operators: ALL_STRING_OPERATORS, sample: 'Product webinar' },
      { key: 'sessionId', label: 'Session ID', operators: ['equals', 'contains', 'starts_with', 'ends_with'], sample: 'abc123…' },
      { key: 'joinedAt', label: 'Joined at', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T13:02:00Z' },
      { key: 'leftAt', label: 'Left at', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T13:58:00Z' },
      { key: 'email', label: 'Attendee email', operators: ALL_STRING_OPERATORS, sample: 'person@example.com' },
    ],
  },
];

export function getIntegrationCatalog(): IntegrationCatalog[] {
  return INTEGRATION_CATALOG;
}

export function getCatalogField(fieldKey: ConditionField, scope?: 'calendar' | 'attendance'): CatalogField | undefined {
  const entries = scope ? INTEGRATION_CATALOG.filter((i) => i.scope === scope) : INTEGRATION_CATALOG;
  for (const integration of entries) {
    const field = integration.fields.find((f) => f.key === fieldKey);
    if (field) return field;
  }
  return undefined;
}
