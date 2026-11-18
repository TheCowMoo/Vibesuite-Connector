import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import type { GhlEmailVerification } from '../ghl/emailVerification';

/** The normalized result GHL returned for one address, cached across lists/campaigns. */
export type StoredEmailVerification = GhlEmailVerification;

const CACHE_TTL_SECONDS = env.EMAIL_VERIFY_CACHE_DAYS * 24 * 60 * 60;

export function normalizeVerificationEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function parse(raw: string | null | undefined): StoredEmailVerification | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredEmailVerification;
    if (!value || typeof value !== 'object') return null;
    if (!value.address || !value.result || !value.risk) return null;
    if (typeof value.checkedAt !== 'number') return null;
    return {
      ...value,
      address: normalizeVerificationEmail(value.address),
      reasons: Array.isArray(value.reasons) ? value.reasons : [],
      isEmailValid: value.isEmailValid === true,
    };
  } catch {
    return null;
  }
}

export async function getCachedEmailVerification(email: string): Promise<StoredEmailVerification | null> {
  const normalized = normalizeVerificationEmail(email);
  if (!normalized) return null;
  return parse(await redis.get(REDIS_KEYS.emailVerifyCache(normalized)));
}

/** Batch cache read. Returns one map keyed by normalized email. */
export async function getCachedEmailVerifications(
  emails: string[],
): Promise<Map<string, StoredEmailVerification>> {
  const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
  const out = new Map<string, StoredEmailVerification>();
  if (!unique.length) return out;

  const values = await redis.mget(unique.map((email) => REDIS_KEYS.emailVerifyCache(email)));
  unique.forEach((email, index) => {
    const value = parse(values[index]);
    if (value) out.set(email, value);
  });
  return out;
}

export async function saveCachedEmailVerification(result: StoredEmailVerification): Promise<void> {
  const email = normalizeVerificationEmail(result.address);
  if (!email) return;
  await redis.set(
    REDIS_KEYS.emailVerifyCache(email),
    JSON.stringify({ ...result, address: email }),
    'EX',
    CACHE_TTL_SECONDS,
  );
}

export async function saveCachedEmailVerifications(
  results: StoredEmailVerification[],
): Promise<void> {
  if (!results.length) return;
  const pipe = redis.pipeline();
  for (const result of results) {
    const email = normalizeVerificationEmail(result.address);
    if (!email) continue;
    pipe.set(
      REDIS_KEYS.emailVerifyCache(email),
      JSON.stringify({ ...result, address: email }),
      'EX',
      CACHE_TTL_SECONDS,
    );
  }
  await pipe.exec();
}
