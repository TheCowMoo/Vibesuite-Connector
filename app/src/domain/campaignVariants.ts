import type { Campaign, CopyVariant, CopyVariantId } from './campaign';

/**
 * Excel-style rank for a variant id: A=1, Z=26, AA=27, AB=28, … Unknown ids sort first.
 * Shared by the dispatcher, the stats table and `campaignVariants()` so order is identical.
 */
export function variantRank(id: string): number {
  let rank = 0;
  for (const ch of String(id).toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) continue;
    rank = rank * 26 + (code - 64);
  }
  return rank;
}

function byVariantOrder(a: CopyVariant, b: CopyVariant): number {
  return variantRank(a.id) - variantRank(b.id);
}

/**
 * The variants a campaign is actually sending. A campaign without `copyVariants` is one implicit A
 * variant built from the event copy, so every caller can use the same shape.
 */
export function campaignVariants(camp: Pick<Campaign, 'copyVariants' | 'event'>): CopyVariant[] {
  if (camp.copyVariants && camp.copyVariants.length) {
    return [...camp.copyVariants].sort(byVariantOrder);
  }
  return [{ id: 'A', summary: camp.event.summary, description: camp.event.description }];
}

/** Variants in calendar order (A, B, …, Z, AA, …), regardless of the order the operator added them. */
export function primaryVariant(camp: Pick<Campaign, 'copyVariants' | 'event'>): CopyVariant {
  return campaignVariants(camp)[0];
}

/**
 * Assign every email to a variant, round-robin and deterministic. The audience order is the list's
 * order, so the same frozen audience always produces the same split — no hidden randomness to explain
 * later, and every variant gets an even share (a difference of at most one).
 */
export function assignVariants(emails: string[], variants: CopyVariant[]): Record<string, CopyVariantId> {
  const usable = [...variants].sort(byVariantOrder);
  const out: Record<string, CopyVariantId> = {};
  if (!usable.length) return out;
  emails.forEach((email, index) => {
    out[email.trim().toLowerCase()] = usable[index % usable.length].id;
  });
  return out;
}

/** Group a mailbox's claimed emails by variant, preserving the queue's order inside each group. */
export function groupEmailsByVariant(
  emails: string[],
  variantByEmail: Record<string, string | undefined>,
  fallback: CopyVariantId,
  variants: CopyVariant[],
): Map<CopyVariantId, string[]> {
  const out = new Map<CopyVariantId, string[]>();
  for (const variant of [...variants].sort(byVariantOrder)) out.set(variant.id, []);
  const allowed = new Set(variants.map((v) => v.id));

  for (const email of emails) {
    const raw = variantByEmail[email.trim().toLowerCase()];
    const id = (raw && allowed.has(raw as CopyVariantId) ? raw : fallback) as CopyVariantId;
    if (!out.has(id)) out.set(id, []);
    out.get(id)?.push(email);
  }
  return out;
}

/**
 * Keep the legacy `event.summary`/`event.description` fields aligned with variant A. They are still
 * what cards, attendance labels and older clients read; variant A is also the operator's base copy.
 */
export function mirrorPrimaryVariant<
  T extends { event: { summary: string; description?: string }; copyVariants?: CopyVariant[] },
>(camp: T): T {
  if (!camp.copyVariants || !camp.copyVariants.length) return camp;
  const primary = [...camp.copyVariants].sort(byVariantOrder)[0];
  return {
    ...camp,
    event: {
      ...camp.event,
      summary: primary.summary,
      description: primary.description ?? camp.event.description,
    },
  };
}
