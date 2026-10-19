export const INVITE_PLACEHOLDERS = ['name', 'email', 'role', 'invitedBy', 'expiresAt', 'inviteUrl'] as const;

export type InvitePlaceholder = (typeof INVITE_PLACEHOLDERS)[number];

export interface InviteTemplate {
  subject: string;
  body: string;
}

export const DEFAULT_INVITE_TEMPLATE: InviteTemplate = {
  subject: "You're invited to Vibesuite",
  body: [
    'Hi {{name}},',
    '',
    '{{invitedBy}} has invited you to Vibesuite as {{role}}.',
    '',
    'Accept the invitation: {{inviteUrl}}',
    '',
    'This link works once and expires on {{expiresAt}}.',
    "If you weren't expecting this, you can ignore this email.",
  ].join('\n'),
};

const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Placeholders a template uses, in first-seen order, duplicates collapsed. */
export function templatePlaceholders(template: InviteTemplate): string[] {
  const seen = new Set<string>();
  for (const text of [template.subject, template.body]) {
    for (const match of text.matchAll(TOKEN_RE)) seen.add(match[1]);
  }
  return Array.from(seen);
}

/** Placeholders the template uses that we have no value for — almost always a typo. */
export function unknownPlaceholders(template: InviteTemplate): string[] {
  const known = new Set<string>(INVITE_PLACEHOLDERS);
  return templatePlaceholders(template).filter((p) => !known.has(p));
}

export interface InviteTemplateProblem {
  field: 'subject' | 'body';
  message: string;
}

/**
 * Everything that would make an operator's template unusable, checked at save time.
 *
 * The `{{inviteUrl}}` rule is the important one: without the link the email cannot be acted on, and
 * it would look like it sent fine.
 */
export function validateInviteTemplate(template: InviteTemplate): InviteTemplateProblem[] {
  const problems: InviteTemplateProblem[] = [];

  if (!template.subject.trim()) problems.push({ field: 'subject', message: 'Add a subject line.' });
  if (!template.body.trim()) problems.push({ field: 'body', message: 'Add a body.' });

  if (template.body.trim() && !templatePlaceholders({ subject: '', body: template.body }).includes('inviteUrl')) {
    problems.push({ field: 'body', message: 'Your email must include {{inviteUrl}} — without it nobody can accept.' });
  }

  const unknown = unknownPlaceholders(template);
  if (unknown.length) {
    problems.push({
      field: 'body',
      message:
        'Unknown placeholder' + (unknown.length === 1 ? ': ' : 's: ') +
        unknown.map((u) => `{{${u}}}`).join(', ') +
        '. Available: ' + INVITE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ') + '.',
    });
  }

  return problems;
}

export interface InviteEmailVars {
  name?: string;
  email?: string;
  role?: string;
  invitedBy?: string;
  expiresAt?: string;
  inviteUrl: string;
}

export interface RenderedInviteEmail {
  subject: string;
  html: string;
  text: string;
}

function substitute(text: string, vars: InviteEmailVars): string {
  return text.replace(TOKEN_RE, (whole: string, name: string) => {
    const value = (vars as unknown as Record<string, string | undefined>)[name];
    return value === undefined ? whole : value;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Fill the template in and produce both an HTML and a plain-text body.
 *
 * The body is treated as **plain text**: it is escaped first, then the invite URL inside it is
 * turned into a link. That ordering is deliberate — neither an operator's template nor a
 * recipient's display name can inject markup into a mail sent on their behalf.
 */
export function renderInviteEmail(template: InviteTemplate, vars: InviteEmailVars): RenderedInviteEmail {
  const subject = substitute(template.subject, vars).replace(/[\r\n]+/g, ' ').trim();
  const text = substitute(template.body, vars);

  const escapedUrl = escapeHtml(vars.inviteUrl || '');
  let bodyHtml = escapeHtml(text);

  if (escapedUrl) {
    bodyHtml = bodyHtml.split(escapedUrl).join(`<a href="${escapedUrl}">${escapedUrl}</a>`);
  }
  bodyHtml = bodyHtml.replace(/\r?\n/g, '<br>');

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1A1F36;max-width:560px">' +
    bodyHtml +
    '</div>';

  return { subject, html, text };
}
