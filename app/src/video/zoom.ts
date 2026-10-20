import axios from 'axios';
import { getConnection, saveConnection } from '../domain/connectionStore';
import { getVideoSettings } from '../domain/videoSettings';
import { refreshZoomToken, isInvalidGrant, zoomErrorDetail } from '../oauth/zoomOAuth';
import {
  chooseZoomTokenSource,
  defaultZoomAuthMode,
  expiryFrom,
  pickZoomAccount,
  tokenUsable,
  withoutZoomToken,
  type ZoomTokenSource,
} from './zoomAuth';
import type {
  AttendeeRecord,
  PollResult,
  ProviderFetchResult,
  QaEntry,
  SessionType,
  VideoAuthContext,
  VideoProviderImpl,
} from './types';

const BASE = 'https://api.zoom.us/v2';

/**
 * Tokens are cached per identity, not globally: with per-connection Zoom auth a single shared slot
 * would hand one tenant's user token to another tenant's request.
 */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function cacheKey(source: ZoomTokenSource, ctx?: VideoAuthContext): string {
  return source.kind === 'user' ? `user:${ctx?.connectionId ?? ''}:${source.userId}` : 's2s';
}

async function getAccessToken(ctx?: VideoAuthContext): Promise<string> {
  const settings = await getVideoSettings();
  const conn = ctx?.connectionId ? await getConnection(ctx.connectionId) : null;

  const source = chooseZoomTokenSource({
    mode: defaultZoomAuthMode(settings.zoomAuthMode),
    requestedUserId: ctx?.zoomUserId,
    accounts: conn?.zoomAccounts,
    tokens: conn?.zoomTokens,
    s2sConfigured: !!(settings.zoom?.accountId && settings.zoom.clientId && settings.zoom.clientSecret),
    now: Date.now(),
  });
  if (source.kind === 'error') throw new Error(source.error);

  const key = cacheKey(source, ctx);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.accessToken;

  if (source.kind === 's2s') {
    const zoom = settings.zoom!;
    const res = await axios.post('https://zoom.us/oauth/token', null, {
      params: { grant_type: 'account_credentials', account_id: zoom.accountId },
      auth: { username: zoom.clientId, password: zoom.clientSecret },
      timeout: 20000,
    });
    const accessToken = res.data?.access_token as string | undefined;
    const expiresAt = expiryFrom(Date.now(), res.data?.expires_in as number | undefined);
    if (!accessToken) throw new Error('Zoom OAuth token request returned no access_token');

    tokenCache.set(key, { accessToken, expiresAt });
    return accessToken;
  }

  // A still-valid access token from the authorisation itself saves a refresh round-trip.
  if (source.accessToken && tokenUsable(source.expiresAt, Date.now())) {
    tokenCache.set(key, { accessToken: source.accessToken, expiresAt: source.expiresAt! });
    return source.accessToken;
  }

  try {
    const tokens = await refreshZoomToken(source.refreshToken);
    const expiresAt = expiryFrom(Date.now(), tokens.expires_in);
    tokenCache.set(key, { accessToken: tokens.access_token, expiresAt });

    if (conn && ctx?.connectionId) {
      conn.zoomTokens = {
        ...(conn.zoomTokens ?? {}),
        [source.userId]: {
          // Zoom may rotate the refresh token; keep the new one when it does.
          refreshToken: tokens.refresh_token || source.refreshToken,
          accessToken: tokens.access_token,
          expiresAt,
        },
      };
      conn.updatedAt = Date.now();
      await saveConnection(conn);
    }

    return tokens.access_token;
  } catch (err) {
    if (isInvalidGrant(err)) {
      // The authorisation is gone for good — drop it so the UI can say "reconnect" instead of
      // retrying a dead token on every sync.
      if (conn && ctx?.connectionId) {
        conn.zoomTokens = withoutZoomToken(conn.zoomTokens, source.userId);
        conn.updatedAt = Date.now();
        await saveConnection(conn);
      }
      throw new Error(`Zoom needs reconnecting for ${source.email}`);
    }
    throw new Error(`Zoom token refresh failed: ${zoomErrorDetail(err)}`);
  }
}

/** Remember what Zoom allowed, so we stop probing on every sync. Best-effort by design. */
async function rememberReportAccess(
  ctx: VideoAuthContext | undefined,
  access: 'granted' | 'denied',
): Promise<void> {
  if (!ctx?.connectionId) return;
  try {
    const conn = await getConnection(ctx.connectionId);
    if (!conn) return;

    const accounts = conn.zoomAccounts ?? [];
    const target = pickZoomAccount(accounts, ctx.zoomUserId).account;
    if (!target || target.reportAccess === access) return;

    target.reportAccess = access;
    conn.zoomAccounts = accounts;
    conn.updatedAt = Date.now();
    await saveConnection(conn);
  } catch {
    /* never let bookkeeping break a sync */
  }
}

/**
 * Best-effort GET that keeps the status code.
 *
 * The status is what distinguishes "this authorisation may not read reports" (401/403, expected for a
 * non-admin host) from "that meeting does not exist yet" (404) — without it both look like `null`.
 */
async function getJsonResult(
  token: string,
  path: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 30000,
    });
    return { status: res.status, data: (res.data ?? null) as Record<string, unknown> | null };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
    return { status, data: null };
  }
}

/** Best-effort GET: returns null on any error so one disabled feature can't break a sync. */
async function getJson(token: string, path: string, params?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  return (await getJsonResult(token, path, params)).data;
}

/** Page through a Zoom list endpoint, tolerating response key-name differences. */
async function fetchListResult(
  token: string,
  path: string,
  key: string,
): Promise<{ status: number; rows: Array<Record<string, unknown>> }> {
  const rows: Array<Record<string, unknown>> = [];
  let nextPageToken: string | undefined;
  let guard = 0;
  let status = 0;

  do {
    const res = await getJsonResult(token, path, { page_size: 300, next_page_token: nextPageToken || undefined });
    status = res.status;
    const data = res.data;
    if (!data) break;

    const arr = Array.isArray(data[key]) ? (data[key] as Array<Record<string, unknown>>) : [];
    if (arr.length) {
      rows.push(...arr);
    } else if (rows.length === 0) {
      for (const alt of ['participants', 'absentees', 'registrants', 'polls', 'questions', 'qa']) {
        if (alt !== key && Array.isArray(data[alt])) {
          rows.push(...(data[alt] as Array<Record<string, unknown>>));
          break;
        }
      }
    }

    nextPageToken = (data.next_page_token as string) || undefined;
    guard += 1;
  } while (nextPageToken && guard < 25);

  return { status, rows };
}

async function fetchList(token: string, path: string, key: string): Promise<Array<Record<string, unknown>>> {
  return (await fetchListResult(token, path, key)).rows;
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

/** Exposed so the account probe route can call Zoom without duplicating token resolution. */
export async function zoomAccessToken(ctx?: VideoAuthContext): Promise<string> {
  return getAccessToken(ctx);
}

function statsFrom(details: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!details) return out;
  for (const k of DETAIL_KEYS) {
    const v = details[k];
    if (v !== undefined && v !== null && v !== '') out[k] = String(v);
  }
  return out;
}

/** The account this session's host authorisation maps to, if any (used for `reportAccess`). */
async function accountFor(ctx?: VideoAuthContext) {
  if (!ctx?.connectionId) return undefined;
  const conn = await getConnection(ctx.connectionId);
  return pickZoomAccount(conn?.zoomAccounts, ctx.zoomUserId).account;
}

export const zoomProvider: VideoProviderImpl = {
  key: 'zoom',

  /**
   * Attendance for a finished session.
   *
   * Order matters. The report API gives the richest data (absentees, polls, Q&A) but a user-managed
   * app authorised by a non-admin host is refused there — that is normal, not an error. So the first
   * refusal is remembered on the connection and the call falls through to the past-meetings
   * participant list, which a host *can* read for their own meetings. Attendance and no-shows survive
   * that switch because `buildReport()` derives no-shows from invited − attended; only polls, Q&A and
   * the absentee list become unavailable, and a note says so.
   */
  async fetch(
    externalId: string,
    sessionType: SessionType = 'meeting',
    ctx?: VideoAuthContext,
  ): Promise<ProviderFetchResult> {
    const token = await getAccessToken(ctx);
    const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
    const enc = encodeURIComponent(externalId);
    const notes: string[] = [];

    const account = await accountFor(ctx);
    const reportAllowed = account ? account.reportAccess !== 'denied' : true;

    if (reportAllowed) {
      const participants = await fetchListResult(token, `/report/${seg}/${enc}/participants`, 'participants');

      if (participants.status === 200) {
        await rememberReportAccess(ctx, 'granted');

        const absenteesRaw = await fetchList(token, `/report/${seg}/${enc}/absentees`, 'absentees');
        const registrantsRaw = await fetchList(token, `/${seg}/${enc}/registrants`, 'registrants');
        const details = await getJson(token, `/report/${seg}/${enc}`);
        const pollsRaw = await fetchList(token, `/report/${seg}/${enc}/polls`, 'polls');
        const qaRaw = await fetchList(token, `/report/${seg}/${enc}/qa`, 'questions');

        return {
          attendees: participants.rows.map(mapParticipant),
          absentees: absenteesRaw
            .map((a) => (str(a.user_email) || str(a.email) || '').toLowerCase())
            .filter(Boolean),
          registrants: registrantsRaw.length,
          sessionStats: statsFrom(details),
          polls: pollsRaw as unknown as PollResult[],
          qa: qaRaw as unknown as QaEntry[],
        };
      }

      if (participants.status === 401 || participants.status === 403) {
        await rememberReportAccess(ctx, 'denied');
        notes.push(
          'Zoom did not allow report access for this host, so polls, Q&A and the absentee list are unavailable. Attendance still comes from the meeting participant list.',
        );
      }
    } else {
      notes.push(
        'Zoom reports are unavailable for this host, so polls, Q&A and the absentee list are unavailable. Attendance comes from the meeting participant list.',
      );
    }

    // Fallback: a host can always read participants of their own past meeting/webinar.
    const pastSeg = sessionType === 'webinar' ? 'past_webinars' : 'past_meetings';
    const detailsRes = await getJsonResult(token, `/${pastSeg}/${enc}`);
    const uuid = detailsRes.data ? str(detailsRes.data.uuid) : undefined;

    let past = await fetchListResult(token, `/${pastSeg}/${enc}/participants`, 'participants');
    if (past.status !== 200 && uuid) {
      // Zoom's UUID form usually needs double encoding, and starts with '/' for recurring meetings.
      past = await fetchListResult(
        token,
        `/${pastSeg}/${encodeURIComponent(encodeURIComponent(uuid))}/participants`,
        'participants',
      );
    }

    if (past.status !== 200) {
      notes.push(
        'Zoom would not return participants for this call — it may not have ended yet, or the selected host cannot see it.',
      );
    }

    return {
      attendees: past.rows.map(mapParticipant),
      absentees: [],
      registrants: 0,
      sessionStats: statsFrom(detailsRes.data),
      polls: [],
      qa: [],
      notes: notes.length ? notes : undefined,
    };
  },

  /**
   * The real attendee join link, read from the management endpoint — which works *before* the
   * session runs, unlike the /report/* endpoints `fetch()` uses, which only exist once it has
   * ended.
   *
   * Best-effort by design: a missing Zoom config, or an app without the `webinar:read` /
   * `meeting:read` scope, yields undefined instead of throwing, so creating a session never fails
   * because of Zoom.
   */
  async resolveJoinUrl(
    externalId: string,
    sessionType: SessionType = 'meeting',
    ctx?: VideoAuthContext,
  ): Promise<string | undefined> {
    try {
      const token = await getAccessToken(ctx);
      const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
      const data = await getJson(token, `/${seg}/${encodeURIComponent(externalId)}`);
      return data ? str(data.join_url) : undefined;
    } catch {
      return undefined;
    }
  },

  async test(ctx?: VideoAuthContext) {
    try {
      const token = await getAccessToken(ctx);
      await axios.get(`${BASE}/users/me`, { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
      return { ok: true };
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      return { ok: false, detail: e?.response?.data?.message || e?.message || 'unknown error' };
    }
  },
};

