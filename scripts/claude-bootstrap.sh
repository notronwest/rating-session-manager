#!/usr/bin/env bash
# claude-bootstrap SHIM — installed as <repo>/scripts/claude-bootstrap.sh.
#
# DO NOT add logic here. The real bootstrap is the CANONICAL at
#   ../wmpc-meta/conventions/claude-bootstrap.sh
# This shim only (1) ensures wmpc-meta is present, then (2) execs the canonical.
# So a convention change is ONE wmpc-meta PR that reaches every repo on its next
# `git pull` — no per-repo PRs, nothing to drift. Self-healing (wmpc-meta#4).
# See the canonical's header + daemon docs/synchronization.md (Pillar 4).
#
# Fail-open: any problem (no network, wmpc-meta absent, canonical missing) exits
# 0 so it never blocks a `git pull` or a session. Idempotent.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
META_DIR="$(dirname "$REPO_ROOT")/wmpc-meta"
META_URL="git@github-notronwest:notronwest/wmpc-meta.git"

# Ensure wmpc-meta exists so the canonical can be found (canonical pulls it fresh).
if [ ! -d "$META_DIR/.git" ]; then
  echo "[claude-bootstrap] cloning wmpc-meta to $META_DIR..." >&2
  git clone --quiet "$META_URL" "$META_DIR" 2>/dev/null \
    || { echo "[claude-bootstrap] wmpc-meta unavailable (network/auth) — skipping." >&2; exit 0; }
fi

CANON="$META_DIR/conventions/claude-bootstrap.sh"
[ -f "$CANON" ] || { echo "[claude-bootstrap] canonical missing at $CANON — skipping." >&2; exit 0; }

# Hand off to the canonical (it does the wmpc-meta pull, hook install, CLAUDE.md
# backlog block, and board link). Runs in this repo's cwd, so it targets here.
exec bash "$CANON"
