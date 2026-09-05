#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Publish session-manager at https://session.wmpc.app via its OWN Cloudflare Tunnel.
#
# Runs ON the club Mac mini (wmpcMacMini1) — the always-on box that holds the video
# files and runs the Express API (localhost:3001). Express serves the built SPA as
# well as /api, so the tunnel has a single local origin and Caddy is not involved.
# Outbound-only: no router ports, and the mini's real IP stays behind Cloudflare.
#
# Mirrors courtreserve-api/ and qbo-api/deploy/cloudflared but with its own tunnel
# name, config file, and LaunchAgent so the three tunnels stay independent (none
# clobbers another's ~/.cloudflared/config*.yml).
#
# ⚠ This app has NO login of its own. The public hostname MUST sit behind
#   Cloudflare Access, and the server refuses tunnel traffic without a valid
#   Access token until CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD are set in .env
#   (fail closed). This script prints those steps at the end.
#
# One-time prerequisites (interactive, once per machine — already done on the mini
# for the crapi/qbo tunnels):
#   1. brew install cloudflared
#   2. cloudflared tunnel login          # browser → pick the wmpc.app zone
# Then, idempotent (safe to re-run; re-running is how you update):
#   bash deploy/cloudflared/setup.sh
#
# Undo:  launchctl bootout gui/$(id -u)/com.wmpc.cloudflared-session
#        rm ~/Library/LaunchAgents/com.wmpc.cloudflared-session.plist
#        cloudflared tunnel delete session   (also remove the session CNAME in the CF dashboard)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TUNNEL="${TUNNEL_NAME:-session}"
HOSTNAME_FQDN="${PUBLIC_HOST:-session.wmpc.app}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# Honour PORT from the repo's .env (the API's port) unless PORT is already exported.
if [[ -z "${PORT:-}" && -f "$REPO_ROOT/.env" ]]; then
  PORT="$(grep -E '^PORT=' "$REPO_ROOT/.env" | tail -1 | cut -d= -f2- | tr -d '[:space:]' || true)"
fi
SERVICE_URL="http://localhost:${PORT:-3001}"
CFDIR="$HOME/.cloudflared"
CONFIG="$CFDIR/config-$TUNNEL.yml"
PLIST_LABEL="com.wmpc.cloudflared-$TUNNEL"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LOGDIR="$HOME/Library/Logs"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; CYAN=$'\033[0;36m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}  ✓${RESET}  $*"; }
info() { echo "${CYAN}  ->${RESET}  $*"; }
warn() { echo "${YELLOW}  !${RESET}  $*"; }
err()  { echo "${RED}  x${RESET}  $*" >&2; exit 1; }
step() { echo; echo "▶ $*"; }

# ── Preconditions ────────────────────────────────────────────────────────────
step "Preconditions"
CFBIN="$(command -v cloudflared || true)"
[[ -n "$CFBIN" ]] || err "cloudflared not found. Run:  brew install cloudflared"
ok "cloudflared: $CFBIN ($("$CFBIN" --version 2>/dev/null | head -1))"

[[ -f "$CFDIR/cert.pem" ]] || err "Not logged in. Run:  cloudflared tunnel login   (pick the wmpc.app zone)"
ok "logged in (cert.pem present)"

health="$(curl -fsS -m 4 "$SERVICE_URL/api/health" 2>/dev/null || true)"
if [[ "$health" == *'"ok":true'* ]]; then
  ok "local API healthy at $SERVICE_URL"
  # The tunnel needs Express to serve the SPA too — check the root answers with HTML.
  if curl -fsS -m 4 "$SERVICE_URL/" 2>/dev/null | grep -qi "<html"; then
    ok "local API is serving the SPA at $SERVICE_URL/"
  else
    warn "$SERVICE_URL/ is not serving the SPA. Rebuild + restart (npm run build) — the tunnel"
    warn "will otherwise expose /api only and the UI will 404. (Needs the server.ts that serves ../www/\$APP_NAME.)"
  fi
else
  warn "local API not answering at $SERVICE_URL/api/health — the tunnel will 502 until it's up"
  warn "(start it: cd $REPO_ROOT && npm run build   # or: npm run start)"
fi

# ── Create (or reuse) the named tunnel; capture its UUID ─────────────────────
step "Tunnel '$TUNNEL'"
get_uuid() {
  "$CFBIN" tunnel list -o json 2>/dev/null | /usr/bin/python3 -c \
    "import sys,json; ts=json.load(sys.stdin) or []; print(next((t['id'] for t in ts if t.get('name')=='$TUNNEL'), ''))"
}
UUID="$(get_uuid)"
if [[ -n "$UUID" ]]; then
  info "tunnel '$TUNNEL' already exists — reusing"
else
  "$CFBIN" tunnel create "$TUNNEL"
  UUID="$(get_uuid)"
  ok "created tunnel '$TUNNEL'"
fi
[[ -n "$UUID" ]] || err "could not determine the UUID for tunnel '$TUNNEL'"
CREDS="$CFDIR/$UUID.json"
[[ -f "$CREDS" ]] || err "credentials file $CREDS missing (tunnel create should have written it)"
ok "UUID $UUID"

# ── Config: route the hostname to the local Express (SPA + /api) ─────────────
step "Config $CONFIG"
cat > "$CONFIG" <<YAML
# Managed by session-manager/deploy/cloudflared/setup.sh — publishes the app at $HOSTNAME_FQDN.
# Own file (not config.yml) so it can't clobber the crapi / qbo tunnels on this machine.
tunnel: $UUID
credentials-file: $CREDS

ingress:
  - hostname: $HOSTNAME_FQDN
    service: $SERVICE_URL
  # everything else that reaches this tunnel gets a 404 (defence in depth)
  - service: http_status:404
YAML
"$CFBIN" tunnel --config "$CONFIG" ingress validate >/dev/null && ok "config written + validated"

# ── DNS: proxied CNAME $HOSTNAME_FQDN → <UUID>.cfargotunnel.com ─────────────
# Route by the tunnel's explicit UUID (not its name) with --overwrite-dns, so a
# stale CNAME (e.g. one that pointed at another tunnel) is corrected rather than
# silently left wrong.
step "DNS route $HOSTNAME_FQDN"
if "$CFBIN" tunnel route dns --overwrite-dns "$UUID" "$HOSTNAME_FQDN" 2>/tmp/cf_route_err; then
  ok "routed $HOSTNAME_FQDN → $TUNNEL ($UUID)"
else
  if grep -qiE "already|exists" /tmp/cf_route_err; then
    ok "DNS record already present"
  else
    cat /tmp/cf_route_err >&2; err "failed to create DNS route (see above)"
  fi
fi

# ── Run persistently as a user LaunchAgent (RunAtLoad + KeepAlive) ───────────
step "LaunchAgent $PLIST_LABEL"
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
cat > "$PLIST" <<PLISTXML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CFBIN</string>
    <string>tunnel</string>
    <string>--config</string><string>$CONFIG</string>
    <string>--no-autoupdate</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/cloudflared-$TUNNEL.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/cloudflared-$TUNNEL.err.log</string>
</dict>
</plist>
PLISTXML
launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null || true
sleep 1
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  ok "LaunchAgent installed + started (logs: $LOGDIR/cloudflared-$TUNNEL.log)"
else
  # Already registered (bootout can lag) — kickstart instead of failing under set -e
  # with a bare "Bootstrap failed: 5: Input/output error".
  if launchctl kickstart -k "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null; then
    ok "restarted existing LaunchAgent $PLIST_LABEL"
  else
    warn "$PLIST_LABEL not (re)loaded — if the tunnel is already running this is fine"
  fi
fi

# ── Smoke test the public URL ────────────────────────────────────────────────
# /api/health is exempt from the server's Access gate, so what we see here tells
# us about the edge: 200 = tunnel is live (Access NOT yet in front — fix that!),
# 302 → *.cloudflareaccess.com = Access is gating the hostname (good),
# 502/530 = tunnel or origin not up yet.
step "Smoke test https://$HOSTNAME_FQDN/api/health"
info "waiting for the tunnel + DNS to come up…"
code=""; loc=""
for _ in $(seq 1 20); do
  out="$(curl -sS -m 6 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$HOSTNAME_FQDN/api/health" 2>/dev/null || true)"
  code="${out%% *}"; loc="${out#* }"
  case "$code" in
    200) ok "PUBLIC: https://$HOSTNAME_FQDN/api/health → 200 (tunnel live)"; break ;;
    302|303|307) ok "PUBLIC: https://$HOSTNAME_FQDN → $code to ${loc:-?} (Cloudflare Access is in front)"; break ;;
    403) ok "PUBLIC: https://$HOSTNAME_FQDN → 403 (reaches Express; its Access gate refused it)"; break ;;
  esac
  sleep 3
done
case "$code" in
  200|302|303|307|403) ;;
  *)
    warn "public URL not answering yet (last status: ${code:-none}). Check:"
    warn "  launchctl print gui/$(id -u)/$PLIST_LABEL | head ; tail $LOGDIR/cloudflared-$TUNNEL.err.log"
    warn "  DNS can take a minute to propagate; re-run:  curl -I https://$HOSTNAME_FQDN/api/health"
    exit 1 ;;
esac

echo
echo "${GREEN}Done.${RESET} Tunnel '${TUNNEL}' publishes ${CYAN}https://$HOSTNAME_FQDN${RESET} → $SERVICE_URL"
cat <<NOTE

${YELLOW}── REQUIRED: put Cloudflare Access in front (the app has no login) ─────────────${RESET}
Until both halves below are done, the public URL is refused by the server (403,
fail closed) — LAN access via Caddy is unaffected.

  1. Cloudflare dashboard → Zero Trust → Access → Applications → Add → Self-hosted
       Application domain:  $HOSTNAME_FQDN
       Policy (Allow):      Emails ending in  @whitemountainpickleball.com
                            (or list specific emails)
     Save, then open the app's Overview and copy the
       "Application Audience (AUD) Tag"  (64 hex chars).

  2. On this machine, in $REPO_ROOT/.env:
       CF_ACCESS_TEAM_DOMAIN=<your team name, e.g. wmpc>   # <team>.cloudflareaccess.com
       CF_ACCESS_AUD=<the AUD tag>
     then restart the API:   cd $REPO_ROOT && npm run restart

  Verify:  open https://$HOSTNAME_FQDN in a private window → Access login → the app.
           curl -sI https://$HOSTNAME_FQDN/ | head -1        # expect a 302 to *.cloudflareaccess.com
Runbook + troubleshooting: deploy/cloudflared/README.md
NOTE
