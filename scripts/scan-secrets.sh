#!/usr/bin/env bash
# scan-secrets.sh — refuse to let a credential into a repo.
#
# Ron 2026-10-09, after the second leak in a week: "This can NEVER happen again."
# A written rule did not stop it; record-watchdog's tests even asserted that no
# Discord webhook appears in source — and the leak happened anyway, because the
# test covered one file. So this scans EVERY tracked file, and runs in two places:
# a pre-commit hook (fast, staged only) and CI (the whole tree, every PR).
#
#   scan-secrets.sh --staged    # pre-commit: only what is about to be committed
#   scan-secrets.sh             # everything git tracks
#
# Exit 1 on a finding, printed with the VALUE REDACTED — a scanner that echoes a
# secret into a CI log has just leaked it a second time.
set -uo pipefail

MODE="${1:-all}"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "scan-secrets: not a git repo"; exit 0; }
cd "$root" || exit 0

if [ "$MODE" = "--staged" ]; then
  files="$(git diff --cached --name-only --diff-filter=ACM)"
else
  files="$(git ls-files)"
fi
[ -n "$files" ] || exit 0

# Deliberately narrow. A rule that cries wolf gets disabled, and a disabled rule
# protects nothing.
RULES='discord-webhook=https://discord(app)?\.com/api/webhooks/[0-9]{5,}/[A-Za-z0-9_-]{20,}
anthropic-key=sk-ant-[A-Za-z0-9_-]{20,}
github-token=gh[pousr]_[A-Za-z0-9]{30,}
github-pat=github_pat_[A-Za-z0-9_]{30,}
stripe-live-key=[sr]k_live_[A-Za-z0-9]{20,}
resend-key=re_[A-Za-z0-9]{16,}_[A-Za-z0-9]{16,}
supabase-service-role=role"[[:space:]]*:[[:space:]]*"service_role
private-key=-----BEGIN [A-Z ]*PRIVATE KEY-----
postgres-url-with-password=postgres(ql)?://[^:@/[:space:]]+:[^@/[:space:]]{8,}@
jwt-token=eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}
assigned-credential=(SERVICE_ROLE|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|PRIVATE_?KEY|_KEY)[A-Z0-9_]*[[:space:]]*[=:][[:space:]]*.?([A-Za-z0-9_+/-]{19,}[0-9]|[A-Za-z0-9_+/-]{0,18}[0-9][A-Za-z0-9_+/-]{19,})'

# Values that are PUBLIC by design, and a local test database. Checked line by
# line across the fleet before shipping — each of these was a real hit:
#   sb_publishable_… / pk_live_ / pk_test_  ship to browsers; that is their job
#   postgres:postgres@localhost|127.0.0.1   the local Supabase test DB
# A publishable key matching a rule named "credential" is how a gate loses its
# reader: the next person sees a false alarm and stops reading the next one.
PUBLIC_RE='sb_publishable_|pk_(live|test)_|postgres:postgres@(localhost|127\.0\.0\.1)'

# ── Why the last two rules exist ──────────────────────────────────────────────
# Added 2026-10-12 after testing this scanner against the shapes of the two leaks
# it was WRITTEN for. It caught neither:
#
#   SUPABASE_SERVICE_ROLE_KEY=eyJ...   (the 2026-10-01 PROD leak)   → passed
#   CRAPI_KEY=...  /  CR_PASSWORD=...  (the 2026-10-08 leak)        → passed
#
# The `supabase-service-role` rule above matches `"role": "service_role"` — the
# DECODED payload — but a service-role key in a .env is the ENCODED JWT, which
# never contains that text. The rule was true to its name and useless in practice.
#
# `jwt-token` requires BOTH the header and payload to start `eyJ` plus a real
# signature, which is a token rather than any base64. `assigned-credential`
# catches the second shape: a credential-ish NAME assigned a value that is long
# AND CONTAINS A DIGIT.
#
# The digit is the whole discriminator, and it was learned by running this across
# the fleet before shipping it. Without it the rule flagged `CONSENT_KEY =
# "wmpc_analytics_consent"`, `DISMISSED_KEY = "floorCeilingExplainer.dismissed"`
# and `CARD_EVIDENCE_KEYS = PAY_EVIDENCE_KEYS + (…)` — ordinary constants whose
# names end in _KEY. Generated credentials carry digits; hand-written identifiers
# usually do not. Both rules stay narrow on purpose — "a rule that cries wolf gets
# disabled" — and the placeholder skips below keep .env.example files quiet.

found=0
printf '%s\n' "$RULES" | while IFS= read -r rule; do :; done   # no-op, keeps shellcheck calm

while IFS= read -r rule; do
  [ -n "$rule" ] || continue
  name="${rule%%=*}"; pat="${rule#*=}"
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    case "$f" in
      # test-scan-secrets.sh is skipped for exactly the reason scan-secrets.sh is:
      # its job is to CONTAIN specimen credentials. It blocked this very commit the
      # first time, which is the gate working, not a reason to weaken it.
      */scan-secrets.sh|scan-secrets.sh|*/test-scan-secrets.sh|test-scan-secrets.sh|*SECRETS.md|*.lock|*package-lock.json|*.min.js|*.map|*/node_modules/*) continue ;;
      # Templates and samples exist to SHOW the shape of a credential. Skipping
      # them is what lets the two rules above be broad enough to be useful.
      *.example|*.example.*|*.sample|*.template|*.dist|*/fixtures/*|*/__fixtures__/*) continue ;;
    esac
    # A matching line that is public by design is not a finding. Filter per LINE,
    # never per file — a blanket file skip is how the last leak got through.
    hits=$(LC_ALL=C grep -nEI -- "$pat" "$f" 2>/dev/null | grep -vE "$PUBLIC_RE" || true)
    if [ -n "$hits" ]; then
      printf '%s\n' "$hits" | cut -d: -f1 | while IFS= read -r ln; do
        printf '  %-26s %s:%s\n' "$name" "$f" "$ln"
      done
      found=1
      echo "$f" >> /tmp/.scan-secrets-hits.$$
    fi
  done <<EOF
$files
EOF
done <<EOF
$RULES
EOF

if [ -s "/tmp/.scan-secrets-hits.$$" ]; then
  rm -f "/tmp/.scan-secrets-hits.$$"
  cat >&2 <<'MSG'

✖ A credential is present in a tracked file. Refusing.

  Values are redacted above on purpose — printing them would leak them again.

  What to do:
    1. Take the literal out. Resolve it at runtime from the environment and fail
       loudly when it is unset. Never carry a default.
    2. Put the real value where that deployment shape keeps settings — see
       wmpc-meta/conventions/SECRETS.md.
    3. If it was ever pushed it is in the history and in every clone:
       ROTATE IT. Removing it from HEAD does not unleak it.

  Genuinely a false positive? Narrow the rule in scripts/scan-secrets.sh.
  Do not add a blanket skip — the last leak got through a test that covered
  only one file.

MSG
  exit 1
fi
rm -f "/tmp/.scan-secrets-hits.$$"
exit 0
