# Status — session-manager

Append-only session handoff log. **Read this first; append a dated entry
before you wrap.** Newest on top; new entries supersede old — don't rewrite.

Current state: **Local pipeline orchestrator (Express + Vite + Python);
design tokens adopted.**
Last updated: **2026-06-11**

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
