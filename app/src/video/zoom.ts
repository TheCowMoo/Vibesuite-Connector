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
  classifyCapability,
  defaultZoomAuthMode,
  expiryFrom,
  isInvalidToken,
  isScopeDenied,
  pickZoomAccount,
  scopesFromDenial,
  shouldAttemptReports,
  tokenUsable,
  type ZoomTokenSource,
} from './zoomAuth';
import type { ZoomCapability, ZoomCapabilityResult } from '../domain/zoomStore';
import type {
  AttendeeRecord,
  PollResult,
  ProviderFetchResult,
  QaEntry,
  SessionType,
  SyncAttempt,
  VideoAuthContext,
  VideoProviderImpl,
} from './types';
import { normalizeZoomCallId, otherType } from './zoomId';

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

/**
 * Zoom rejected the token outright.
 *
 * Keep the host listed — campaigns still point at it — but bin the dead credentials so the UI says
 * "reconnect" instead of retrying a token that can never work. A refresh token cannot be revived after
 * an app's scopes or credentials change, which is the usual cause.
 */
async function invalidateZoomAuthorisation(userId: string): Promise<void> {
  forgetZoomToken(userId);
  try {
    await deleteZoomTokens(userId);
    const target = pickZoomAccount(await listZoomAccounts(), userId).account;
    if (target) {
      await saveZoomAccount({
        ...target,
        reportAccess: 'unknown',
        reportDetail: undefined,
        reportMissingScopes: [],
      });
    }
  } catch {
    /* best effort: the reconnect message matters more than the bookkeeping */
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
 * Ask every report endpoint about one finished call, and record what each said.
 *
 * One vocabulary for all four: available / empty / missing / denied / unknown. That is what separates
 * "add this scope" from "this plan has no Q&A" from "that meeting ran no polls" — three problems that
 * used to look identical.
 */
export async function probeZoomCapabilities(
  externalId: string,
  sessionType: SessionType = 'meeting',
  ctx?: VideoAuthContext,
): Promise<{ capabilities: Record<ZoomCapability, ZoomCapabilityResult>; participants: ZoomCapabilityResult }> {
  const token = await getAccessToken(ctx);
  const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
  const enc = encodeURIComponent(externalId);
  const checkedAt = Date.now();

  const targets: Array<{ key: ZoomCapability; path: string; listKey: string }> = [
    { key: 'participants', path: `/report/${seg}/${enc}/participants`, listKey: 'participants' },
    { key: 'absentees', path: `/report/${seg}/${enc}/absentees`, listKey: 'absentees' },
    { key: 'polls', path: `/report/${seg}/${enc}/polls`, listKey: 'polls' },
    { key: 'qa', path: `/report/${seg}/${enc}/qa`, listKey: 'questions' },
  ];

  const capabilities = {} as Record<ZoomCapability, ZoomCapabilityResult>;

  for (const target of targets) {
    const res = await fetchListResult(token, target.path, target.listKey);
    const verdict = classifyCapability(res.status, res.rows.length, res.detail);

    capabilities[target.key] = {
      status: verdict.status,
      httpStatus: res.status,
      detail: res.detail,
      missingScopes: verdict.missingScopes,
      checkedAt,
    };
  }

  const participants = capabilities.participants;
  // A 401 is a dead token, not a scope refusal. Caching it as "denied" sends every later sync down
  // the fallback path with a token that will never work, so say what actually happened instead.
  if (isInvalidToken(participants.httpStatus ?? 0)) {
    const target = await accountFor(ctx);
    if (target) await invalidateZoomAuthorisation(target.userId);
    throw new Error(
      `Zoom has invalidated this authorisation${target ? ` for ${target.email}` : ''} — use Disconnect, then Connect Zoom again.`,
    );
  }

  return { capabilities, participants };
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

interface FetchAttempt {
  result: ProviderFetchResult;
  reportStatus?: number;
  pastStatus?: number;
  detail?: string;
}

/**
 * One pass over one call type with one host.
 *
 * Throws only when Zoom invalidates the token itself: a dead authorisation is not fixed by trying a
 * different type or host, and it needs the reconnect instruction rather than another retry.
 */
async function fetchOnce(
  externalId: string,
  sessionType: SessionType,
  ctx?: VideoAuthContext,
): Promise<FetchAttempt> {
  const token = await getAccessToken(ctx);
  const seg = sessionType === 'webinar' ? 'webinars' : 'meetings';
  const enc = encodeURIComponent(externalId);
  const notes: string[] = [];

  const account = await accountFor(ctx);
  const attemptKey = account?.userId ?? 's2s';
  // A cached "denied" buys one verification attempt, because the probe and the participant call
  // need different scopes — the probe's verdict must not be the final word.
  const reportAllowed = shouldAttemptReports(account?.reportAccess, reportAttempted.has(attemptKey));
  let reportStatus: number | undefined;
  let detail: string | undefined;

  if (reportAllowed) {
    const participants = await fetchListResult(token, `/report/${seg}/${enc}/participants`, 'participants');
    reportStatus = participants.status;
    detail = participants.detail;

    if (isInvalidToken(participants.status)) {
      const target = await accountFor(ctx);
      if (target) await invalidateZoomAuthorisation(target.userId);
      throw new Error(
        `Zoom has invalidated this authorisation${target ? ` for ${target.email}` : ''} — use Disconnect, then Connect Zoom again.`,
      );
    }

    if (participants.status === 200) {
      reportAttempted.delete(attemptKey);
      await rememberReportAccess(ctx, 'granted');

      const absenteesRaw = await fetchList(token, `/report/${seg}/${enc}/absentees`, 'absentees');
      const registrantsRaw = await fetchList(token, `/${seg}/${enc}/registrants`, 'registrants');
      const details = await getJson(token, `/report/${seg}/${enc}`);
      const pollsRaw = await fetchList(token, `/report/${seg}/${enc}/polls`, 'polls');
      const qaRaw = await fetchList(token, `/report/${seg}/${enc}/qa`, 'questions');

      return {
        reportStatus,
        result: {
          attendees: participants.rows.map(mapParticipant),
          absentees: absenteesRaw
            .map((a) => (str(a.user_email) || str(a.email) || '').toLowerCase())
            .filter(Boolean),
          registrants: registrantsRaw.length,
          sessionStats: statsFrom(details),
          polls: pollsRaw as unknown as PollResult[],
          qa: qaRaw as unknown as QaEntry[],
          reportReady: true,
        },
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

  // A dead token is just as dead on the fallback path; without this it would look like "no report"
  // and keep the session pending instead of asking for a reconnect.
  if (isInvalidToken(past.status)) {
    const target = await accountFor(ctx);
    if (target) await invalidateZoomAuthorisation(target.userId);
    throw new Error(
      `Zoom has invalidated this authorisation${target ? ` for ${target.email}` : ''} — use Disconnect, then Connect Zoom again.`,
    );
  }

  if (past.status !== 200) {
    const pastDetail = past.detail || detailsRes.detail;
    notes.push(
      `Zoom would not return participants for this call (HTTP ${past.status || 'error'}${pastDetail ? `: ${pastDetail}` : ''}) — it may not have ended yet, or the selected host cannot see it.`,
    );
  }

  return {
    reportStatus,
    pastStatus: past.status,
    detail: past.detail || detail || detailsRes.detail,
    result: {
      attendees: past.rows.map(mapParticipant),
      absentees: [],
      registrants: 0,
      sessionStats: statsFrom(detailsRes.data),
      polls: [],
      qa: [],
      notes: notes.length ? notes : undefined,
      // A 200 with an empty list is a real answer ("nobody joined"); anything else means there is
      // no report yet, which the caller must retry rather than store as zero attendance.
      reportReady: past.status === 200,
    },
  };
}

const MAX_SWEEP_HOSTS = 3;

interface HostSweep {
  found?: { userId: string; email?: string; type: SessionType };
  probes: Array<{ host: string; type: SessionType; status: number }>;
}

/**
 * If the selected host cannot see the call, another authorised host may be its owner. Probe the
 * past-call endpoint (one cheap call each) before declaring the call unreadable.
 */
async function sweepOtherHosts(
  externalId: string,
  types: SessionType[],
  ctx: VideoAuthContext | undefined,
  excludeUserId?: string,
): Promise<HostSweep> {
  const probes: HostSweep['probes'] = [];
  const settings = await getVideoSettings();
  if (defaultZoomAuthMode(settings.zoomAuthMode) !== 'user') return { probes };

  const accounts = (await listZoomAccounts()).filter((a) => a.userId !== excludeUserId);
  if (!accounts.length) return { probes };

  for (const account of accounts.slice(0, MAX_SWEEP_HOSTS)) {
    let token: string;
    try {
      token = await getAccessToken({ ...ctx, zoomUserId: account.userId });
    } catch {
      continue;
    }

    for (const type of types) {
      const seg = type === 'webinar' ? 'past_webinars' : 'past_meetings';
      const res = await getJsonResult(token, `/${seg}/${encodeURIComponent(externalId)}`);
      probes.push({ host: account.email || account.userId, type, status: res.status });
      if (res.status === 200) {
        return { found: { userId: account.userId, email: account.email, type }, probes };
      }
    }
  }

  return { probes };
}

interface FinishInput {
  attempt: FetchAttempt;
  type: SessionType;
  hostLabel?: string;
  hostUserId?: string;
  id: string;
  originalId: string;
  originalType: SessionType;
  attempts: SyncAttempt[];
  probes?: HostSweep['probes'];
  ctx?: VideoAuthContext;
}

/** Add the corrections, the sentences that explain them, and the diagnostics record. */
function finishFetch(input: FinishInput): ProviderFetchResult {
  const notes = [...(input.attempt.result.notes ?? [])];
  const correctedId = input.id !== input.originalId ? input.id : undefined;
  const correctedType = input.type !== input.originalType ? input.type : undefined;
  const correctedHost =
    input.hostUserId && input.hostUserId !== input.ctx?.zoomUserId ? input.hostUserId : undefined;

  if (correctedId) notes.push(`The call ID was a Zoom link — using ${input.id} instead.`);
  if (correctedType) {
    notes.push(
      `This call is a ${input.type === 'webinar' ? 'webinar' : 'meeting'}, but it was set as a ${input.originalType}. Corrected the type for future syncs.`,
    );
  }
  if (correctedHost) {
    notes.push(
      `This call is not visible to the selected Zoom host; ${input.hostLabel || correctedHost} can read it. Using that host from now on.`,
    );
  }

  return {
    ...input.attempt.result,
    notes: notes.length ? notes : undefined,
    correction:
      correctedId || correctedType || correctedHost
        ? { externalId: correctedId, sessionType: correctedType, zoomUserId: correctedHost }
        : undefined,
    diagnostics: {
      at: Date.now(),
      externalId: input.id,
      sessionType: input.type,
      host: input.hostLabel,
      attempts: input.attempts,
      hostSweep: input.probes?.length ? input.probes : undefined,
    },
  };
}


export const zoomProvider: VideoProviderImpl = {
  key: 'zoom',

  /**
   * Attendance for a finished session.
   *
   * The report API gives the richest data, but a user-managed app authorised by a non-admin host is
   * refused there — normal, not an error. The fallback reads the past-call participant list, which a
   * host can always read for their own calls.
   *
   * A 404 on both paths used to mean a permanent "pending". The usual causes are a webinar stored as
   * a meeting, a pasted link instead of an ID, and a host who does not own the call; all three are
   * recoverable here, and every attempt is recorded in `diagnostics` so the panel can explain a
   * failure instead of just showing a status.
   */
  async fetch(
    externalId: string,
    sessionType: SessionType = 'meeting',
    ctx?: VideoAuthContext,
  ): Promise<ProviderFetchResult> {
    const normalized = normalizeZoomCallId(externalId);
    const id = normalized?.id ?? externalId;
    const firstType = normalized?.kind ?? sessionType;
    const secondType = otherType(firstType);
    // In server-to-server mode the token is account-wide; naming a host there would be misleading.
    const settings = await getVideoSettings();
    const usingUserPool = defaultZoomAuthMode(settings.zoomAuthMode) === 'user';
    const primary = usingUserPool ? await accountFor(ctx) : undefined;
    const primaryHost = usingUserPool
      ? primary
        ? primary.email || primary.userId
        : undefined
      : 'server-to-server';
    const attempts: SyncAttempt[] = [];

    const attempt = async (type: SessionType, hostCtx: VideoAuthContext | undefined, host?: string) => {
      const out = await fetchOnce(id, type, hostCtx);
      attempts.push({ type, host, reportStatus: out.reportStatus, pastStatus: out.pastStatus, detail: out.detail });
      return out;
    };

    const finish = (
      out: FetchAttempt,
      type: SessionType,
      host?: string,
      hostUserId?: string,
      probes?: HostSweep['probes'],
    ): ProviderFetchResult =>
      finishFetch({
        attempt: out,
        type,
        hostLabel: host,
        hostUserId,
        id,
        originalId: externalId,
        originalType: sessionType,
        attempts,
        probes,
        ctx,
      });

    const first = await attempt(firstType, ctx, primaryHost);
    if (first.result.reportReady) return finish(first, firstType, primaryHost);

    // A webinar sent to /meetings (or the reverse) 404s on both paths. Try the other type once.
    const second = await attempt(secondType, ctx, primaryHost);
    if (second.result.reportReady) return finish(second, secondType, primaryHost);

    // The selected host may simply not own this call. Probe the other hosts before giving up.
    const types = normalized?.kind ? [normalized.kind, otherType(normalized.kind)] : [firstType, secondType];
    const sweep = await sweepOtherHosts(id, types, ctx, primary?.userId);
    if (sweep.found) {
      const host = sweep.found.email || sweep.found.userId;
      const third = await attempt(sweep.found.type, { ...ctx, zoomUserId: sweep.found.userId }, host);
      return finish(third, sweep.found.type, host, sweep.found.userId, sweep.probes);
    }

    return finish(first, firstType, primaryHost, undefined, sweep.probes);
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
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
      const account = await accountFor(ctx).catch(() => undefined);

      // 401 means the token itself is dead (app recreated, secret rotated, scopes changed). Say so,
      // and drop it, rather than echoing Zoom's terse "Invalid access token".
      if (account && isInvalidToken(status)) {
        await invalidateZoomAuthorisation(account.userId);
        return {
          ok: false,
          detail: `Zoom has invalidated this authorisation for ${account.email} — use Disconnect, then Connect Zoom again.`,
        };
      }

      const e = err as { response?: { data?: { message?: string } }; message?: string };
      return { ok: false, detail: e?.response?.data?.message || e?.message || 'unknown error' };
    }
  },
};

