# WMPC Session Manager

> **Strategic context** — For the *why* (manifesto) and *what's next* (strategy) across all four repos in this stack, see `../wmpc-meta/strategy.md`. That sibling directory is auto-synced on every `git pull` via `scripts/claude-bootstrap.sh` — run it once after first cloning to install the hooks. Update `wmpc-meta/strategy.md` after meaningful strategic decisions; engineering specs stay in this repo's docs.


## Session bootstrap

**Start every session here:** read [`STATUS.md`](./STATUS.md) — the
append-only front door (current state · done · in flight · next). **Before
you wrap:** append a short dated entry with what changed and what's next.
Don't rewrite history; newest entry wins.

## Overview

On-premise orchestration tool for WMPC pickleball rating sessions. Manages the pipeline from video recording through game extraction, PB Vision upload, player tagging, to Rating Hub import.

This is a **local service** designed to run on the machine with access to video files. It can run on a Mac, Raspberry Pi, or any Linux box on the network.

## Tech Stack

- **Backend**: Node + Express + TypeScript (ESM)
- **Frontend**: React 18 + TypeScript + Vite (SPA)
- **Database**: Supabase (Postgres) — tables `session_manager_sessions` and
  `session_manager_session_logs` in the shared rating-hub project, scoped by
  `org_id`. State persists across machines. (Was local SQLite via
  better-sqlite3 before 2026-04-28; the old `session-manager.db` is kept as
  a backup but no longer read by the app.)
- **Video Processing**: Python 3.10+ scripts (detect_games.py, export_from_srt.py) called via child_process
- **CR Scraping**: Python + Playwright (imports from sibling courtreserve-scheduler project)
- **Package manager**: npm
- **Runtime**: tsx for dev, compiled JS for prod

## Prerequisites

- Node.js 18+
- Python 3.10+ with venv support
- ffmpeg (for clip export)
- Playwright + Chromium (for CourtReserve scraping)

## Quick Start

```bash
# One-command setup (installs all deps)
./setup.sh

# Edit .env with your credentials and paths
nano .env

# Start the app
npm run dev

# Open http://localhost:3000
```

## Sibling Project Dependencies

This project expects the following sibling projects to exist:

```
projects/
  session-manager/          # This project
  courtreserve-scheduler/   # Required for CR scraping (login, schedule fetch)
  rating-hub/               # The web app this feeds data into
```

**courtreserve-scheduler** is required for:
- `scripts/scrape-members.py` — imports `cr_client.browser_session` for Cloudflare-safe login
- `scripts/fetch-schedule.py` — imports `cr_client.fetch_schedule` for schedule data

If courtreserve-scheduler is not present, the video processing features still work but CR scraping will not.

## Architecture

- Express API on port 3001 serves `/api/*` endpoints — and, when the built SPA
  exists (`../www/$APP_NAME`, override `WEB_DIST`), serves it too with an SPA
  fallback, so one process is a complete origin
- Vite dev server on port 3000 proxies `/api` to Express
- Public access: a Cloudflare Tunnel on the mini publishes Express at
  `https://session.wmpc.app` behind **Cloudflare Access** (the app has no login
  of its own). Requests arriving via Cloudflare must carry a valid Access JWT or
  get 403 (fail closed; LAN/localhost never gated) —
  `src/middleware/cf-access.ts`, runbook `deploy/cloudflared/README.md`
- Supabase stores session state and logs (replaces the old local SQLite DB).
  All session-manager state is tagged with `org_id`, so multiple coaches /
  machines can collaborate against the same Supabase project.
- Python scripts in `scripts/videos/` handle video analysis + clip extraction
- Python scripts in `scripts/` handle CourtReserve scraping
- Communicates with Rating Hub via its webhook endpoint when ready to import

## Directory Structure

```
setup.sh                     # One-command setup for new machines
deploy/cloudflared/          # Cloudflare Tunnel: setup.sh (run on the mini) + README runbook
.env.template                # Template for environment variables (copied to .env by setup.sh)
src/
  server.ts                  # Express entry point (API + serves the built SPA)
  middleware/
    cf-access.ts             # Cloudflare Access JWT gate for tunnel traffic
  types.ts                   # Shared TypeScript types
  db/
    index.ts                 # Supabase-backed sessions + logs repository
                             # (listSessions, getSession, createSession,
                             # updateSession, listLogs, makeAddLog, …)
  routes/
    sessions.ts              # Session CRUD + pipeline actions + reset
    videos.ts                # Video file listing from VIDEO_DIR
    members.ts               # Member list from cached CR data
    schedule.ts              # Schedule + rating event detection
  services/
    video-processor.ts       # Wraps Python scripts (detect_games, export_from_srt)
scripts/
  videos/                    # Python video processing
    detect_games.py          # Motion analysis → game segment detection
    export_from_srt.py       # ffmpeg clip extraction from SRT timecodes
    roi.json                 # Court region of interest for motion detection
    requirements.txt         # Python deps (opencv-python, numpy)
  scrape-members.py          # CR member export via Playwright + Excel download
  fetch-schedule.py          # CR schedule fetch + rating event detection
web/
  index.html                 # SPA entry
  src/
    App.tsx                  # React router
    pages/
      Dashboard.tsx          # Rating events, session list, manual creation with member search
      SessionDetail.tsx      # Video select, game detection, segment editing, clip export
    components/
      StatusBadge.tsx        # Color-coded pipeline status indicator
data/                        # Cached data (gitignored)
  schedule.json              # CR schedule cache
  rating_events.json         # Filtered rating events
```

## Rating Hub Integration

**End-to-end workflow across both projects is documented in**
`../wmpc_rating_hub/CLAUDE.md` — that file is the single source of truth.
Update it there first, then update summaries here.

### Division of responsibilities

This project owns everything from scheduling through pb.vision upload:

1. Schedule — CourtReserve scraping, rating-event detection
2. Record — coordinate camera capture
3. Split — detect + export per-game clips from session recording
4. Upload — push clips to pb.vision via their Partner API
5. Wait for AI processing
6. Wait for human tagging on pb.vision
7. Fetch Mux playback ID from pb.vision Firestore
8. Fire webhook to rating-hub

rating-hub handles everything downstream (import, visualization, coach analysis).

### What the public PB Vision API exposes (verified 2026-04-19)

rating-hub fetches these directly without needing us:
- Compact insights JSON
- Augmented insights JSON
- Tagged player names (come through insights after tagging)
- Player avatar images (from GCS `pbv-pro` bucket)
- Video poster image

What's NOT public (session-manager must fetch and push):
- **Mux playback ID** — in pb.vision's Firestore at `pbv-prod/videos/{vid}.mux.playbackId`
- **stats.json format** — the public API returns HTTP 400
- **Listing a user's videos** — no REST endpoint, only Firestore

### Updated webhook contract (as of 2026-04-19)

Only ONE call per game — fire it AFTER human tagging is complete on pb.vision:

```
POST https://cjtfhegtgbfwccnruood.supabase.co/functions/v1/pbvision-webhook
Authorization: Bearer <WEBHOOK_SECRET>
Content-Type: application/json
{
  "videoId": "abc123",
  "sessionId": "optional-session-uuid",
  "muxPlaybackId": "a00w01bJI01Ax..."   // optional but highly recommended
}
```

rating-hub will:
- Fetch compact + augmented insights from the public API
- Import games, game_players, players (by real name), rallies, rally_shots, rating snapshots
- Merge highlights + 119 advanced stats from augmented
- Set `games.mux_playback_id` if provided
- Derive player avatar URLs from `aiEngineVersion` + `avatar_id`

Response:
```json
{
  "status": "success",
  "sessionsImported": 1,
  "augmentedMerged": true,
  "totalShots": 260,
  "muxPlaybackIdSet": true,
  "games": [{ "gameId": "...", "players": 4, "rallies": 48, "shots": 260 }]
}
```

### Why the "delay until tagged" ordering matters

If we fire the webhook before tagging, rating-hub imports players as "Player 0",
"Player 1", etc. and creates placeholder `players` rows. When we later re-fire
after tagging, the real names arrive and rating-hub's `findOrCreatePlayer` can
match against existing real-name players — but the placeholder rows linger in
the DB, polluting the leaderboard.

To keep this clean: session-manager must poll pb.vision's Firestore for both
"AI processing complete" AND "names are not 'Player N'" before firing the
webhook.

### Current status

- ✅ session-manager calls rating-hub webhook (existing "Sync with Rating Hub"
  button per session)
- ⬜ session-manager does NOT yet poll for tagging completion — coach must
  manually trigger sync after tagging
- ⬜ session-manager does NOT yet fetch Mux playback ID from Firestore and
  include it in the webhook payload — current workaround is the `📌 PBV Grab`
  bookmarklet on rating-hub's analyze page
- ⬜ session-manager may need to update its webhook caller to include
  `muxPlaybackId` in the body once the Firestore fetch is built

## Session Pipeline States

```
scheduled → recording → recorded → splitting → split → uploading → processing → tagging → importing → complete
                                                                                              ↓
                                                                                           failed
```

"Start Over" resets a session back to `scheduled`, deletes clips and logs.

## Common Commands

```bash
# One-command setup
./setup.sh

# Dev (API + frontend)
npm run dev

# Dev (server only / frontend only)
npm run dev:server
npm run dev:web

# Build for production
npm run build

# Refresh CourtReserve data
npm run sync:members                           # Scrape CR members → Supabase (inserts only)
npm run sync:members -- --headed               # Headed mode if Cloudflare blocks headless
venv/bin/python scripts/fetch-schedule.py      # Today's schedule
venv/bin/python scripts/fetch-schedule.py --days 7  # Next 7 days
```

## Environment Variables

```bash
# Required
VIDEO_DIR=/path/to/video/files        # Optional — defaults to <project>/videos

# courtreserve-api HTTP service — the app's schedule sync source. The service
# (sibling ../courtreserve-api) owns the CR login + browser and runs on the
# club Mac mini; this app just makes an authenticated LAN fetch.
CRAPI_URL=http://localhost:8787        # service base (localhost on the mini, or http://<mini-ip>:8787)
CRAPI_KEY=your-courtreserve-api-key    # == the service's CRAPI_KEY, sent as X-API-Key

# CourtReserve creds — ONLY still used by the legacy Python scripts
# (scripts/scrape-members.py, scripts/fetch-schedule.py). The app's schedule
# sync no longer needs them.
CR_EMAIL=your-email@example.com
CR_PASSWORD=your-password
CR_BASE_URL=https://app.courtreserve.com

# Optional
PORT=3001                              # Express API port (default 3001)
WEB_DIST=/abs/path                     # Where Express finds the built SPA (default ../www/$APP_NAME)

# Cloudflare Access — REQUIRED on the mini once the tunnel publishes the app at
# https://session.wmpc.app. The server refuses requests that arrived via
# Cloudflare unless they carry a valid Access JWT; with these unset that is
# every tunnel request (fail closed). LAN / localhost are never gated.
CF_ACCESS_TEAM_DOMAIN=wmpc             # Zero Trust team name (→ <team>.cloudflareaccess.com)
CF_ACCESS_AUD=<64-hex AUD tag>         # Access application → Overview → Application Audience Tag
# CF_ACCESS_DISABLE=1                  # local debugging only — never on the mini
```

**CR sync paths (both via courtreserve-api — no Python / Playwright / sibling):**
- **Schedule** — dashboard "Sync with CourtReserve" → `refreshScheduleFromCr()`
  → `GET {CRAPI_URL}/schedule` → writes `data/schedule.json`.
- **Members** — Members page "Sync now" / `npm run sync:members` →
  `src/members/sync.ts` `fetchMembers()` → `GET {CRAPI_URL}/memberships/records`
  → deduped to one row per member → reconciled into Supabase `players`.

The legacy `scripts/fetch-schedule.py` + `scripts/scrape-members.py` (which
import `cr_client`) remain only as manual CLI fallbacks; no app code path uses
them anymore.

## Moving to a New Machine

1. Clone this repo and courtreserve-scheduler as siblings
2. Run `./setup.sh`
3. Copy `.env` from old machine (or create from `.env.template`) — set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ORG_SLUG`
4. Drop recordings into `videos/` (gitignored, auto-created) — or set `VIDEO_DIR` to an external directory
5. Run `npm run sync:members` to pull members from CourtReserve into Supabase
6. `npm run dev`

Sessions/logs come from Supabase automatically — no SQLite file to copy.

Note: `video_path` and `clip_paths` are stored as absolute paths from
whichever machine processed the video. On a second machine those paths
won't resolve unless the same directory tree exists. For now the convention
is that the recording machine "owns" the video files; other machines see
the metadata but can't replay clips.

## Backlog

This repo's backlog lives on the **WMPC Roadmap** GitHub Project board
(Project **#1**, owner `notronwest`) — **not** in a file. This repo's
stories are its `story`-labeled GitHub Issues, added to the board.

- **Read:** `gh issue list --repo notronwest/rating-session-manager --label story`
  (whole board: `gh project item-list 1 --owner notronwest`).
- **Write ("add to backlog"):** create a GitHub Issue with a user story + a
  scripted, code-free `## Acceptance criteria`; label it `story`; add it
  (`gh project item-add 1 --owner notronwest --url <url>`); set **Priority**
  + **Type**. Runs on your `gh` auth — no approval needed.
- **Statuses — one pipeline:** `Backlog` → `Agent Ready` → `In Progress` →
  `In Review` → `Done`, with `Blocked` and `On Hold` as side rails.
  - The **Builder** drains **Agent Ready** into PRs and moves cards itself;
    **you merge** `In Review` (the only gate). It never merges or pushes main.
  - **`Blocked` = the Builder needs you** (missing AC, a product decision, or
    risky work — migrations / security / money). **Draining `Blocked` is your
    loop:** read its comment, then add the AC/decision and move it to **Agent
    Ready**, do the risky part yourself, or close it.
  - **`On Hold`** = intentionally parked (no action needed); **`Backlog`** =
    uncurated intake.
- **Full convention** (lifecycle table, the Blocked flow, fields, examples):
  [`../wmpc-meta/conventions/backlog.md`](../wmpc-meta/conventions/backlog.md).
  Don't reintroduce a `BACKLOG.md` file.



<!-- wmpc-block:environments:v1 START -->
## Deploy environments — TEST vs PR **preview** vs PROD (they differ)

There are **three** running environments, not two. Know which one you're
looking at, because they do **not** share configuration:

| Environment | Comes from | Cloudflare variable scope |
|---|---|---|
| **TEST** | the `main` branch build | the `main`/TEST build's variables |
| **PR preview** | **every open PR** gets its own preview deploy | the **preview** (non-production) scope — set **separately** |
| **PROD** | the `production` branch build | the production scope |

**The trap that costs real debugging time:** a PR **preview is not TEST.**
Cloudflare builds each deploy with the variables/secrets configured for *that
deploy's scope*, and for our Vite SPAs the `VITE_*` values are **baked into the
bundle at build time**. So a PR preview is compiled against the **preview**
scope's `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ENV`,
`VITE_COACH_AI_SECRET`, `VITE_GOOGLE_CLIENT_ID`, etc. — which are configured
independently of TEST. If any of those differ or lag, the preview points at a
**different Supabase project / different keys / a missing secret** than TEST and
**behaves differently for reasons that have nothing to do with the code.**

**Because of this, always:**

- **Name the environment** when you hand work over. Say "validate on the **PR
  preview** (its own env-var scope, *not* TEST)" — don't let anyone assume the
  preview equals TEST.
- **Suspect the env vars first** when a preview misbehaves but the code looks
  right. Confirm the preview's Supabase URL / keys / secret are the intended
  ones *before* debugging code. `VITE_APP_ENV` and the Supabase URL are visible
  in the running app — check them.
- **Add any new var/secret a feature needs to the preview scope too**, not just
  TEST/PROD. Set only in TEST → the PR preview won't have it and fails in a way
  that looks like a code bug (and it must be in PROD before promotion).
- **Remember `VITE_*` is build-time.** Changing a Cloudflare variable takes
  effect only after the PR **re-builds/re-deploys** — a page refresh won't pick
  it up.

Migrations are the mirror image: a preview is **frontend-only against the live
DB**, and a migration applies **only on merge to `main`** — so the DB the
preview talks to is real/live, while the schema change it may depend on isn't
there until merged (why DB and UX ship as separate PRs — see the migration
convention).
<!-- wmpc-block:environments:v1 END -->

<!-- wmpc-block:engineering-standard:v2 START -->
## Engineering standard

Operate as a **senior full-stack engineer**, not a code generator. This is the
posture for all code work in this repo (interactive sessions and the Builder):

- **Production-minded.** Handle errors, edge cases, and loading / empty /
  failure states — not just the happy path.
- **Verify before "done."** Typecheck, build, and lint; run the test where one
  exists. Report the real output — never claim success you didn't check.
- **Delegate to sub-agents to protect your context — by default, not as a last
  resort.** For well-scoped, context-heavy work, spin up a sub-agent (the
  Task/Agent tool) and keep only its *result* in your main thread. Reach for it
  whenever it applies: broad multi-file searches and codebase exploration (use
  the **Explore** agent — you want the conclusion, not the file dumps);
  **mechanical sweeps** with clear rules ("convert all ~20 loading states to
  `<Loading>`"); research questions; and independent parallel workstreams (launch
  them in one message so they run concurrently). **You stay the owner:** the main
  session *verifies* (typecheck/build/lint), *reviews the diff*, and *ships the
  single PR* — the sub-agent does the legwork, you keep the judgment and the
  context window. **Don't** delegate trivial quick edits (the round-trip costs
  more than it saves), work needing tight back-and-forth with Ron, or **parallel
  edits to the same files** (they clobber each other — serialize, or give each
  agent its own worktree). A budget-capped headless run (the Builder) weighs the
  extra token cost before fanning out; an interactive session should lean in,
  since context is the scarce resource.
- **Match the codebase.** Follow existing patterns, naming, and structure;
  reuse before adding. Read neighboring code first.
- **Mockups are the real page, running and interactive — never an inline
  widget.** When asked to "do a mockup," the deliverable is the **actual page
  rendered end-to-end with the proposed change inline**, served in a **real,
  clickable browser preview**: start the app's dev server and open the real
  route, or — only if that's genuinely impractical — write a full standalone
  HTML page that duplicates the real page and open *that* in the preview.
  Duplicate the real page/component being changed (its true layout, markup,
  styles, and design tokens) and modify *that* in context; never an abstract,
  from-scratch, or "clean-room" stand-in. **Do NOT** deliver a mockup as a
  chat-inline visualization/widget (e.g. a `show_widget` / visualize call, or an
  SVG/HTML blob embedded in the reply) — the whole point is to **feel the real
  UX by interacting with it before we build**, which a static inline widget
  can't do. If the target page doesn't exist yet, build the new page full-size
  and interactive in a real preview all the same. Fall back to a static image or
  snippet only when explicitly asked for one.
- **Right-size it.** The simplest thing that fully solves the task — no
  speculative abstraction, no gold-plating a small change.
- **Security + data aware.** No secrets in code, validate inputs, respect
  auth / tenancy boundaries.
- **Surface tradeoffs.** Flag risks, migrations, and breaking changes; ask
  before large refactors or irreversible actions.

This raises the floor; it does not override this repo's specific conventions
above (branch/PR discipline, mobile-first, design tokens, docs-in-the-same-change).
<!-- wmpc-block:engineering-standard:v2 END -->

<!-- wmpc-block:ui-work:v2 START -->
## UI work — required before any visual change

Before ANY change to visual/UI code (a page, component, layout, nav, or style)
— this is a gate, not a suggestion:

- **Consult our design system FIRST.** `../wmpc-meta/design-system/` (tokens) +
  this repo's `docs/DESIGN_PREFERENCES.md` govern look, spacing, layout, and
  brand. Reuse existing components and tokens; do not invent one-off styles.
- **Component behavior + accessibility: follow shadcn/ui + Radix conventions**
  (accessible primitives, keyboard + ARIA, focus management) — but **style with
  our design tokens, NOT Tailwind.** This stack uses inline styles + a minimal
  index.css, no CSS framework; a Tailwind/shadcn migration is a separate,
  deliberate project, not something to introduce inside an unrelated UI change.
- **Mobile-first is non-negotiable.** Design AND verify at **390px width FIRST**,
  then scale up. A UI change that has not been checked at 390px is NOT done.
- **Mockups run in a real, interactive preview — not a chat-inline widget.**
  When Ron asks to "do a mockup," render the **whole page** with the change
  inline in a **clickable browser preview** (the app's dev server on the real
  route, or a full standalone HTML page duplicated from the real one) so the UX
  can be *felt* before we build. Never a `show_widget` / inline SVG-or-HTML blob.
  Full rule under **Engineering standard → Mockups**.
- **Uncovered pattern?** Fetch the specific Radix / shadcn (or Material 3) doc
  for that component rather than freelancing or guessing at the design.
- **Never overwhelm the user — guide them, don't dump the whole surface.** A
  config screen is a design failure when it's a **wall of granular controls the
  user has to reverse-engineer** — the *Stripe restricted-key permissions screen*
  anti-pattern: dozens of ungrouped toggles, two unexplained columns ("Permissions
  vs Connect Permissions"), no search, and a primary field ambiguous enough to
  look like a filter. Instead: **sensible defaults**; a **preset for the common
  task** (one click does the 90% case); **search/filter** on any long list;
  **plain-language labels** (no unexplained jargon or ambiguous columns);
  **progressive disclosure** (advanced/rare options collapsed by default); and
  **bulk actions** for repetitive rows. There should be one **obvious primary
  path**; the long tail is opt-in. If a screen forces the user to understand the
  whole domain model just to make one choice, it needs redesigning — flag it, don't
  ship it.
<!-- wmpc-block:ui-work:v2 END -->
