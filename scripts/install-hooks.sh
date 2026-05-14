#!/usr/bin/env bash
# scripts/install-hooks.sh — installs the secret-scan pre-commit hook
# into .git/hooks/ for this clone. Idempotent.
#
# Run once per fresh clone:
#   bash scripts/install-hooks.sh
#
# CI enforces the same check server-side via .github/workflows/
# secret-scan.yml, so this hook is the convenience layer — it catches
# leaks before they're pushed, but isn't load-bearing.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_DST="${REPO_ROOT}/.git/hooks/pre-commit"

cat > "${HOOK_DST}" <<'EOF'
#!/usr/bin/env bash
# pre-commit hook installed by scripts/install-hooks.sh.
# Scans staged additions for credential patterns before allowing commit.
# Bypassable with `git commit --no-verify` — CI re-runs the same check
# server-side, so the bypass is logged on the PR.

set -e
exec bash "$(git rev-parse --show-toplevel)/scripts/check-secrets.sh" --staged
EOF

chmod +x "${HOOK_DST}"
echo "[install-hooks] installed ${HOOK_DST}"
echo "[install-hooks] try a 'git commit' to verify; bypass with --no-verify if needed."
