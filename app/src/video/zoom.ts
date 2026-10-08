import axios from 'axios';
import { getVideoSettings } from '../domain/videoSettings';
import type { AttendeeRecord, VideoProviderImpl } from './types';

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

export const zoomProvider: VideoProviderImpl = {
  key: 'zoom',

  async listAttendees(externalId: string): Promise<AttendeeRecord[]> {
    const token = await getAccessToken();
    const out: AttendeeRecord[] = [];
    let nextPageToken: string | undefined;

    do {
      const res = await axios.get(`https://api.zoom.us/v2/report/meetings/${encodeURIComponent(externalId)}/participants`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { page_size: 300, next_page_token: nextPageToken || undefined },
        timeout: 30000,
      });
      const participants = (res.data?.participants ?? []) as Array<Record<string, unknown>>;
      for (const p of participants) {
        out.push({
          email: (p.user_email as string) || undefined,
          name: (p.name as string) || undefined,
          joinedAt: (p.join_time as string) || undefined,
          leftAt: (p.leave_time as string) || undefined,
          durationSec: typeof p.duration === 'number' ? (p.duration as number) : undefined,
        });
      }
      nextPageToken = (res.data?.next_page_token as string) || undefined;
    } while (nextPageToken);

    return out;
  },

  async test() {
    try {
      const token = await getAccessToken();
      await axios.get('https://api.zoom.us/v2/users/me', { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 });
      return { ok: true };
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      return { ok: false, detail: e?.response?.data?.message || e?.message || 'unknown error' };
    }
  },
};
