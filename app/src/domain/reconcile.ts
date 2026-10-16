export interface ReconcileFailure {
  connectionId: string;
  message: string;
}

export interface ReconcileOutcome {
  attempted: number;
  failed: number;
  failures: ReconcileFailure[];
}

/**
 * Sweep a set of connections, never letting one failure stop the rest.
 *
 * Deliberately dependency-free — no Redis, no env, no logger, not even an import. The property that
 * actually breaks in production is "one unreachable connection aborts the whole catch-up pass, so
 * every other connection silently stops reconciling", and that is only testable if this module can
 * be imported without booting a config. The caller owns logging and metrics; this reports.
 */
export async function reconcileConnections(
  connectionIds: string[],
  sync: (connectionId: string) => Promise<void>,
): Promise<ReconcileOutcome> {
  const outcome: ReconcileOutcome = { attempted: 0, failed: 0, failures: [] };

  for (const connectionId of connectionIds) {
    outcome.attempted += 1;
    try {
      await sync(connectionId);
    } catch (err) {
      outcome.failed += 1;
      outcome.failures.push({
        connectionId,
        message: (err as Error)?.message ?? String(err),
      });
    }
  }

  return outcome;
}
