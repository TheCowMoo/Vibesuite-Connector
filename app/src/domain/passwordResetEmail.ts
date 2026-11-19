export interface PasswordResetEmailVars {
  name?: string;
  email: string;
  resetUrl: string;
  expiresAt: string;
}

export interface RenderedPasswordResetEmail {
  subject: string;
  html: string;
  text: string;
}

export const DEFAULT_PASSWORD_RESET_SUBJECT = 'Reset your Vibesuite password';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Dedicated password-reset email.
 *
 * Deliberately not the team-invite template: a reset email must never be confused with an invite,
 * and the reset token must not be run through a template an operator can edit into something unsafe.
 */
export function renderPasswordResetEmail(vars: PasswordResetEmailVars): RenderedPasswordResetEmail {
  const name = String(vars.name || vars.email).trim() || vars.email;
  const subject = DEFAULT_PASSWORD_RESET_SUBJECT;
  const text = [
    `Hi ${name},`,
    '',
    'Someone requested a password reset for your Vibesuite account.',
    '',
    `Set a new password: ${vars.resetUrl}`,
    '',
    `This link works once and expires on ${vars.expiresAt}.`,
    "If you didn't request this, you can ignore this email. Your password has not changed.",
  ].join('\n');

  const escapedUrl = escapeHtml(vars.resetUrl);
  let bodyHtml = escapeHtml(text);
  if (escapedUrl) {
    bodyHtml = bodyHtml.split(escapedUrl).join(`<a href="${escapedUrl}">${escapedUrl}</a>`);
  }
  bodyHtml = bodyHtml.replace(/\r?\n/g, '<br>');

  return {
    subject,
    text,
    html:
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1A1F36;max-width:560px">' +
      bodyHtml +
      '</div>',
  };
}
