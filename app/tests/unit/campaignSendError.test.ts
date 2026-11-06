import { describe, expect, it } from 'vitest';
import { describeSendError, isGoogleAuthExpired } from '../../src/domain/campaignSendError';

describe('isGoogleAuthExpired', () => {
  it('matches the OAuth invalid_grant error', () => {
    expect(isGoogleAuthExpired('400 invalid_grant')).toBe(true);
    expect(isGoogleAuthExpired('invalid_grant: Token has been expired or revoked.')).toBe(true);
    expect(isGoogleAuthExpired('429 rate limit')).toBe(false);
    expect(isGoogleAuthExpired(undefined)).toBe(false);
  });
});

describe('describeSendError', () => {
  it('turns an OAuth invalid_grant into a reconnect instruction', () => {
    expect(describeSendError({ response: { status: 400, data: { error: 'invalid_grant' } } }, 'oauth')).toContain(
      'reconnect this sending account',
    );
  });

  it('uses service-account advice for a service account', () => {
    expect(describeSendError({ message: 'invalid_grant' }, 'service_account')).toContain(
      'domain-wide delegation',
    );
  });

  it('keeps the provider status and message for ordinary failures', () => {
    expect(describeSendError({ response: { status: 403, data: { error: { message: 'quota exceeded' } } } })).toBe(
      '403 quota exceeded',
    );
  });

  it('handles string errors', () => {
    expect(describeSendError('network down')).toBe('network down');
  });
});
