import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INVITE_TEMPLATE,
  INVITE_PLACEHOLDERS,
  renderInviteEmail,
  templatePlaceholders,
  unknownPlaceholders,
  validateInviteTemplate,
} from '../../src/domain/inviteEmail';

const vars = {
  name: 'Delynn Miller',
  email: 'delynn@example.com',
  role: 'admin',
  invitedBy: 'Nathanael',
  expiresAt: '5 Nov 2026',
  inviteUrl: 'https://connect.vibesuite.io/invite?token=abc123',
};

const tpl = (body: string, subject = 'Subject') => ({ subject, body });

describe('validateInviteTemplate', () => {
  it('accepts the shipped default', () => {
    expect(validateInviteTemplate(DEFAULT_INVITE_TEMPLATE)).toEqual([]);
  });

  it('rejects a body with no invite link', () => {
    const problems = validateInviteTemplate(tpl('Hi {{name}}, welcome aboard.'));
    expect(problems.map((p) => p.message).join(' ')).toMatch(/must include \{\{inviteUrl\}\}/);
  });

  it('rejects empty subject and body', () => {
    expect(validateInviteTemplate({ subject: '  ', body: '' })).toHaveLength(2);
  });

  it('names unknown placeholders instead of ignoring them', () => {
    const problems = validateInviteTemplate(tpl('Hi {{nane}}, {{inviteUrl}}'));
    expect(problems[0].message).toContain('{{nane}}');
  });
});

describe('templatePlaceholders', () => {
  it('lists every placeholder once, across subject and body', () => {
    expect(templatePlaceholders({ subject: 'Hi {{name}}', body: '{{name}} {{inviteUrl}}' })).toEqual([
      'name',
      'inviteUrl',
    ]);
  });

  it('tolerates spacing inside the braces', () => {
    expect(templatePlaceholders(tpl('{{  inviteUrl  }}'))).toEqual(['inviteUrl']);
  });

  it('knows every advertised placeholder', () => {
    expect(unknownPlaceholders(DEFAULT_INVITE_TEMPLATE)).toEqual([]);
    expect(INVITE_PLACEHOLDERS).toContain('inviteUrl');
  });
});

describe('renderInviteEmail', () => {
  it('fills every placeholder', () => {
    const out = renderInviteEmail(DEFAULT_INVITE_TEMPLATE, vars);
    expect(out.text).toContain('Delynn Miller');
    expect(out.text).toContain('Nathanael');
    expect(out.text).toContain('admin');
    expect(out.text).toContain('5 Nov 2026');
    expect(out.text).not.toContain('{{');
  });

  it('turns the invite URL into a link', () => {
    const out = renderInviteEmail(tpl('Join: {{inviteUrl}}'), vars);
    expect(out.html).toContain(`<a href="${vars.inviteUrl}">${vars.inviteUrl}</a>`);
  });

  it('converts newlines to line breaks', () => {
    expect(renderInviteEmail(tpl('one\ntwo {{inviteUrl}}'), vars).html).toContain('one<br>two');
  });

  /*
   * The reason this is a pure module: a display name is operator/auth-supplied data going into HTML
   * we send on their behalf. It must never become markup.
   */
  it('escapes a hostile display name', () => {
    const out = renderInviteEmail(tpl('Hi {{name}}, {{inviteUrl}}'), { ...vars, name: '<script>alert(1)</script>' });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('leaves an unknown placeholder untouched rather than blanking it', () => {
    const out = renderInviteEmail(tpl('{{nane}} {{inviteUrl}}'), vars);
    expect(out.text).toContain('{{nane}}');
  });

  it('keeps the subject on one line', () => {
    expect(renderInviteEmail({ subject: 'a\nb', body: '{{inviteUrl}}' }, vars).subject).toBe('a b');
  });
});
