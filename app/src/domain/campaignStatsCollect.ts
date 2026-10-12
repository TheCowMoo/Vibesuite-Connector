import { normalizeEmail } from './attendance';
import { getAttendance } from './attendanceStore';
import { getRecipients } from './campaignStore';
import { stateStore } from './stateStore';
import { buildCampaignStats, type CampaignStats, type StatsInput } from './campaignStats';
import type { Campaign } from './campaign';

/**
 * Gather everything a campaign's funnel needs — frozen recipients, the RSVP state of
 * each mailbox that actually sent, and the linked session's attendance — then reduce it.
 * Kept separate from `campaignStats.ts` so the pure reducer stays free of Redis imports.
 */
export async function collectCampaignStats(camp: Campaign): Promise<CampaignStats> {
  const recipients = await getRecipients(camp.id);

  const rsvpByConnection: StatsInput['rsvpByConnection'] = {};
  const connectionIds = Array.from(new Set(recipients.map((r) => r.connectionId)));
  for (const connectionId of connectionIds) {
    const states = await stateStore.getStates(connectionId);
    const perEvent: Record<string, Record<string, string>> = {};
    for (const [eventId, map] of states) perEvent[eventId] = map;
    rsvpByConnection[connectionId] = perEvent;
  }

  const attendance = camp.sessionId ? await getAttendance(camp.sessionId) : null;
  let attendanceByEmail: Record<string, boolean> | undefined;
  if (attendance) {
    attendanceByEmail = {};
    for (const person of attendance.attended) {
      if (person.email) attendanceByEmail[normalizeEmail(person.email)] = true;
    }
    for (const email of attendance.noShow) attendanceByEmail[normalizeEmail(email)] = false;
  }

  return buildCampaignStats({ recipients, rsvpByConnection, attendanceByEmail });
}
