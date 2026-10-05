import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export function googleRedirectUri(): string {
  return `${env.OAUTH_BASE_URL.replace(/\/$/, '')}${env.GOOGLE_OAUTH_REDIRECT_PATH}`;
}

export function googleOAuthClient(): OAuth2Client {
  if (!env.GOOGLE_OAUTH_CLIENT_ID || !env.GOOGLE_OAUTH_CLIENT_SECRET) {
    throw new Error('Google OAuth client credentials not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)');
  }
  return new OAuth2Client({
    clientId: env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: googleRedirectUri(),
  });
}

export function buildGoogleAuthUrl(state: string): string {
  return googleOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
  });
}

export async function exchangeGoogleCode(code: string) {
  const { tokens } = await googleOAuthClient().getToken(code);
  return tokens;
}

export async function refreshGoogleToken(refreshToken: string) {
  const oauth = googleOAuthClient();
  oauth.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth.refreshAccessToken();
  return credentials;
}
