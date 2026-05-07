#!/usr/bin/env bash
# Sync ../wmpc-meta (cross-cutting strategic + reference docs) and install
# a post-merge hook so future `git pull`s on this project keep it current.
#
# Run once after cloning the project. Idempotent — safe to re-run anytime.
# After the post-merge hook is installed, regular `git pull` calls will
# refresh ../wmpc-meta automatically.
#
# Edge cases handled:
#   - First run ever: clones wmpc-meta as a sibling.
#   - Network down or SSH key missing: warns and continues.
#   - Already-installed hook: leaves it alone.
#   - User uses `git pull --rebase`: also installs post-rewrite hook.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "claude-bootstrap.sh: must be run inside a git repo" >&2
  exit 1
fi

PARENT_DIR="$(dirname "$REPO_ROOT")"
META_DIR="$PARENT_DIR/wmpc-meta"
META_URL="git@github-notronwest:notronwest/wmpc-meta.git"

# 1. Sync wmpc-meta — clone if missing, pull if present.
if [ -d "$META_DIR/.git" ]; then
  if git -C "$META_DIR" pull --ff-only --quiet 2>/dev/null; then
    : # silent on success
  else
    echo "[claude-bootstrap] wmpc-meta pull failed (network? auth?). Continuing with last-pulled copy." >&2
  fi
else
  echo "[claude-bootstrap] cloning wmpc-meta to $META_DIR..."
  if ! git clone --quiet "$META_URL" "$META_DIR" 2>/dev/null; then
    echo "[claude-bootstrap] clone failed. Strategy doc won't be available until network/auth is fixed." >&2
  fi
fi

# 2. Install hooks. Both post-merge (for `git pull`) and post-rewrite (for
#    `git pull --rebase`) so any pull strategy works.
HOOK_BODY='#!/usr/bin/env bash
# Auto-installed by scripts/claude-bootstrap.sh
"$(git rev-parse --show-toplevel)/scripts/claude-bootstrap.sh" >/dev/null 2>&1 || true
'
for hook_name in post-merge post-rewrite; do
  HOOK_PATH="$REPO_ROOT/.git/hooks/$hook_name"
  if [ ! -f "$HOOK_PATH" ] || ! grep -q "claude-bootstrap" "$HOOK_PATH" 2>/dev/null; then
    mkdir -p "$(dirname "$HOOK_PATH")"
    printf '%s' "$HOOK_BODY" > "$HOOK_PATH"
    chmod +x "$HOOK_PATH"
    echo "[claude-bootstrap] installed $hook_name hook"
  fi
done
