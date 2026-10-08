# Runbook

> Full deploy / SSL / update / troubleshooting: see [DEPLOYMENT.md](DEPLOYMENT.md).

## First deploy

1. `cp .env.example .env` and populate `OAUTH_BASE_URL`, `GOOGLE_WEBHOOK_URL`, and
   `CREDENTIALS_ENCRYPTION_KEY` (recommended), plus any OAuth app credentials.
2. `docker compose up -d --build`.
3. Onboard connections either:
   - **Dashboard/OAuth**: open the dashboard (`https://your.domain/`), create a connection, then
     "Connect Google" (and "Connect GHL" if not using an API token).
   - **Seed**: with service-account + GHL API token values in `.env`, run
     `docker compose exec app-worker node dist/scripts/seed-connection.js`.
   - **Manual**: `docker compose exec app-worker node dist/scripts/bootstrap-watch.js <connectionId>`.

## Verify it works

- `curl -s https://connect.vibesuite.io/healthz` → `{"status":"ok"}`.
- `curl -s https://connect.vibesuite.io/readyz` → `{"status":"ready"}`.
- `curl -s https://connect.vibesuite.io/metrics` → ingestion metrics (Prometheus text).
- `docker compose exec app-worker wget -qO- http://localhost:9090/metrics` → worker metrics
  (sync/dispatch/error counters).
- Change an attendee RSVP in a connected Google Calendar; within seconds the worker logs
  `dispatching RSVP change` and GHL receives the mapped update.

## Operations

- **Connections**: list/create/delete via the dashboard or `/api/connections`.
- **Watch renewal**: automatic (worker checks daily, renews when within
  `WATCH_RENEWAL_THRESHOLD_DAYS` of expiry). Logs `watch channel renewed`.
- **Manual re-sync**: `redis-cli DEL "conn:<id>:sync:token"` then POST a synthetic notification,
  or re-run bootstrap.
- **Lost notification**: incremental sync is the source of truth; a dropped push is self-healed on
  the next notification or renewal check.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `403 invalid channel token` | Channel created under a different token — re-run bootstrap for that connection. |
| `unknown channel` | Channel not persisted — re-run bootstrap for that connection. |
| `410` in logs | Expired `syncToken` — handled automatically (reset + full sync). |
| `429` from GHL | Rate limit — worker retries with exponential backoff (honors `Retry-After`). |
| `401` from GHL (oauth) | Access token expired — client refreshes automatically. |
| No GHL appointment updated | `conn:{id}:map:event:{eventId}` missing — populate mapping at booking time. |
| OAuth callback `invalid state` | State expired (>10 min) or mismatched — restart the OAuth flow. |

