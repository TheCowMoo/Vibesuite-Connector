import axios from 'axios';
import { getVideoSettings } from '../domain/videoSettings';
import type { AttendeeRecord, PollResult, ProviderFetchResult, QaEntry, SessionType, VideoProviderImpl } from './types';

const BASE = 'https://api.zoom.us/v2';

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  const settings = await getVideoSettings();
  const zoom = settings?.zoom;
  if (!zoom || !zoom.accountId || !zoom.clientId || !zoom.clientSecret) {
    throw new Error('Zoom is not configured. Set it in Settings → Video conferencing.');
  }
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) {
    return cachedToken.accessToken;
  }

  const res = await axios.post('https://zoom.us/oauth/token', null, {
    params: { grant_type: 'account_credentials', account_id: zoom.accountId },
    auth: { username: zoom.clientId, password: zoom.clientSecret },
    timeout: 20000,
  });
  const accessToken = res.data?.access_token as string | undefined;
  const expiresIn = (res.data?.expires_in as number | undefined) ?? 3600;
  if (!accessToken) throw new Error('Zoom OAuth token request returned no access_token');

  cachedToken = { accessToken, expiresAt: Date.now() + expiresIn * 1000 };
  return accessToken;
}

/** Best-effort GET: returns null on any error so one disabled feature can't break a sync. */
async function getJson(token: string, path: string, params?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  try {
    const res = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 30000,
    });
    return (res.data ?? null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

/** Page through a Zoom list endpoint, tolerating response key-name differences. */
async function fetchList(token: string, path: string, key: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let nextPageToken: string | undefined;
  let guard = 0;

  do {
    const data = await getJson(token, path, { page_size: 300, next_page_token: nextPageToken || undefined });
    if (!data) break;

    const arr = Array.isArray(data[key]) ? (data[key] as Array<Record<string, unknown>>) : [];
    if (arr.length) {
      out.push(...arr);
    } else if (out.length === 0) {
      for (const alt of ['participants', 'absentees', 'registrants', 'polls', 'questions', 'qa']) {
        if (alt !== key && Array.isArray(data[alt])) {
          out.push(...(data[alt] as Array<Record<string, unknown>>));
          break;
        }
      }
    }

    nextPageToken = (data.next_page_token as string) || undefined;
    guard += 1;
  } while (nextPageToken && guard < 25);

  return out;
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function mapParticipant(p: Record<string, unknown>): AttendeeRecord {
  return {
    email: str(p.user_email) || str(p.email),
    name: str(p.name),
    joinedAt: str(p.join_time),
    leftAt: str(p.leave_time),
    durationSec: num(p.duration),
    attentivenessScore: num(p.attentiveness_score),
    isGuest: typeof p.guest === 'boolean' ? p.guest : undefined,
    registrantId: str(p.registrant_id),
    userId: str(p.user_id),
    participantId: str(p.id),
    customerKey: str(p.customer_key),
    raw: p,
  };
}

const DETAIL_KEYS = [
  'topic',
  'start_time',
  'end_time',
  'duration',
  'total_minutes',
  'participants_count',
  'host_email',
  'dept',
  'uuid',
  'id',
  'type',
];

export const zoomProvider: VideoProviderImpl = {
  key: 'zoom',

  async fetch(externalId: string, sessionType: SessionType = 'meeting'): Promise<ProviderFetchResult> {
    const token = await getAccessToken();
    const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
    const enc = encodeURIComponent(externalId);

    const participantsRaw = await fetchList(token, `/report/${seg}/${enc}/participants`, 'participants');
    const attendees = participantsRaw.map(mapParticipant);

    const absenteesRaw = await fetchList(token, `/report/${seg}/${enc}/absentees`, 'absentees');
    const absentees = absenteesRaw.map((a) => (str(a.user_email) || str(a.email) || '').toLowerCase()).filter(Boolean);

    const registrantsRaw = await fetchList(token, `/${seg}/${enc}/registrants`, 'registrants');

    const details = await getJson(token, `/report/${seg}/${enc}`);
    const sessionStats: Record<string, string> = {};
    if (details) {
      for (const k of DETAIL_KEYS) {
        const v = details[k];
        if (v !== undefined && v !== null && v !== '') sessionStats[k] = String(v);
      }
    }

    const pollsRaw = await fetchList(token, `/report/${seg}/${enc}/polls`, 'polls');
    const qaRaw = await fetchList(token, `/report/${seg}/${enc}/qa`, 'questions');

    return {
      attendees,
      absentees,
      registrants: registrantsRaw.length,
      sessionStats,
      polls: pollsRaw as unknown as PollResult[],
      qa: qaRaw as unknown as QaEntry[],
    };
  },

  async test() {
    try {
      const token = await getAccessToken();
      await axios.get(`${BASE}/users/me`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
      return { ok: true };
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      return { ok: false, detail: e?.response?.data?.message || e?.message || 'unknown error' };
    }
  },
};

