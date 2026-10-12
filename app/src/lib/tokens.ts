import crypto from 'node:crypto';

/** URL-safe random token. Only the SHA-256 of this is ever stored. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
