import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a secret. Returns the plaintext unchanged when no key is provided
 * (dev/fallback). Provide CREDENTIALS_ENCRYPTION_KEY in production.
 */
export function seal(plaintext: string, key?: string): string {
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(key), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function open(ciphertext: string, key?: string): string {
  if (!ciphertext.startsWith('v1:')) return ciphertext;
  if (!key) throw new Error('encryption key required to decrypt credentials (CREDENTIALS_ENCRYPTION_KEY)');
  const [, ivB64, tagB64, dataB64] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv(ALGO, deriveKey(key), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
