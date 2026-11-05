import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import {
  normalizeFollowUp,
  normalizeNote,
  type CampaignCrmNote,
} from './campaignNotes';

function parseNote(raw: string | undefined): CampaignCrmNote | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const followUp = normalizeFollowUp(value.followUp) ?? 'none';
    const note = normalizeNote(value.note) ?? '';
    return {
      followUp,
      note,
      ...(typeof value.updatedAt === 'number' ? { updatedAt: value.updatedAt } : {}),
      ...(typeof value.updatedBy === 'string' ? { updatedBy: value.updatedBy } : {}),
    };
  } catch {
    return null;
  }
}

export async function getCampaignCrmNotes(campaignId: string): Promise<Record<string, CampaignCrmNote>> {
  const raw = await redis.hgetall(REDIS_KEYS.campaignCrmNotes(campaignId));
  const out: Record<string, CampaignCrmNote> = {};
  for (const [key, json] of Object.entries(raw || {})) {
    const note = parseNote(json);
    if (note) out[key] = note;
  }
  return out;
}

export async function saveCampaignCrmNote(
  campaignId: string,
  personKey: string,
  note: CampaignCrmNote,
): Promise<CampaignCrmNote> {
  const record: CampaignCrmNote = {
    followUp: note.followUp,
    note: note.note,
    updatedAt: note.updatedAt ?? Date.now(),
    updatedBy: note.updatedBy || 'panel',
  };
  await redis.hset(REDIS_KEYS.campaignCrmNotes(campaignId), personKey, JSON.stringify(record));
  return record;
}

export async function deleteCampaignCrmNote(campaignId: string, personKey: string): Promise<void> {
  await redis.hdel(REDIS_KEYS.campaignCrmNotes(campaignId), personKey);
}
