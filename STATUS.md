# Status — session-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **Local pipeline orchestrator (Express + Vite + Python);
design tokens adopted.**
Last updated: **2026-07-22**

## 2026-07-22 — Schedule sync moved off Python → courtreserve-api HTTP service

- **Problem:** the dashboard "Sync with CourtReserve" button spawned
  `scripts/fetch-schedule.py`, which imports `cr_client` from the sibling
  `courtreserve-scheduler/` repo. On any machine without that sibling (e.g. the
  Mac mini) it died with `ModuleNotFoundError: No module named 'cr_client'`
  (and with system `python3` instead of the venv it fails one import later on
  `dotenv`). Fragile cross-repo Python coupling.
- **Fix:** `refreshScheduleFromCr()` in
  [`src/services/cr-sync.ts`](./src/services/cr-sync.ts) now does an
  authenticated `fetch` to the shared **courtreserve-api** service
  (`GET {CRAPI_URL}/schedule?start=<today>&end=<today>`, header
  `X-API-Key: {CRAPI_KEY}`) and writes the returned `items` array to
  `data/schedule.json` — the same cache everything downstream already reads, so
  no other code changed. No Python / Playwright / sibling repo on this side.
  60s timeout; typed `CrSyncError` codes (`crapi_not_configured`,
  `crapi_unreachable`, `crapi_timeout`, `crapi_unauthorized`, `crapi_error`,
  `crapi_bad_json`) instead of a raw traceback.
- **Config:** new env vars `CRAPI_URL` (default `http://localhost:8787`) and
  `CRAPI_KEY` (== the service's `CRAPI_KEY`). Added to `.env.template` + `.env`.
  On the mini, set `CRAPI_URL` to the service (localhost or LAN IP:8787) and
  `CRAPI_KEY` to match — see `../courtreserve-api/deploy/README.md`.
- Also refreshed the Discord failure alert + the "no schedule data" hint to
  point at courtreserve-api instead of the old Playwright profile.
- `tsc` + `vite build` clean; smoke-tested happy path (sends key, requests
  `/schedule?start=7/22/2026&…`, writes items) + not-configured + 401 paths.
- **Still on Python (follow-up):** `npm run sync:members` →
  `scripts/scrape-members.py` still imports `cr_client`. courtreserve-api can
  serve this too (`/memberships/records`) — migrate it the same way next.
- **Left in place:** `scripts/fetch-schedule.py` stays as a manual CLI fallback
  (venv + sibling required); the app no longer calls it.

## 2026-07-14 — Root-caused the webhook 401 (secret value mismatch)

- The `401 Unauthorized` on every rating-hub webhook is a **pure secret
  value mismatch**, not a format/scheme bug. Confirmed by reading the
  deployed function source: **rating-hub = the `third-shot-academy` repo**,
  `supabase/functions/pbvision-webhook/index.ts:609-616` does an exact match
  — `Authorization` must equal `` `Bearer ${WEBHOOK_SECRET}` `` where
  `WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")`.
- Our `webhook.ts` sends exactly that scheme, so it's correct. Probed the
  live endpoint: our `.env` secret (ends `022b`), a valid service-role JWT,
  AND no-auth ALL return `{"error":"Unauthorized"}` → the deployed
  `WEBHOOK_SECRET` is simply a value we don't have. The `if (WEBHOOK_SECRET)`
  guard means it only started enforcing once someone set/rotated that secret
  on the deployed side without updating our `.env`.
- **The correct value lives only in the Supabase secret store** (project
  `cjtfhegtgbfwccnruood` → Edge Functions → Secrets → `WEBHOOK_SECRET`), not
  in any repo file — so it can't be read from disk.
- **Next (fix is the user's infra call, two options):**
  - **A:** copy the deployed `WEBHOOK_SECRET` into `RATING_HUB_WEBHOOK_SECRET`
    in each session-manager machine's `.env`, then `npm run build` to restart.
  - **B (one-shot, fixes all machines):** from the third-shot-academy repo,
    `supabase secrets set WEBHOOK_SECRET=<value ending 022b> --project-ref
    cjtfhegtgbfwccnruood` to align the deployed secret to what the machines
    already have.
  - Until aligned, nothing imports ("0 game(s) linked" is downstream of this).

## 2026-07-14 — Committed bootstrap artifacts + new "PR must close an issue" CI gate

- The `wmpc-meta` bootstrap hook regenerates managed files on every `git
  pull`, but this repo had never committed them — so the working tree looked
  dirty (`+1,431`) on every machine. Sorted it in **[PR #48](https://github.com/notronwest/rating-session-manager/pull/48)** (closes #47):
  - **Committed** `.github/workflows/pr-linked-issue.yml` and the `wmpc-block`
    managed sections in `CLAUDE.md` (engineering-standard, ui-work) — shared
    org artifacts, matching sibling `club-dashboard`. Idempotent START/END
    markers mean tracking them *stops* the churn.
  - **Gitignored** `**/.claude/history/` + `CLAUDE.md.tmp`; removed the stale
    tmp. Fresh `git pull` on a clean checkout now leaves `git status` clean.
- **⚠️ New CI gate now on `main`:** `pr-linked-issue.yml` requires **every
  PR body to CLOSE an issue** with a keyword (`Closes #N` / `Fixes #N` /
  `Resolves #N`) — `Part of #N` alone does NOT count. Any future PR here
  (incl. retiring the Mux scraper) needs a tracking issue + closing keyword
  or its check fails.

## 2026-07-14 — pb.vision dropped Mux → deterministic public GCS MP4

- **Diagnosed two unrelated failures** from a live sync log (session
  `3a7a6e17…`): (1) every rating-hub webhook returned **401 Unauthorized**,
  and (2) the auto Mux fetch reported **9 errors / 0 updated**.
- **pb.vision no longer uses Mux.** Inspected their video page — zero
  `<mux-player>`, no `stream.mux.com` requests, `<video>` plays a blob/MSE
  source. Real media is a **public, CORS-open, deterministic** GCS MP4:
  `https://storage.googleapis.com/pbv-pro/<vid>/max.mp4` (200/206,
  `video/mp4`, `access-control-allow-origin: *`, Range-seekable). No
  login/scrape needed — derivable from the vid alone.
- **Migration is complete.** Tested all 61 historical Mux-era vids (back to
  2026-04-19, from the `session-manager.db` backup) + today's 3 → **64/64
  serve on GCS, zero misses.** No old video stranded on Mux, so retiring our
  scraper is safe from a coverage standpoint.
- **Consequence:** `scripts/pbvision-mux.py` + `src/services/mux-sync.ts` are
  obsolete — they'll error on every video forever ("playback ID not found").
  The "9 errors" are not our bug.
- **Decision:** rating-hub will **derive** the GCS URL from the vid itself;
  session-manager sends no new payload field (the webhook already sends
  `videoId`). **No session-manager code changed this session.**
- **Next (ordered):**
  1. **Fix the 401** — re-sync `RATING_HUB_WEBHOOK_SECRET` here with what the
     rating-hub `pbvision-webhook` edge function expects. This is the real
     blocker; nothing imports until it matches.
  2. **rating-hub** switches its embed from `games.mux_playback_id` (Mux
     player) to the derived GCS MP4 in a plain `<video>`.
  3. **Only then** retire `pbvision-mux.py`, `mux-sync.ts`, the background
     auto-fetch ([sessions.ts:1589](src/routes/sessions.ts:1589)), and the
     "Fetch Mux IDs" button here. Optional interim: silence the auto-fetch so
     Sync stops logging 9 errors, while leaving the files until step 2 lands.

## 2026-06-25 — Reverted the lengthened ROI (it regressed detection)

- The 2026-06-24 ROI change (PR #42) **broke production detection** and was
  reverted in **PR #43**. `roi.json` is back to the original production
  polygon `[821,573] [1082,369] [573,236] [382,276]`.
- **What went wrong:** PR #42 was tuned against the local `2026-05-14`
  *sample* clip, which uses a **different camera angle** than the production
  "Road to 4.5" / Group Play recordings. Every prior session detected 4–12
  games correctly with the original ROI; the first session run after #42
  ("Road to 4.5 Week 5", `videos/2026-06-24 09-51-44.mov`) collapsed to 2
  short segments (2m + 4m across 95 min).
- **Lesson:** the single global `roi.json` is camera-specific. Never tune it
  against a clip whose camera differs from the sessions being detected. The
  production session videos are **not on this machine** (they live on the
  recording machine, under `videos/processed/`), so ROI tuning must be done
  **there** via the Configure Court ROI UI against a real session frame.
- **Next:** on the recording machine — `git pull`, then Clear Segments &
  re-Detect "Road to 4.5 Week 5". If it's still bad, the Week 5 camera likely
  moved vs prior weeks; re-trace the court in Configure Court ROI on a Week 5
  frame (all 4 players visible) and re-detect. The original "mid-game cut"
  report is still open and should be addressed via break-threshold tuning
  (Break seconds / empty-court max) — camera-independent — not by editing the
  global polygon blind.

## 2026-06-24 — Lengthened court ROI to stop mid-game splits (REVERTED — see above)

- **Problem:** game detection cut games mid-rally even when nobody left the
  court. Root cause: [`roi.json`](./scripts/videos/roi.json) traced only the
  in-bounds court (the four *baseline* corners). `detect_games.py` counts a
  player as on-court only if their feet fall inside the polygon, so a serving
  player (and partner) standing **behind the baseline** weren't counted. When
  enough hung back, the in-court count fell to ≤1 for ≥12s → a false BREAK →
  game split.
- **Fix:** extended the polygon past both baselines along the court's long
  axis (≈22% toward camera, ≈13% far end for perspective), leaving the
  sidelines alone so it won't grab adjacent courts. New points:
  `[925,620] [1186,416] [511,208] [320,248]` (tuned against `2026-05-14`).
- **Confirmed working:** the "Configure Court ROI" UI saves via
  `PUT /api/videos/roi` straight into the `roi.json` the detector reads
  (per-session `roi_path` is never set, so the global file always wins).
- **Caveats:** ROI is global and assumes a fixed camera — re-tune in the
  configurator if a recording used a different angle. Break rule
  (`≤1 person ≥12s`) is still dropout-sensitive; next lever is raising
  **Break seconds** (12→20) or lowering **empty-court max** in the UI.
- **Next:** re-run a ~5-min YOLO detection pass on the recording that showed
  the bad cut to confirm it's gone (not yet run — need which session).

## 2026-06-19 — Editable session roster (Players card)

- **Problem:** the session-detail "Players" card only displayed the roster
  (`session.player_names`) as read-only chips — no way to fix a wrong roster.
- **Fix:** made the Players card editable in
  [`web/src/pages/SessionDetail.tsx`](./web/src/pages/SessionDetail.tsx).
  An **Edit / Done** toggle reveals an `×` on each chip (remove) and the
  shared `AddPlayer` search-or-create combobox (add). Add reuses
  `POST /api/sessions/:id/players` (create/reuse profile + roster append);
  remove `PATCH`es the trimmed `player_names`. Both refresh the roster chips
  **and** tagging candidates. Removal only de-rosters — it doesn't delete the
  rating-hub profile or saved tags (noted inline). Empty roster now renders
  the card (with "No players yet") instead of hiding it.
- Verified live on the real `5.0+ Group Play 20260617` session: removed
  "Andrew Schage" (persisted to DB), re-added via search-or-create
  (persisted), chips updated live, roster restored to original.

## 2026-06-19 — Manual players (add subs/guests, sync to rating-hub)

- **Problem:** players who aren't in CourtReserve (subs, guests) had no way
  to get a rating-hub profile, so they couldn't be tagged in games they
  played.
- **Fix (search-or-create, two surfaces):**
  - New helper [`src/players/manual.ts`](./src/players/manual.ts) —
    `findOrCreatePlayer(orgId, name)` (fuzzy name/pbvision-alias match, mints
    unique slug, inserts `is_active` row with no `cr_member_id`) +
    `getPlayerById`.
  - `POST /api/members` — create/reuse a global profile (Members page).
  - `POST /api/sessions/:id/players` — `{displayName}` or `{playerId}`:
    create/reuse a player **and** append their canonical name to
    `session.player_names` so they become a tagging candidate and pass the
    `POST /tagging` roster guard. Idempotent.
  - Shared combobox [`web/src/components/AddPlayer.tsx`](./web/src/components/AddPlayer.tsx)
    (debounced `/api/members/search`, reuse-existing or create-new). Wired
    into the tagging panel ("Missing a player?") and a new Members-page card.
- Verified end-to-end against real data: reuse path (no dup row), case-
  insensitive match, empty-name guard (400), roster append + idempotency,
  and the added player surfacing as a candidate **with a resolved id** on a
  complete session (then restored the test session's roster). Members-page
  autocomplete shows existing matches + "Create new".
- **Next:** brand-new-profile insert path is covered by the shared helper
  (mirrors the proven member-sync insert) but wasn't exercised against the
  live DB to avoid writing a throwaway row.

## 2026-06-19 — Zoomable segment-editor timeline

- **Problem:** game detection is unreliable, so segments get hand-edited a
  lot — but a 2+ hour recording crammed into one panel width makes the drag
  handles too finicky to grab.
- **Fix:** added horizontal zoom to
  [`web/src/components/VideoSegmentEditor.tsx`](./web/src/components/VideoSegmentEditor.tsx).
  `−` / `+` / `Fit` controls (1×–32×), track widens inside a horizontal
  scroll container, view recenters on playhead per zoom + auto-follows during
  playback, and time-marker interval tightens with zoom (5m→2m→1m→30s).
  Drag/click math untouched — it reads `getBoundingClientRect()` which folds
  in scroll offset, so boundary editing works at any zoom.
- Verified live on the real 2h20m `Thursday 4_2_2026` session (7 segments):
  track 1008→4032px at 4×, scrollbar appears, markers tighten, Fit resets.
- Landed as PR #39 (squash-merged to `main`).

## 2026-06-19 — "Reset tags" button per game in tagging UI

- **Problem:** in the in-app tagging panel, slot picks are exclusive within
  a game — picking a player disables them in the other 3 slots, and the 4th
  slot auto-fills once 3 are set. A mis-assignment could lock out the player
  you actually wanted ("already in this game") with no way to back out.
- **Fix:** added a **Reset tags** button to each game's header
  ([`web/src/pages/SessionDetail.tsx`](./web/src/pages/SessionDetail.tsx)).
  `resetGameTags(gameId)` clears that game's slot picks + CLIP suggested
  badges and marks dirty. Button only shows when ≥1 slot has a pick. Scoped
  to pending picks — persisted tags aren't unassigned until a save with new
  picks.
- Typecheck clean. Not exercised live (tagging UI needs a session with
  uploaded pb.vision vids + imported games).
- Landed as PR #38 (squash-merged to `main`).

## 2026-06-18 — Game detection rewritten around empty-court breaks

- **Problem:** session `63575e8f` was marked **21 games** — perfectly
  contiguous ~7.5-min chunks with no gaps. The YOLO detector segmented on
  quadrant-occupancy "game-start" signals and never checked whether the court
  emptied, so it fired every ~7-8 min and chopped the video arbitrarily.
- **Fix** (`scripts/videos/detect_games.py`): ripped out the paddle-tap /
  formation / quadrant machinery. A game now ends when all players leave the
  court (≤ `empty_max_n` persons in ROI) for ≥ `break_sec`; the next starts
  when play resumes. Between two breaks = one game; last game runs to EOV
  (UNFINISHED only if not followed by a clean break). `run_yolo` untouched.
  Defaults: empty ≤1 player, break 12s, min game 120s, warmup 0.
- **Removed the 5 UI detection knobs** (Warmup/Min Gap/Long Break/Restart
  Look/Min Game) — they were legacy motion-detector params the YOLO script
  silently ignored, so tweaking them did nothing. Detection is now just a
  button; defaults live in the script. CLI still exposes `--warmup`,
  `--break-sec`, `--empty-max-n`, `--active-min-n`, `--min-game`.
- Synthetic segmentation test passes (3 games, mid-game lull ignored, warmup
  skipped, straggler-in-break handled); `tsc` + `vite build` clean.
- Landed as **[PR #37](https://github.com/notronwest/rating-session-manager/pull/37)** — **merged** to `main` (`0551f80`).
- **Next:** on the Mac Mini `git pull && npm run build`,
  Clear Segments, re-Detect — that's the first end-to-end run on the real
  June 17 video (not present on the dev laptop). If the boundary is slightly
  off, optionally pin game start to the first serve (right-foreground side).

## 2026-06-11 — "Date played" on manual session create

- Dashboard "New Manual Session" form now has a **Date played** field
  (between Label and Video File) that posts `booking_time` at create time —
  previously you had to open SessionDetail afterward to set it. Defaults to
  today.
- Fixed a UTC off-by-one in the default: was `toISOString()` (rolled to
  tomorrow on evening sessions east of UTC), now `toLocaleDateString("en-CA")`
  → correct local date. Verified live in the browser preview.
- Landed as **[PR #36](https://github.com/notronwest/rating-session-manager/pull/36)** (open at time of writing).
- Earlier this session: rebased a diverged `main`, set `pull.rebase true`
  for the repo, and merged the STATUS/CLAUDE front-door (PR #35).

## 2026-06-03 — Design system adopted

- `web/src/tokens.css` added (no value overrides — canonical primary/success
  already matched), imported in `main.tsx`.
- Lucide (`lucide-react`) adopted.
- `docs/DESIGN_PREFERENCES.md` created (pointer + specifics: no overrides,
  100%-inline / no base `index.css` yet, `StatusBadge` stays domain-specific).
- Landed as PR #31 (merged).
- Note: `web/src/pages/Dashboard.tsx` had separate in-progress (uncommitted)
  work at the time — left untouched.

## ⏳ In flight / pending

- (from [`CLAUDE.md`](./CLAUDE.md) status) Webhook does NOT yet poll
  pb.vision for tagging completion — sync is triggered manually.
- Does NOT yet fetch the Mux playback ID from pb.vision Firestore to include
  it in the webhook payload (the `📌 PBV Grab` bookmarklet is the workaround).

## 🔜 Next

- **[parked — needs full app running to verify]** Add a minimal base
  `web/src/index.css` (box-sizing reset + token-based body) to match the
  other web apps.

## Deeper references

- [`CLAUDE.md`](./CLAUDE.md) — pipeline states, rating-hub webhook contract.
- End-to-end workflow source of truth: rating-hub's `CLAUDE.md`.
- [`../wmpc-meta/strategy.md`](../wmpc-meta/strategy.md).
