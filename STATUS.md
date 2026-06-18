# Status — session-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **Local pipeline orchestrator (Express + Vite + Python);
design tokens adopted.**
Last updated: **2026-06-18**

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
