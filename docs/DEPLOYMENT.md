# Deployment Guide

> Complete first-deploy, SSL, update, and troubleshooting playbook for the Vibesuite Connector stack.
> For design decisions and the Redis key map see [`architecture.md`](architecture.md); for day-to-day
> operations see [`runbook.md`](runbook.md).

## Stack overview

| Service      | Image / build   | Role                                                             |
|--------------|-----------------|------------------------------------------------------------------|
| `redis`      | `redis:7-alpine`| state, BullMQ queue, encrypted credentials (persistent volume `redis-data`) |
| `app-api`    | `./app`         | Fastify API + control panel (exposes `3000` internally)          |
| `app-worker` | `./app`         | BullMQ sync worker + watch renewal + metrics (`9090` internally) |
| `nginx`      | `./nginx`       | TLS termination + reverse proxy (publishes `80` + `443`)         |

All services share one Compose network and address each other by **service name** (`redis`, `app-api`).
Only `nginx` publishes host ports.

---

## Prerequisites

- Linux VPS with Docker Engine + Compose v2.
- A domain with an `A` record → VPS IP. **Live domain: `connect.vibesuite.io`.**
- Ports `80` and `443` open (firewall / cloud security group).
- Google Cloud project with the **Calendar API enabled**; OAuth web-app client (redirect
  `https://connect.vibesuite.io/oauth/google/callback`) and/or a service account.
- GoHighLevel private-integration token (or Marketplace app).

---

## 1. First deploy

```bash
git clone <repo-url> && cd <repo>
cp .env.example .env
# edit .env, at minimum:
#   OAUTH_BASE_URL=https://connect.vibesuite.io
#   GOOGLE_WEBHOOK_URL=https://connect.vibesuite.io/webhooks/google/calendar
#   CREDENTIALS_ENCRYPTION_KEY=<strong random key>
#   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (or service-account vars)
#   GHL_OAUTH_* (or GHL_API_TOKEN + GHL_LOCATION_ID)
docker compose up -d --build
```

Notes:

- `REDIS_URL` is pinned to `redis://redis:6379` in `docker-compose.yml` and **must stay that way**
  inside Compose — the `.env` `redis://127.0.0.1:6379` value is only for running outside Docker.
- Generate the encryption key with: `openssl rand -hex 32`. This key protects GHL/Google tokens
  **and AI provider API keys** at rest. Rotating it invalidates all stored secrets.
- The **AI provider keys** (OpenAI / Claude / Gemini / DeepSeek / custom) are configured in the
  dashboard (**Settings → AI**), not in `.env`.

---

## 2. SSL / TLS

The `nginx` image bundles `certbot`. The live cert lives at
`./nginx/certs/live/connect.vibesuite.io/` (mounted to `/etc/letsencrypt` inside the container).

### Renew (already issued)

```bash
docker compose exec nginx certbot renew
docker compose restart nginx        # reload the renewed certificate
```

### Issue for a new / first domain

The HTTPS server block references a cert that does not exist yet, so on a fresh box:

1. Update `server_name` and the `ssl_certificate*` paths in `nginx/conf.d/default.conf` to your domain.
2. Temporarily **comment out the entire `listen 443 ssl` server block** so nginx can start without the cert.
3. Start nginx and issue via webroot (the ACME challenge location is already routed to `/var/www/certbot`):

   ```bash
   docker compose up -d --build nginx
   docker compose exec nginx certbot certonly --webroot \
     -w /var/www/certbot -d connect.vibesuite.io \
     --email you@example.com --agree-tos --no-eff-email
   ```

4. Restore the HTTPS block and rebuild:

   ```bash
   docker compose up -d --build nginx
   ```

### Auto-renewal (optional)

```bash
(crontab -l 2>/dev/null; echo "0 3 * * * cd <repo> && docker compose exec -T nginx certbot renew -q && docker compose restart nginx") | crontab -
```

---

## 3. Verify

- `curl -s https://connect.vibesuite.io/healthz` → `{"status":"ok"}`
- `curl -s https://connect.vibesuite.io/readyz` → `{"status":"ready"}` (Redis ping)
- `curl -s https://connect.vibesuite.io/metrics` → ingestion metrics (Prometheus text)
- Open `https://connect.vibesuite.io/` → control panel (connections / lists / knowledge / settings)
- End-to-end: create a connection, connect Google, change an attendee RSVP → worker logs
  `dispatching RSVP change` and GHL receives the mapped update.

Worker metrics (`9090`) are **not published**; inspect from inside the network if needed
(`docker compose exec app-worker wget -qO- http://localhost:9090/metrics`).

---

## 4. Updating the stack

```bash
cd <repo>
git pull
docker compose up -d --build        # rebuilds app-api / app-worker (and nginx if its files changed)
```

### Update quirks (learned on the VPS)

1. **nginx config changes require `--build`.** `nginx/Dockerfile` does
   `COPY conf.d/default.conf ...`, so editing the file is **not** picked up by `up -d` alone — the
   image must be rebuilt.
2. **`.env` changes require `--force-recreate`.** `env_file` is read at container create and Compose
   does not always detect the change. Use `docker compose up -d --force-recreate` after editing `.env`.
3. **After recreating `app-api`, restart `nginx`.** nginx resolves `app-api` through Docker DNS
   (`resolver 127.0.0.11`) and caches the container IP. A recreated `app-api` gets a new IP, so run
   `docker compose restart nginx` to clear the cached upstream.

Rule of thumb:

- app / nginx code changed → `docker compose up -d --build`
- only `.env` changed → `docker compose up -d --force-recreate` then `docker compose restart nginx`

---

## 5. Day-to-day operations

| Task                    | Command                                                             |
|-------------------------|---------------------------------------------------------------------|
| Tail API logs           | `docker compose logs -f app-api`                                    |
| Tail worker logs        | `docker compose logs -f app-worker --tail 100`                      |
| Restart worker          | `docker compose restart app-worker`                                 |
| Rebuild one service     | `docker compose up -d --build app-api`                              |
| Redis shell             | `docker compose exec redis redis-cli`                               |
| Status                  | `docker compose ps`                                                 |
| Rollback                | `git checkout <sha> && docker compose up -d --build`                |

---

## 6. Troubleshooting

| Symptom                            | Likely cause / fix                                                                        |
|------------------------------------|-------------------------------------------------------------------------------------------|
| nginx `502 Bad Gateway`            | `app-api` down/crashed, or cached upstream IP — `docker compose ps`, then `docker compose restart nginx` |
| `ECONNREFUSED redis:6379` in logs  | `REDIS_URL` must be `redis://redis:6379` inside Compose (not `localhost`/`127.0.0.1`)     |
| TLS / cert errors                  | Renew or re-issue via certbot (see SSL); confirm the `./nginx/certs` mount is intact      |
| `403 invalid channel token`        | Google watch channel created under a different token — re-run bootstrap for that connection |
| `unknown channel`                  | Channel not persisted — re-run bootstrap for that connection                              |
| `410` in worker logs               | Expired `syncToken` — handled automatically (reset + full sync)                           |
| OAuth callback `invalid state`     | State expired (>10 min) or mismatched — restart the OAuth flow                            |
| **"Awaiting Google" status stuck** | Bootstrap/watch failed after OAuth — see below                                            |

### "Awaiting Google" (OAuth completes but the connection never goes active)

```bash
docker compose logs app-api --tail 120 | grep -iE "bootstrap|google|oauth|error|watch"
```

Most likely causes, in order:

1. **Calendar API not enabled** on the Google Cloud project.
2. **`GOOGLE_WEBHOOK_URL` mismatch** — it must be exactly
   `https://connect.vibesuite.io/webhooks/google/calendar` (match the nginx SSL endpoint).
3. **Wrong calendar ID** — the connected account's calendar differs from `GOOGLE_CALENDAR_ID` /
   the id used at bootstrap.

---

## 7. Secrets & environment reference

- `CREDENTIALS_ENCRYPTION_KEY` — AES-256-GCM key for GHL/Google tokens **and AI API keys**
  (both stored encrypted in Redis). Keep it safe; rotating it invalidates all stored secrets.
- `OAUTH_BASE_URL` / `GOOGLE_WEBHOOK_URL` — public HTTPS origin + Google push endpoint.
- AI provider keys (OpenAI / Claude / Gemini / DeepSeek / custom) — configured in the dashboard
  (**Settings → AI**), stored encrypted in Redis (not in `.env`).
- Full variable list and defaults: [`.env.example`](../.env.example).

## Related docs

- [`architecture.md`](architecture.md) — design decisions, data flow, Redis key map.
- [`runbook.md`](runbook.md) — first-deploy checklist and operations/troubleshooting tables.

