# Deployment Guide

> Complete first-deploy, SSL, update, and troubleshooting playbook for the Vibesuite Connector stack.
> For design decisions and the Redis key map see [`architecture.md`](architecture.md); for day-to-day
> operations see [`runbook.md`](runbook.md).

## TL;DR — push an update

```bash
git fetch origin && git reset --hard origin/main
docker compose up -d --build --force-recreate
docker compose restart nginx
curl -s https://connect.vibesuite.io/api/lists
```

> **Copy-paste rules:** paste **one command at a time** and press Enter. Do **not** include the
> `ubuntu@...$` prompt or any trailing `#` comment — pasting those produces
> `bash: syntax error near unexpected token 'newline'` or `...: No such file or directory`.

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
docker compose up -d --build
```

Edit `.env` before the build, at minimum:

- `OAUTH_BASE_URL=https://connect.vibesuite.io`
- `GOOGLE_WEBHOOK_URL=https://connect.vibesuite.io/webhooks/google/calendar`
- `CREDENTIALS_ENCRYPTION_KEY=<strong random key>`
- `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (or service-account vars)
- `GHL_OAUTH_*` (or `GHL_API_TOKEN` + `GHL_LOCATION_ID`)

Notes:

- `REDIS_URL` is pinned to `redis://redis:6379` in `docker-compose.yml` and **must stay that way**
  inside Compose — the `.env` `redis://127.0.0.1:6379` value is only for running outside Docker.
- Generate the encryption key with `openssl rand -hex 32`. It protects GHL/Google tokens **and AI
  provider API keys** at rest; rotating it invalidates all stored secrets.
- The **AI provider keys** (OpenAI / Claude / Gemini / DeepSeek / custom) are configured in the
  dashboard (**Settings → AI**), not in `.env`.

---

## 2. SSL / TLS

The `nginx` image bundles `certbot`. The live cert lives at
`./nginx/certs/live/connect.vibesuite.io/` (mounted to `/etc/letsencrypt` inside the container).

### Renew (already issued)

```bash
docker compose exec nginx certbot renew
docker compose restart nginx
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

### Confirm the new code is actually live

After any update, prove the new code made it onto the box:

```bash
ls app/src/api/routes/
curl -s https://connect.vibesuite.io/api/lists
```

`ls` should list `ai.ts  knowledge.ts  lists.ts`; `curl` should print `{"lists":[]}` (old code → `404`).

Then hard-refresh the browser with **Ctrl+F5** — you should see **Lists** and **Knowledge** nav items
and a **Settings → AI provider** card.

---

## 4. Updating the stack

### Push from your workstation (PowerShell → SSH)

On your local machine:

```powershell
cd "c:\path\to\repo"
git push origin main
```

Over SSH on the VPS:

```bash
cd ~/Vibesuite-Connector
git fetch origin && git reset --hard origin/main
docker compose up -d --build --force-recreate
docker compose restart nginx
```

### VPS-local changes block `git pull`

If `git pull` prints:

```
error: Your local changes to the following files would be overwritten by merge:
        nginx/conf.d/default.conf
Please commit your changes or stash them before you merge.
Aborting
```

…it means a tracked file was edited **directly on the server** (most often `nginx/conf.d/default.conf`
during an SSL change). Make the server match the remote exactly:

```bash
git fetch origin && git reset --hard origin/main
```

This is safe: `nginx/certs/`, `nginx/www/`, and `.env` are **gitignored**, so your certificate,
certbot webroot, and secrets are untouched.

### Did the pull actually take?

Before building, confirm the new code is on disk:

```bash
git log --oneline -3
ls app/src/api/routes/
```

`git log` should show the new commit SHAs; `ls` should list `ai.ts  knowledge.ts  lists.ts`. Then build:

```bash
docker compose up -d --build --force-recreate
docker compose restart nginx
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
4. **A ~1-second `Built` means nothing changed.** If the build finishes in ~1s and containers show
   `Running` (not `Recreated`), the source on disk was unchanged — usually because `git pull` aborted
   before the build. Re-check "Did the pull actually take?" above.

Rule of thumb:

- app / nginx code changed → `docker compose up -d --build --force-recreate` then `docker compose restart nginx`
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
| Rollback                | `git checkout <sha> && docker compose up -d --build --force-recreate` |

---

## 6. Troubleshooting

| Symptom                                              | Likely cause / fix                                                                        |
|------------------------------------------------------|-------------------------------------------------------------------------------------------|
| `bash: syntax error near unexpected token 'newline'`  | Pasted the `ubuntu@...$` prompt or a `#` comment — paste only the command, one line at a time |
| `bash: ...: No such file or directory`                | Pasted shell prompt text as a command — copy only the command line                         |
| nginx `502 Bad Gateway`                               | `app-api` down/crashed, or cached upstream IP — `docker compose ps`, then `docker compose restart nginx` |
| `ECONNREFUSED redis:6379` in logs                     | `REDIS_URL` must be `redis://redis:6379` inside Compose (not `localhost`/`127.0.0.1`)     |
| TLS / cert errors                                     | Renew or re-issue via certbot (see SSL); confirm the `./nginx/certs` mount is intact      |
| `git pull` aborts ("would be overwritten by merge")   | Server has local edits — `git fetch origin && git reset --hard origin/main` (§4)          |
| New features missing after a deploy                   | Code never updated (fast build + `Running` containers) — re-check "Did the pull actually take?" (§4) |
| `403 invalid channel token`                           | Google watch channel created under a different token — re-run bootstrap for that connection |
| `unknown channel`                                     | Channel not persisted — re-run bootstrap for that connection                              |
| `410` in worker logs                                  | Expired `syncToken` — handled automatically (reset + full sync)                           |
| OAuth callback `invalid state`                        | State expired (>10 min) or mismatched — restart the OAuth flow                            |
| **"Awaiting Google" status stuck**                    | Bootstrap/watch failed after OAuth — see below                                            |

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

## 8. Auth & team (login system)

The dashboard ships with a login system that is **off by default** (`AUTH_ENABLED=false`) so a deploy can never lock you out.

### Safe rollout

```bash
# 1) deploy with auth off (the default) — behaviour is unchanged
git fetch origin && git reset --hard origin/main
docker compose up -d --build --force-recreate
docker compose restart nginx

# 2) create the owner — either path
#    a) enable AUTH_ENABLED=true, open the panel and complete "Create your owner account"
#       (the first-run form only appears while zero users exist)
#    b) CLI, no redeploy needed:
docker compose exec app-api npm run create-owner:prod -- --email you@example.com --password "a-strong-password"

# 3) turn auth on
#    set AUTH_ENABLED=true in .env, then:
docker compose up -d --force-recreate
docker compose restart nginx
```

### Roles

| Role | Can do |
|---|---|
| `owner` | Everything, including promoting/demoting owners |
| `admin` | Invite members, change roles, disable/remove members |
| `member` | Use the product only (no Team tab) |

### Invites

- **Team → Invite member** always produces a **copyable link** (`/invite?token=…`), single-use and expiring after `INVITE_TTL_DAYS` (default 7).
- Optionally set a **GHL inbound webhook URL** in **Team → Invite delivery** (or `TEAM_INVITE_WEBHOOK_URL`); every invite is also POSTed there so GHL sends the email. Use **Send test** first.
- The webhook payload includes `email`, `name`, `role`, `inviteUrl`, `invitedBy`, `expiresAt`, `subject`.

### Notes

- Sessions live in Redis (`auth:session:*`) and are issued as an httpOnly `SameSite=Lax` cookie; only the token's SHA-256 is stored.
- `/webhooks/google/calendar` and `/oauth/**` **must remain public** — they are allowlisted in `app/src/lib/authPaths.ts`. If RSVP sync breaks right after enabling auth, check that first.
- Login attempts are rate-limited (10 per 15 min per email+IP).
- With `AUTH_ENABLED=false` every route behaves exactly as before.

## 9. Zoom authorisation (optional)

Two modes, chosen in **Settings → Video conferencing**:

- **Zoom hosts shared across campaigns** (default) — a **user-managed General App**. Each Zoom account
  is authorised once into a shared pool, then every campaign picks the host whose webinar it is
  inviting people to. One host can serve any number of campaigns. Nothing works in this mode until the
  app credentials below are set and at least one host is connected.
- **Server-to-server** — paste the Account ID, Client ID and Client secret from a Server-to-Server OAuth
  app. No redirect URL, no consent screen, hourly token. Still selectable, and used automatically for
  any campaign with no Zoom host chosen.

### Creating the user-managed app

1. Zoom App Marketplace → **Developer → Build an app → General app**.
2. Management type: **user-managed** (each host authorises their own Zoom user).
3. **OAuth redirect URL** *and* **OAuth allow list** must both contain
   `https://connect.vibesuite.io/oauth/zoom/callback` — it must match `OAUTH_BASE_URL` +
   `ZOOM_OAUTH_REDIRECT_PATH` exactly. For local development also add
   `http://localhost:3000/oauth/zoom/callback` to the allow list and run the app with
   `OAUTH_BASE_URL=http://localhost:3000`; the value is built as `OAUTH_BASE_URL` +
   `ZOOM_OAUTH_REDIRECT_PATH`, so the two must match character for character (no trailing slash).
4. Scopes: pick the equivalents of **user read**, **meeting read** and **webinar read** in the app's
   scope picker. Zoom now presents granular names (for example `user:read:user`,
   `meeting:read:meeting`, `webinar:read:webinar`) alongside the classic ones (`user:read`,
   `meeting:read`, `webinar:read`) — use whichever the picker offers. Add the report scope
   (`report:read:admin`) only if an account admin will authorise the app; that is what unlocks polls,
   Q&A and the absentee list.
5. Copy the **production** client id/secret (development credentials are separate) into `.env`:

```bash
ZOOM_OAUTH_CLIENT_ID=your_client_id
ZOOM_OAUTH_CLIENT_SECRET=your_client_secret
```

Then apply it — an env change only, no rebuild required:

```bash
docker compose up -d --force-recreate
docker compose restart nginx
```

Until those two values exist, the settings card shows *"Zoom sign-in is not set up yet"* instead of a
**Connect Zoom** button, and `/oauth/zoom/start` answers with the same instruction rather than failing
inside the URL builder.

### What to expect

- Connect a host once in **Settings → Video conferencing**, then choose it per campaign — in the
  campaign wizard's **Zoom host** field, or later with **Add / Change Zoom host** on the campaign card.
  The card shows which host the campaign is using.
- A **user-managed** app cannot hold the admin-only report scope, so after a sync or **Check access** the
  host reports which endpoints were refused and names the scope each one wants. Attendance still syncs
  from the past-meeting participant list; polls, Q&A and absentees need the admin-managed upgrade below.
- **Check access** replays the newest finished Zoom call against every report endpoint and lists the
  result under the host — participants / absentees / polls / Q&A, each **available**, **nothing on that
  call**, **no such report for that call**, or **refused** with a copyable scope. That is what separates a
  missing scope from a missing plan feature from a meeting that simply ran no polls.
- **Check access** re-probes a host after the app's scopes change — no reconnect needed for a granted
  scope, but see the upgrade note about existing authorisations.
- **Disconnect** removes the host from the pool; campaigns that were using it report "needs
  reconnecting" until another host is chosen.
- Tokens are stored encrypted in Redis (`zoom:account:{userId}:tokens`). Switching the mode back to
  server-to-server restores the previous behaviour; nothing is migrated or deleted.

### Admin-managed upgrade (polls, Q&A, absentees)

The report scope (`report:read:admin`, or the granular `report:read:list_past_participants:admin` and
its siblings) is only offered to **admin-managed** apps — a user-managed app will not show it at all.

1. Zoom Marketplace → your app → **Basic Information** → change the app to **Admin-managed**, save.
   Zoom asks you to reconfirm features and scopes afterwards; the redirect URL and allow list are
   unchanged.
2. **Scopes** → add the meeting and webinar report scopes (search “report”, including the
   past-participant, absentee, poll and Q&A ones), keeping the user/meeting/webinar read scopes. The
   panel names the exact scope Zoom asks for once a sync or **Check access** has run — those two test
   the participant call attendance uses, so no scope is ever guessed at.
3. **Local Test → Add App Now**, authorised by a Zoom account admin. Admin-managed apps are installed
   at account level, so one admin covers everyone on that account.
4. In this panel: **Disconnect** the host, then **Connect Zoom** again. A refresh token never gains
   new scopes, so the old authorisation keeps reporting a refusal until it is replaced.
5. **Check access** → the matrix under the host should show participants, absentees, polls and Q&A as
   **available** (or *nothing on that call* when that particular meeting ran none). It replays the newest
   finished Zoom call, so there must be at least one past session.

Customers on other Zoom accounts will each need their own account admin to install the app, and the
app must pass Zoom's review before it can be installed outside your account.

### If the panel says "Invalid access token"

That is a **401 from Zoom**, not a scope problem: the token belongs to an earlier version of the app
(recreated app, rotated secret, changed management type or scopes) or the server clock is skewed.

1. `docker compose exec app-api printenv ZOOM_OAUTH_CLIENT_ID` — must match the app you are looking at,
   and be the same credential set (development vs production) that issued the token.
2. `date -u` — should be within a minute of real time.
3. Panel → **Disconnect**, then **Connect Zoom** as the account admin.

The app now drops a token Zoom rejects and tells you to reconnect, instead of echoing Zoom's terse
message. The host stays listed so campaigns keep pointing at it.

### If the panel still says `report:read:user:admin`

That string came from a probe removed in `d799716`. Seeing it means the server is running an **old
build**:

```bash
git log --oneline -1                                   # expect aaf57a4 or later
grep -c probeZoomCapabilities app/src/video/zoom.ts    # must not be 0
```

## Related docs

- [`architecture.md`](architecture.md) — design decisions, data flow, Redis key map.
- [`runbook.md`](runbook.md) — first-deploy checklist and operations/troubleshooting tables.

