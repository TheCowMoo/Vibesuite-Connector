import axios from 'axios';
import { logger } from '../lib/logger';
import { resolveInviteWebhookUrl } from './teamSettings';
import { resolveSystemEmailSettings, systemEmailConfigured } from './systemEmailSettings';
import { upsertContactByEmail, sendEmailMessage } from '../ghl/conversations';
import type { GhlRequestTarget } from '../ghl/client';

export type SystemEmailChannel = 'ghl' | 'webhook' | 'none';

export interface SystemEmailInput {
  to: string;
  name?: string;
  subject: string;
  html: string;
  text?: string;
  /** Payload for the webhook fallback. Omitted means no fallback is attempted. */
  webhookPayload?: Record<string, unknown>;
}

export interface SystemEmailResult {
  ok: boolean;
  via: SystemEmailChannel;
  detail?: string;
}

/**
 * Minimal credentials, so we can reuse `ghlRequest` — and with it the existing retry, backoff,
 * `Retry-After` and 401 handling — without fabricating a whole StoredConnection.
 */
function ghlTarget(apiToken: string): GhlRequestTarget {
  return { id: 'system-email', ghlAuthType: 'api_token', ghlApiToken: apiToken };
}

async function postWebhook(payload?: Record<string, unknown>): Promise<SystemEmailResult> {
  if (!payload) return { ok: false, via: 'none', detail: 'nothing configured to deliver system email' };

  const url = await resolveInviteWebhookUrl();
  if (!url) return { ok: false, via: 'none', detail: 'no system email configured' };

  try {
    await axios.post(url, payload, { timeout: 15000 });
    return { ok: true, via: 'webhook' };
  } catch (err) {
    const e = err as { response?: { status?: number; data?: unknown }; message?: string };
    const detail = e?.response?.status
      ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`
      : e?.message || 'unknown error';
    logger.warn({ detail }, 'system email webhook fallback failed');
    return { ok: false, via: 'webhook', detail };
  }
}

/**
 * Send one platform email.
 *
 * GoHighLevel is preferred when configured. Anything that goes wrong there falls through to the
 * GHL inbound webhook when one is set, so an existing setup keeps working across a deploy — and the
 * caller always learns which path was actually used, rather than assuming.
 */
export async function sendSystemEmail(input: SystemEmailInput): Promise<SystemEmailResult> {
  const s = await resolveSystemEmailSettings();

  if (systemEmailConfigured(s) && s.apiToken && s.locationId) {
    try {
      const contactId = await upsertContactByEmail(ghlTarget(s.apiToken), {
        email: input.to,
        name: input.name,
        locationId: s.locationId,
        source: 'vibesuite team invite',
      });

      await sendEmailMessage(ghlTarget(s.apiToken), {
        contactId,
        subject: input.subject,
        html: input.html,
        text: input.text,
        emailFrom: s.fromEmail,
      });

      return { ok: true, via: 'ghl' };
    } catch (err) {
      const detail = (err as Error)?.message || 'GHL send failed';
      logger.warn({ to: input.to, err: detail }, 'system email via GHL failed; trying webhook fallback');

      const fallback = await postWebhook(input.webhookPayload);
      return fallback.ok
        ? { ok: true, via: 'webhook', detail: `GHL failed (${detail}); the webhook accepted it instead.` }
        : {
            ok: false,
            via: 'none',
            detail: `GHL failed (${detail}); the webhook fallback also failed (${fallback.detail}).`,
          };
    }
  }

  return postWebhook(input.webhookPayload);
}