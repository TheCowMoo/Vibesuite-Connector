import { ghlRequest, type GhlRequestTarget } from './client';

export const GHL_EMAIL_VERIFICATION_RESULTS = [
  'deliverable',
  'undeliverable',
  'do_not_send',
  'unknown',
  'catch_all',
] as const;
export type GhlEmailVerificationResult = (typeof GHL_EMAIL_VERIFICATION_RESULTS)[number];

export const GHL_EMAIL_VERIFICATION_RISKS = ['low', 'medium', 'high', 'unknown'] as const;
export type GhlEmailVerificationRisk = (typeof GHL_EMAIL_VERIFICATION_RISKS)[number];

export interface GhlEmailVerification {
  address: string;
  result: GhlEmailVerificationResult;
  risk: GhlEmailVerificationRisk;
  reasons: string[];
  isEmailValid: boolean;
  locationId: string;
  checkedAt: number;
}

/** A connection slice that includes the location whose wallet pays for verification. */
export type GhlEmailVerificationTarget = GhlRequestTarget & { ghlLocationId?: string };

interface GhlVerifyResponse {
  result?: unknown;
  risk?: unknown;
  reason?: unknown;
  address?: unknown;
  leadConnectorRecommendation?: { isEmailValid?: unknown } | null;
}

function normalizeResult(value: unknown): GhlEmailVerificationResult {
  const text = String(value ?? '').toLowerCase();
  return (GHL_EMAIL_VERIFICATION_RESULTS as readonly string[]).includes(text)
    ? (text as GhlEmailVerificationResult)
    : 'unknown';
}

function normalizeRisk(value: unknown): GhlEmailVerificationRisk {
  const text = String(value ?? '').toLowerCase();
  return (GHL_EMAIL_VERIFICATION_RISKS as readonly string[]).includes(text)
    ? (text as GhlEmailVerificationRisk)
    : 'unknown';
}

function normalizeReasons(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return value == null || value === '' ? [] : [String(value)];
}

function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

function errorDetail(err: unknown): string {
  const e = err as {
    response?: { data?: { message?: unknown; error?: unknown; error_description?: unknown } };
    message?: string;
  };
  const data = e?.response?.data;
  const provider =
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof data?.error_description === 'string' && data.error_description);
  return (provider || e?.message || '').toString().slice(0, 500);
}

/**
 * Turn a GHL failure into the sentence an operator can act on.
 *
 * The endpoint needs `lc-email.readonly` and a location on LC Email or Mailgun. A generic
 * "request failed" hides both, and they are the only two setup mistakes that matter here.
 */
/** Setup/rate-limit failures stop the whole run instead of burning through every address. */
export function isGhlVerificationFatalError(err: unknown): boolean {
  const status = errorStatus(err);
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 429
  );
}

export function describeGhlVerificationError(err: unknown): string {
  const status = errorStatus(err);
  const detail = errorDetail(err);
  if (status === 401) {
    return 'GHL authorization failed — reconnect GHL or check the private integration token.';
  }
  if (status === 403) {
    return 'GHL email-verification scope is missing — add lc-email.readonly, then reconnect or regenerate the GHL token.';
  }
  if (status === 402) {
    return 'GHL wallet has no email-verification credits — top up the location or company wallet.';
  }
  if (status === 429) {
    return 'GHL is rate-limiting email verification — try again shortly.';
  }
  if (status === 400 || status === 404) {
    return `GHL email verification is unavailable for this location (LC Email or Mailgun is required)${detail ? `: ${detail}` : ''}.`;
  }
  return detail || 'GHL email verification failed.';
}

/**
 * Verify one address through GHL's Email ISV API.
 *
 * Result meanings:
 * - deliverable    — GHL believes the mailbox exists
 * - undeliverable  — GHL says it does not
 * - do_not_send    — GHL suppression / unsafe to send
 * - catch_all      — the domain accepts everything, so existence cannot be confirmed
 * - unknown        — no verdict
 *
 * This is a pre-send check. It is not a bounce, and it does not tell us what Google Calendar
 * does after the invitation is handed to Google.
 */
export async function verifyEmailWithGhl(
  conn: GhlEmailVerificationTarget,
  email: string,
): Promise<GhlEmailVerification> {
  const address = String(email || '').trim().toLowerCase();
  if (!address) throw new Error('an email address is required');
  const locationId = String(conn.ghlLocationId || '').trim();
  if (!locationId) throw new Error('GHL location id is missing on this connection');

  const res = await ghlRequest<GhlVerifyResponse>(
    conn,
    {
      method: 'POST',
      url: '/email/verify',
      params: { locationId },
      data: { type: 'email', verify: address },
    },
    { version: 'v3' },
  );

  if (!res || typeof res !== 'object') {
    throw new Error('GHL email verification returned an empty response');
  }

  const result = normalizeResult(res.result);
  const recommendation = res.leadConnectorRecommendation;
  const isEmailValid =
    typeof recommendation?.isEmailValid === 'boolean'
      ? recommendation.isEmailValid
      : result === 'deliverable';

  return {
    // Keep the requested address as the key. GHL may echo a display form; the cache, list snapshot
    // and campaign snapshot must all match what the audience actually contains.
    address,
    result,
    risk: normalizeRisk(res.risk),
    reasons: normalizeReasons(res.reason),
    isEmailValid,
    locationId,
    checkedAt: Date.now(),
  };
}
