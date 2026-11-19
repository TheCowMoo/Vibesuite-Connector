import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/lib/tokens';
import type { UserRecord } from '../../src/domain/authStore';

const mocks = vi.hoisted(() => ({
  consumePasswordReset: vi.fn(),
  getInvite: vi.fn(),
  getUser: vi.fn(),
  listInvites: vi.fn(),
  getUserByEmail: vi.fn(),
  savePasswordReset: vi.fn(),
  saveUser: vi.fn(),
  deletePasswordReset: vi.fn(),
  deleteUserLogins: vi.fn(),
  pushAudit: vi.fn(),
  sendSystemEmail: vi.fn(),
}));

vi.mock('../../src/domain/authStore', () => ({
  countUsers: vi.fn(),
  createInvite: vi.fn(),
  createLogin: vi.fn(),
  createUser: vi.fn(),
  consumePasswordReset: mocks.consumePasswordReset,
  deleteInvite: vi.fn(),
  deleteLogin: vi.fn(),
  deletePasswordReset: mocks.deletePasswordReset,
  deletePasswordResetForUser: vi.fn(),
  deleteUser: vi.fn(),
  deleteUserLogins: mocks.deleteUserLogins,
  findInviteByTokenHash: vi.fn(),
  getInvite: mocks.getInvite,
  getLogin: vi.fn(),
  getLoginAttempts: vi.fn(),
  getUser: mocks.getUser,
  getUserByEmail: mocks.getUserByEmail,
  listInvites: mocks.listInvites,
  listUsers: vi.fn(),
  bumpLoginAttempts: vi.fn(),
  clearLoginAttempts: vi.fn(),
  pushAudit: mocks.pushAudit,
  saveInvite: vi.fn(),
  savePasswordReset: mocks.savePasswordReset,
  saveUser: mocks.saveUser,
}));

vi.mock('../../src/domain/systemEmail', () => ({ sendSystemEmail: mocks.sendSystemEmail }));
vi.mock('../../src/domain/systemEmailSettings', () => ({
  resolveSystemEmailSettings: vi.fn().mockResolvedValue({ fromEmail: 'info@example.com', fromName: 'Vibesuite' }),
}));

import {
  createAdminPasswordReset,
  listTeamInvites,
  requestPasswordReset,
  resetPassword,
  revokeInvite,
} from '../../src/domain/auth';

const user: UserRecord = {
  id: 'u1',
  email: 'ada@example.com',
  emailLower: 'ada@example.com',
  name: 'Ada',
  role: 'member',
  status: 'active',
  passwordHash: 'old-hash',
  createdAt: 1,
};

function resetRecord(overrides: Record<string, unknown> = {}) {
  return {
    tokenHash: sha256('token-1'),
    userId: user.id,
    emailLower: user.emailLower,
    issuedAt: 100,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUser.mockResolvedValue({ ...user });
  mocks.consumePasswordReset.mockResolvedValue(resetRecord());
  mocks.saveUser.mockResolvedValue(undefined);
  mocks.savePasswordReset.mockResolvedValue(undefined);
  mocks.deletePasswordReset.mockResolvedValue(undefined);
  mocks.deleteUserLogins.mockResolvedValue(undefined);
  mocks.pushAudit.mockResolvedValue(undefined);
  mocks.sendSystemEmail.mockResolvedValue({ ok: true, via: 'ghl' });
});

describe('resetPassword', () => {
  it('changes the password, invalidates sessions and consumes the link', async () => {
    const out = await resetPassword('token-1', 'a long enough password');

    expect(out.id).toBe(user.id);
    expect(mocks.saveUser).toHaveBeenCalledWith(
      expect.objectContaining({
        passwordHash: expect.stringMatching(/^scrypt\$/),
        passwordChangedAt: expect.any(Number),
      }),
    );
    expect(mocks.deleteUserLogins).toHaveBeenCalledWith(user.id);
    expect(mocks.deletePasswordReset).toHaveBeenCalledWith(sha256('token-1'), user.id);
    expect(mocks.pushAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset_completed' }),
    );
  });

  it('rejects an expired link', async () => {
    mocks.consumePasswordReset.mockResolvedValue(resetRecord({ expiresAt: Date.now() - 1 }));

    await expect(resetPassword('token-1', 'a long enough password')).rejects.toThrow('invalid or has expired');
    expect(mocks.deletePasswordReset).toHaveBeenCalled();
    expect(mocks.saveUser).not.toHaveBeenCalled();
  });

  it('rejects a link issued before the last password change', async () => {
    mocks.getUser.mockResolvedValue({ ...user, passwordChangedAt: 200 });

    await expect(resetPassword('token-1', 'a long enough password')).rejects.toThrow('invalid or has expired');
    expect(mocks.saveUser).not.toHaveBeenCalled();
  });

  it('rejects disabled accounts and weak passwords', async () => {
    mocks.getUser.mockResolvedValueOnce({ ...user, status: 'disabled' });
    await expect(resetPassword('token-1', 'a long enough password')).rejects.toThrow('invalid or has expired');

    mocks.getUser.mockResolvedValueOnce({ ...user });
    await expect(resetPassword('token-1', 'short')).rejects.toThrow('12 characters');
  });

  it('returns the same generic error for an unknown token', async () => {
    mocks.consumePasswordReset.mockResolvedValue(null);
    await expect(resetPassword('missing', 'a long enough password')).rejects.toThrow('invalid or has expired');
  });
});

describe('requestPasswordReset', () => {
  it('issues and emails a reset link for an active account', async () => {
    mocks.getUserByEmail.mockResolvedValue({ ...user });

    const out = await requestPasswordReset('ada@example.com', 'https://connect.example.com', '1.2.3.4');

    expect(out.requested).toBe(true);
    expect(mocks.savePasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        emailLower: user.emailLower,
        requestedIp: '1.2.3.4',
      }),
      expect.any(Number),
    );
    expect(mocks.sendSystemEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        subject: expect.stringContaining('Reset'),
      }),
    );
    expect(mocks.pushAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset_requested' }),
    );
  });

  it('does nothing for a missing or disabled account', async () => {
    mocks.getUserByEmail.mockResolvedValueOnce(null);
    expect(await requestPasswordReset('missing@example.com', 'https://connect.example.com')).toEqual({
      requested: false,
    });

    mocks.getUserByEmail.mockResolvedValueOnce({ ...user, status: 'disabled' });
    expect(await requestPasswordReset('ada@example.com', 'https://connect.example.com')).toEqual({
      requested: false,
    });
    expect(mocks.savePasswordReset).not.toHaveBeenCalled();
    expect(mocks.sendSystemEmail).not.toHaveBeenCalled();
  });
});

describe('createAdminPasswordReset', () => {
  it('lets an owner generate a link without sending mail', async () => {
    const owner: UserRecord = { ...user, id: 'owner-1', email: 'owner@example.com', role: 'owner' };
    mocks.getUser.mockResolvedValueOnce({ ...user });

    const out = await createAdminPasswordReset(owner, user.id, 'https://connect.example.com', false);

    expect(out.resetUrl).toContain('/reset-password?token=');
    expect(out.expiresAt).toBeGreaterThan(Date.now());
    expect(out.delivery).toBeUndefined();
    expect(mocks.savePasswordReset).toHaveBeenCalled();
    expect(mocks.pushAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'password_reset_link_created' }),
    );
  });

  it('requires the target account to be active', async () => {
    const owner: UserRecord = { ...user, id: 'owner-1', email: 'owner@example.com', role: 'owner' };
    mocks.getUser.mockResolvedValue({ ...user, status: 'disabled' });

    await expect(
      createAdminPasswordReset(owner, user.id, 'https://connect.example.com', false),
    ).rejects.toThrow('enable the account');
    expect(mocks.savePasswordReset).not.toHaveBeenCalled();
  });

  it('stops an admin from resetting an owner', async () => {
    const admin: UserRecord = { ...user, id: 'admin-1', email: 'admin@example.com', role: 'admin' };
    mocks.getUser.mockResolvedValue({ ...user, role: 'owner' });

    await expect(
      createAdminPasswordReset(admin, user.id, 'https://connect.example.com', false),
    ).rejects.toThrow('admins can only manage members');
    expect(mocks.savePasswordReset).not.toHaveBeenCalled();
  });
});

describe('invite hierarchy', () => {
  const invites = [
    { id: 'i-owner', email: 'owner@example.com', role: 'owner', token: 't1', expiresAt: Date.now() + 1000 },
    { id: 'i-admin', email: 'admin@example.com', role: 'admin', token: 't2', expiresAt: Date.now() + 1000 },
    { id: 'i-member', email: 'member@example.com', role: 'member', token: 't3', expiresAt: Date.now() + 1000 },
  ];

  it('hides owner/admin invites from admins', async () => {
    mocks.listInvites.mockResolvedValue(invites);

    const visible = await listTeamInvites('https://connect.example.com', 'admin');

    expect(visible.map((i) => i.role)).toEqual(['member']);
  });

  it('shows all invites to owners', async () => {
    mocks.listInvites.mockResolvedValue(invites);

    const visible = await listTeamInvites('https://connect.example.com', 'owner');

    expect(visible.map((i) => i.role)).toEqual(['owner', 'admin', 'member']);
  });

  it('stops an admin from revoking an owner invite', async () => {
    mocks.getInvite.mockResolvedValue(invites[0]);

    await expect(
      revokeInvite('i-owner', { email: 'admin@example.com', role: 'admin' }),
    ).rejects.toThrow('admins can only manage members');
  });
});
