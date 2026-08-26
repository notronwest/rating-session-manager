# Video delivery — the gated, Third Shot Academy-branded download page

> **Status:** design agreed 2026-08-26, not yet built. Ron's calls are recorded
> under *Decisions*. Open questions are flagged inline — none of them block
> starting.

A customer finishes a session, we record it, and they want the video. Today
there is no way to give it to them that isn't "someone AirDrops a file." This
designs the thing that replaces that: a **Third Shot Academy-branded page** where
a customer confirms their email, sees only their own videos, and downloads them —
with every access recorded.

The footage lives on the **NAS attached to the club Mac mini**. That placement is
already settled: `VIDEO_DIR` in [`.env.template`](../.env.template) takes an
absolute path, so pointing session-manager at the NAS mount is a config change,
not a code change.

## Decisions (Ron, 2026-08-26)

| Question | Decision |
|---|---|
| Which repo owns it | **session-manager** — it is the only repo that touches video, and it already runs an Express server on the mini with a Supabase service-role client. `club-dashboard` is a backend-less SPA and cannot serve files. |
| Gate | **Email confirmation.** No account, no password. |
| What they see | A download screen listing **only their own** videos. |
| Tracking | **Every access recorded** — who, what, when. |
| Branding | **Third Shot Academy.** |
| Access scope | **On-site now, anywhere later.** LAN streams straight off the NAS; off-site is served from cloud storage. |
| Retention | **The grant expires (default 30 days); the file stays on the NAS.** Limits exposure without destroying the archive. Re-issuing is a staff action. |

## The shape

```
                    ┌─────────────────────────────────────────┐
customer's phone ──▶│  TSA-branded download page              │
  (club wifi)       │  session-manager, Express on the mini    │
                    │  1. enter email  2. enter 6-digit code   │
                    │  3. see MY videos  4. download           │
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
        ┌───────────────────────┐      ┌────────────────────────┐
        │ NAS via VIDEO_DIR     │      │ Supabase               │
        │ the bytes (LAN path)  │      │ grants · access log    │
        └───────────────────────┘      │ (source of truth)      │
                                       └────────────────────────┘
```

### Use an emailed CODE, not a magic link

This is the design's least obvious and most important call.

A magic link in an email **breaks on a LAN-only host**. The customer's phone may
fetch mail over cellular, or the link may open in an in-app browser that isn't on
club wifi — and the LAN hostname then resolves to nothing. They get a dead link
while standing ten feet from the server.

A **6-digit code** typed into the page they already have open works regardless of
which network delivered the email. It also avoids the entire class of
link-preview scanners that consume single-use magic links before the human clicks
(a problem TSA already hit — see the anti-phishing magic-link work, issue #270).

Codes: 6 digits, single-use, 10-minute expiry, rate-limited per email and per IP,
constant-time compare. A verified email mints a session cookie scoped to that
email for the browser session only.

### Two delivery paths, one page

| | On-site (LAN) | Off-site |
|---|---|---|
| Bytes from | the NAS via `VIDEO_DIR`, streamed by Express | cloud object storage |
| Cost | zero egress | egress per download |
| Speed | full LAN speed | internet upload-bound |
| Trigger | default when the request comes from the LAN | when the grant is used off-site |

**Recommendation: upload lazily, not eagerly.** Push a video to cloud storage the
first time it is actually requested off-site, not for every session. Most
customers download on site; eagerly uploading every recording pays storage and
upload bandwidth for files nobody fetches remotely, and undercuts the reason for
buying the NAS. The grant row carries a `cloud_key` that is null until the first
remote fetch populates it.

> **Open — which bucket.** Cloudflare **R2** (zero egress fees, already in the
> Cloudflare account) vs **Supabase Storage** (one fewer vendor, integrates with
> the same RLS). R2 is the better economics for video. Not decided.

## Data model (Supabase, source of truth)

Three tables. The mini holds bytes and nothing authoritative — so a wiped or
rebuilt mini loses no grants and no audit trail.

- **`video_grants`** — who may see what. `id`, `email` (lowercased, normalized),
  `session_id`, `video_path` (relative to `VIDEO_DIR`, never absolute),
  `cloud_key` (null until first off-site fetch), `created_by`, `created_at`,
  `expires_at` (default `created_at + 30 days`), `revoked_at`.
- **`video_access_log`** — append-only. `grant_id`, `email`, `action`
  (`code_sent` · `code_verified` · `code_failed` · `listed` · `downloaded`),
  `ip`, `user_agent`, `bytes_sent`, `path` (`lan` | `cloud`), `at`. This is the
  "track who accessed them" requirement, and it is also the security audit trail.
- **`video_access_codes`** — short-lived. `email`, `code_hash`, `expires_at`,
  `attempts`, `consumed_at`. Never store the code itself.

**RLS:** all three are service-role only. The customer-facing page never talks to
Supabase directly — it talks to session-manager, which holds the service-role key
server-side. That keeps the anon key out of a page shown to the public.

## Endpoints (session-manager)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/delivery/request-code` | email → mint + email a code. Always returns 200 (never reveals whether an email has videos). |
| POST | `/api/delivery/verify-code` | email + code → session cookie. |
| GET | `/api/delivery/videos` | list this email's non-expired, non-revoked grants. |
| GET | `/api/delivery/download/:grantId` | stream the file; log the access. |
| POST | `/api/delivery/grants` | **staff only** — create/revoke grants. |

Staff endpoints stay behind the existing internal auth; the customer endpoints are
the only ones exposed on the public hostname.

## Branding

Third Shot Academy, using the existing Kitchen palette and `Brand.tsx` lockup
rather than a new look. The email chrome reuses TSA's
`supabase/functions/_shared/email-brand.ts` (sender "Third Shot Academy"), which
already sends branded mail via Resend — so the code email matches the welcome and
rating-report emails a customer may already have received.

Mobile-first: this is a phone-in-hand experience at the club. Design at 390px
first, per the standing WMPC rule.

> **Open — entity ownership.** `wmpc-meta/initiatives/tsa-umbrella.md` puts the
> training brand, software, and customer under **TSA**, with WMPC as the venue.
> This feature is TSA-branded and TSA-customer-facing but lives in a
> WMPC-operated repo on WMPC hardware. Fine for now; worth revisiting at the
> Phase-2 entity split.

## The hostname and TLS problem — read before wiring Caddy

The mini already runs Caddy, so "add a site block" looks like a five-minute job.
**It is not**, and this is where the naive version fails in front of a customer.

`dashboard.wmpc.app` uses `tls internal` and is **not in public DNS**. Every
client needs an `/etc/hosts` entry *and* Caddy's local CA installed. That is
workable for Ron's machines and **completely unusable for a walk-up customer's
phone** — they would get a full-page certificate warning on a page asking for
their email address, which is exactly the shape of a phishing screen. Nobody
should be trained to click through that.

**The fix:** a real, publicly-resolvable hostname on the `wmpc.app` zone (already
on Cloudflare) with a **DNS-01 Let's Encrypt certificate** — Caddy issues these
via the Cloudflare DNS plugin without the host needing to be reachable from the
internet. The A record points at the mini's **LAN IP**. On club wifi the phone
resolves it, connects locally, and gets a genuine green padlock. Traffic never
leaves the building.

> **Open — the off-site half.** A public A record pointing at a private IP is
> unreachable from outside, which is *correct* for the LAN path but means the
> off-site path needs its own public origin (the cloud-storage signed URL, or a
> Cloudflare Tunnel for the page itself while bytes come from R2). Decide with
> the bucket choice.

A **Cloudflare Tunnel for the video bytes is the wrong tool**: it would route
every on-site download out to Cloudflare's edge and back, turning a free LAN
transfer into a slow, metered round trip.

## Infra intake

Answering [`daemon/infrastructure/INFRA-INTAKE.md`](../../daemon/infrastructure/INFRA-INTAKE.md),
since this runs unattended in front of customers.

1. **Unattended?** Yes — customers use it with no staff present. Staff only
   create grants.
2. **How many machines?** One: the club Mac mini. Not fleet-replicated.
3. **Singleton?** Yes, inherently — one mini, one NAS mount. No host-gate needed,
   unlike the Builder.
4. **Propagation.** Same as the rest of session-manager: `git pull` then
   `npm run build` on the mini. See [`../DEPLOYMENT.md`](../DEPLOYMENT.md).
5. **Bootstrap — the one manual touch.** Mount the NAS with an **automount entry
   so it survives reboot** (a hand-mounted SMB share does not), set `VIDEO_DIR`,
   and add the Caddy site block + DNS record. Everything after is a rebuild.
6. **Self-heal.** Grants and the log live in Supabase, so a rebuilt mini recovers
   by remounting and rebuilding. Codes are short-lived; losing them costs a
   customer one retry.
7. **Source of truth.** Supabase for grants and access history; the NAS for bytes.
   Deliberately split — the durable, auditable state is not on the mini.
8. **Failure mode — FAIL CLOSED.** If the NAS is unmounted, Supabase is
   unreachable, or a grant cannot be verified, serve **nothing** and show a
   "temporarily unavailable" page. Never fall back to an ungated listing. The
   existing `VIDEO_DIR does not exist` error in
   [`../src/routes/videos.ts`](../src/routes/videos.ts) is the right instinct —
   it refuses rather than silently reading the wrong directory.
9. **Secrets.** `SUPABASE_SERVICE_ROLE_KEY` (already used by
   [`../src/supabase.ts`](../src/supabase.ts)) plus the Resend key for the code
   email. Both in the mini's gitignored `.env`, never in the repo.
10. **Observability.** `video_access_log` is the record. A weekly digest of
    grants issued vs downloads completed, and a Discord alert (reusing
    `services/discord-alert.ts`) when the NAS mount is missing or the code-send
    path fails — the two failures a customer would otherwise discover for us.

## Privacy — the thing to get right

These are **videos of identifiable people**, often including other players who
never asked to be recorded and are not the grant holder.

- A grant is **per email, per video**. There is no "browse all sessions" view and
  no directory listing, ever.
- Enumeration is not a shortcut: `request-code` always returns 200, so the page
  cannot be used to test whether an address is a customer.
- The 30-day grant window exists so a leaked inbox does not mean permanent access
  to someone's footage.
- **`video_access_log` is itself personal data** — it records who watched what and
  from where. Service-role only; do not surface it in club-dashboard without
  deciding who may read it.

> **Open — third parties in frame.** A doubles video contains three people who did
> not request it. Current design grants to the requesting customer only. If that
> is not acceptable, the answer is per-session consent at booking, which is a
> product/policy decision, not a code one.

## Build order

1. **NAS mount + `VIDEO_DIR`** — config only, no code. Immediately makes recording
   land on the NAS. Independently useful; do it first.
2. **Schema + staff grant creation** — the tables and a way to issue a grant.
3. **The gated page + code flow, LAN only** — the customer-visible feature.
4. **Hostname + DNS-01 certificate** — required before any customer sees it.
5. **Lazy cloud upload for the off-site path** — last; the on-site experience is
   complete without it.

Steps 1–4 deliver the whole on-site experience. Step 5 is a genuine add-on, not a
prerequisite.
