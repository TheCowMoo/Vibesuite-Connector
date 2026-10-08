# Google Calendar RSVP → GoHighLevel Sync Middleware

Event-driven, multi-tenant middleware that bridges the "silent" gap in Google Calendar push
notifications: Google notifies us that *something* changed (with an empty body), we delta-fetch the
changed events, detect which attendee RSVP status actually changed, and dispatch the corresponding
action to GoHighLevel (GHL) — updating appointment status, contact tags, DND, and firing a workflow
webhook per branch (yes / maybe / no).

## Architecture

```
Google Calendar ──(X-Goog-* headers, empty body)──▶ Nginx (SSL) ──▶ app-api (Fastify)
                                                                      │ route by channel → connection
                                                                      ▼ enqueue
                                                              Redis + BullMQ
                                                                      │
                                                                      ▼
                                                     app-worker ──▶ Google Delta Fetch
                                                                      │ detect RSVP change
                                                                      ▼
                                                          GHL v2 (status/tags/dnd/webhook)
```

- **app-api**: validates Google's channel token, resolves `X-Goog-Channel-ID` to a **connection**,
  returns `200 OK` in <100ms, enqueues a per-connection job.
- **app-worker**: loads the connection, acquires a per-connection lock, performs incremental
  `events.list` via `syncToken` (full sync on first run / `410 Gone` recovery), diffs attendee
  `responseStatus`, and dispatches.
- **redis**: connections + encrypted credentials, queue, per-connection state, dedupe locks,
  event→appointment mapping.
- **scheduler** (inside worker): renews every connection's watch channel before 30-day expiry.
- **dashboard** (in app-api): list/create/delete connections and drive OAuth onboarding.

## Concepts: "connections" (tenants)

A **connection** binds one Google Calendar to one GHL location:

- **Google auth**: `oauth` (user authorizes `calendar.events`) or `service_account` (domain-wide
  delegation).
- **GHL auth**: `oauth` (Marketplace) or `api_token` (private integration).
- Optional per-connection `webhookUrls` (`yes`/`maybe`/`no`) for the RSVP automation branches.

All runtime state is namespaced by connection id in Redis (`conn:{id}:*`).

## Repo layout

```
nginx/                 SSL termination + proxy
app/src/api/           ingestion endpoint + dashboard + connections/OAuth routes
app/src/oauth/         Google & GHL OAuth clients
app/src/queue/         BullMQ + Redis
app/src/workers/       sync pipeline + worker entrypoint
app/src/google/        per-connection auth, watch, delta sync
app/src/ghl/           per-connection GHL v2 client + handlers
app/src/domain/        connection store, state store, lock, transform, dedupe, bootstrap
app/src/scheduler/     per-connection watch renewal
app/src/scripts/       bootstrap-watch (<connectionId>), seed-connection (legacy env)
app/tests/             unit tests (transform, dedupe, crypto)
```

## Prerequisites

1. A public HTTPS domain pointing at the VPS (for Google push + OAuth redirects).
2. **Google**:
   - OAuth onboarding: a Google OAuth web-app client id/secret with redirect URI
     `https://your.domain/oauth/google/callback`.
   - Seed/service-account: a service account with the Calendar API enabled + calendar access.
3. **GoHighLevel**:
   - OAuth onboarding: a GHL Marketplace app client id/secret with redirect URI
     `https://your.domain/oauth/ghl/callback`.
   - API-token: a Private Integration token (+ location id).

## Setup

```bash
cp .env.example .env       # fill in real values
```

Key `.env` values: `OAUTH_BASE_URL`, `GOOGLE_WEBHOOK_URL`, optional OAuth app credentials, and
(strongly recommended) `CREDENTIALS_ENCRYPTION_KEY` to encrypt stored tokens at rest.

## Onboarding connections

**Option A — dashboard + OAuth (SaaS flow)**

1. Start the API: `cd app && npm run dev:api`, open `http://localhost:3000`.
2. "Create connection" (name, calendar id, location id, optional GHL API token + webhook URLs).
3. "Connect Google" (OAuth) — completes and auto-bootstraps (full sync + watch channel).
4. "Connect GHL" (OAuth) if you did not paste an API token.

**Option B — seed script (service account + GHL API token)**

```bash
cd app
npm run seed       # creates + bootstraps a connection from legacy .env values
```

**Manual bootstrap of an existing connection:**

```bash
npm run bootstrap -- <connectionId>
# or, after build: npm run bootstrap:prod <connectionId>
```

## Local development

```bash
cd app
npm install
npm run dev:api      # terminal 1 — API + dashboard (http://localhost:3000)
npm run dev:worker   # terminal 2 — worker + renewal scheduler + metrics
```

Run unit tests:

```bash
cd app
npm test
```

## Docker (VPS deployment)

```bash
docker compose up -d --build
```

- `redis` (persistent volume), `app-api`, `app-worker`, and `nginx` (SSL).
- Replace the placeholder cert paths in `nginx/conf.d/default.conf` and run certbot to obtain
  certificates, or mount existing ones.
- See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full first-deploy, SSL, update, and
  troubleshooting playbook.

## RSVP → GHL mapping

| Google `responseStatus` | GHL status | Tags added | Trigger |
|---|---|---|---|
| `accepted`  | `confirmed` | `rsvp-yes` | confirmed webhook |
| `tentative` | `tentative`* | `rsvp-maybe` | tentative webhook |
| `declined`  | `cancelled` | `rsvp-no`, `communication-stopped` + DND | declined webhook |
| `needsAction` | `pending`* | `rsvp-pending` | none |

\* GHL native appointment statuses are typically `new/confirmed/cancelled/showed/noshow/invalid`;
`tentative`/`pending` are expressed via tags + custom field + webhook branch. Verify the exact
status field/enum against the GHL v2 reference before production use.

## Observability & metrics

- `app-api` exposes Prometheus-style metrics at `/metrics` (ingestion: received/rejected/enqueued).
- `app-worker` serves `/metrics` on `METRICS_PORT` (default `9090`): sync runs, RSVP dispatches by
  status, duplicates skipped, GHL errors, watch renewals.
- `/healthz` (liveness) and `/readyz` (Redis ping) on both.

Key counters: `webhook_received_total`, `webhook_rejected_total`, `jobs_enqueued_total`,
`sync_processed_total{type}`, `rsvp_dispatched_total{status}`, `rsvp_duplicates_skipped_total`,
`ghl_errors_total{status}`, `watch_renewals_total`.

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/connections` | list connections (secrets stripped) |
| POST | `/api/connections` | create connection (`pending_google`) |
| GET | `/api/connections/:id` | get one connection |
| POST | `/api/connections/:id/bootstrap` | full sync + create watch channel |
| DELETE | `/api/connections/:id` | delete connection |
| GET | `/oauth/google/start?connectionId=` | redirect to Google OAuth |
| GET | `/oauth/google/callback` | complete Google OAuth |
| GET | `/oauth/ghl/start?connectionId=` | redirect to GHL OAuth |
| GET | `/oauth/ghl/callback` | complete GHL OAuth |

## Notes & caveats

- Google push notifications are **not 100% reliable**. The worker's incremental sync is the source
  of truth; the watch renewal scheduler also reconciles, and you can trigger a manual re-sync via
  a synthetic notification or by clearing the stored token.
- Event ↔ GHL appointment linkage uses the per-connection Redis mapping table
  (`conn:{id}:map:event:{eventId}`). Populate it at booking time; if absent, the worker still
  applies contact tags, DND, and the webhook (appointment status update is best-effort).
- **Idempotency**: each dispatch is fingerprinted (connection + event + attendee + status + Google
  `updated` timestamp). A Redis `SET NX` guard (5-min TTL) plus GHL `Idempotency-Key` headers
  prevent duplicate side effects from BullMQ retries or burst notifications.
- **Security**: store a strong `CREDENTIALS_ENCRYPTION_KEY` so OAuth/API tokens are AES-256-GCM
  encrypted at rest in Redis. Without it, tokens are stored in plaintext (dev fallback).
- GHL OAuth Marketplace endpoints/scope names and the appointment-status field name should be
  verified against the current GHL docs before going live.
#   V i b e s u i t e - C o n n e c t o r  
 