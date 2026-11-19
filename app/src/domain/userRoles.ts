import type { UserRole } from './authStore';

/**
 * Role hierarchy for team administration.
 *
 * Owners manage everyone. Admins manage members only, so an admin cannot promote themselves or
 * anyone else to owner/admin, disable an owner, or reset an owner's password.
 */
export function canManageUser(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole === 'member';
  return false;
}

/** A role can only be assigned if the actor outranks it (or is an owner). */
export function canAssignRole(actorRole: UserRole, targetRole: UserRole): boolean {
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole === 'member';
  return false;
}

export function roleDeniedMessage(actorRole: UserRole): string {
  return actorRole === 'admin'
    ? 'admins can only manage members'
    : 'you do not have permission to manage that user';
}
