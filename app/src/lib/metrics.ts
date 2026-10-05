export type MetricType = 'counter';

interface Counter {
  help: string;
  values: Map<string, number>;
}

const counters = new Map<string, Counter>();

export function defineCounter(name: string, help: string): void {
  if (!counters.has(name)) counters.set(name, { help, values: new Map() });
}

function labelKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k].replace(/"/g, '\\"')}"`)
    .join(',');
}

export function inc(name: string, labels: Record<string, string> = {}, by = 1): void {
  const c = counters.get(name);
  if (!c) return;
  const key = labelKey(labels);
  c.values.set(key, (c.values.get(key) ?? 0) + by);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, c] of counters) {
    lines.push(`# HELP ${name} ${c.help}`);
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of c.values) {
      lines.push(`${name}${key ? `{${key}}` : ''} ${value}`);
    }
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

// --- Standard counters (registered once per process) ---
defineCounter('webhook_received_total', 'Total Google Calendar push notifications received.');
defineCounter('webhook_rejected_total', 'Total push notifications rejected by validation.');
defineCounter('jobs_enqueued_total', 'Total sync jobs enqueued.');
defineCounter('jobs_enqueue_failed_total', 'Total sync jobs that failed to enqueue.');
defineCounter('sync_processed_total', 'Total sync runs completed, by type (full/incremental).');
defineCounter('sync_errors_total', 'Total sync runs that failed.');
defineCounter('rsvp_dispatched_total', 'Total RSVP changes dispatched to GHL, by status.');
defineCounter('rsvp_duplicates_skipped_total', 'Total duplicate dispatches skipped.');
defineCounter('ghl_errors_total', 'Total GHL dispatch errors, by status.');
defineCounter('watch_renewals_total', 'Total watch channel renewals.');
defineCounter('watch_renewal_errors_total', 'Total watch channel renewal failures.');
