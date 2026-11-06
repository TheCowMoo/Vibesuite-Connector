import type { GoogleAuthType } from './connection';

interface ErrorShape {
  response?: {
    status?: number;
    data?: {
      error?: { message?: string } | string;
      error_description?: string;
    };
  };
  message?: string;
}

export function isGoogleAuthExpired(value: unknown): boolean {
  return /invalid_grant/i.test(String(value ?? ''));
}

/**
 * Turn a Google API error into the sentence an operator can act on. The raw status and provider
 * text are kept for non-auth failures; OAuth invalid_grant is always a reconnect, not a retry.
 */
export function describeSendError(err: unknown, googleAuthType?: GoogleAuthType): string {
  if (typeof err === 'string') {
    return isGoogleAuthExpired(err)
      ? authExpiredMessage(googleAuthType)
      : err;
  }

  const e = (err || {}) as ErrorShape;
  const status = e.response?.status;
  const detail = e.response?.data?.error;
  const providerText = typeof detail === 'string'
    ? detail
    : detail?.message || e.response?.data?.error_description || e.message;
  const raw = providerText
    ? (status ? `${status} ${providerText}` : providerText)
    : 'unknown error';

  return isGoogleAuthExpired(raw) ? authExpiredMessage(googleAuthType) : raw;
}

function authExpiredMessage(googleAuthType?: GoogleAuthType): string {
  return googleAuthType === 'service_account'
    ? 'Google service account authorization failed — check its key and domain-wide delegation (invalid_grant)'
    : 'Google authorization expired — reconnect this sending account (invalid_grant)';
}
