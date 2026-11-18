import { percent } from './campaignStats';
import {
  COPY_FEATURE_KEYS,
  COPY_FEATURE_LABELS,
  extractCopyFeatures,
  type CopyFeatureKey,
} from './copyFeatures';

export interface CopyPatternRow {
  campaignId: string;
  variant: string;
  summary: string;
  description?: string;
  sent: number;
  accepted: number;
  tentative: number;
  attended: number;
  hasAttendance: boolean;
}

export interface CopyPatternSide {
  variants: number;
  campaigns: number;
  sent: number;
  accepted: number;
  acceptanceRate: number;
  yesBase: number;
  yesRate: number;
  showUpBase: number;
  showUpRate: number | null;
}

export interface CopyPattern {
  key: CopyFeatureKey;
  label: string;
  present: CopyPatternSide;
  absent: CopyPatternSide;
}

export interface CopyPatterns {
  generatedAt: number;
  campaigns: number;
  variants: number;
  patterns: CopyPattern[];
  note: string;
}

interface Accumulator {
  variants: number;
  campaigns: Set<string>;
  sent: number;
  accepted: number;
  yesBase: number;
  attended: number;
  showUpBase: number;
}

function emptyAccumulator(): Accumulator {
  return {
    variants: 0,
    campaigns: new Set<string>(),
    sent: 0,
    accepted: 0,
    yesBase: 0,
    attended: 0,
    showUpBase: 0,
  };
}

function toSide(value: Accumulator): CopyPatternSide {
  return {
    variants: value.variants,
    campaigns: value.campaigns.size,
    sent: value.sent,
    accepted: value.accepted,
    acceptanceRate: percent(value.accepted, value.sent),
    yesBase: value.yesBase,
    yesRate: percent(value.accepted, value.yesBase),
    showUpBase: value.showUpBase,
    showUpRate: value.showUpBase ? percent(value.attended, value.showUpBase) : null,
  };
}

/**
 * Aggregate copy features against accepted/yes/show-up outcomes across campaigns.
 *
 * Observational only: different campaigns have different audiences, events and timing. The output
 * always carries sample sizes and is never used as an automatic winner.
 */
export function aggregateCopyPatterns(
  rows: CopyPatternRow[],
  now = Date.now(),
  limit = 16,
): CopyPatterns {
  const buckets = new Map<
    CopyFeatureKey,
    { present: Accumulator; absent: Accumulator }
  >();
  for (const key of COPY_FEATURE_KEYS) {
    buckets.set(key, { present: emptyAccumulator(), absent: emptyAccumulator() });
  }

  const campaignIds = new Set<string>();
  let variants = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.sent) || row.sent <= 0) continue;
    const features = extractCopyFeatures({ summary: row.summary, description: row.description });
    campaignIds.add(row.campaignId);
    variants += 1;
    const expected = Math.max(0, row.accepted + row.tentative);

    for (const key of COPY_FEATURE_KEYS) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const side = features[key] ? bucket.present : bucket.absent;
      side.variants += 1;
      side.campaigns.add(row.campaignId);
      side.sent += row.sent;
      side.accepted += row.accepted;
      side.yesBase += expected;
      if (row.hasAttendance) {
        side.attended += row.attended;
        side.showUpBase += expected;
      }
    }
  }

  const patterns: CopyPattern[] = [];
  for (const key of COPY_FEATURE_KEYS) {
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const present = toSide(bucket.present);
    const absent = toSide(bucket.absent);
    if (!present.sent || !absent.sent) continue;
    patterns.push({
      key,
      label: COPY_FEATURE_LABELS[key],
      present,
      absent,
    });
  }

  patterns.sort(
    (a, b) =>
      b.present.sent + b.absent.sent - (a.present.sent + a.absent.sent) ||
      a.label.localeCompare(b.label),
  );

  return {
    generatedAt: now,
    campaigns: campaignIds.size,
    variants,
    patterns: patterns.slice(0, Math.max(1, limit)),
    note: 'Observational patterns from other campaigns, not a controlled test and not causal. Different audiences, events and timing can explain the difference; current-campaign evidence takes priority.',
  };
}
