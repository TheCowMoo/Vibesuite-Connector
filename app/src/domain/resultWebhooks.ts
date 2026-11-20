import { sha256 } from '../lib/tokens';
import type { AttendanceSegment } from './attendanceSegments';
import type { AttendanceResultWebhooks } from './sessionStore';

const SEGMENT_KEY: Record<AttendanceSegment, keyof AttendanceResultWebhooks> = {
  attended: 'attended',
  partial: 'partial',
  no_show: 'noShow',
  not_invited: 'notInvited',
};

const URL_RE = /^https?:\/\/\S+$/i;

export type ResultWebhookParseResult =
  | { ok: true; value?: AttendanceResultWebhooks }
  | { ok: false; error: string };

/**
 * Validate the four simple result webhook URLs. A blank value disables that result.
 * There is deliberately no condition builder here: each URL is tied to one result.
 */
export function parseResultWebhooks(body: unknown): ResultWebhookParseResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'invalid result webhook settings' };
  }

  const source = body as Record<string, unknown>;
  const out: AttendanceResultWebhooks = {};
  for (const key of ['attended', 'partial', 'noShow', 'notInvited'] as const) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { ok: false, error: `${key} must be a URL string` };
    const url = raw.trim();
    if (!url) continue;
    if (url.length > 2048) return { ok: false, error: `${key} URL is too long` };
    if (!URL_RE.test(url)) return { ok: false, error: `${key} must start with http:// or https://` };
    out[key] = url;
  }

  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

export function webhookForSegment(
  webhooks: AttendanceResultWebhooks | undefined,
  segment: AttendanceSegment,
): string | undefined {
  return webhooks?.[SEGMENT_KEY[segment]];
}

export function hasResultWebhooks(webhooks: AttendanceResultWebhooks | undefined): boolean {
  return !!webhooks && Object.values(webhooks).some(Boolean);
}

/**
 * Include the URL in the claim so changing a URL is treated as a new target, while an unchanged
 * URL still cannot be delivered twice for the same person and result.
 */
export function resultWebhookFingerprint(
  identity: string,
  segment: AttendanceSegment,
  url: string,
): string {
  return `${identity}:result-webhook:${segment}:${sha256(url).slice(0, 16)}`;
}
