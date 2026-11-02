import { describe, it, expect } from 'vitest';
import { planEventGroups } from '../../src/domain/inviteEventPlan';
import { assignVariants, groupEmailsByVariant } from '../../src/domain/campaignVariants';

const emails = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}@x.com`);

describe('planEventGroups', () => {
  it('puts the whole account slice on one event', () => {
    expect(planEventGroups(emails(250), { maxAttendees: 3000 })).toEqual([emails(250)]);
  });

  it('caps an explicit scheduled round at batchSize', () => {
    const groups = planEventGroups(emails(250), { batchSize: 100, maxAttendees: 3000 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(100);
  });

  it('splits only at the provider guest ceiling', () => {
    const groups = planEventGroups(emails(3001), { maxAttendees: 3000 });
    expect(groups.map((g) => g.length)).toEqual([3000, 1]);
  });

  it('makes one event per active copy variant', () => {
    const variants = [
      { id: 'A', summary: 'First' },
      { id: 'B', summary: 'Second' },
    ];
    const list = emails(250);
    const variantByEmail = assignVariants(list, variants);
    const grouped = groupEmailsByVariant(list, variantByEmail, 'A', variants);
    const plan = variants.map((v) => planEventGroups(grouped.get(v.id) ?? [], { maxAttendees: 3000 }));

    expect(plan).toHaveLength(2);
    expect(plan[0]).toEqual([list.filter((_, i) => i % 2 === 0)]);
    expect(plan[1]).toEqual([list.filter((_, i) => i % 2 === 1)]);
  });

  it('returns no event for an empty slice', () => {
    expect(planEventGroups([], { maxAttendees: 3000 })).toEqual([]);
  });
});
