# Deployment — session-manager

Two halves, both on the club **Mac mini**, both deployed by running
`npm run build` **on that machine**: an **Express API** on port 3001 (restarted
in-place by the build) and a **Vite SPA** that builds straight into the sibling
`www/sessionmanager/` directory the shared **Caddy** file-server publishes on the
LAN. Express **also** serves that same built directory, and a **Cloudflare
Tunnel** publishes Express at **`https://session.wmpc.app`** behind **Cloudflare
Access** for use off the LAN. Pushing to `main` deploys nothing.

> ⚠️ Two known gaps, recorded rather than papered over:
> - **`launchd/ai.wmpc.sessions.plist` is stale and not installed.** Its
>   `WorkingDirectory` still points at `…/projects/rating-session-manager`, the
>   repo's old name. `setup.sh` never installs it, and the API is actually run as
>   a backgrounded `node dist/server.js` by `scripts/restart-api.sh`. So the API
>   does **not** survive a reboot unless someone starts it.
> - **The LAN hostname is not recorded anywhere in this repo.** The SPA is
>   served on the LAN by Caddy from `../www/sessionmanager`, but which host maps
>   to it isn't written down here — read it off the mini's
>   `/opt/homebrew/etc/Caddyfile`. (club-dashboard's Caddy snippet mentions
>   `sessions.wmpc.ai` as a neighbour; **unverified**.) The *public* hostname is
>   `session.wmpc.app` (the `tunnel` target below).
> - **The tunnel is only as durable as the API.** `cloudflared` restarts itself
>   (LaunchAgent), but until the plist gap above is fixed the API does not, so
>   after a reboot the public URL 502s until someone runs `npm run build`.

```yaml
# wmpc-deployment: v1
repo: session-manager
archetype: caddy-static
branches:
  main: n/a — pushing to main deploys NOTHING; a human runs npm run build on the mini
  production: n/a — this repo has no production branch
targets:
  - name: api
    kind: mac-mini-launchd
    trigger: MANUAL — `npm run build` on the mini (tsc + vite build + ./scripts/restart-api.sh)
    source: src/server.ts → dist/server.js, Express on port 3001
    env: LAN
    url: http://localhost:3001 on the mini — /api/* AND the built SPA (from ../www/${APP_NAME}, override WEB_DIST); this is the tunnel's origin
    host: wmpcMacMini1
    config_scope: .env in the repo root on the mini (also reads courtreserve-scheduler/.env for CR scraping); CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD gate tunnel traffic (fail closed)
    verify: curl an /api/* endpoint on the mini AND curl localhost:3001/ for the SPA's <html>; log at /tmp/sm.log (override with SM_LOG)
    rollback: git checkout an earlier commit on the mini and re-run npm run build
  - name: web
    kind: caddy-static
    trigger: MANUAL — `npm run build` on the mini; Vite writes DIRECTLY into ../../www/${APP_NAME}
    source: web/ → ../../www/sessionmanager (APP_NAME defaults to sessionmanager; emptyOutDir true)
    env: LAN
    url: unknown — Caddy serves ../www/sessionmanager on the mini; the hostname is not recorded in this repo
    host: wmpcMacMini1
    config_scope: repo-root .env — VITE_* values are BAKED INTO THE BUNDLE at build time
    verify: load the Caddy-served host and confirm the change is present
    rollback: git checkout an earlier commit on the mini and rebuild
  - name: launchd-plist
    kind: none
    trigger: NOT INSTALLED — setup.sh does not install it, and its path is stale
    source: launchd/ai.wmpc.sessions.plist
    env: n/a
    url: n/a
    host: wmpcMacMini1
    config_scope: WorkingDirectory still points at the repo's OLD name (rating-session-manager)
    verify: launchctl list | grep ai.wmpc.sessions — expect nothing
    rollback: n/a
  - name: tunnel
    kind: cloudflare-tunnel
    trigger: MANUAL, one time — `bash deploy/cloudflared/setup.sh` on the mini (idempotent; re-run to update)
    source: deploy/cloudflared/
    env: PROD
    url: https://session.wmpc.app → http://localhost:3001 on the mini (Express, SPA + /api)
    host: wmpcMacMini1
    config_scope: ~/.cloudflared/config-session.yml + the session.wmpc.app CNAME on the wmpc.app zone; LaunchAgent com.wmpc.cloudflared-session; Cloudflare Access app for session.wmpc.app (Zero Trust) whose AUD tag goes in the mini's .env
    verify: "curl -sI https://session.wmpc.app/ | head -1 — expect a 302 to *.cloudflareaccess.com; signed in, the dashboard loads"
    rollback: launchctl bootout the agent, delete the tunnel + its CNAME + the Access app (deploy/cloudflared/README.md → Undo)
```

## What ships from this repo

| Target | Trigger | Lands at |
|---|---|---|
| `api` | `npm run build` on the mini | `localhost:3001` on the mini |
| `web` | `npm run build` on the mini | `../www/sessionmanager` → Caddy |
| `launchd-plist` | — | **not installed**; see the warning above |
| `tunnel` | one-time `bash deploy/cloudflared/setup.sh` on the mini | `https://session.wmpc.app` (behind Cloudflare Access) |

## Targets

### api — Express on the mini

```bash
cd ~/data/web/wmpc/projects/session-manager
git pull && npm run build
```

`npm run build` is `tsc && vite build && ./scripts/restart-api.sh`. The restart
step matters: the mini runs the API as a backgrounded `node dist/server.js`, so a
build that didn't restart would leave the new code on disk with the **old code
still serving requests**. `restart-api.sh` is idempotent (safe cold, safe twice),
SIGTERMs then escalates to SIGKILL after 5s, and honours `SKIP_API_RESTART=1` for
CI or a dev machine where you only want to prove the build compiles. Use
`npm run build:only` to build without touching a running server.

Port `3001` (`PORT`), log `/tmp/sm.log` (`SM_LOG`).

Since 2026-09-05 Express also **serves the built SPA** from the same directory
Caddy publishes (`../www/${APP_NAME}`, override `WEB_DIST`), with an SPA fallback
for client routes — so one process is a complete origin for the tunnel. If the
directory is missing it logs `No built SPA at …` and serves `/api` only. Requests
that arrive **via Cloudflare** (the tunnel) must carry a valid Cloudflare Access
JWT or get `403`; LAN/localhost requests are never gated
(`src/middleware/cf-access.ts`).

### web — caddy-static

Unlike [`club-dashboard`](../club-dashboard), which builds to `web/dist` and
rsyncs, this repo points Vite's `outDir` **straight at** `../../www/${APP_NAME}`
with `emptyOutDir: true`. So a build **writes into the served directory in place**
and wipes whatever was there — there is no staging step, and a failed build can
leave the served directory empty.

In dev, `vite` serves on port 3000 and proxies `/api` to `http://localhost:3001`.

### tunnel — cloudflare-tunnel

```bash
# on the mini, once cloudflared is installed + logged in to the wmpc.app zone:
bash deploy/cloudflared/setup.sh
```

Own tunnel (`session`), own config file and LaunchAgent, so it can't clobber the
`crapi` / `qbo` tunnels on the same machine. **Cloudflare Access is required, not
optional** — the app has no login. The server refuses tunnel traffic until
`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` are in `.env` (fail closed), so setup
is two halves: the script, then the Access application + those two variables.

Runbook: [`deploy/cloudflared/README.md`](./deploy/cloudflared/README.md)

### launchd-plist — present but inert

`launchd/ai.wmpc.sessions.plist` declares `RunAtLoad` + `KeepAlive` for
`node dist/server.js`, which is what this service *should* have. It is not
installed, and its `WorkingDirectory` is the repo's pre-rename path. Fixing it
means updating the path and installing it; until then the API is not
reboot-durable.

## Environments & variable scopes

One environment. Configuration is the repo-root `.env` on the mini (from
[`.env.template`](./.env.template)), plus — for Court Reserve scraping — the
sibling `courtreserve-scheduler/.env`.

`VITE_*` values are **baked into the bundle at build time**, so changing `.env`
takes effect only after a rebuild.

**Tunnel gate:** `CF_ACCESS_TEAM_DOMAIN` (Zero Trust team name) and
`CF_ACCESS_AUD` (the Access application's AUD tag) live in the same `.env`. Unset
= every request arriving through Cloudflare is `403`. `CF_ACCESS_DISABLE=1` turns
the gate off — local debugging only, never on the mini.

**Sibling dependency:** `courtreserve-scheduler` must be present as a sibling for
CR scraping (login, schedule fetch) — the Python scripts import from it. Without
it, video processing still works and CR scraping does not.

## Verify a deploy

```bash
npm run build:only
```

on a dev machine to prove it compiles without disturbing anything. On the mini,
after `npm run build`: confirm the API answers on `localhost:3001` (and
`localhost:3001/` returns the SPA's `<html>`), check `/tmp/sm.log` for a clean
start, and load the Caddy-served SPA host. For the public URL:

```bash
curl -sI https://session.wmpc.app/ | head -1    # 302 → *.cloudflareaccess.com
```

then sign in from a phone off the club Wi-Fi and open a deep link such as
`/members`.

## Roll back

`git checkout <earlier-commit>` on the mini and re-run `npm run build` — that
rebuilds the SPA into the served directory and restarts the API. There is no
deployment history to roll back to; the previous build is gone once
`emptyOutDir` fires.

To take the public hostname down without touching the LAN: `launchctl bootout
gui/$(id -u)/com.wmpc.cloudflared-session` (see the README's *Undo* for removing
the tunnel, CNAME and Access app entirely).

## Does NOT deploy from here

- **Pushing to `main`.** No CI deploy. Merged code is live only after
  `npm run build` **on the mini**.
- **Anything *built* on Cloudflare.** This repo has no Pages project, no Worker,
  and no `wrangler` config — the only Cloudflare piece is the `tunnel` target
  (DNS CNAME + Access app on the existing `wmpc.app` zone). If `CLAUDE.md`'s
  generic "Deploy environments — TEST vs PR preview vs PROD" block suggests a
  Pages/preview setup, that block is a **fleet-wide convention synced into every
  repo** and does not describe this one.
- **Supabase schema.** There are no migrations in this repo; it reads and writes
  an existing project.
- **Court Reserve access.** Login and schedule fetching come from
  [`courtreserve-scheduler`](../court-reserve-scheduler) as a sibling checkout,
  not from anything deployed here.

## Deeper docs

- [`CLAUDE.md`](./CLAUDE.md) — architecture, dev commands, environment variables.
- [`README.md`](./README.md) — what the tool does.
- [`deploy/cloudflared/README.md`](./deploy/cloudflared/README.md) — the public
  tunnel: why it targets Express, the required Cloudflare Access setup, undo.
- `../wmpc-meta/conventions/deployment-doc.md` — why this file exists and its shape.
