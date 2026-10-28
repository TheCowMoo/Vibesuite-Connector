import type { SessionType } from './types';

export interface ZoomCallId {
  id: string;
  /** Set only when the input itself proves the kind (a `/w/` or `/register/` link). */
  kind?: SessionType;
  /** True when the input was a link and had to be reduced to its ID. */
  fromUrl: boolean;
}

const NUMERIC = /^\d{9,11}$/;
/** Zoom UUIDs are base64-ish and may start with `/` (recurring occurrences). */
const UUIDISH = /^\/?[A-Za-z0-9._=+/-]{15,}$/;

function withoutSeparators(value: string): string {
  return value.replace(/[\s-]/g, '');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Accept what operators actually paste: a numeric meeting/webinar ID, a join link, a `/w/` or
 * `/register/` link, or a UUID (Zoom wants that for a recurring occurrence).
 *
 * A plain `/j/` link is treated as kind-unknown on purpose: Zoom uses it for both meetings and
 * webinars, and guessing there would break the one case that matters.
 *
 * Returns `null` when nothing usable can be extracted — a registration *token* link, for example,
 * carries no ID and cannot be used for reports.
 */
export function normalizeZoomCallId(input: string | undefined | null): ZoomCallId | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  const plain = withoutSeparators(raw);
  if (NUMERIC.test(plain)) return { id: plain, fromUrl: false };

  // UUIDs stay as they are: they are what Zoom needs for a recurring occurrence.
  if (!raw.includes('://') && UUIDISH.test(raw) && /[A-Za-z]/.test(raw)) {
    return { id: raw, fromUrl: false };
  }

  if (!/zoom\.us\//i.test(raw)) return null;

  const decoded = safeDecode(raw);
  // Only the path can hold the ID: `us02web.zoom.us` itself is a 15+ character run that would
  // otherwise be mistaken for a UUID.
  const path = decoded.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const kind: SessionType | undefined = /\/(?:w|wc|webinar|register)\//i.test(path) ? 'webinar' : undefined;

  // Prefer the number that follows a known join or registration marker.
  const marked = /\/(?:w|wc|j|meeting|webinar|register)\/(?:[A-Za-z0-9._-]+\/)?(\d{9,11})(?:[/?#]|$)/i.exec(path);
  if (marked) return { id: marked[1], kind, fromUrl: true };

  // Otherwise take the first ID-shaped run in the link (tracking prefixes, short domains, …).
  const any = /(\d{9,11})/.exec(path);
  if (any) return { id: any[1], kind, fromUrl: true };

  // No UUID fallback here: join and registration links carry numeric IDs or unusable tokens, and a
  // base64 UUID's `/` characters would swallow the rest of the path.
  return null;
}

/** The opposite kind, used when a stored type turns out to be wrong. */
export function otherType(type: SessionType): SessionType {
  return type === 'webinar' ? 'meeting' : 'webinar';
}
