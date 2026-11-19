export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 200;

export interface PasswordContext {
  email?: string;
  name?: string;
}

/**
 * Shared policy for every place a password is created.
 *
 * Length is the only hard requirement; forcing symbols/numbers tends to produce predictable
 * substitutions. Context checks stop the most obvious account-specific passwords.
 */
export function passwordProblems(password: unknown, context: PasswordContext = {}): string[] {
  const value = String(password ?? '');
  const problems: string[] = [];
  if (value.length < PASSWORD_MIN_LENGTH) {
    problems.push(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    problems.push(`password must be ${PASSWORD_MAX_LENGTH} characters or fewer`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized && context.email && normalized === context.email.trim().toLowerCase()) {
    problems.push('password cannot be the account email address');
  }
  if (normalized && context.name && normalized === context.name.trim().toLowerCase()) {
    problems.push('password cannot be your display name');
  }
  return problems;
}

export function passwordProblem(password: unknown, context: PasswordContext = {}): string | null {
  return passwordProblems(password, context)[0] ?? null;
}

export const PASSWORD_POLICY_HINT = `At least ${PASSWORD_MIN_LENGTH} characters`;
