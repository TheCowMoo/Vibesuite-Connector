import { getConnection } from './connectionStore';
import { getSenderGauge } from './senderStore';
import { senderReadiness } from './campaignSchedule';
import type { AccountAllowance } from './invitePlan';

export interface AccountCapacity extends AccountAllowance {
  name: string;
}

/**
 * How much each chosen account can still send right now, and why not when it can't.
 *
 * The same `senderReadiness()` the campaign scheduler uses, so the numbers shown before a send are
 * the numbers the send itself honours. These counters are per *mailbox*, not per feature, so any
 * campaigns running on the same account share this budget — an invite sent here consumes it.
 */
export async function accountAllowances(connectionIds: string[], now: Date): Promise<AccountCapacity[]> {
  return Promise.all(
    connectionIds.map(async (connectionId) => {
      const conn = await getConnection(connectionId);
      const name = conn?.name || connectionId;
      if (!conn) return { connectionId, name, allowance: 0, reason: 'account not found' };
      if (conn.status !== 'active') return { connectionId, name, allowance: 0, reason: 'not connected to Google' };

      const gauge = await getSenderGauge(connectionId, now);
      const readiness = senderReadiness({
        enabled: gauge.profile.enabled,
        inWindow: gauge.inWindow,
        coolingUntil: gauge.state.cooldownUntil,
        now: now.getTime(),
        capToday: gauge.capToday,
        sentToday: gauge.sentToday,
        hourlyCap: gauge.profile.hourlyCap,
        sentThisHour: gauge.sentThisHour,
        // Sending invitations is an explicit act, not scheduled pacing — the send window exists to
        // spread a bulk campaign, so it must not grey out a one-off send at 9pm. Caps and cooldowns
        // below still apply, so an account with no headroom is still refused.
        ignoreWindow: true,
      });

      return readiness.ready
        ? { connectionId, name, allowance: readiness.allowance }
        : { connectionId, name, allowance: 0, reason: readiness.reason };
    }),
  );
}
