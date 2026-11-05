import type { CampaignCrmRow } from './campaignCrm';
import type { RsvpHistoryEntry } from './rsvpHistory';
import type { ExportRow, ExportTable } from './statsExport';

function iso(value?: number): string {
  return value ? new Date(value).toISOString() : '';
}

function rsvpLabel(row: CampaignCrmRow): string {
  switch (row.rsvp) {
    case 'accepted':
      return 'Yes';
    case 'declined':
      return 'No';
    case 'tentative':
      return 'Maybe';
    case 'needsAction':
      return 'No reply';
    default:
      return 'Not sent';
  }
}

function zoomLabel(row: CampaignCrmRow): string {
  switch (row.zoom) {
    case 'attended':
      return 'Attended';
    case 'partial':
      return 'Brief visit';
    case 'didnt_join':
      return "Didn't join";
    case 'walk_in':
      return 'Walk-in';
    case 'not_invited':
      return 'Not invited';
    default:
      return 'Not tracked';
  }
}

function sendLabel(row: CampaignCrmRow): string {
  if (row.sendStatus === 'sent') return 'Sent';
  if (row.sendStatus === 'failed') return 'Failed';
  if (row.sendStatus === 'walk_in') return 'Walk-in';
  return 'Waiting';
}

function followUpLabel(row: CampaignCrmRow): string {
  switch (row.note?.followUp) {
    case 'todo':
      return 'To contact';
    case 'contacted':
      return 'Contacted';
    case 'done':
      return 'Done';
    default:
      return 'None';
  }
}

function historyStatusLabel(status: RsvpHistoryEntry['status']): string {
  if (status === 'accepted') return 'Yes';
  if (status === 'declined') return 'No';
  if (status === 'tentative') return 'Maybe';
  return 'No reply';
}

function historyText(entries: RsvpHistoryEntry[]): string {
  return [...entries]
    .sort((a, b) => a.at - b.at)
    .map((entry) => `${historyStatusLabel(entry.status)}@${iso(entry.at)}${entry.initial ? ' (started)' : ''}`)
    .join('; ');
}

function answers(entries: Array<{ question: string; answer?: string }> | undefined, arrow = ':'): string {
  return (entries || [])
    .filter((entry) => entry.question)
    .map((entry) => `${entry.question}${arrow} ${entry.answer ?? ''}`.trim())
    .join('; ');
}

function sharedFlags(row: CampaignCrmRow): string {
  const flags: string[] = [];
  if (row.behavior?.shareDesktop) flags.push('desktop');
  if (row.behavior?.shareApplication) flags.push('application');
  return flags.join(', ');
}

export function buildCampaignCrmTable(rows: CampaignCrmRow[], campaignName: string): ExportTable {
  const columns = [
    { key: 'campaign', label: 'Campaign' },
    { key: 'name', label: 'Name' },
    { key: 'email', label: 'Email' },
    { key: 'company', label: 'Company' },
    { key: 'phone', label: 'Phone' },
    { key: 'walkIn', label: 'Walk-in' },
    { key: 'rsvp', label: 'RSVP' },
    { key: 'rsvpHistory', label: 'RSVP history' },
    { key: 'zoom', label: 'Zoom result' },
    { key: 'sender', label: 'Sending account' },
    { key: 'variant', label: 'Copy variant' },
    { key: 'sendStatus', label: 'Send status' },
    { key: 'sentAt', label: 'Sent at' },
    { key: 'eventId', label: 'Google event id' },
    { key: 'sendError', label: 'Send error' },
    { key: 'joinedAt', label: 'Joined at' },
    { key: 'leftAt', label: 'Left at' },
    { key: 'durationMin', label: 'Minutes' },
    { key: 'engagement', label: 'Engagement' },
    { key: 'joinedLate', label: 'Joined late (min)' },
    { key: 'leftEarly', label: 'Left early (min)' },
    { key: 'attendedPct', label: 'Attended (%)' },
    { key: 'polls', label: 'Poll answers' },
    { key: 'qa', label: 'Q&A' },
    { key: 'registration', label: 'Registration answers' },
    { key: 'device', label: 'Device' },
    { key: 'location', label: 'Location' },
    { key: 'network', label: 'Network' },
    { key: 'camera', label: 'Camera' },
    { key: 'microphone', label: 'Microphone' },
    { key: 'shared', label: 'Shared' },
    { key: 'followUp', label: 'Follow-up' },
    { key: 'note', label: 'Note' },
    { key: 'noteUpdatedAt', label: 'Note updated at' },
    { key: 'noteUpdatedBy', label: 'Note updated by' },
  ];

  const out: ExportRow[] = rows.map((row) => ({
    campaign: campaignName,
    name: row.name ?? '',
    email: row.email ?? '',
    company: row.company ?? '',
    phone: row.phone ?? '',
    walkIn: row.walkIn ? 'Yes' : 'No',
    rsvp: rsvpLabel(row),
    rsvpHistory: historyText(row.rsvpHistory),
    zoom: zoomLabel(row),
    sender: row.senderName ?? '',
    variant: row.variant ?? '',
    sendStatus: sendLabel(row),
    sentAt: iso(row.sentAt),
    eventId: row.eventId ?? '',
    sendError: row.sendError ?? '',
    joinedAt: row.joinedAt ?? '',
    leftAt: row.leftAt ?? '',
    durationMin: row.durationSec === undefined ? '' : Math.round(row.durationSec / 60),
    engagement: row.attentivenessScore ?? '',
    joinedLate: row.behavior?.joinedLateMinutes ?? '',
    leftEarly: row.behavior?.leftEarlyMinutes ?? '',
    attendedPct: row.behavior?.attendedPortionPct ?? '',
    polls: answers(row.behavior?.pollAnswers),
    qa: answers(row.behavior?.qa, ' ->'),
    registration: answers(row.behavior?.registrationAnswers),
    device: row.behavior?.device ?? '',
    location: row.behavior?.location ?? '',
    network: row.behavior?.networkType ?? '',
    camera: row.behavior?.camera ?? '',
    microphone: row.behavior?.microphone ?? '',
    shared: sharedFlags(row),
    followUp: followUpLabel(row),
    note: row.note?.note ?? '',
    noteUpdatedAt: iso(row.note?.updatedAt),
    noteUpdatedBy: row.note?.updatedBy ?? '',
  }));

  return { columns, rows: out };
}
