import { describe, expect, it } from 'vitest';
import { PASSWORD_MIN_LENGTH, passwordProblem, passwordProblems } from '../../src/domain/passwordPolicy';

describe('password policy', () => {
  it('requires the shared minimum length', () => {
    expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toContain(String(PASSWORD_MIN_LENGTH));
    expect(passwordProblem('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('rejects the account email and display name', () => {
    expect(passwordProblem('person@example.com', { email: 'person@example.com' })).toContain('email');
    expect(passwordProblem('Alex Example', { name: 'Alex Example' })).toContain('display name');
  });

  it('returns every applicable problem', () => {
    expect(passwordProblems('short', { email: 'short' })).toEqual([
      'password must be at least 12 characters',
      'password cannot be the account email address',
    ]);
  });
});
