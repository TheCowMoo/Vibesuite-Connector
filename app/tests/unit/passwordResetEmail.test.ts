import { describe, expect, it } from 'vitest';
import { renderPasswordResetEmail } from '../../src/domain/passwordResetEmail';

describe('password reset email', () => {
  const vars = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    resetUrl: 'https://connect.example.com/reset-password?token=abc',
    expiresAt: '19 Nov 2026',
  };

  it('includes the one-time link and expiry in text and HTML', () => {
    const out = renderPasswordResetEmail(vars);
    expect(out.subject).toContain('Reset');
    expect(out.text).toContain(vars.resetUrl);
    expect(out.text).toContain(vars.expiresAt);
    expect(out.html).toContain(`<a href="${vars.resetUrl}">${vars.resetUrl}</a>`);
  });

  it('escapes a hostile display name', () => {
    const out = renderPasswordResetEmail({ ...vars, name: '<script>alert(1)</script>' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});
