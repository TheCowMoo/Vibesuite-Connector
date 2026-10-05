import { describe, it, expect } from 'vitest';
import { seal, open } from '../../src/lib/crypto';

describe('crypto (credentials encryption at rest)', () => {
  const key = 'test-encryption-key-123456';

  it('round-trips plaintext when a key is provided', () => {
    const ciphertext = seal('super-secret-token', key);
    expect(ciphertext).not.toBe('super-secret-token');
    expect(open(ciphertext, key)).toBe('super-secret-token');
  });

  it('returns plaintext unchanged when no key is provided', () => {
    expect(seal('plain', undefined)).toBe('plain');
    expect(open('plain', undefined)).toBe('plain');
  });

  it('throws when decrypting with the wrong key', () => {
    const ciphertext = seal('super-secret-token', key);
    expect(() => open(ciphertext, 'different-key')).toThrow();
  });

  it('throws when decrypting an encrypted value without a key', () => {
    const ciphertext = seal('super-secret-token', key);
    expect(() => open(ciphertext, undefined)).toThrow();
  });

  it('produces non-deterministic ciphertext (unique IV)', () => {
    const a = seal('super-secret-token', key);
    const b = seal('super-secret-token', key);
    expect(a).not.toBe(b);
  });
});
