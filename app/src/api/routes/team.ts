import axios from 'axios';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { listAudit, listUsers, publicUser, type UserRole, type UserStatus } from '../../domain/authStore';
import { createTeamInvite, listTeamInvites, removeUser, resendInvite, revokeInvite, setUserRole, setUserStatus } from '../../domain/auth';
import { getTeamSettings, saveTeamSettings, resolveInviteWebhookUrl } from '../../domain/teamSettings';
import {
  getSystemEmailSettings,
  saveSystemEmailSettings,
  resolveSystemEmailSettings,
  publicSystemEmailSettings,
  systemEmailConfigured,
  type SystemEmailSettings,
} from '../../domain/systemEmailSettings';
import { DEFAULT_INVITE_TEMPLATE, INVITE_PLACEHOLDERS, renderInviteEmail, validateInviteTemplate } from '../../domain/inviteEmail';
import { sendSystemEmail } from '../../domain/systemEmail';
import { getAuthUser, requireRole } from '../middleware/requireAuth';

const ROLES: UserRole[] = ['owner', 'admin', 'member'];

function describeErr(err: unknown): string {
  const e = err as { response?: { status?: number; data?: unknown }; message?: string };
  return e?.response?.status
    ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`
    : e?.message || 'unknown error';
}

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('owner', 'admin') };
  const baseUrl = (): string => env.OAUTH_BASE_URL;

  app.get('/api/team', guard, async () => {
    const users = await listUsers();
    const invites = await listTeamInvites(baseUrl());
    const settings = await getTeamSettings();
    return {
      users: users.map(publicUser),
      invites: invites
        .filter((i) => !i.acceptedAt && i.expiresAt > Date.now())
        .map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          invitedBy: i.invitedBy,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
          inviteUrl: i.inviteUrl,
        })),
      settings: { inviteWebhookUrl: settings.inviteWebhookUrl || env.TEAM_INVITE_WEBHOOK_URL || '' },
      audit: await listAudit(50),
    };
  });

  app.post('/api/team/invites', guard, async (req, reply) => {
    const b = req.body as { email?: string; role?: UserRole; name?: string };
    if (!b.email || !b.role || !ROLES.includes(b.role)) {
      reply.code(400).send({ error: 'email and a valid role are required' });
      return;
    }
    const actor = getAuthUser(req);
    try {
      const out = await createTeamInvite({
        email: b.email,
        role: b.role,
        name: b.name,
        invitedBy: actor?.email ?? 'unknown',
        baseUrl: baseUrl(),
      });
      return {
        ok: true,
        invite: { id: out.invite.id, email: out.invite.email, role: out.invite.role, expiresAt: out.invite.expiresAt },
        inviteUrl: out.inviteUrl,
        webhook: out.webhook,
      };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/team/invites/:id/resend', guard, async (req, reply) => {
    const out = await resendInvite((req.params as { id: string }).id, baseUrl());
    if (!out) {
      reply.code(404).send({ error: 'invite not found' });
      return;
    }
    return { ok: true, inviteUrl: out.inviteUrl, webhook: out.webhook };
  });

  app.delete('/api/team/invites/:id', guard, async (req) => {
    await revokeInvite((req.params as { id: string }).id);
    return { ok: true };
  });

  app.patch('/api/team/users/:id', guard, async (req, reply) => {
    const actor = getAuthUser(req);
    const id = (req.params as { id: string }).id;
    const b = req.body as { role?: UserRole; status?: UserStatus };
    try {
      if (b.role) {
        if (!ROLES.includes(b.role)) {
          reply.code(400).send({ error: 'invalid role' });
          return;
        }
        await setUserRole(actor?.email ?? 'unknown', id, b.role);
      }
      if (b.status) {
        if (b.status !== 'active' && b.status !== 'disabled') {
          reply.code(400).send({ error: 'invalid status' });
          return;
        }
        await setUserStatus(actor?.email ?? 'unknown', actor?.id ?? '', id, b.status);
      }
      return { ok: true };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/team/users/:id', guard, async (req, reply) => {
    const actor = getAuthUser(req);
    try {
      await removeUser(actor?.email ?? 'unknown', actor?.id ?? '', (req.params as { id: string }).id);
      return { ok: true };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/api/team/settings', guard, async () => {
    const s = await getTeamSettings();
    return { inviteWebhookUrl: s.inviteWebhookUrl || '', envDefault: env.TEAM_INVITE_WEBHOOK_URL || '' };
  });

  app.put('/api/team/settings', guard, async (req, reply) => {
    const b = req.body as { inviteWebhookUrl?: string };
    const url = (b.inviteWebhookUrl ?? '').trim();
    if (url && !/^https?:\/\//i.test(url)) {
      reply.code(400).send({ error: 'webhook URL must start with http:// or https://' });
      return;
    }
    await saveTeamSettings({ inviteWebhookUrl: url || undefined });
    return { ok: true, inviteWebhookUrl: url };
  });

  /* ---- System email (GoHighLevel) ----
   * Platform email only: team invites and account notices. Calendar invitations are never sent
   * from here — those go out through each connection's own Google account. */

  const sampleVars = () => ({
    name: 'Alex Example',
    email: 'alex@example.com',
    role: 'member',
    invitedBy: 'Vibesuite',
    expiresAt: '5 Nov 2026',
    inviteUrl: `${baseUrl().replace(/\/$/, '')}/invite?token=PREVIEW`,
  });

  const currentTemplate = (s: { subjectTemplate?: string; bodyTemplate?: string }) => ({
    subject: s.subjectTemplate || DEFAULT_INVITE_TEMPLATE.subject,
    body: s.bodyTemplate || DEFAULT_INVITE_TEMPLATE.body,
  });

  app.get('/api/team/system-email', guard, async () => {
    const resolved = await resolveSystemEmailSettings();
    return {
      configured: systemEmailConfigured(resolved),
      fromEmail: resolved.fromEmail,
      fromName: resolved.fromName,
      ...publicSystemEmailSettings(resolved),
      defaults: DEFAULT_INVITE_TEMPLATE,
      template: currentTemplate(resolved),
      placeholders: INVITE_PLACEHOLDERS,
    };
  });

  app.put('/api/team/system-email', guard, async (req, reply) => {
    const b = req.body as Partial<SystemEmailSettings> & { clearToken?: boolean };
    const existing = await getSystemEmailSettings();

    // Blank token keeps the stored one, so re-saving the form never wipes a credential.
    const apiToken = b.clearToken ? undefined : (b.apiToken || '').trim() || existing.apiToken;
    const locationId = ((b.locationId ?? existing.locationId) || '').trim() || undefined;
    const fromEmail = ((b.fromEmail ?? existing.fromEmail) || '').trim() || undefined;
    const fromName = ((b.fromName ?? existing.fromName) || '').trim() || undefined;

    if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) {
      reply.code(400).send({ error: 'The from address does not look like an email address.' });
      return;
    }
    // Half-configured is the failure mode that looks like nothing happened, so refuse it.
    if (Boolean(apiToken) !== Boolean(locationId)) {
      reply.code(400).send({ error: 'The API token and Location ID must be set together.' });
      return;
    }

    const subjectTemplate = typeof b.subjectTemplate === 'string' ? b.subjectTemplate.trim() || undefined : existing.subjectTemplate;
    const bodyTemplate = typeof b.bodyTemplate === 'string' ? b.bodyTemplate || undefined : existing.bodyTemplate;

    const problems = validateInviteTemplate(currentTemplate({ subjectTemplate, bodyTemplate }));
    if (problems.length) {
      reply.code(400).send({ error: problems.map((p) => p.message).join(' '), problems });
      return;
    }

    const next: SystemEmailSettings = { apiToken, locationId, fromEmail, fromName, subjectTemplate, bodyTemplate };
    await saveSystemEmailSettings(next);

    const resolved = await resolveSystemEmailSettings();
    return {
      ok: true,
      configured: systemEmailConfigured(resolved),
      ...publicSystemEmailSettings(next),
      fromEmail: resolved.fromEmail,
      fromName: resolved.fromName,
      template: currentTemplate(resolved),
    };
  });

  /** Render the saved (or in-editor) template with sample values. */
  app.post('/api/team/system-email/preview', guard, async (req) => {
    const b = (req.body || {}) as { subjectTemplate?: string; bodyTemplate?: string };
    const stored = await getSystemEmailSettings();
    const rendered = renderInviteEmail(
      currentTemplate({
        subjectTemplate: b.subjectTemplate ?? stored.subjectTemplate,
        bodyTemplate: b.bodyTemplate ?? stored.bodyTemplate,
      }),
      sampleVars(),
    );
    return { subject: rendered.subject, html: rendered.html, text: rendered.text };
  });

  /** Send the rendered template to the signed-in admin, proving connection and template at once. */
  app.post('/api/team/system-email/test', guard, async (req, reply) => {
    const me = getAuthUser(req);
    if (!me?.email) {
      reply.code(400).send({ error: 'no signed-in address to send the test to' });
      return;
    }

    const resolved = await resolveSystemEmailSettings();
    const rendered = renderInviteEmail(currentTemplate(resolved), { ...sampleVars(), email: me.email });
    const res = await sendSystemEmail({
      to: me.email,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    });
    return { ...res, to: me.email };
  });

  app.post('/api/team/settings/test', guard, async () => {
    const url = await resolveInviteWebhookUrl();
    if (!url) return { ok: false, detail: 'no invite webhook configured' };
    try {
      await axios.post(
        url,
        {
          type: 'team_invite_test',
          subject: 'Vibesuite invite webhook test',
          inviteUrl: `${baseUrl().replace(/\/$/, '')}/invite?token=TEST`,
          timestamp: new Date().toISOString(),
        },
        { timeout: 15000 }
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: describeErr(err) };
    }
  });
}
