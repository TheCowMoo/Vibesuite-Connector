import axios from 'axios';
import { env } from '../config/env';

export interface GhlTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  locationId?: string;
  companyId?: string;
}

const TOKEN_URL = 'https://services.leadconnectorhq.com/oauth/token';

export function ghlRedirectUri(): string {
  return `${env.OAUTH_BASE_URL.replace(/\/$/, '')}${env.GHL_OAUTH_REDIRECT_PATH}`;
}

export function buildGhlAuthUrl(state: string): string {
  if (!env.GHL_OAUTH_CLIENT_ID) throw new Error('GHL OAuth client id not configured (GHL_OAUTH_CLIENT_ID)');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.GHL_OAUTH_CLIENT_ID,
    redirect_uri: ghlRedirectUri(),
    scope: 'contacts.write contacts.readonly calendars.write calendars.readonly workflows.write workflows.readonly',
    state,
  });
  // NOTE: verify the exact Marketplace authorization URL against current GHL docs.
  return `https://marketplace.gohighlevel.com/oauth/chooselocation?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<GhlTokenResponse> {
  const res = await axios.post<GhlTokenResponse>(TOKEN_URL, new URLSearchParams(body).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return res.data;
}

export async function exchangeGhlCode(code: string): Promise<GhlTokenResponse> {
  if (!env.GHL_OAUTH_CLIENT_ID || !env.GHL_OAUTH_CLIENT_SECRET) {
    throw new Error('GHL OAuth credentials not configured (GHL_OAUTH_CLIENT_ID / GHL_OAUTH_CLIENT_SECRET)');
  }
  return tokenRequest({
    client_id: env.GHL_OAUTH_CLIENT_ID,
    client_secret: env.GHL_OAUTH_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: ghlRedirectUri(),
  });
}

export async function refreshGhlToken(refreshToken: string): Promise<GhlTokenResponse> {
  if (!env.GHL_OAUTH_CLIENT_ID || !env.GHL_OAUTH_CLIENT_SECRET) {
    throw new Error('GHL OAuth credentials not configured (GHL_OAUTH_CLIENT_ID / GHL_OAUTH_CLIENT_SECRET)');
  }
  return tokenRequest({
    client_id: env.GHL_OAUTH_CLIENT_ID,
    client_secret: env.GHL_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
