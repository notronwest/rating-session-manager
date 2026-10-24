#!/usr/bin/env bash
# wmpc-sql-gate.sh — PreToolUse gate: a connector SQL tool may READ, never WRITE.
#
# Ron, 2026-10-24, on being told that allowing Execute SQL at the connector removes
# the last confirmation in front of a live production database: *"Make sure the gate
# is deployed everywhere even if that means I have to abandon all running sessions."*
#
# ⛔ WHY IT HAS TO BE A HOOK. The club database connection runs as `postgres` with
# `transaction_read_only = off` — measured, not assumed: full DML and DDL on live
# member data. Until today the only thing between a session and `delete from …` was
# a permission prompt, and three days of work went into removing that prompt because
# it was asking about harmless reads. Removing a tollbooth is right; removing the
# only gate is not. The stop list already says destroying something that holds
# history waits for Ron — this is that rule with something behind it (D-0071).
#
# A repository permission rule could not do this: it is measured not to govern
# connector tools at all (D-0217), and it could not read the statement even if it
# did. A hook sees `tool_input.query`.
#
# CONTRACT. stdin is the PreToolUse payload: {tool_name, tool_input:{query,…}}.
# stdout is one JSON object with hookSpecificOutput.permissionDecision.
# Exit 0 always — the decision is in the JSON, and a non-zero exit would be read as
# a hook failure rather than a verdict.
#
# FAIL CLOSED. Anything it cannot confidently read as read-only is denied: no jq,
# unreadable input, an empty query, a statement whose first word is not a reading
# verb, or any writing keyword anywhere outside a string literal. A gate that waves
# through what it does not understand is not a gate.
set -uo pipefail

decide() {  # <allow|deny|ask> <reason>
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' \
    "$1" "$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  exit 0
}

DENY_HELP="This gate allows reads and refuses writes to live club data. If this change is genuinely needed, put it to Ron as one ask saying what it changes and what it cannot be undone from — the stop list already makes destroying anything that holds history his call. A schema change goes through a migration, which he approves at the connector."

payload="$(cat 2>/dev/null)"
[ -n "$payload" ] || decide deny "The SQL gate received no input, so it could not read the statement. Refusing rather than guessing. $DENY_HELP"
command -v jq >/dev/null 2>&1 || decide deny "The SQL gate needs jq to read the statement and jq is not on this machine. Refusing rather than guessing. $DENY_HELP"

tool="$(printf '%s' "$payload" | jq -r '.tool_name // ""' 2>/dev/null)"
# Not a SQL tool: the matcher should have kept us out, so say nothing and let the
# normal flow decide. `allow` here would be this gate granting something it was
# never asked about.
case "$tool" in
  *execute_sql|*apply_migration) ;;
  *) printf '{}\n'; exit 0 ;;
esac

q="$(printf '%s' "$payload" | jq -r '.tool_input.query // .tool_input.sql // ""' 2>/dev/null)"
[ -n "$q" ] || decide deny "The SQL gate could not read a statement out of this call. Refusing rather than guessing. $DENY_HELP"

# A migration is a schema change by definition. It is never a read.
case "$tool" in *apply_migration) decide deny "This is a migration, which changes the shape of live club data. $DENY_HELP";; esac

# NORMALISE BEFORE JUDGING, or the verdict is about the wrong text.
#  · string literals are removed FIRST, so `where action = 'delete'` is a read and
#    not a false alarm — that false alarm is how a safety gate gets switched off;
#  · comments go next, so a writing statement cannot hide behind `--` or /* */;
#  · case and whitespace are flattened last.
norm="$(printf '%s' "$q" | python3 -c '
import re, sys
s = sys.stdin.read()
s = re.sub(r"\x27(?:\x27\x27|[^\x27])*\x27", " ", s)   # single-quoted literals
s = re.sub(r"\$\$.*?\$\$", " ", s, flags=re.S)         # dollar-quoted bodies
s = re.sub(r"--[^\n]*", " ", s)                        # line comments
s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)           # block comments
s = re.sub(r"\s+", " ", s).strip().lower()
sys.stdout.write(s)
' 2>/dev/null)"
[ -n "$norm" ] || decide deny "The SQL gate could not make sense of this statement. Refusing rather than guessing. $DENY_HELP"

# BOTH TESTS MUST PASS. The first says it starts as a read; the second says it does
# not turn into a write further in — `with x as (delete … returning *) select …` is
# a delete, and it opens with `with`.
case "$norm" in
  select\ *|select|with\ *|explain\ *|show\ *|table\ *|values\ *) ;;
  *) decide deny "This statement does not begin as a read (it starts \"$(printf '%s' "$norm" | cut -c1-40)\"). $DENY_HELP" ;;
esac

if printf '%s' "$norm" | grep -qE '(^|[^a-z_])(insert|update|delete|drop|truncate|alter|create|grant|revoke|rename|merge|upsert|call|do|copy|vacuum|reindex|cluster|lock|refresh|reset|discard|comment|import|prepare|execute|listen|notify|begin|commit|rollback|savepoint|security)([^a-z_]|$)'; then
  decide deny "This statement reads as a write or a schema change, not a read. $DENY_HELP"
fi
# `set` is its own case: `set local …` and `set role …` change the session, while
# nothing read-only needs it.
if printf '%s' "$norm" | grep -qE '(^|[^a-z_])set([^a-z_]|$)'; then
  decide deny "This statement changes the session before reading. $DENY_HELP"
fi
# A second statement after a semicolon is a second chance to write; the first test
# only ever saw the first one.
case "$norm" in
  *\;*)
    tail_after=$(printf '%s' "$norm" | sed 's/^[^;]*;//' | tr -d ' ;')
    [ -n "$tail_after" ] && decide deny "More than one statement was sent in one call, and only the first was judged. Send them one at a time. $DENY_HELP"
    ;;
esac

decide allow "Read-only; the SQL gate let it through."
