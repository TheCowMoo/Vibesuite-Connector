/**
 * Curated copy guidance for Copy Coach.
 *
 * This is deliberately a built-in reference rather than a user-editable knowledge document: it
 * keeps the safety/experiment-design notes available even on a fresh install. It is guidance to
 * weigh, not a hard rulebook. Campaign evidence and the operator always take priority.
 */
export const CURATED_COPY_BEST_PRACTICES: string[] = [
  'A calendar invitation is read in a crowded inbox and a busy calendar. Say who it is for, what they will get, and why it matters now.',
  'Prefer a concrete, specific promise over hype. Avoid guarantees, invented scarcity, and claims the knowledge base does not support.',
  'One clear action is better than several competing asks. The calendar already shows the date, time and location.',
  'The description is shared by every recipient. There is no safe recipient-name merge token for Calendar invitations.',
  'Short subjects are easier to scan, but there is no universal character limit; show the trade-off rather than blocking a suggestion.',
  'Test one variable at a time where possible. If subject and description both change, the result is directional rather than causal.',
  'Small samples are noisy. Report the sample size and confidence; do not declare a winner from a handful of sends.',
  'A high yes rate with poor show-up can mean the copy attracted low-intent replies. Treat acceptance, yes quality and attendance as separate outcomes.',
  'Attendance is affected by event timing, reminders, calendar conflicts, audience quality and the Zoom link, not copy alone.',
  'Do not optimize for opens or clicks: the system does not measure them. The observable outcomes are RSVP and Zoom attendance.',
  'If the evidence is weak, the best recommendation may be to keep the current copy and collect more data.',
];

export const COPY_COACH_PRIVACY = {
  sends: [
    'Current campaign copy (subject and description)',
    'Aggregate campaign and per-variant performance totals',
    'List criteria/name and retrieved knowledge-base notes',
    'Built-in copy guidance',
  ],
  neverSends: [
    'Recipient emails, names, phone numbers or individual replies',
    'Raw contact-list rows',
    'Account/domain identity or credentials',
    'Per-person Zoom behaviour',
  ],
} as const;
