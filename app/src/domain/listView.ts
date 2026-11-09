import type { ListRecord, ListSummary } from './listStore';
import type { ListSegmentationStatus } from './listSegmentStore';

export interface PreviewSegment {
  name: string;
  reason?: string;
  count: number;
  rows: unknown[];
}

export interface ResultPreview {
  segments: PreviewSegment[];
  truncated: boolean;
}

export interface PublicSegmentationStatus {
  status: ListSegmentationStatus['status'];
  totalRows: number;
  processedRows: number;
  totalBatches: number;
  processedBatches: number;
  error?: string;
  warnings?: string[];
  startedAt?: number;
  finishedAt?: number;
}

export function publicSegmentationStatus(status: ListSegmentationStatus | null): PublicSegmentationStatus | null {
  if (!status) return null;
  return {
    status: status.status,
    totalRows: status.totalRows,
    processedRows: status.processedRows,
    totalBatches: status.totalBatches,
    processedBatches: status.processedBatches,
    ...(status.error ? { error: status.error } : {}),
    ...(status.warnings?.length ? { warnings: status.warnings } : {}),
    ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    ...(status.finishedAt ? { finishedAt: status.finishedAt } : {}),
  };
}

/**
 * Keep the list-management payload small. The full result remains in Redis for campaigns and
 * invitations, but the UI only needs segment names, counts, and a few preview rows.
 */
export function previewSegmentationResult(result: unknown, limit = 25): ResultPreview | null {
  if (result == null) return null;
  const raw = (result as { segments?: unknown }).segments;
  if (!Array.isArray(raw)) return null;

  let truncated = false;
  const segments: PreviewSegment[] = raw.map((value, index) => {
    const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const rows = Array.isArray(candidate.rows) ? (candidate.rows as unknown[]) : [];
    if (rows.length > limit) truncated = true;
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : `Segment ${index + 1}`;
    const reason = typeof candidate.reason === 'string' ? candidate.reason : '';
    return {
      name,
      ...(reason ? { reason } : {}),
      count: rows.length,
      rows: rows.slice(0, limit),
    };
  });

  return { segments, truncated };
}

export function listView(rec: ListRecord, status: ListSegmentationStatus | null): Record<string, unknown> {
  return {
    id: rec.id,
    name: rec.name,
    criteria: rec.criteria,
    rowCount: rec.rowCount ?? null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    hasResult: rec.result != null,
    segmentation: publicSegmentationStatus(status),
    result: previewSegmentationResult(rec.result),
  };
}

export function listSummaryView(
  summary: ListSummary,
  status: ListSegmentationStatus | null,
): Record<string, unknown> {
  return {
    id: summary.id,
    name: summary.name,
    criteria: summary.criteria,
    rowCount: summary.rowCount,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    hasResult: summary.hasResult,
    segmentation: publicSegmentationStatus(status),
  };
}
