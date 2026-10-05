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

