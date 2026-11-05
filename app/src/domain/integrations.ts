import type { ConditionField, ConditionOperator } from './connection';

export interface CatalogField {
  key: ConditionField;
  label: string;
  operators: ConditionOperator[];
  values?: string[];
  /** Friendly labels for raw values (the stored/compared value stays `values`). */
  valueLabels?: Record<string, string>;
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
      // Per attendee
      {
        key: 'attendanceStatus',
        label: 'Attendance result',
        operators: ['equals', 'not_equals'],
        values: ['attended', 'no_show', 'partial'],
        valueLabels: { attended: 'Attended', partial: 'Brief visit', no_show: 'No-show' },
        sample: 'attended',
      },
      {
        key: 'segment',
        label: 'Result group',
        operators: ['equals', 'not_equals'],
        values: ['attended', 'partial', 'no_show', 'not_invited'],
        valueLabels: { attended: 'Attended', partial: 'Brief visit', no_show: 'No-show', not_invited: 'Walk-in' },
        sample: 'no_show',
      },
      {
        key: 'invited',
        label: 'Was invited',
        operators: ['equals', 'not_equals'],
        values: ['true', 'false'],
        sample: 'true',
      },
      {
        key: 'invitedSource',
        label: 'Invited list source',
        operators: ['equals', 'not_equals'],
        values: ['campaign', 'invitation', 'list', 'none'],
        sample: 'campaign',
      },
      { key: 'attendanceMinutes', label: 'Minutes watched', operators: NUMERIC_OPERATORS, sample: '10' },
      { key: 'durationSec', label: 'Seconds watched', operators: NUMERIC_OPERATORS, sample: '3360' },
      { key: 'attentivenessScore', label: 'Attentiveness score', operators: NUMERIC_OPERATORS, sample: '85' },
      { key: 'isGuest', label: 'Is guest', operators: ['equals', 'not_equals'], values: ['true', 'false'], sample: 'false' },
      { key: 'email', label: 'Attendee email', operators: ALL_STRING_OPERATORS, sample: 'person@example.com' },
      { key: 'name', label: 'Attendee name', operators: ALL_STRING_OPERATORS, sample: 'Jane Doe' },
      { key: 'joinedAt', label: 'Joined at', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T13:02:00Z' },
      { key: 'leftAt', label: 'Left at', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T13:58:00Z' },
      { key: 'registrantId', label: 'Registrant ID', operators: ['equals', 'contains', 'is_empty', 'not_empty'], sample: 'abc123…' },
      { key: 'userId', label: 'Zoom user ID', operators: ['equals', 'contains', 'is_empty', 'not_empty'], sample: 'abc123…' },
      { key: 'participantId', label: 'Participant ID', operators: ['equals', 'contains', 'is_empty', 'not_empty'], sample: 'abc123…' },
      { key: 'customerKey', label: 'Customer key', operators: ALL_STRING_OPERATORS, sample: 'acct-42' },
      // Session
      {
        key: 'provider',
        label: 'Video provider',
        operators: ['equals', 'not_equals'],
        values: ['zoom', 'google_meet', 'webinargeek'],
        sample: 'zoom',
      },
      { key: 'sessionType', label: 'Session type', operators: ['equals', 'not_equals'], values: ['meeting', 'webinar'], sample: 'webinar' },
      { key: 'sessionId', label: 'Session ID', operators: ['equals', 'contains', 'starts_with', 'ends_with'], sample: 'abc123…' },
      { key: 'sessionTitle', label: 'Session title', operators: ALL_STRING_OPERATORS, sample: 'Product webinar' },
      { key: 'sessionStart', label: 'Session start', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T13:00:00Z' },
      { key: 'sessionEnd', label: 'Session end', operators: ALL_STRING_OPERATORS, sample: '2026-10-08T14:00:00Z' },
      { key: 'sessionDurationMin', label: 'Session duration (min)', operators: NUMERIC_OPERATORS, sample: '60' },
      { key: 'sessionTotalMinutes', label: 'Total participant-minutes', operators: NUMERIC_OPERATORS, sample: '3120' },
      { key: 'sessionParticipantsCount', label: 'Participants count', operators: NUMERIC_OPERATORS, sample: '98' },
      { key: 'sessionHostEmail', label: 'Host email', operators: ALL_STRING_OPERATORS, sample: 'host@example.com' },
      { key: 'sessionDept', label: 'Host department', operators: ALL_STRING_OPERATORS, sample: 'Marketing' },
      // Report rollups
      { key: 'invitedCount', label: 'Invited count', operators: NUMERIC_OPERATORS, sample: '142' },
      { key: 'attendedCount', label: 'Attended count', operators: NUMERIC_OPERATORS, sample: '98' },
      { key: 'attendedFullCount', label: 'Fully attended count', operators: NUMERIC_OPERATORS, sample: '65' },
      { key: 'partialCount', label: 'Partial count', operators: NUMERIC_OPERATORS, sample: '33' },
      { key: 'notInvitedCount', label: 'Not-invited count', operators: NUMERIC_OPERATORS, sample: '17' },
      { key: 'noShowCount', label: 'No-show count', operators: NUMERIC_OPERATORS, sample: '44' },
      { key: 'registrantCount', label: 'Registrant count', operators: NUMERIC_OPERATORS, sample: '150' },
      { key: 'absenteeCount', label: 'Absentee count', operators: NUMERIC_OPERATORS, sample: '52' },
      { key: 'attendanceRate', label: 'Attendance rate (%)', operators: NUMERIC_OPERATORS, sample: '69' },
      { key: 'pollCount', label: 'Poll questions (session)', operators: NUMERIC_OPERATORS, sample: '3' },
      { key: 'pollRespondentCount', label: 'Poll respondents', operators: NUMERIC_OPERATORS, sample: '42' },
      { key: 'pollQuestionCount', label: 'Poll questions this person saw', operators: NUMERIC_OPERATORS, sample: '3' },
      { key: 'pollAnsweredCount', label: 'Poll questions answered', operators: NUMERIC_OPERATORS, sample: '2' },
      { key: 'pollAnswerCount', label: 'Poll answers given', operators: NUMERIC_OPERATORS, sample: '2' },
      { key: 'pollAnsweredAll', label: 'Answered every poll', operators: ['equals', 'not_equals'], values: ['true', 'false'], sample: 'true' },
      { key: 'pollAnswerText', label: 'Poll answers (text)', operators: ALL_STRING_OPERATORS, sample: 'Which plan?: Pro' },
      { key: 'qaCount', label: 'Q&A entries (session)', operators: NUMERIC_OPERATORS, sample: '12' },
      { key: 'qaAskedCount', label: 'Q&A questions this person asked', operators: NUMERIC_OPERATORS, sample: '1' },
      { key: 'qaAnsweredCount', label: 'Q&A questions answered', operators: NUMERIC_OPERATORS, sample: '1' },
      { key: 'qaQuestionText', label: 'Q&A questions (text)', operators: ALL_STRING_OPERATORS, sample: 'Does it support SSO?' },
      { key: 'registrationAnswerCount', label: 'Registration answers', operators: NUMERIC_OPERATORS, sample: '2' },
      { key: 'registrationAnswerText', label: 'Registration answers (text)', operators: ALL_STRING_OPERATORS, sample: 'Company size: 50–200' },
      { key: 'joinedLateMinutes', label: 'Joined late (minutes)', operators: NUMERIC_OPERATORS, sample: '3' },
      { key: 'leftEarlyMinutes', label: 'Left early (minutes)', operators: NUMERIC_OPERATORS, sample: '5' },
      { key: 'attendedPortionPct', label: 'Attended portion (%)', operators: NUMERIC_OPERATORS, sample: '87' },
      { key: 'zoomDevice', label: 'Zoom device', operators: ALL_STRING_OPERATORS, sample: 'Mac' },
      { key: 'zoomLocation', label: 'Zoom location', operators: ALL_STRING_OPERATORS, sample: 'US' },
      { key: 'zoomNetworkType', label: 'Zoom network type', operators: ALL_STRING_OPERATORS, sample: 'Wifi' },
      { key: 'zoomMicrophone', label: 'Zoom microphone', operators: ALL_STRING_OPERATORS, sample: 'Built-in' },
      { key: 'zoomCamera', label: 'Zoom camera', operators: ALL_STRING_OPERATORS, sample: 'Built-in' },
      { key: 'zoomConnectionType', label: 'Zoom connection type', operators: ALL_STRING_OPERATORS, sample: 'UDP' },
      { key: 'zoomShareDesktop', label: 'Shared desktop', operators: ['equals', 'not_equals'], values: ['true', 'false'], sample: 'true' },
      { key: 'zoomShareApplication', label: 'Shared application', operators: ['equals', 'not_equals'], values: ['true', 'false'], sample: 'true' },
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
