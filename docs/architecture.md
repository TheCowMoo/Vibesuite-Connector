# Architecture Notes

See the top-level README for an overview. This file records the design decisions and the
spec-to-implementation mapping.

## Multi-tenancy model

A **connection** is the unit of tenancy, binding one Google Calendar to one GHL location. Each
connection stores its own auth (Google `oauth`/`service_account`, GHL `oauth`/`api_token`),
calendar id, location id, and optional webhook URLs. All runtime keys are namespaced by
`connectionId` (`conn:{id}:*`), and the Google watch channel maps back to a connection via
`watch:byChannel:{channelId}`.

## Data flow (async, event-driven)

1. Google Calendar POSTs an empty-body notification to `/webhooks/google/calendar` with all
   routing info in `X-Goog-*` headers.
2. `app-api` validates `X-Goog-Channel-Token` against the stored channel, resolves the channel to
   a **connection**, returns `200 OK`, and enqueues a per-connection `process-sync` BullMQ job.
3. `app-worker` loads the connection, acquires a per-connection Redis lock (`SET NX EX 5`) for
   dedupe, then:
   - full sync (`events.list` + `timeMin`) if no `nextSyncToken` exists, or
   - incremental sync (`events.list` + `syncToken`), handling `410 Gone` by resetting.
4. Attendee `responseStatus` is diffed against last-known state; only actual changes proceed.
5. Each change maps through the transform matrix and dispatches to GHL using that connection's
   credentials and webhook URLs.

## Redis keys

| Key | Purpose |
|---|---|
| `connections` | set of connection ids |
| `conn:{id}:meta` | connection metadata (no secrets) |
| `conn:{id}:secrets` | encrypted OAuth/API tokens (AES-256-GCM) |
| `conn:{id}:sync:token` | `nextSyncToken` |
| `conn:{id}:sync:state` | hash `eventId -> JSON{email:responseStatus}` |
| `conn:{id}:lock` | per-connection dedupe lock (`SET NX EX 5`) |
| `conn:{id}:dispatch:seen:{fp}` | idempotency guard for a dispatched change (5-min TTL) |
| `watch:byChannel:{channelId}` | channel metadata (connectionId, token, resourceId, expiry) |
| `conn:{id}:watch:channel` | connectionId -> channelId |
| `conn:{id}:map:event:{eventId}` | event -> `{appointmentId, contactId}` |
| `conn:{id}:map:contact:{email}` | email -> contactId cache (1h TTL) |
| `oauth:state:{state}` | pending OAuth state -> connectionId (10-min TTL) |
| `sender:profile:{conn}` | per-mailbox load profile (cap, hourly, delay, ramp, window) |
| `sender:day:{conn}:{YYYY-MM-DD}` | hash `sent` / `failed` counters for the mailbox (35-day TTL) |
| `sender:hour:{conn}:{YYYY-MM-DDTHH}` | hourly send counter (3-hour TTL) |
| `sender:state:{conn}` | health state: `errorStreak`, `cooldownUntil`, `lastSentAt`, `lastError` |
| `campaign:{id}` | campaign record (audience, event, senders, distribution, status) |
| `campaign:{id}:recipients` | hash `email -> JSON{connectionId,status,sentAt,eventId,error}` |
| `campaign:{id}:queue:{conn}` | list of pending emails assigned to that mailbox |
| `campaign:{id}:sender:{conn}` | hash `sent` / `failed` for that mailbox inside the campaign |
| `campaign:{id}:dispatch:{email}` | idempotency guard: a recipient is invited once per campaign (30-day TTL) |
| `advisor:analysis` | latest Advisor analysis (snapshot + label→id targets + recommendations) |
| `advisor:applyLog` | append-only audit of every Apply, newest first (200 max) |

## Senders & campaigns

A **Sender** is a connected Google account plus a load profile: `dailyCap`, `hourlyCap`,
`minDelayMs`, an optional warming **ramp** (`startDailyCap` + `incrementPerDay` + `maxDailyCap`
from a start date), a **send window** (hours + weekdays + IANA timezone, evaluated with Node's
built-in `Intl.DateTimeFormat`) and a health state with an automatic **cooldown** after repeated
failures. Limits are **per mailbox and global** — every campaign drawing on that mailbox shares one
counter. `dailyCapFor()` always clamps the ramp value to `dailyCap`, so raising the ramp can never
exceed the hard ceiling.

A **Campaign** freezes an audience (`listId` + optional segment names), an event payload
(title/description/start/end/timezone and an optional Zoom join link resolved from the linked
session) and a list of sending mailboxes. `startCampaign()` extracts and de-duplicates recipients,
drops anyone already invited for that list, then partitions them with `computeAllocation()` —
a weighted-share split honouring per-sender `quota`, with the rounding remainder handed out
round-robin and the result assigned with `allocateEmails()` so each mailbox's queue is interleaved
from the source order rather than a contiguous block.

`sendCampaignBatch()` then sends at most one batch per mailbox, bounded by
`min(headroom, maxPerSender, queueLength)`. Each recipient is claimed with a `SET NX` key before
it is included, so a retry can never double-invite. Successes bump the mailbox day/hour counters,
the campaign counters and the list's invited set; failures mark the recipients, increment the
sender `errorStreak`, and are re-queued at the front so another mailbox (or the next tick) can pick
them up. Once `errorStreak` reaches `CAMPAIGN_COOLDOWN_ON_ERRORS` the mailbox enters a
`CAMPAIGN_COOLDOWN_HOURS` cooldown and is skipped until it expires or an operator hits Resume.
The campaign flips to `completed` when no mailbox has work left. `planSchedule()` powers the
capacity planner by walking day by day and summing each mailbox's cap for that date.

### Distribution engine

`startCampaignScheduler()` runs inside the sync worker as a self-rescheduling loop
(`CAMPAIGN_TICK_INTERVAL_MS` + up to 10% jitter), and a tick is never started while the previous
one is still running. Each tick collects every mailbox that has queued campaign work and calls
`runMailbox()` once per mailbox, so **a mailbox is treated as one shared, rate-limited resource**
rather than one queue per campaign.

`orderClaims()` ranks a mailbox's campaigns by campaign priority then age, and `allocateBatch()`
gives every campaign an equal slice of the mailbox's allowance before letting leftover capacity
flow back down the priority order — a huge high-priority campaign cannot starve a small one, and
the small one still finishes. `senderReadiness()` derives the allowance from the daily headroom,
the hourly headroom, the send window and any cooldown; `dueForNextBatch()` then enforces
`minDelayMs` between batches so sends are never back-to-back.

After the send pass, `redistributeStranded()` moves queued recipients off mailboxes that cannot
progress (paused, or inside a cooldown) onto healthy mailboxes in the same campaign, so a single
bad mailbox never strands a campaign — the cooled mailbox simply refills on its own once its
cooldown lapses. `finalizeIfDone()` then flips the campaign to `completed` when every queue is
drained. Operators can bypass the pacing (but never the caps) for one mailbox with
`POST /api/senders/:connectionId/send-now`.

### Stats & attribution

`buildCampaignStats()` is pure: it folds the frozen recipient records, the per-mailbox Google RSVP
state (`conn:{id}:sync:state`, read via `stateStore.getStates()`) and the linked session's Zoom
attendance into one funnel — invited → sent/failed/queued → accepted/declined/tentative/no-reply →
attended/no-show — and emits the same numbers broken down **per sending mailbox**. Every figure is
attributable to the mailbox that actually created the calendar event, because each recipient row
keeps its `connectionId` and `eventId`. Rates are real percentages of real denominators
(`rsvpRate = (accepted + declined + tentative) / sent`, `attendanceRate = attended / (accepted +
tentative)`), never estimates. Bounce/open metrics are intentionally absent until the GHL reminder
layer exists.

## Advisor

The Advisor tab is advisory-only: `analyzeAdvisor()` builds a **PII-free aggregate snapshot**,
asks the configured AI provider for recommendations, and stores the result. It never changes
anything by itself — every change requires the operator to press Apply.

`collectAdvisorSnapshot()` replaces identities with labels: connections become `Account A/B/C` and
campaigns become `Campaign 1/2/3`. The snapshot carries mailbox load settings, today's counters, a
14-day daily history and per-campaign funnel aggregates. It deliberately omits addresses, display
names, domains, campaign/list/session names, event titles and copy, recipient records and any
credentials. `SNAPSHOT_APPENDIX` publishes that list verbatim in the UI, so an operator can audit
exactly what the model received. The label → real-id mapping lives in `analysis.targets` on the
server and is never sent to the provider.

Recommendations come from two sources: the model (ids `ai-*`) and `localRecommendations()` (ids
`local-*`), a deterministic rule set for cooldowns, paused mailboxes, hour-ceiling stalls, clean
full days, >10% failure rates and single-mailbox campaigns. The rules keep the tab useful when no
AI key is configured, and the two sources are merged so a provider outage degrades instead of
breaking.

Every model-proposed action is passed through `clampAdvisorAction()`, which rejects unknown kinds
and clamps every number into the same bounds the manual UI enforces (daily cap 1–5000, hourly cap
1–1000, delay 0–600000 ms, hours 0–23, weekday subset of 0–6, priority 0–10, status
`active|paused`). An action that fails to clamp is downgraded to advisory-only rather than applied.
Apply resolves the label back to the real id, mutates the sender profile or campaign, marks the
recommendation `applied` and appends a line to the append-only `advisor:applyLog`. "Ask a
follow-up" is grounded on the stored snapshot and is ephemeral — the server keeps no transcript.

## Security model

- **Webhook authentication**: the only reliable Google push validation is the
  `X-Goog-Channel-Token` (a per-connection random secret set at `events.watch` time and verified on
  every inbound call). There is no published static IP allowlist for Calendar push.
- **Credential storage**: OAuth refresh/access tokens and API keys are AES-256-GCM encrypted at
  rest in Redis using `CREDENTIALS_ENCRYPTION_KEY`. Without that key, tokens are stored in
  plaintext (dev fallback only).
- **Transport**: Nginx terminates TLS; only the internal `app-api` port is proxied.

## Phase mapping

- **Phase 1 (MVP)**: single calendar, hardcoded keys, ingestion + delta sync + GHL status/tags. ✅
- **Phase 2**: webhook branches, DND/suppression + audit note, idempotency + backoff hardening,
  observability (metrics). ✅
- **Phase 3**: OAuth 2.0 multi-tenant, per-connection credentials, connection API + dashboard,
  encrypted credential store. ✅
- **Phase 4**: invitations + segmentation, AI provider layer, knowledge base, video attendance
  (Zoom meetings/webinars), attendance automations dispatched to GHL. ✅
- **Phase 5**: auth/team login (scrypt, Redis sessions, roles), audit log, sender load profiles,
  campaigns + distribution engine, capacity planner, per-mailbox attribution, AI Advisor. 🚧
- **Phase 6 (next)**: GHL reminder layer → real delivered/bounced/opened stats.
## Reliability & idempotency

- **Burst dedupe**: per-connection `SET NX EX 5` lock prevents concurrent delta fetches.
- **Dispatch idempotency**: each change is fingerprinted from
  `(connection, event, email, prevStatus, newStatus, event.updated)`. A
  `conn:{id}:dispatch:seen:{fp}` key (`SET NX`, 5-min TTL) prevents re-dispatch on BullMQ retry;
  released on failure so retries can proceed. GHL mutations carry an `Idempotency-Key` header.
- **Backoff**: GHL client retries 429/5xx with exponential backoff + jitter, honoring `Retry-After`,
  and refreshes OAuth access tokens on `401`.

## Observability

- Structured JSON logs via pino (`LOG_LEVEL`).
- Prometheus-style counters (no external deps), exposed at:
  - `app-api` `/metrics` — ingestion (received/rejected/enqueued).
  - `app-worker` `/metrics` on `METRICS_PORT` — sync runs, RSVP dispatches by status, duplicates,
    GHL errors, watch renewals.


## Where the app starts

`Campaigns` is the **landing view** (`startPanel()` calls `load()` then `showView('campaigns')`) and
the first nav tab, because it is the only object that binds an event, an audience, a set of sending
accounts and an optional video call together — and the only one that owns per-recipient state
(`campaign:{id}:recipients`).

It **references** rather than owns everything around it, which matters when reading the code:

- A **connection** is shared. Its `sender:profile` caps are global, so every campaign drawing on
  that mailbox shares one counter; a campaign's `quota`/`share` only split *within that campaign*
  (`allocateBatch()` then arbitrates one mailbox's allowance across campaigns).
- A **contact list** records everyone it has ever invited in `list:{id}:invited`, shared with the
  one-off Invitations path. A person is therefore invited **once per contact list** across all
  campaigns — not once per campaign.
- `startCampaign()` reads the list's segmentation, so deleting a list leaves a campaign that cannot
  start; deleting a session only drops the join link.

Because the tab is reachable before anything exists, `campaignPrereq()` renders a card naming the
missing piece (no active account, then no sorted list) with a button through to the right tab. It
deliberately leaves `#campaignNew` visible, because that is the tour's opening target.

### The shell

Navigation lives in a **left rail** (`.rail`, `--rail-w: 224px`) grouped by plain labels: Campaigns
and Invitations first, then *Set up* (Google accounts, Contact lists, Sending accounts, Documents),
*Insights* (Who attended, Assistant) and *Workspace* (People, Settings). A slim `.topbar` carries
only the brand and the help/account menus. Below 900px the rail flattens into a horizontal scrolling
strip and the group labels hide.

The groups are **labels, not disclosure widgets**, and that is load-bearing: the guided tour targets
rail buttons by `[data-view]`, and a collapsed group would make its children zero-sized — which
`tourPaint()` reads as "nothing to point at" and skips silently. Keep the groups open and every stop
stays real.

## Words we use in the UI

The interface deliberately uses plain words rather than the engineering vocabulary. The data model,
API routes and Redis keys keep their original names, so use this table when reading code or logs:

| The UI says | Code says |
|---|---|
| Google accounts | `connection`, `/api/connections`, `conn:{id}:*` |
| Contact lists | `list`, `/api/lists`, `list:{id}` |
| Documents | `knowledge`, `/api/knowledge` |
| Invitations | `invite`, `/api/invites`, `list:{id}:invited` |
| Who attended | `session`, `attendance`, `/api/sessions`, `attendance:{sessionId}` |
| Campaigns | `campaign`, `/api/campaigns`, `campaign:{id}` |
| Sending accounts | `sender`, `/api/senders`, `sender:*` |
| Assistant | `advisor`, `/api/advisor`, `advisor:analysis` |
| People | `team`, `users`, `/api/team` |
| "max per day" | `dailyCap` |
| "max per hour" | `hourlyCap` |
| "pause between batches" | `minDelayMs` |
| "warm up slowly" | `mode: 'ramp'` |
| "sending hours" | `window` |
| "resting" | cooldown (`cooling`, `cooldownUntil`) |
| "still available" | headroom |
| "what happened" | funnel |
| "per sending account" | per-sender attribution |

Two rules keep this safe, and both are load-bearing:

1. **Display strings only.** Renaming what a label says must never rename the thing. API payloads,
   Redis keys and stored JSON keep their original field names.
2. **Never rename a wire value.** `accepted`, `declined`, `tentative`, `needsAction`, `rsvp-yes`,
   `partial`, `confirmed` and `cancelled` are Google and GoHighLevel contract values. The UI maps
   them to "yes / no / maybe / no reply" at render time (`campaignStats.ts`, plus `STATUS` and
   `REASON_LABELS` in `app.js`). Renaming one of these values would silently break RSVP sync or GHL
   tagging, so `transform.test.ts`, `dedupe.test.ts` and `campaignStats.test.ts` assert on them
   unchanged — they are the guardrail.

## Built-in guide

Two pieces of in-app help keep the plain wording explainable:

- **How it works** (`#howItWorks`) is an 11-item prose list driven by the `HELP_STEPS` array in
  `app.js`.
- **The guided tour** (`#tourRoot`) is a hand-rolled spotlight walkthrough: a fixed overlay whose
  cutout is positioned to the target's `getBoundingClientRect()`, dimming the rest of the page with
  a large `box-shadow`. No dependency, no `localStorage` requirement — it works in private mode too
  (it just won't remember that you finished).

`TOUR_STEPS` holds only `view` + `target` + `placement` and reuses `HELP_STEPS` by index, so the
tour text and the written guide cannot drift apart. The tour opens on **Campaigns** — the landing
view — and walks the prerequisites after it. `placement` follows the shell: rail stops use `'right'`
so the card sits beside the item, page-content stops use `'top'`/`'bottom'`. `tourPlace()` degrades
a `'right'` stop to `'bottom'` below 900px, where the rail lies flat. Stops that need a tab call
`showView()` and re-measure on the next frame via `requestAnimationFrame`. Admin-only stops carry
`adminOnly: true` and are filtered out for members, matching the rail gating. A stop whose target is
missing or zero-sized (closed group, empty panel) is skipped rather than floating a tooltip at nothing.

`tests/unit/tour.test.ts` reads the shipped `app.js` and `index.html` and asserts that every tour
target exists in the markup, every tab exists, and every `help` index is real — which is what
catches a stop pointing at an element that a later rename removed.

