# Deployment — session-manager

Two halves, both on the club **Mac mini**, both deployed by running
`npm run build` **on that machine**: an **Express API** on port 3001 (restarted
in-place by the build) and a **Vite SPA** that builds straight into the sibling
`www/sessionmanager/` directory the shared **Caddy** file-server publishes.
Nothing here touches Cloudflare, and pushing to `main` deploys nothing.

> ⚠️ Two known gaps, recorded rather than papered over:
> - **`launchd/ai.wmpc.sessions.plist` is stale and not installed.** Its
>   `WorkingDirectory` still points at `…/projects/rating-session-manager`, the
>   repo's old name. `setup.sh` never installs it, and the API is actually run as
>   a backgrounded `node dist/server.js` by `scripts/restart-api.sh`. So the API
>   does **not** survive a reboot unless someone starts it.
> - **The public hostname is not recorded anywhere in this repo.** The SPA is
>   served by Caddy from `../www/sessionmanager`, but which host maps to it isn't
>   written down — read it off the mini's `/opt/homebrew/etc/Caddyfile`.

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
    url: http://localhost:3001 on the mini (the SPA proxies /api to it)
    host: wmpcMacMini1
    config_scope: .env in the repo root on the mini (also reads courtreserve-scheduler/.env for CR scraping)
    verify: curl an /api/* endpoint on the mini; log at /tmp/sm.log (override with SM_LOG)
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
```

## What ships from this repo

| Target | Trigger | Lands at |
|---|---|---|
| `api` | `npm run build` on the mini | `localhost:3001` on the mini |
| `web` | `npm run build` on the mini | `../www/sessionmanager` → Caddy |
| `launchd-plist` | — | **not installed**; see the warning above |

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

### web — caddy-static

Unlike [`club-dashboard`](../club-dashboard), which builds to `web/dist` and
rsyncs, this repo points Vite's `outDir` **straight at** `../../www/${APP_NAME}`
with `emptyOutDir: true`. So a build **writes into the served directory in place**
and wipes whatever was there — there is no staging step, and a failed build can
leave the served directory empty.

In dev, `vite` serves on port 3000 and proxies `/api` to `http://localhost:3001`.

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

**Sibling dependency:** `courtreserve-scheduler` must be present as a sibling for
CR scraping (login, schedule fetch) — the Python scripts import from it. Without
it, video processing still works and CR scraping does not.

## Verify a deploy

```bash
npm run build:only
```

on a dev machine to prove it compiles without disturbing anything. On the mini,
after `npm run build`: confirm the API answers on `localhost:3001`, check
`/tmp/sm.log` for a clean start, and load the Caddy-served SPA host.

## Roll back

`git checkout <earlier-commit>` on the mini and re-run `npm run build` — that
rebuilds the SPA into the served directory and restarts the API. There is no
deployment history to roll back to; the previous build is gone once
`emptyOutDir` fires.

## Does NOT deploy from here

- **Pushing to `main`.** No CI deploy. Merged code is live only after
  `npm run build` **on the mini**.
- **Anything to Cloudflare.** This repo has no Pages project, no Worker, and no
  `wrangler` config. If `CLAUDE.md`'s generic "Deploy environments — TEST vs PR
  preview vs PROD" block suggests otherwise, that block is a **fleet-wide
  convention synced into every repo** and does not describe this one.
- **Supabase schema.** There are no migrations in this repo; it reads and writes
  an existing project.
- **Court Reserve access.** Login and schedule fetching come from
  [`courtreserve-scheduler`](../court-reserve-scheduler) as a sibling checkout,
  not from anything deployed here.

## Deeper docs

- [`CLAUDE.md`](./CLAUDE.md) — architecture, dev commands, environment variables.
- [`README.md`](./README.md) — what the tool does.
- `../wmpc-meta/conventions/deployment-doc.md` — why this file exists and its shape.
