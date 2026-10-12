import type { Recommendation } from './advisorActions';
import type { AdvisorSnapshot } from './advisorSnapshot';

export interface AdvisorTargets {
  mailboxes: Array<{ label: string; connectionId: string }>;
  campaigns: Array<{ label: string; id: string }>;
}

export interface AdvisorAnalysis {
  createdAt: number;
  provider: string | null;
  model: string | null;
  summary: string;
  note?: string;
  snapshot: AdvisorSnapshot;
  /** Label -> real id. Server-side only; never sent to the model. */
  targets: AdvisorTargets;
  recommendations: Recommendation[];
}

export interface ApplyLogEntry {
  at: number;
  recommendationId: string;
  title: string;
  description: string;
  actor?: string;
  ok: boolean;
  error?: string;
}
