import { google } from 'googleapis';
import { JWT } from 'google-auth-library';
import { googleOAuthClient, GOOGLE_SCOPES } from '../oauth/googleOAuth';
import type { StoredConnection } from '../domain/connection';

export function createCalendarClient(conn: StoredConnection) {
  if (conn.googleAuthType === 'service_account') {
    if (!conn.googleServiceAccountEmail || !conn.googleServiceAccountKey) {
      throw new Error(`connection ${conn.id}: missing service account credentials`);
    }
    const auth = new JWT({
      email: conn.googleServiceAccountEmail,
      key: conn.googleServiceAccountKey.replace(/\\n/g, '\n'),
      scopes: GOOGLE_SCOPES,
      subject: conn.googleSubject || undefined,
    });
    return google.calendar({ version: 'v3', auth });
  }

  if (!conn.googleRefreshToken) {
    throw new Error(`connection ${conn.id}: missing Google refresh token`);
  }
  const oauth = googleOAuthClient();
  oauth.setCredentials({ refresh_token: conn.googleRefreshToken });
  return google.calendar({ version: 'v3', auth: oauth });
}

