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

export const INTEGRATION_CATALOG: IntegrationCatalog[] = [
  {
    key: 'google_calendar',
    label: 'Google Calendar RSVP',
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
];

export function getIntegrationCatalog(): IntegrationCatalog[] {
  return INTEGRATION_CATALOG;
}

export function getCatalogField(fieldKey: ConditionField): CatalogField | undefined {
  for (const integration of INTEGRATION_CATALOG) {
    const field = integration.fields.find((f) => f.key === fieldKey);
    if (field) return field;
  }
  return undefined;
}
