import { describe, expect, it } from 'vitest';
import {
  applyVerificationPolicy,
  estimateVerificationCostUsd,
  summarizeVerification,
} from '../../src/domain/emailVerificationPolicy';
import type { StoredEmailVerification } from '../../src/domain/emailVerificationStore';

function result(
  address: string,
  value: StoredEmailVerification['result'],
  risk: StoredEmailVerification['risk'] = 'low',
): StoredEmailVerification {
  return {
    address,
    result: value,
    risk,
    reasons: value === 'undeliverable' ? ['mailbox_does_not_exist'] : [],
    isEmailValid: value === 'deliverable',
    locationId: 'loc-1',
    checkedAt: 1,
  };
}

describe('email verification policy', () => {
  const emails = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com', 'f@x.com'];
  const results = new Map([
    ['a@x.com', result('a@x.com', 'deliverable')],
    ['b@x.com', result('b@x.com', 'undeliverable', 'high')],
    ['c@x.com', result('c@x.com', 'do_not_send', 'high')],
    ['d@x.com', result('d@x.com', 'catch_all', 'medium')],
    ['e@x.com', result('e@x.com', 'unknown')],
  ]);

  it('summarizes checked and unchecked addresses', () => {
    expect(summarizeVerification(emails, results)).toEqual({
      total: 6,
      checked: 5,
      deliverable: 1,
      undeliverable: 1,
      doNotSend: 1,
      catchAll: 1,
      unknown: 1,
      unchecked: 1,
    });
  });

  it('only removes undeliverable and do-not-send addresses', () => {
    const out = applyVerificationPolicy(emails, results);

    expect(out.excluded.undeliverable).toEqual(['b@x.com']);
    expect(out.excluded.doNotSend).toEqual(['c@x.com']);
    expect(out.allowed).toEqual(['a@x.com', 'd@x.com', 'e@x.com', 'f@x.com']);
    expect(out.warnings.join(' ')).toContain('1 undeliverable and 1 do-not-send');
    expect(out.warnings.join(' ')).toContain('1 catch-all and 1 unknown');
    expect(out.warnings.join(' ')).toContain('1 address has not been verified');
  });

  it('never blocks a valid email just because it is unverified', () => {
    const out = applyVerificationPolicy(['new@x.com'], new Map());
    expect(out.allowed).toEqual(['new@x.com']);
    expect(out.excluded.undeliverable).toEqual([]);
    expect(out.excluded.doNotSend).toEqual([]);
    expect(out.warnings.join(' ')).toContain('1 address has not been verified');
  });

  it('estimates GHL cost and rounds to four decimals', () => {
    expect(estimateVerificationCostUsd(0)).toBe(0);
    expect(estimateVerificationCostUsd(1)).toBe(0.0025);
    expect(estimateVerificationCostUsd(1000)).toBe(2.5);
    expect(estimateVerificationCostUsd(1234)).toBe(3.085);
  });
});
