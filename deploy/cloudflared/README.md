# Cloudflare Tunnel — `session.wmpc.app`

Publishes the Session Manager (Express on the club **Mac mini**, `localhost:3001`)
at **`https://session.wmpc.app`**, so a coach can drive the pipeline from outside
the club LAN — without opening router ports, moving the video files, or exposing
the mini's IP. Same shape as [`courtreserve-api`](../../../courtreserve-api/deploy/cloudflared)
(`crapi.wmpc.app`) and [`qbo-api`](../../../qbo-api/deploy/cloudflared) (`qbo.wmpc.app`):
its **own** tunnel name (`session`), config file (`~/.cloudflared/config-session.yml`)
and LaunchAgent (`com.wmpc.cloudflared-session`), so the three never clobber each other.

```
coach → https://session.wmpc.app → Cloudflare edge (Access login) → [outbound tunnel]
      → cloudflared (mini) → http://localhost:3001  (Express: the built SPA + /api)
```

## Two hostnames, two security models (D-0273)

The same tunnel now publishes **two** hostnames, and they are protected in
different ways. Do not reason about one from the other.

| Hostname | In front | What it serves | If the server-side check is missing |
|---|---|---|---|
| `session.wmpc.app` | **Cloudflare Access** + the Express JWT gate | the whole app | refused (403) |
| `video.thirdshotacademy.com` | **nothing** — public | `GET /lesson-video/<token>` only | refused (503): an unset `LESSON_VIDEO_SIGNING_SECRET` refuses every request |

On `video.thirdshotacademy.com` the Express route **is the only protection**.
"The public URL has no login" is therefore **not** a symptom on that hostname — it
is the design. It is held in three layers, each failing closed on its own:

1. **Tunnel ingress** — a path-restricted rule: only `/lesson-video/<token>` reaches
   Express from that hostname; everything else is the tunnel's catch-all `404`.
2. **The Access gate** (`src/middleware/cf-access.ts`) — its exemption matches the
   hostname **and** the path together. Every other path on that host is refused
   `403 not_served_here`, even with a valid Access token; the same `/lesson-video/…`
   path on `session.wmpc.app` still needs Access.
3. **The route** (`src/routes/lesson-video.ts`) — verifies an HMAC-SHA256 token
   (15 minutes, minted by the Academy's `lesson-video-token` function) that names
   exactly one file. No caller-supplied path exists; a tampered, expired or
   wrong-file token is refused; one `video_access_log` row is written before any
   bytes (no row, no video).

`LESSON_VIDEO_SIGNING_SECRET` must be the same value in the Academy's Supabase
function secrets and in the mini's `.env`. Never put an Access application on
`video.thirdshotacademy.com` — it would 302 the phone's player to a login page.
Its DNS record is on the Academy's zone (a proxied CNAME to the tunnel's `cfargotunnel.com` address),
which `setup.sh` prints if it cannot create it. When it does, add the record in the
Cloudflare dashboard (thirdshotacademy.com → DNS → Add record, type CNAME, Proxied), one value per field:

**Name** field:

```
video
```

**Target** field: copy the line `setup.sh` printed under "Target field" (a single line
ending in `.cfargotunnel.com`) and paste it as-is.

The rest of this file describes `session.wmpc.app`.

## Why the tunnel points at Express, not Caddy

On the LAN, Caddy file-serves the built SPA from `../www/sessionmanager` and the
browser reaches `/api` on the Express process separately. A tunnel needs **one**
local origin, so `src/server.ts` now also serves that same built directory (with
an SPA fallback for `/sessions/:id`, `/members`, `/roi`) and the tunnel targets
`localhost:3001` directly. Caddy is untouched and the LAN address keeps working;
Express just serves the same files. No Caddy config to discover or keep in sync.

## ⚠️ The app has no login — Cloudflare Access is REQUIRED, not optional

Session Manager has no authentication of its own: anyone who can load it can
create sessions, run video jobs, and fire the Rating Hub webhook. Two layers keep
the public hostname safe:

1. **Cloudflare Access at the edge** — unauthenticated visitors get a login page
   and never reach the mini.
2. **A fail-closed gate in Express** (`src/middleware/cf-access.ts`) — every request
   that arrived via Cloudflare must carry a valid Access JWT
   (`Cf-Access-Jwt-Assertion`, verified against the team's public keys for this
   app's AUD tag). With `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` unset, tunnel
   traffic is refused with `403 cf_access_not_configured`. LAN / localhost requests
   (no Cloudflare headers) are never gated, so Caddy and dev are unaffected.
   `/api/health` is exempt so the smoke test and uptime checks work (it omits
   `videoDir` for public callers).

Layer 2 is what stops a missing or misconfigured Access policy from silently
making the app public.

## Setup (run on the mini)

One-time, interactive — already done on the mini for the other two tunnels:

```bash
brew install cloudflared
cloudflared tunnel login          # browser → choose the wmpc.app zone → ~/.cloudflared/cert.pem
```

Make sure the API is running the current build (it must be serving the SPA):

```bash
cd ~/data/web/wmpc/projects/session-manager
git pull && npm run build         # tsc + vite build + restart the API
curl -s localhost:3001/ | head -3 # expect the SPA's <html>
```

Then the reproducible, idempotent part:

```bash
bash deploy/cloudflared/setup.sh
```

It creates/reuses the `session` tunnel, writes `~/.cloudflared/config-session.yml`,
routes the `session.wmpc.app` CNAME (proxied, `--overwrite-dns`), installs the
`com.wmpc.cloudflared-session` LaunchAgent (`RunAtLoad` + `KeepAlive`), and
smoke-tests `https://session.wmpc.app/api/health`. Overrides: `PORT=`,
`PUBLIC_HOST=`, `TUNNEL_NAME=`.

### Then: Cloudflare Access (both halves)

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add → Self-hosted**.
   - Application domain: `session.wmpc.app`
   - Policy **Allow**: *Emails ending in* `@whitemountainpickleball.com` (or specific
     emails). Session duration: whatever suits (24h is reasonable for a phone).
   - Save. Open the app's **Overview** and copy the **Application Audience (AUD) Tag**.
   - Optional: a **Bypass** policy for the path `/api/health` so uptime checks need
     no login. (Everything else must stay behind Allow.)
2. On the mini, in the repo's `.env`:
   ```bash
   CF_ACCESS_TEAM_DOMAIN=<team name>   # e.g. wmpc  →  wmpc.cloudflareaccess.com
   CF_ACCESS_AUD=<the AUD tag>
   ```
   then `npm run restart`. The API log (`/tmp/sm.log`) shows
   `[cf-access] gating tunnel traffic against https://<team>.cloudflareaccess.com`.

Verify from a phone on cellular:

- `https://session.wmpc.app` → Access login → the dashboard.
- `https://session.wmpc.app/members` (deep link) → Members page, not a 404.
- Private window → Access login page, never the app.

```bash
curl -sI https://session.wmpc.app/ | head -1      # 302 → *.cloudflareaccess.com
```

## Cost

Free — `cloudflared`, the tunnel, the Free plan, and Access (≤50 users) on the
existing `wmpc.app` zone. Only requirement: the mini stays online (it must anyway,
it owns the video files).

## Troubleshooting

```bash
launchctl print gui/$(id -u)/com.wmpc.cloudflared-session | head   # running?
tail -f ~/Library/Logs/cloudflared-session.err.log                  # tunnel logs
cloudflared tunnel info session                                     # connections
curl -s localhost:3001/api/health                                   # origin up?
tail -50 /tmp/sm.log                                                # API log
```

| Symptom | Cause / fix |
|---|---|
| `502` at the public URL | Express isn't up on the mini — `npm run build` (or `npm run start`). The API restarts itself after a reboot once `./scripts/install-api.sh` has been run on the mini (see `DEPLOYMENT.md`); if that was never run, someone must start it. |
| `530` / DNS errors right after setup | DNS still propagating; wait a minute. |
| Public root or `/api/*` returns `403 cf_access_not_configured` | Access vars missing in `.env` — do "both halves" above, then `npm run restart`. |
| `403 cf_access_invalid` after signing in | Wrong `CF_ACCESS_AUD` (copy it from the *right* Access application) or wrong team domain. |
| Public URL shows the app with **no** login | The Access application/policy is missing — you're only protected by the Express gate. Add it now. |
| Public root returns a JSON 404 or `Cannot GET /` | Express isn't serving the SPA: the build dir (`../www/sessionmanager`, or `WEB_DIST`) is missing — run `npm run build`. |
| `video.thirdshotacademy.com/lesson-video/…` returns `503 video_delivery_not_configured` | `LESSON_VIDEO_SIGNING_SECRET` is unset (or under 16 characters) in the mini's `.env` — set it, then `npm run restart`. |
| `video.thirdshotacademy.com/lesson-video/…` returns `403 token_refused` | The token is expired (15 min), tampered, or was signed with a different secret than the mini holds. |
| `video.thirdshotacademy.com/lesson-video/…` returns `404 not_found` | The token is good but the clip file is not on the NAS yet (the cutter has not run, or `/Volumes/wmpc-video` is unmounted). |
| LAN address suddenly needs login | It shouldn't — the gate only fires on requests with Cloudflare headers. Check nothing on the LAN path adds `Cf-Connecting-Ip`. |

Re-running `setup.sh` is safe (reuses the tunnel, rewrites its config, reloads the agent).

## Undo

```bash
launchctl bootout gui/$(id -u)/com.wmpc.cloudflared-session
rm ~/Library/LaunchAgents/com.wmpc.cloudflared-session.plist ~/.cloudflared/config-session.yml
cloudflared tunnel delete session      # then remove the session CNAME in the Cloudflare dashboard
```
Also delete the Access application in Zero Trust and drop the two `CF_ACCESS_*` lines from `.env`.
