import axios from 'axios';
import { env } from '../config/env';
import { reportAccessFromStatus } from '../video/zoomAuth';

const AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const TOKEN_URL = 'https://zoom.us/oauth/token';
const API_BASE = 'https://api.zoom.us/v2';

/** Whether the General App credentials the user-OAuth flow needs are present. */
export function zoomOAuthConfigured(): boolean {
  return !!(env.ZOOM_OAUTH_CLIENT_ID && env.ZOOM_OAUTH_CLIENT_SECRET);
}

function credentials(): { clientId: string; clientSecret: string } {
  if (!env.ZOOM_OAUTH_CLIENT_ID || !env.ZOOM_OAUTH_CLIENT_SECRET) {
    throw new Error(
      'Zoom OAuth app credentials are not configured (ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET)',
    );
  }
  return { clientId: env.ZOOM_OAUTH_CLIENT_ID, clientSecret: env.ZOOM_OAUTH_CLIENT_SECRET };
}

export function zoomRedirectUri(): string {
  return `${env.OAUTH_BASE_URL.replace(/\/$/, '')}${env.ZOOM_OAUTH_REDIRECT_PATH}`;
}

function basicAuth(): string {
  const { clientId, clientSecret } = credentials();
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

/** The user-managed General App consent screen. Scopes come from the app unless pinned by env. */
export function buildZoomAuthUrl(state: string): string {
  const { clientId } = credentials();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: zoomRedirectUri(),
    state,
  });

  const scopes = env.ZOOM_OAUTH_SCOPES.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (scopes.length) params.set('scope', scopes.join(' '));

  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface ZoomTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function toTokenResponse(data: unknown): ZoomTokenResponse {
  const d = (data ?? {}) as Record<string, unknown>;
  const accessToken = typeof d.access_token === 'string' ? d.access_token : '';
  if (!accessToken) throw new Error('Zoom token request returned no access_token');
  return {
    access_token: accessToken,
    refresh_token: typeof d.refresh_token === 'string' ? d.refresh_token : undefined,
    expires_in: typeof d.expires_in === 'number' ? d.expires_in : undefined,
    scope: typeof d.scope === 'string' ? d.scope : undefined,
  };
}

export async function exchangeZoomCode(code: string): Promise<ZoomTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: zoomRedirectUri(),
  });
  const res = await axios.post(TOKEN_URL, body.toString(), {
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });
  return toTokenResponse(res.data);
}

export async function refreshZoomToken(refreshToken: string): Promise<ZoomTokenResponse> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await axios.post(TOKEN_URL, body.toString(), {
    headers: { Authorization: `Basic ${basicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });
  return toTokenResponse(res.data);
}

export interface ZoomUser {
  id: string;
  email: string;
  displayName?: string;
}

export async function fetchZoomUser(accessToken: string): Promise<ZoomUser> {
  const res = await axios.get(`${API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 20000,
  });
  const d = (res.data ?? {}) as Record<string, unknown>;
  const id = String(d.id ?? '');
  if (!id) throw new Error('Zoom /users/me returned no user id');
  return {
    id,
    email: String(d.email ?? ''),
    displayName: d.display_name ? String(d.display_name) : undefined,
  };
}

/**
 * Ask Zoom whether this authorisation may read account reports.
 *
 * A user-managed app authorised by a non-admin host is refused here, and that is the normal outcome —
 * attendance still works from the past-meetings participant list, only polls/Q&A/absentees do not.
 * Probing once at connect time is what lets the UI explain that instead of showing empty sections.
 */
export async function probeZoomReportAccess(
  accessToken: string,
  userId: string,
): Promise<'granted' | 'denied' | 'unknown'> {
  const iso = (d: Date): string => d.toISOString().slice(0, 10);
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86400000);

  try {
    const res = await axios.get(`${API_BASE}/report/users/${encodeURIComponent(userId)}/meetings`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { from: iso(from), to: iso(to), page_size: 1 },
      timeout: 20000,
    });
    return reportAccessFromStatus(res.status);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
    return reportAccessFromStatus(status);
  }
}

/** Zoom answers a revoked/rotated token with this, which means the host must authorise again. */
export function isInvalidGrant(err: unknown): boolean {
  const data = (err as { response?: { data?: { error?: string } } })?.response?.data;
  return data?.error === 'invalid_grant';
}

export function zoomErrorDetail(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: { reason?: string; message?: string; error?: string } };
    message?: string;
  };
  const d = e?.response?.data;
  const base = d?.reason || d?.message || d?.error || e?.message || 'unknown error';
  return e?.response?.status ? `${e.response.status} ${base}` : base;
}
