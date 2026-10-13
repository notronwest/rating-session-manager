#!/usr/bin/env bash
# scan-retrieval.sh — refuse an embeddings/vector dependency that no decision authorized.
#
# D-0147: retrieval takes the highest tier it can reach — deterministic where a key
# exists, agentic where it does not, embedded only for semantic recall AND only with
# its own decision record. The reason the third tier needs a record is not the index:
# the Claude API exposes no embeddings endpoint, so reaching for one means adding a
# SECOND AI VENDOR and its credentials to a Claude-only fleet. That is an architectural
# decision, not an implementation detail, and D-0071 says a rule that lives only in a
# CLAUDE.md block is a reminder rather than a rule. This is the refusal.
#
#   scan-retrieval.sh --staged    # pre-commit: only what is about to be committed
#   scan-retrieval.sh             # everything git tracks
#
# Deliberately narrow, for the reason scan-secrets.sh states about itself: a rule that
# cries wolf gets disabled, and a disabled rule protects nothing. So it reads ONLY
# dependency manifests and SQL — the two places you cannot avoid touching to actually
# add one — and never prose, docs, or lock files.
#
# Two ways past it, both deliberate and both auditable:
#   1. `.wmpc-retrieval-ok` at the repo root, one `D-NNNN <rule-name>` per line. You
#      name the record that authorized it AND which rule it covers, so the exemption
#      points at the decision instead of hiding it.
#   2. WMPC_ALLOW_EMBEDDINGS=1 for a one-off — the typed, deliberate override D-0097
#      requires of any guard.
#
# KNOWN LIMIT, stated rather than overclaimed: a hand-rolled embeddings call over raw
# HTTP, with no dependency and no migration, is not caught. The gate covers the paths
# you have to walk in practice, not every conceivable one.
#
# Tests: scripts/scan-retrieval.test.sh (run it after any rule change).
set -uo pipefail

MODE="${1:-all}"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "scan-retrieval: not a git repo"; exit 0; }
cd "$root" || exit 0

if [ "${WMPC_ALLOW_EMBEDDINGS:-0}" = "1" ]; then
  echo "scan-retrieval: WMPC_ALLOW_EMBEDDINGS=1 — skipped deliberately." >&2
  exit 0
fi

if [ "$MODE" = "--staged" ]; then
  files="$(git diff --cached --name-only --diff-filter=ACM)"
else
  files="$(git ls-files)"
fi
[ -n "$files" ] || exit 0

ALLOW_FILE=".wmpc-retrieval-ok"

# rule-name=regex. Matched case-insensitively against manifest and SQL files only.
RULES='embeddings-vendor-dep="?(openai|cohere|voyageai|replicate|@huggingface/[a-z-]+|@xenova/transformers|sentence-transformers)"?[[:space:]]*[:=><"^~]
vector-store-dep="?(pinecone|@pinecone-database/[a-z-]+|chromadb|weaviate|qdrant|faiss|lancedb|pymilvus|pgvector)"?[[:space:]]*[:=><"^~]
rag-framework-dep="?(langchain|@langchain/[a-z-]+|llamaindex|llama-index|haystack-ai)"?[[:space:]]*[:=><"^~]
pgvector-extension=CREATE[[:space:]]+EXTENSION.*["'"'"']?vector
vector-index=USING[[:space:]]+(ivfflat|hnsw)
vector-column=[a-z_]+[[:space:]]+vector\([0-9]+\)'

hits="$(mktemp)"; trap 'rm -f "$hits"' EXIT

while IFS= read -r rule; do
  [ -n "$rule" ] || continue
  name="${rule%%=*}"; pat="${rule#*=}"
  # Already authorized for this repo by a named record?
  if [ -f "$ALLOW_FILE" ] && LC_ALL=C grep -qE "^D-[0-9]{4}[[:space:]]+${name}([[:space:]]|$)" "$ALLOW_FILE" 2>/dev/null; then
    continue
  fi
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    # Only the two places you cannot avoid. Lock files are excluded on purpose:
    # they carry transitive deps nobody chose, so scanning them would cry wolf.
    case "$f" in
      */scan-retrieval.sh|scan-retrieval.sh|*/scan-retrieval.test.sh|scan-retrieval.test.sh) continue ;;
      *package-lock.json|*yarn.lock|*pnpm-lock.yaml|*poetry.lock|*Cargo.lock|*deno.lock) continue ;;
      */node_modules/*) continue ;;
      *package.json|*requirements*.txt|*pyproject.toml|*Pipfile|*go.mod|*Gemfile|*deno.json|*deno.jsonc|*import_map.json|*.sql) ;;
      *) continue ;;
    esac
    if LC_ALL=C grep -niE -- "$pat" "$f" >/dev/null 2>&1; then
      LC_ALL=C grep -niE -- "$pat" "$f" 2>/dev/null | cut -d: -f1 | while IFS= read -r ln; do
        printf '  %-24s %s:%s\n' "$name" "$f" "$ln"
      done
      echo "$name" >> "$hits"
    fi
  done <<EOF
$files
EOF
done <<EOF
$RULES
EOF

if [ -s "$hits" ]; then
  cat >&2 <<'MSG'

✖ An embeddings / vector dependency is being added, and no decision authorized it.

  D-0147: embedded retrieval is the THIRD tier and needs its own decision record,
  because the Claude API has no embeddings endpoint — so this means a second AI
  vendor and its credentials, which is an architectural decision, not a detail.

  What to do:
    1. Check you need the third tier at all. A key that selects the slice, or a
       tool the model can call, beats an index — and a corpus small enough to sit
       behind a prompt-cache breakpoint beats retrieving it. Most of this fleet is
       already tier 1 and that is deliberate.
    2. If it really is semantic recall over a large unkeyed corpus, write the
       record (infrastructure/decision-register/new.sh in daemon), take it through
       the table in decisions/PROCESS.md, and say in it which vendor and where the
       credential lives.
    3. Then authorize it here: add the record id and the rule name to
       .wmpc-retrieval-ok at the repo root, one per line, e.g.

         D-0152 embeddings-vendor-dep

  One-off, deliberately: WMPC_ALLOW_EMBEDDINGS=1 git commit ...

  Never index Court Reserve bookings, occurrences, rosters, occupancy, payments or
  QuickBooks data (D-0060, D-0103, D-0120), and never .claude/history/ (D-0093).

MSG
  exit 1
fi
exit 0
