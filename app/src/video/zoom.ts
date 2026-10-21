import axios from 'axios';
import { getVideoSettings } from '../domain/videoSettings';
import {
  deleteZoomTokens,
  listZoomAccounts,
  loadZoomTokens,
  saveZoomAccount,
  saveZoomTokens,
} from '../domain/zoomStore';
import { refreshZoomToken, isInvalidGrant, zoomErrorDetail } from '../oauth/zoomOAuth';
import {
  chooseZoomTokenSource,
  defaultZoomAuthMode,
  expiryFrom,
  isScopeDenied,
  pickZoomAccount,
  reportAccessFromProbe,
  scopesFromDenial,
  shouldAttemptReports,
  tokenUsable,
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
 * Tokens are cached per Zoom host. With several campaigns sharing one authorised host this avoids a
 * refresh per campaign, and keying by user id keeps two hosts from ever sharing a slot.
 */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

function cacheKey(source: ZoomTokenSource): string {
  return source.kind === 'user' ? `user:${source.userId}` : 's2s';
}

/** Drop a cached token after a disconnect, so the next call cannot keep using it. */
export function forgetZoomToken(userId: string): void {
  tokenCache.delete(`user:${userId}`);
  // Also forget the one-shot "reports were refused" marker, so a fresh authorisation re-verifies.
  reportAttempted.delete(userId);
}

/**
 * Hosts whose report access we have already verified once while the cached verdict says denied.
 *
 * The connect-time probe asks a different endpoint from the one attendance needs, so one verification
 * attempt per host per process keeps a wrong "denied" from hiding report data forever.
 */
const reportAttempted = new Set<string>();

async function getAccessToken(ctx?: VideoAuthContext): Promise<string> {
  const settings = await getVideoSettings();
  const accounts = await listZoomAccounts();
  const tokens = await loadZoomTokens(accounts);

  const source = chooseZoomTokenSource({
    mode: defaultZoomAuthMode(settings.zoomAuthMode),
    requestedUserId: ctx?.zoomUserId,
    accounts,
    tokens,
    s2sConfigured: !!(settings.zoom?.accountId && settings.zoom.clientId && settings.zoom.clientSecret),
    now: Date.now(),
  });
  if (source.kind === 'error') throw new Error(source.error);

  const key = cacheKey(source);
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
    const refreshed = await refreshZoomToken(source.refreshToken);
    const expiresAt = expiryFrom(Date.now(), refreshed.expires_in);
    tokenCache.set(key, { accessToken: refreshed.access_token, expiresAt });

    await saveZoomTokens(source.userId, {
      // Zoom may rotate the refresh token; keep the new one when it does.
      refreshToken: refreshed.refresh_token || source.refreshToken,
      accessToken: refreshed.access_token,
      expiresAt,
    });

    return refreshed.access_token;
  } catch (err) {
    if (isInvalidGrant(err)) {
      // The authorisation is gone for good. Keep the host listed (campaigns still point at it) but
      // drop the dead credentials, so the error is "reconnect" rather than a silent retry loop.
      await deleteZoomTokens(source.userId);
      tokenCache.delete(key);
      throw new Error(`Zoom needs reconnecting for ${source.email}`);
    }
    throw new Error(`Zoom token refresh failed: ${zoomErrorDetail(err)}`);
  }
}

/** Remember what Zoom allowed, so we stop probing on every sync. Best-effort by design. */
async function rememberReportAccess(
  ctx: VideoAuthContext | undefined,
  access: 'granted' | 'denied',
  detail?: string,
): Promise<void> {
  try {
    const target = pickZoomAccount(await listZoomAccounts(), ctx?.zoomUserId).account;
    if (!target) return;
    if (target.reportAccess === access && (!detail || target.reportDetail === detail)) return;

    const nextDetail = access === 'denied' ? (detail ?? target.reportDetail) : undefined;
    await saveZoomAccount({
      ...target,
      reportAccess: access,
      reportDetail: nextDetail,
      reportMissingScopes: access === 'denied' ? scopesFromDenial(nextDetail) : [],
    });
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
): Promise<{ status: number; data: Record<string, unknown> | null; detail?: string }> {
  try {
    const res = await axios.get(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 30000,
    });
    return { status: res.status, data: (res.data ?? null) as Record<string, unknown> | null };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
    // Keep Zoom's own message: a missing scope arrives as 400 code 4711, not 403.
    return { status, data: null, detail: zoomErrorDetail(err) };
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
): Promise<{ status: number; rows: Array<Record<string, unknown>>; detail?: string }> {
  const rows: Array<Record<string, unknown>> = [];
  let nextPageToken: string | undefined;
  let guard = 0;
  let status = 0;
  let detail: string | undefined;

  do {
    const res = await getJsonResult(token, path, { page_size: 300, next_page_token: nextPageToken || undefined });
    status = res.status;
    detail = res.detail;
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

  return { status, rows, detail };
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

/**
 * Verify report access against the endpoint attendance actually uses.
 *
 * The old connect-time probe asked `/report/users/{userId}/meetings`, whose scope is unrelated to the
 * participant/absentee/poll calls — it could refuse a token that works, and demanded a scope the app
 * may not even offer. This tests the participants call itself and records the verdict.
 */
export async function probeReportsFor(
  externalId: string,
  sessionType: SessionType = 'meeting',
  ctx?: VideoAuthContext,
): Promise<{ access: 'granted' | 'denied' | 'unknown'; detail?: string; missingScopes?: string[] }> {
  const token = await getAccessToken(ctx);
  const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
  const participants = await fetchListResult(
    token,
    `/report/${seg}/${encodeURIComponent(externalId)}/participants`,
    'participants',
  );

  const access = reportAccessFromProbe(participants.status, participants.detail);
  if (access === 'granted') {
    await rememberReportAccess(ctx, 'granted');
    return { access };
  }
  if (access === 'denied') {
    await rememberReportAccess(ctx, 'denied', participants.detail);
    return { access, detail: participants.detail, missingScopes: scopesFromDenial(participants.detail) };
  }

  return { access, detail: participants.detail };
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

/** The host this session is pinned to, if any (used for `reportAccess`). */
async function accountFor(ctx?: VideoAuthContext) {
  return pickZoomAccount(await listZoomAccounts(), ctx?.zoomUserId).account;
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
    const attemptKey = account?.userId ?? 's2s';
    // A cached "denied" buys one verification attempt, because the probe and the participant call
    // need different scopes — the probe's verdict must not be the final word.
    const reportAllowed = shouldAttemptReports(account?.reportAccess, reportAttempted.has(attemptKey));

    if (reportAllowed) {
      const participants = await fetchListResult(token, `/report/${seg}/${enc}/participants`, 'participants');

      if (participants.status === 200) {
        reportAttempted.delete(attemptKey);
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

      if (isScopeDenied(participants.status, participants.detail)) {
        reportAttempted.add(attemptKey);
        await rememberReportAccess(ctx, 'denied', participants.detail);
        notes.push(
          'Zoom refused report access for this authorisation, so polls, Q&A and the absentee list are unavailable (they need an admin-managed Zoom app). Attendance still comes from the meeting participant list.',
        );
      }
    } else {
      notes.push(
        'This Zoom authorisation has no report scope, so polls, Q&A and the absentee list are unavailable. Attendance comes from the meeting participant list.',
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

