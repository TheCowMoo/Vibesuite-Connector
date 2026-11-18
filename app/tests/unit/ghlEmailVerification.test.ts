import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ghlRequestMock } = vi.hoisted(() => ({ ghlRequestMock: vi.fn() }));
vi.mock('../../src/ghl/client', () => ({ ghlRequest: ghlRequestMock }));

import { describeGhlVerificationError, verifyEmailWithGhl } from '../../src/ghl/emailVerification';

const conn = {
  id: 'conn-1',
  ghlAuthType: 'api_token',
  ghlApiToken: 'token',
  ghlLocationId: 'loc-1',
} as const;

describe('verifyEmailWithGhl', () => {
  beforeEach(() => ghlRequestMock.mockReset());

  it('calls the v3 endpoint and normalizes a mailbox failure', async () => {
    ghlRequestMock.mockResolvedValue({
      result: 'undeliverable',
      risk: 'high',
      reason: ['mailbox_does_not_exist'],
      address: 'Person@Example.com',
      leadConnectorRecommendation: { isEmailValid: false },
    });

    const out = await verifyEmailWithGhl(conn, ' Person@Example.com ');

    expect(ghlRequestMock).toHaveBeenCalledWith(
      conn,
      {
        method: 'POST',
        url: '/email/verify',
        params: { locationId: 'loc-1' },
        data: { type: 'email', verify: 'person@example.com' },
      },
      { version: 'v3' },
    );
    expect(out).toMatchObject({
      address: 'person@example.com',
      result: 'undeliverable',
      risk: 'high',
      reasons: ['mailbox_does_not_exist'],
      isEmailValid: false,
      locationId: 'loc-1',
    });
    expect(out.checkedAt).toBeGreaterThan(0);
  });

  it('keeps unknown results and missing reasons distinct', async () => {
    ghlRequestMock.mockResolvedValue({ result: 'mystery', risk: 'nope', address: '' });

    const out = await verifyEmailWithGhl(conn, 'person@example.com');

    expect(out.result).toBe('unknown');
    expect(out.risk).toBe('unknown');
    expect(out.reasons).toEqual([]);
    expect(out.isEmailValid).toBe(false);
  });

  it('accepts a string reason and catch_all', async () => {
    ghlRequestMock.mockResolvedValue({ result: 'catch_all', risk: 'medium', reason: 'catch_all' });

    const out = await verifyEmailWithGhl(conn, 'person@example.com');

    expect(out.result).toBe('catch_all');
    expect(out.reasons).toEqual(['catch_all']);
  });

  it('requires an email and a location id before spending a check', async () => {
    await expect(verifyEmailWithGhl(conn, '  ')).rejects.toThrow('email address is required');
    await expect(verifyEmailWithGhl({ ...conn, ghlLocationId: '' }, 'a@b.com')).rejects.toThrow(
      'GHL location id is missing',
    );
    expect(ghlRequestMock).not.toHaveBeenCalled();
  });
});

describe('describeGhlVerificationError', () => {
  const error = (status: number, message = 'provider detail') =>
    Object.assign(new Error('request failed'), { response: { status, data: { message } } });

  it('tells the operator how to fix scope and provider problems', () => {
    expect(describeGhlVerificationError(error(403))).toContain('lc-email.readonly');
    expect(describeGhlVerificationError(error(402))).toContain('wallet');
    expect(describeGhlVerificationError(error(400))).toContain('LC Email or Mailgun');
    expect(describeGhlVerificationError(error(401))).toContain('reconnect GHL');
  });

  it('keeps provider detail for ordinary failures', () => {
    expect(describeGhlVerificationError(error(500, 'mailbox provider exploded'))).toContain(
      'mailbox provider exploded',
    );
  });
});
