import { describe, expect, it } from 'vitest';
import { canAssignRole, canManageUser } from '../../src/domain/userRoles';

describe('user role hierarchy', () => {
  it('lets owners manage every role', () => {
    expect(canManageUser('owner', 'owner')).toBe(true);
    expect(canManageUser('owner', 'admin')).toBe(true);
    expect(canManageUser('owner', 'member')).toBe(true);
    expect(canAssignRole('owner', 'owner')).toBe(true);
    expect(canAssignRole('owner', 'admin')).toBe(true);
  });

  it('lets admins manage members only', () => {
    expect(canManageUser('admin', 'member')).toBe(true);
    expect(canManageUser('admin', 'admin')).toBe(false);
    expect(canManageUser('admin', 'owner')).toBe(false);
    expect(canAssignRole('admin', 'member')).toBe(true);
    expect(canAssignRole('admin', 'admin')).toBe(false);
    expect(canAssignRole('admin', 'owner')).toBe(false);
  });

  it('gives members no management rights', () => {
    expect(canManageUser('member', 'member')).toBe(false);
    expect(canAssignRole('member', 'member')).toBe(false);
  });
});
