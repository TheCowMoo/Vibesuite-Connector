# Architecture Notes

See the top-level README for an overview. This file records the design decisions and the
spec-to-implementation mapping. For how to *use* the panel (setup, invitations, campaigns,
reading the numbers), see [`USING.md`](USING.md).

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
   a **connection**, returns `200 OK` *before* enqueuing (see the sweep in step 6 for why that
   ordering needs a safety net), and enqueues a per-connection `process-sync` BullMQ job.
3. `app-worker` loads the connection, acquires a per-connection Redis lock (`SET NX EX 5`) for
   dedupe, then:
   - full sync (`events.list` + `timeMin`) if no `nextSyncToken` exists, or
   - incremental sync (`events.list` + `syncToken`), handling `410 Gone` by resetting.
4. Attendee `responseStatus` is diffed against last-known state; only actual changes proceed.
5. Each change maps through the transform matrix and dispatches to GHL using that connection's
   credentials and webhook URLs.
6. **Safety net.** A reconciliation sweep (`scheduler/reconcile.ts`) calls `processSync()` for every
   active connection — every `SYNC_RECONCILE_INTERVAL_MS` (default 15 min, `0` disables) and once at
   worker startup. Since step 2 answers Google *before* it enqueues, a dropped notification or a
   failed enqueue has no retry path; the sweep is what recovers it. `processSync()` is idempotent (a
   per-connection lock, a state diff, and a `SET NX` dispatch claim), so an unchanged connection is a
   cheap no-op, and a sweep overlapping a live sync skips that connection rather than double-sending.
   One failing connection never aborts the pass (`domain/reconcile.ts` — the loop is dependency-free
   so exactly that property is unit-tested).

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

### Scheduling and ending

A campaign can also be **`scheduled`** (begin later) and **`ended`** (stopped for good).
`campaignTickAction()` (`domain/campaignLifecycle.ts`) is the single place that decision lives, kept
pure so the edges are testable: a `scheduled` campaign with no start time never fires, an `active`
campaign with no deadline never auto-ends, and only `active` is subject to the deadline — except that
a `scheduled` campaign whose deadline lapsed before it ever started (a worker outage spanning the
whole window) is **ended** rather than activated, because freezing an audience that is no longer
allowed to receive anything would be pure waste.

The audience is frozen at **activation**, not at scheduling time, so anyone invited elsewhere in the
meantime is correctly skipped. `runCampaignTick()` applies the lifecycle *before* the send pass, so the
send pass only ever sees campaigns that should genuinely be sending. A scheduled campaign whose audience
turns out to be empty when it activates is flipped to `paused` with `lastError` rather than retried
silently on every tick — a scheduled failure that nobody can see is worse than a visible pause.

**Start and stop are independent.** `resolveSendPlan()` (`domain/campaignLifecycle.ts`) validates the
pair for both the wizard and the API: a start must be in the future, a stop must be after the start.
Choosing "as soon as I press Begin sending" still keeps the stop time — it is sent with the create
call and stored on the draft, so the later Begin sending press is bounded by it. That was the gap that
made the feature look unfinished: the wizard used to return early on the not-scheduled path and drop
the stop time entirely.

The deadline can also be set, changed or cleared on its own with
`POST /api/campaigns/:id/deadline` (`{ sendByAt }`, `null` clears it), for any campaign that has not
finished. `startCampaign()` and `sendCampaignBatch()` both refuse to run once `sendByAt` has passed
(`startBlockedByDeadline()`), so a manual batch cannot slip invitations out between the deadline and
the next tick. `startCampaign()` also clears `scheduledStartAt` and `endCampaign()` clears it, so a
consumed start never lingers in the UI.

Pace versus deadline is computed server-side by `invitedByDeadline()` (`domain/campaign.ts`) against
day-end **timestamps**, not date strings: the old `toISOString().slice(0, 10)` comparison moved a late
evening deadline to the next UTC day and mis-warned by one day. `POST /api/campaigns/plan-preview`
runs the same `buildAudience()` + `planSchedule()` for a campaign that does not exist yet, which is
what the wizard's "When it will finish" line shows.

Ending leaves the queues intact: `counts.pending` keeps reporting who never went out, and those people
stay uninvited (`list:{id}:invited` never recorded them), so a follow-up campaign picks them up. It is
**not** a recall — invitations already sent remain in people's calendars.

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

## Video calls and join links

Sessions reference a provider (`zoom` is the only implemented one) and an external id. The Zoom
integration is **read-only and retrospective**: every call it makes is a `GET`, and nearly all of them
are `/report/*`, which only exist after the session has ended. It cannot create, edit, start or list
webinars.

### Two Zoom authorisation modes

`zoomAuthMode` in the video settings picks how a token is obtained. It defaults to **`user`** (the
General App). Server-to-server is still selectable, and it is also the automatic fallback for a
campaign with no host chosen — so an install that only has the old S2S credentials keeps working
untouched even though the default moved.

| Mode | Credentials | Token | Who it can read |
|---|---|---|---|
| `s2s` | `accountId` + `clientId` + `clientSecret` pasted into Settings → Video conferencing | `grant_type=account_credentials`, no refresh token, re-requested hourly | the whole Zoom account that owns the app |
| `user` | a **user-managed General App** (`ZOOM_OAUTH_CLIENT_ID/_SECRET`); hosts are authorised once into a shared pool | `grant_type=authorization_code` once, then `grant_type=refresh_token` | only what that host can see |

### One pool of hosts, one host per campaign

Zoom accounts are **not** attached to a Google account. A campaign is the thing that has one webinar,
one host and possibly several sending mailboxes, so the choice lives there:

- `zoom:accounts` (set), `zoom:account:{userId}` (email, `reportAccess`) and
  `zoom:account:{userId}:tokens` (sealed with `CREDENTIALS_ENCRYPTION_KEY`) form the pool.
- `Campaign.zoomUserId` names this campaign's host. Authorising from the campaign card
  (`/oauth/zoom/start?campaignId=…`) both adds the account and selects it.
- `applyCampaignZoomHost()` (`domain/campaignZoom.ts`) stamps the host onto the campaign's linked
  session, because `syncSession()` only reads the session and should not have to look up a campaign in
  reverse. `planSessionZoomStamp()` (`domain/campaignZoomPlan.ts`, pure) decides whether a write is
  needed: an unchanged host is a no-op, and clearing a campaign's host only clears the session when the
  session was still holding *that* host, so a session-level override is never stomped on.
- Sessions created outside a campaign can name a host themselves; that is the override.

Tokens are cached in-process per Zoom user id — never in one shared slot — and refreshed in place.
Zoom may rotate the refresh token; the rotated value is persisted. An `invalid_grant` drops that host's
tokens but keeps the account listed, so the error is "reconnect this host" rather than silently falling
back to another identity.

`chooseZoomTokenSource()` (`video/zoomAuth.ts`) is the single, pure decision point. It takes the pool
and the requested host, and refuses to guess when the pool holds several hosts and nothing names one.

### Reports are optional; attendance is not

A user-managed app authorised by a **non-admin host** is refused the report endpoints (401/403). That
is expected, not an error, and it is handled:

1. the refusal is recorded as `reportAccess: 'denied'` on that host in the pool, so we stop probing
   every sync (every campaign reusing the host benefits). Zoom reports a missing scope as **400 code
   4711**, not 403 — `isScopeDenied()` recognises that shape, and the probe's own message is kept as
   `reportDetail` so the UI can quote Zoom instead of showing "unknown";
2. `fetch()` falls through to `GET /past_meetings|past_webinars/{id}/participants`, which a host can
   read for their own meetings (retrying with the double-encoded `uuid` when the numeric id 404s);
3. absentees, polls and Q&A come back empty, and a `notes` entry is stored on the session and shown
   in the UI so an empty section is explained rather than looking broken.

Attendance and no-show tagging still work in that mode because `buildReport()` derives no-shows from
invited − attended (`domain/attendance.ts`); the report's absentee list is informational only. Hosts
that *are* account admins, or whose app has been granted the report scope, get the rich path
automatically — "Check access" re-probes without reconnecting.

Report access is judged by the **participants** call attendance actually makes, never by
`/report/users/{id}/meetings` — that endpoint needs `report:read:user:admin`, a scope nothing else uses,
and asking for it made the UI demand a scope the app might not even offer. Connecting therefore stores
`reportAccess: 'unknown'`; the first sync, or **Check access**, records the real verdict.

`Check access` runs `probeZoomCapabilities()` against the newest finished call and records one entry per
endpoint (`participants`, `absentees`, `polls`, `qa`) on the account. `classifyCapability()` labels each
as **available**, **empty** (that call had none), **missing** (404 — no such report for that kind of call,
e.g. Q&A on a plain meeting), **denied** (scope refused, with the scope Zoom names) or **unknown** (retry
later). The UI renders that matrix under the host as four fixed rows — Report, Result, Scope to add — so
“add a scope”, “your plan has no Q&A” and “that meeting ran no polls” are visibly different answers.
A row that was never probed says **not checked** rather than disappearing, and the newest `checkedAt`
is printed underneath. A cached denial still buys exactly one verification attempt
per host per process (`shouldAttemptReports()`), verdicts left by the retired probe (`isProbeEraDenial()`)
are presented as unknown rather than contradicting reality, and `scopesFromDenial()` turns Zoom's refusal
into a copyable scope.

Zoom answers a **401** when the token itself is dead — the usual cause is an app that was recreated, a
rotated secret, or scopes/management type that changed after authorising, since a refresh token cannot
survive any of those. `isInvalidToken()` routes that case away from the scope logic: the host's tokens are
dropped (the account stays listed, so campaigns still point at it) and the error asks for
Disconnect → Connect rather than echoing "Invalid access token".

### Who counts as invited, and when a report is ready

`syncSession()` needs two things to turn Zoom's participant list into attendance: the call's **invited
set**, and a report that actually exists.

The invited set is resolved by `resolveInvitedEmails()` (`workers/attendance.ts`) through
`pickInvitedEmails()` (`domain/sessionAudience.ts`), in this order: the **frozen recipients of every
campaign that links the session** (only rows with `status: 'sent'` — a pending or failed recipient was
never invited), then the linked invitation's list + segments, then a list attached to the session. It used
to read `session.inviteId` only, which left every campaign-linked call with an empty audience: Zoom's
participants all fell into `attendedNotInvited`, the panel showed 0 attended / 0 no-show, campaign stats
lost all attendance and GHL dispatch sent nothing. When the audience is empty but people joined, the
session carries a warning saying so and the panel lists them under **"Attended — not on the invited
list"** instead of hiding them.

A missing report is not a zero. Zoom publishes reports after a call ends (webinars can take much longer),
and `GET /report/*` answers 404 until then. `zoomProvider.fetch()` returns `reportReady: false` when
neither the report call nor the `past_*` fallback answered, and `syncOutcome()`
(`domain/sessionSync.ts`) keeps the session **pending** while the call ended less than
`REPORT_RETRY_WINDOW_MS` (24 h) ago. Only a ready report is stored — an empty placeholder would tell
campaign stats that everyone who said yes was a no-show — and the scheduler re-syncs pending sessions
once an hour (`PENDING_RETRY_INTERVAL_MS`) rather than on every poll. After the window the session becomes
`synced` with a warning naming the likely causes
(wrong call type, wrong ID, wrong host), so nothing retries forever. The auto-sync dispatches to GHL only
once a `synced` report exists.

### Reading a call that moved, or was typed wrong

A 404 from both endpoints used to be terminal. `zoomProvider.fetch()` now treats the recoverable causes
explicitly, and `video/zoomId.ts` normalises what operators paste:

- **A pasted link** is reduced to its numeric ID (`/j/…`, `/w/…`, `?pwd=` and spacing all accepted);
  `/w/`, `/wc/`, `/webinar/` and `/register/` links also prove the call is a **webinar**. The
  `POST /api/sessions` and `PATCH /api/sessions/:id` routes apply the same rule, so a link can no longer be
  stored as an ID. A registration *token* link carries no usable ID and is rejected with an explanation.
- **The wrong type** is retried once with the other kind. If that answers, the data is used, the session's
  type is corrected and a note says so.
- **The wrong host** is found by a bounded sweep: up to three other authorised hosts are asked for the past
  call (one call each, `sweepOtherHosts()`). If one can see it, the sync uses that host and pins the session
  to it; the note names it so the campaign's host can be fixed too.
- **A dead token on the fallback path** takes the same invalid-token route as the report path (drop the
  tokens, ask for Disconnect → Connect) instead of looking like a missing report. `Check access` no longer
  records a 401 as "denied" either.

Every attempt — type, host, report status, fallback status and Zoom's own message — is stored on the
session as `syncDiagnostics` and shown under **"What the last sync tried"** whenever the call is not synced.
`sessionType`, `externalId` and `zoomUserId` are editable through `PATCH /api/sessions/:id`; changing one of
them resets the sync state so the scheduler retries with the new values (renaming a call does not).

### Attendance delivery: four segments, two channels

`buildAttendanceSegments()` (`domain/attendanceSegments.ts`) is pure: it splits the stored report into
`attended` (met `ATTENDANCE_MIN_SECONDS`), `partial`, `no_show` (invited, absent) and `not_invited` (joined,
not on the list), with counts and an attendance percentage. Every list is sorted by email/name so a roster
revision is stable.

The invited list is resolved by `resolveInvitedEmails()` in this order:

1. campaigns that link the session — their `status: 'sent'` recipient rows (exact);
2. the linked invitation — the **calendar attendees of the events it created** (`InviteRecord.batches` →
   `stateStore.getStates()` for each sender account), ignoring resource/group calendars, falling back to
   the selected list groups when the event has not synced;
3. a list attached to the session (`session.listId`, set through `PATCH /api/sessions/:id`);
4. none — then every joiner is `not_invited`, and no no-shows are invented.

`dispatchSession()` delivers two ways:

- **Per person** — a GHL tag from the per-connection `attendanceTags` (a blank partial falls back to the
  attended tag, so existing workflows do not change; env `GHL_TAG_ATTENDED` / `GHL_TAG_NO_SHOW` /
  `GHL_TAG_NOT_INVITED` are the defaults), an optional `attendanceCustomFieldId`, and `attendanceRules`
  webhooks whose context now exposes `segment`, `invited`, `invitedSource`, `attendedFullCount`,
  `partialCount` and `notInvitedCount`. The payload gains `event`, `segment`, `invited`, `invitedSource`,
  `minutes` and `segmentCounts`. Contacts are updated with a bounded fan-out
  (`ATTENDANCE_DISPATCH_CONCURRENCY`, default 5) and three attempts with linear backoff.
- **Roster** — `buildRosterPayloads()` (`domain/attendanceRoster.ts`) emits one POST per non-empty segment
  (`attendance.segment`) or one snapshot (`attendance.session`), with `counts`, `generatedAt` and a
  `revision` that hashes the content without the timestamp. `deliverRoster()` skips an unchanged revision,
  retries transient failures, stores `rosterRevision` / `rosterSentAt` / `rosterError` on the session, and
  supports a bearer token plus `X-Vibesuite-Event` / `X-Vibesuite-Revision` headers. The token is stored with
  the encrypted connection secrets and never returned by the API; `attendanceRosterTokenSet` tells the UI
  whether one exists.
- **Dedupe** — matched outcomes keep the pre-segment dispatch key, so deploying this does not replay every
  past attendee; walk-ins get their own key. Per-person failures release their claim and are counted, not
  fatal.
- **API** — `POST /api/sessions/:id/dispatch` accepts `{ rosterOnly, forceRoster }`; the response reports
  `dispatched`, `failed`, the segment counts and a `roster` block (`sent`, `skipped`, `reason`, `error`).

The link a calendar invite carries comes from `sessionJoinUrl()` (`domain/joinLink.ts`), in priority
order:

1. what the operator typed on the session (they may be pasting a registration or per-guest link);
2. whatever the provider resolved via `resolveJoinUrl()` — Zoom's `GET /webinars|meetings/{id}` →
   `join_url`, which *does* work before the session;
3. a synthesised `https://zoom.us/j/{id}`, for older Zoom sessions that have neither.

Resolution happens when a session is created and at the start of `syncSession()` — deliberately
**before** the report fetch, because that fetch throws for a session that has not run yet, which is
exactly the one needing its link. That ordering is also what backfills existing sessions, one
attendance-poll interval after deploy. Both call sites pass a `VideoAuthContext`
(`{ connectionId, zoomUserId }`); Zoom uses `zoomUserId` — the campaign's stamped host, or the
session's own override — and ignores the Google-account id, which is only there for other providers.

Reading `join_url` needs `webinar:read` / `meeting:read` on the Zoom app. Without those scopes the call
403s → `getJson()` returns null → no link, which is the previous behaviour, so the failure mode is
benign. Note step 3 always builds the `/j/` **meeting** form; whether Zoom accepts that for a webinar
is unverified, which is why step 2 matters.

## System email

Platform mail — team invites and account notices — goes through **GoHighLevel's Conversations API**,
not SMTP and not the calendar path. Calendar invitations are deliberately excluded: those are sent by
each connection's own Google account (`createInviteEvent` → `sendUpdates: 'all'`), so they must never
be routed through here.

`sendSystemEmail()` (`domain/systemEmail.ts`) delivers, in this order:

1. **GHL, when configured** — upsert the recipient as a contact (`POST /contacts/upsert`, with
   `source: 'vibesuite team invite'` so teammates are distinguishable from leads), then
   `POST /conversations/messages` with `type: Email`. The Conversations endpoint requires a
   `contactId`, which is why the upsert is unavoidable.
2. **The GHL inbound webhook** (`TEAM_INVITE_WEBHOOK_URL`, or the per-team setting) when GHL is not
   configured *or* when the GHL send throws — so a workflow already built against it keeps working
   across a deploy.
3. **Nothing** — the invite still returns a copyable link, and the caller is told which path was used.

`ghlRequest()` now accepts a `GhlRequestTarget` (a `Pick` of the fields it actually reads) rather than a
full `StoredConnection`, so the system path reuses the same retry, backoff, `Retry-After` and 401
handling without fabricating a connection.

The email body is an **admin-editable template** (`domain/inviteEmail.ts`, pure and unit-tested): a
subject plus a plain-text body with `{{placeholders}}`. It is escaped first and linkified second, so
neither the template nor a recipient's display name can inject markup into a message sent on the
operator's behalf. `{{inviteUrl}}` is mandatory — a template without it is rejected on save, because
otherwise the email would send successfully and be unusable.

Credentials and template live in `settings:systemEmail`, encrypted with `CREDENTIALS_ENCRYPTION_KEY`
and exposed only as a masked token. **The from address must be a verified sender on that GHL
location**, or GHL rejects it or silently substitutes the location default.

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

## Statistics

`GET /api/stats/overview?days=30` answers "how is outreach going overall?" from data that already
exists: `collectStatsOverview()` reads campaigns, recipient rows, attendance reports and sessions,
and `buildStatsOverview()` (pure, unit-tested) does all the arithmetic. Nothing new is tracked, so the
dashboard cannot quietly disagree with the campaign detail view.

The window is the last N calendar days **including today**, clamped to 1–365. Two different windows
live in one payload on purpose:

| Metric | Window | Why |
|---|---|---|
| Invitations sent | recipient `sentAt` inside the window | "Last 7 days" has to mean exactly that |
| Replies (accepted / declined / maybe / no reply) | whole funnel of any campaign that sent in the window | RSVP status is a campaign aggregate, not a per-recipient timestamp |
| Pending / failed | current, unwindowed | something still waiting is still waiting |
| Sessions, attendances, no-shows | session `startTime` inside the window | one row per call |

Wording is deliberate. **Invitations** counts recipient rows across campaigns, so someone invited to
three campaigns is three invitations — which is why the UI never says "people". **Attendances** counts
check-ins rather than unique humans, for the same reason. Acceptance rate is `accepted / sent` over the
included campaigns; attendance rate is `attended / (attended + noShow)`. Both are `0`, never `NaN`,
when the denominator is empty. Opens and bounces are absent because nothing tracks them, and the card
says "answers only" instead of implying a delivery funnel.

When an account has never sent an invitation and has no sessions at all, the client renders a labelled
`SAMPLE_OVERVIEW` ("Sample data — nothing here is real") instead of a wall of zeros. It is built in
the browser for the requested period, never persisted, and disappears automatically once real
activity exists — the `hasActivity` flag is computed across all campaigns and sessions, so an empty
*period* on an established account still shows honest zeros rather than samples.

### Batched invitations: one event per account per round

Both the one-off Invitations tab and campaigns can send in **rounds**. A round means: every chosen
account creates **one** calendar event with at most `eventBatchSize` recipients (default 300 when enabled),
then the plan waits `batchDelayMinutes` before the next round. With three accounts, a round is up to three
events and 900 invitations.

**One-off invitations** (`POST /api/invites` with `batchSize`/`delayMinutes`):

- The API sends the first round synchronously and creates a `ScheduledInvite` (`invite:schedule:{id}`)
  holding the remaining emails, event payload, accounts, batch size, delay and event-start guard.
- `startInviteScheduler()` (`scheduler/invites.ts`, `INVITE_SCHEDULE_TICK_INTERVAL_MS`) sends due rounds via
  `runScheduledInviteRound()`. Each round:
  - re-checks `list:{id}:invited` unless the schedule was created with `force`;
  - caps each account at `min(batchSize, current allowance)` and plans the split with the same
    `planInviteSplit()` the synchronous route uses;
  - sends one event per account through `sendInviteRound()`, appends the event IDs to the original
    `InviteRecord`, and stores the round on the schedule.
- A round that sends nothing retries after 15 minutes rather than burning the whole delay. A round that
  sent something schedules the next one with `nextRoundAt()`. Once the next round would start at/after the
  event, the schedule completes and reports the remainder as not invited.
- Schedules are `scheduled` / `paused` / `completed` / `cancelled`; `GET /api/invites/schedules` and the
  `pause`/`resume`/`cancel` routes drive the panel. Deleting the invite record cancels its schedules.

**Campaigns** (`eventBatchSize`, `batchDelayMinutes`, `nextBatchAt`, `lastBatchAt`):

- Opt-in fields on the campaign. `sendFromSender()` caps the claimed batch at `eventBatchSize` and creates
  exactly one event per active variant per account; with batching off, the original chunking and numbered suffix
  are untouched.
- `activeCampaigns(now)` skips a campaign whose `nextBatchAt` has not arrived. After a tick in which a
  campaign actually sent, `markBatchRound()` sets `nextBatchAt = now + delay`; the manual “Send a batch”
  action uses the same helper and refuses while the gate is closed.
- Daily/hourly caps, the sending window and `minDelayMs` still apply inside a round, so a capped account can
  send fewer than `eventBatchSize` and the rest waits for the next round.
- `applyLifecycle()` ends a batched campaign at the earlier of `sendByAt` and the event start; a manual batch
  after the event start is refused.

**Shared semantics:** delay from the end of the previous round; remainder carried forward; a failed event is
retried for those recipients in the next round; no round begins at or after the event start.

### A/B/C/D copy variants and test copies

A campaign can carry up to four copy variants (`copyVariants: [{ id: 'A'|'B'|'C'|'D', summary, description? }]`).
Variant A is mirrored into the legacy `event.summary`/`event.description`, so cards, attendance labels and older
clients keep reading one coherent subject.

- At **Begin sending**, `startCampaign()` assigns every audience email round-robin across the active variants
  (even split, deterministic) and writes the `campaign:{id}:variants` hash. The recipient row also stores
  `variant`, so the queue can keep carrying plain email addresses and redistribution does not lose the assignment.
- `sendFromSender()` groups its claimed batch by variant and creates **one event per active variant** in batched
  mode (or the usual chunks in legacy mode). `eventBatchSize` remains the total per account per round, so four
  variants × three accounts can mean up to twelve smaller events rather than three large ones. Google Calendar has
  one summary/description per event, so this is unavoidable for real per-recipient copy.
- `markInvited()` records the variant's subject. `buildCampaignStats()` adds a `variants` funnel alongside the
  aggregate funnel and per-sender table, using the existing recipient `eventId` and RSVP map. There is no
  open/click tracking, so the winner is a manual read of RSVP/attendance, not an automatic decision.
- Variants are frozen once `startedAt` is set. Draft/scheduled campaigns can still be patched; a paused/active
  campaign rejects `copyVariants` changes.

**Test copy** (`POST /api/campaigns/:id/test-copy`, owner/admin) sends a real calendar invite to 1–5 test
addresses from one campaign sender, with the title prefixed `[TEST]`. It deliberately does **not** create
recipient rows, queues, caps, stats or invited-set entries. The event ID is stored in
`campaign:test-event:{connectionId}:{eventId}` for 30 days, and `dispatchChange()` skips those IDs so a test
RSVP cannot create/update a GHL contact or fire attendance/webhook rules. The test event remains on the sender's
calendar, marked `[TEST]`.

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
*Insights* (Statistics, Who attended, Assistant) and *Workspace* (People, Settings). A slim `.topbar` carries
only the brand and the help/account menus. Below 900px the rail flattens into a horizontal scrolling
strip and the group labels hide.

The groups are **labels, not disclosure widgets**, and that is load-bearing: the guided tour targets
rail buttons by `[data-view]`, and a collapsed group would make its children zero-sized — which
`tourPaint()` reads as "nothing to point at" and skips silently. Keep the groups open and every stop
stays real.

### Audience: who actually gets invited

`buildAudience()` (`domain/audience.ts`) is the one place the recipient list is decided.
`extractRecipients()` produces the candidates; `list:{id}:invited` is subtracted to give `emails`,
and the overlap comes back as `alreadyInvited`. Because that set is shared with the one-off
Invitations tab, **a person is invited once per contact list, not once per campaign** — so a second
campaign on the same list legitimately has nothing to send.

Three call sites go through it — the invite preview, the invite send, and `startCampaign()` — so the
numbers an operator is shown before starting are exactly the numbers that get frozen.
`describeEmptyAudience()` turns an empty result into whichever of the three causes actually applies,
and the campaign wizard shows the split live (`refreshCampAudience()`) before the campaign is even
created. `POST /api/campaigns/:id/start` returns the counts so the UI can say how many were skipped.

`GET /api/campaigns/:id/plan` counts the live audience when nothing is frozen yet, so a **draft**
can report how long the send will take before it has started — the only moment that estimate is
useful.

### Re-inviting, and what we remember

`list:{id}:invited` is the membership set, and `getInvitedEmails()` is deliberately unchanged: it is
the fast check every filter uses. Alongside it, `list:{id}:invitedMeta` is a hash of
`email → { summary, start, at, source }`, written by `markInvited(..., meta)` from both send paths, so
the UI can say *"previously invited to <event> on <date>"* instead of only showing a count. The most
recent invitation wins — that is the one you would act on when deciding to re-invite someone.

Re-inviting is **opt-in in both places**: `force: true` on `POST /api/invites`, and a stored
`includeAlreadyInvited` flag on a campaign (default `false`). It is never automatic, because
re-inviting emails those people a second time and creates a second calendar event.

Anyone invited before `invitedMeta` existed has no entry, so `labelPreviousInvite()` degrades to a
plain "previously invited" rather than implying an event it cannot name. Labels fill in from the next
send onward; there is no backfill.

### One-off invitations vs campaigns

The Invitations tab sends **now**, from one or more accounts. `planInviteSplit()`
(`domain/invitePlan.ts`) splits the audience evenly across the chosen accounts, each capped at its own
remaining headroom via `senderReadiness()` — the same call the campaign scheduler makes, so
daily/hourly caps, cooldowns and a paused account all apply. The **send window is deliberately
ignored** here (`ignoreWindow: true`): it exists to pace a bulk campaign, and a manual send is an
explicit act — refusing it at 9pm because a default window says 9–5 would be surprising. Campaigns
still honour it. Because the counters
(`sender:day` / `sender:hour`) are keyed by mailbox rather than by feature, a successful invite
**spends the same budget a campaign would**. A send that exceeds total headroom sends what it can and
reports the remainder as `unplaced` rather than refusing outright or over-sending.

Events are chunked **per account**, not across the whole audience, so the normal case (one chunk per
account) produces no `(1/3)` suffix and a guest never receives a numbered title. The suffix only
returns when a single account needs splitting.

`POST /api/invites/capacity` reports per-account headroom for the picker. It is deliberately **not**
role-gated, unlike `/api/senders` — sending invitations is open to every role, so the picker has to
be able to show what each account can do. It returns an allowance and a reason, never profile
settings.

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
| Statistics | `stats`, `/api/stats/overview`, `statsOverview` |
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

