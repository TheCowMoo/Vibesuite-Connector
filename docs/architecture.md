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

`collectAdvisorSnapshot()` replaces identities with labels: connections become `Mailbox A/B/C` and
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

