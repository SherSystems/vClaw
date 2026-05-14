#!/usr/bin/env bash
# scripts/check-secrets.sh — local + CI secret scanner for the RHODES repo.
#
# Modes:
#   bash scripts/check-secrets.sh             # scan tracked files (git grep)
#   bash scripts/check-secrets.sh --staged    # scan only the staged additions
#                                              (used by the pre-commit hook)
#
# Exit codes:
#   0  clean
#   1  one or more forbidden patterns matched
#
# Patterns: the known burned credential plus generic secret shapes that
# should never land in a committed file (api keys, sshpass-with-literal,
# bcrypt hashes, private-key headers). To allowlist a legitimate
# reference (e.g. a redactor-pattern test fixture), add the inline
# comment `secret-scan: allow` on the same line.
#
# CI re-runs this server-side via .github/workflows/secret-scan.yml,
# so the pre-commit hook is the convenience layer — not the safety net.

set -euo pipefail

MODE="${1:-tree}"

# Files the scanner itself should NEVER scan (they legitimately
# contain the patterns we look for):
SCANNER_SELF="scripts/check-secrets.sh"
CI_WORKFLOW=".github/workflows/secret-scan.yml"

# ── Pattern table ────────────────────────────────────────────────────
# Pipe-delimited rows: regex|severity|description
# Severity is informational; any match blocks. Use POSIX-extended regex.
PATTERNS=(
  # Known-burned lab password — keep this tripwire forever even after
  # the value is rotated and dead. It's our canary for "did we re-commit
  # a known-burned secret?"
  'Patel@0606|burned|known-burned lab password (rotate everywhere, never commit)'

  # sshpass with a literal password (the shape that bit us 2026-05-14)
  "sshpass[[:space:]]+-p[[:space:]]+'[^']{4,}'|secret|sshpass -p '<literal>' — use a secrets manager"

  # AWS access keys
  'AKIA[0-9A-Z]{16}|secret|AWS access key id'
  '(aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[[:space:]]*[=:][[:space:]]*[A-Za-z0-9/+=]{40}|secret|AWS secret access key'

  # Private key headers
  '-----BEGIN[[:space:]]+(OPENSSH|RSA|EC|DSA|PGP)[[:space:]]+PRIVATE[[:space:]]+KEY-----|secret|private key block'

  # LLM provider keys
  'sk-ant-[a-zA-Z0-9_-]{20,}|secret|Anthropic API key'
  'sk-proj-[a-zA-Z0-9_-]{40,}|secret|OpenAI project key'

  # GitHub tokens
  'ghp_[A-Za-z0-9]{36}|secret|GitHub PAT (classic)'
  'github_pat_[A-Za-z0-9_]{82}|secret|GitHub PAT (fine-grained)'
  'gho_[A-Za-z0-9]{36}|secret|GitHub OAuth token'

  # Slack tokens
  'xox[abprs]-[A-Za-z0-9-]{10,}|secret|Slack token'

  # Stripe live keys
  'sk_live_[A-Za-z0-9]{24,}|secret|Stripe live secret key'

  # bcrypt hashes — if it must ship, store in ~/.rhodes/users.json (gitignored)
  '\$2[abxy]\$1[0-9]\$[./A-Za-z0-9]{53}|secret|bcrypt hash literal'
)

# Lines containing this token are exempt:
ALLOW_TOKEN='secret-scan: allow'

# ── Collect candidate content ────────────────────────────────────────

if [[ "$MODE" == "--staged" ]]; then
  # Just the + lines in the staged diff (drop the +++ file header).
  CANDIDATE=$(git diff --cached --no-color --unified=0 \
              -- ":!${SCANNER_SELF}" ":!${CI_WORKFLOW}" \
              | grep -E '^\+' | grep -vE '^\+\+\+ ' || true)

elif [[ "$MODE" == "tree" ]]; then
  # Use git grep — respects gitignore, only tracked files, very fast.
  # We collect per-pattern hits below by re-grepping in the loop;
  # CANDIDATE here is just a marker that we have content to look at.
  CANDIDATE="(use git grep)"

else
  echo "Usage: $0 [--staged]" >&2
  exit 2
fi

if [[ "$MODE" == "--staged" && -z "${CANDIDATE// }" ]]; then
  echo "[scan] nothing staged."
  exit 0
fi

# ── Run each pattern ─────────────────────────────────────────────────

HITS=0
for row in "${PATTERNS[@]}"; do
  pat=$(printf '%s' "$row" | cut -d'|' -f1)
  sev=$(printf '%s' "$row" | cut -d'|' -f2)
  desc=$(printf '%s' "$row" | cut -d'|' -f3-)

  if [[ "$MODE" == "tree" ]]; then
    matches=$(git grep -nE "$pat" -- ":!${SCANNER_SELF}" ":!${CI_WORKFLOW}" 2>/dev/null \
              | grep -v "$ALLOW_TOKEN" || true)
  else
    matches=$(printf '%s\n' "$CANDIDATE" | grep -nE "$pat" 2>/dev/null \
              | grep -v "$ALLOW_TOKEN" || true)
  fi

  if [[ -n "$matches" ]]; then
    HITS=$((HITS + 1))
    echo "──────────────────────────────────────────────"
    echo "[$sev] $desc"
    echo "pattern: $pat"
    printf '%s\n' "$matches" | head -10
    echo
  fi
done

if [[ "$HITS" -gt 0 ]]; then
  echo "══════════════════════════════════════════════════════════════"
  echo "  $HITS secret class(es) matched. Refusing to proceed."
  echo
  echo "  Legitimate documentation reference? Add the inline comment"
  echo "  \`$ALLOW_TOKEN\` on the same line to allowlist."
  echo
  echo "  Real secret? Rotate it everywhere first, redact the literal"
  echo "  (placeholders / env-var refs are fine), then re-commit. Git"
  echo "  history retains prior commits — rotation is non-negotiable."
  echo "══════════════════════════════════════════════════════════════"
  exit 1
fi

echo "[scan] clean — no forbidden patterns matched."
