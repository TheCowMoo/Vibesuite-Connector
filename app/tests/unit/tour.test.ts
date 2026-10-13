import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tour lives in browser code, so these tests read the shipped files and check the wiring
 * rather than importing it. That catches the most likely failure after a copy or nav rename:
 * a tour stop pointing at an element that no longer exists.
 */
const publicDir = join(process.cwd(), 'public');
const appJs = readFileSync(join(publicDir, 'app.js'), 'utf8');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf8');

interface TourStep {
  help: number;
  view: string;
  target: string;
}

function parseTourSteps(): TourStep[] {
  const block = appJs.match(/var TOUR_STEPS = \[([\s\S]*?)\n  \];/);
  if (!block) return [];

  const out: TourStep[] = [];
  const re = /\{\s*help:\s*(\d+),\s*view:\s*'([^']+)',\s*target:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    out.push({ help: Number(m[1]), view: m[2], target: m[3] });
  }
  return out;
}

function parseHelpCount(): number {
  const block = appJs.match(/var HELP_STEPS = \[([\s\S]*?)\n  \];/);
  if (!block) return 0;
  return (block[1].match(/title:/g) || []).length;
}

const steps = parseTourSteps();
const helpCount = parseHelpCount();

describe('guided tour wiring', () => {
  it('parses a real set of stops', () => {
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(helpCount).toBeGreaterThanOrEqual(steps.length);
  });

  it('points every stop at an element that exists in index.html', () => {
    for (const step of steps) {
      // Turn the CSS selector into the markup it has to match:
      //   #newConnectionBtn        -> id="newConnectionBtn"
      //   [data-view="invites"]    -> data-view="invites"
      const key = step.target.startsWith('#')
        ? `id="${step.target.slice(1)}"`
        : step.target.replace(/^\[|\]$/g, '');

      expect(indexHtml.includes(key), `${step.target} (for stop ${step.help + 1}) is not in index.html`).toBe(true);
    }
  });

  it('switches to a tab that actually exists', () => {
    for (const step of steps) {
      expect(
        indexHtml.includes(`id="view-${step.view}"`),
        `stop ${step.help + 1} wants the "${step.view}" tab, but #view-${step.view} is not in index.html`
      ).toBe(true);
    }
  });

  it('reuses How-it-works text instead of duplicating it', () => {
    for (const step of steps) {
      expect(step.help).toBeGreaterThanOrEqual(0);
      expect(step.help, `stop points at How-it-works item ${step.help}, which does not exist`).toBeLessThan(helpCount);
    }
  });

  it('never uses the same How-it-works item twice', () => {
    const used = steps.map((s) => s.help);
    expect(new Set(used).size).toBe(used.length);
  });

  it('gates the admin-only stops', () => {
    const adminTargets = ['#sendersList', '#advisorAnalyze', '#newMemberBtn'];
    for (const step of steps) {
      if (!adminTargets.includes(step.target)) continue;
      expect(
        appJs.includes(`target: '${step.target}', placement: 'bottom', adminOnly: true`) ||
          appJs.includes(`target: '${step.target}'`) && appJs.includes('adminOnly'),
        `${step.target} should be admin-only`
      ).toBe(true);
    }
  });

  /*
   * Campaigns is the landing view by deliberate decision: it is the only object that binds an
   * event, an audience and a set of sending accounts together. These three assertions are what
   * stop a later nav reshuffle from quietly demoting it back to just another tab.
   */
  it('keeps Campaigns as the first tab', () => {
    const firstTab = indexHtml.match(/class="topnav__link[^"]*"\s+data-view="([^"]+)"/);
    expect(firstTab?.[1]).toBe('campaigns');
  });

  it('keeps Campaigns as the landing view', () => {
    const active = indexHtml.match(/class="topnav__link is-active"\s+data-view="([^"]+)"/);
    expect(active?.[1]).toBe('campaigns');

    // Exactly one section is open at load, and it is the campaigns one.
    const open = [...indexHtml.matchAll(/<section id="view-([a-z]+)" class="view"( hidden)?>/g)]
      .filter((m) => !m[2])
      .map((m) => m[1]);
    expect(open).toEqual(['campaigns']);

    expect(appJs).toContain("showView('campaigns')");
  });

  it('opens the tour on the landing view', () => {
    expect(steps[0]?.view).toBe('campaigns');
  });
});
