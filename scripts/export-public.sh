#!/usr/bin/env bash
# scripts/export-public.sh — export a clean copy of the private repo to
# the public openperimetry/openperimetry repo with a fresh single-commit
# history.
#
# Usage:
#   ./scripts/export-public.sh [TARGET_DIR]
#
# TARGET_DIR defaults to ../openperimetry. The script:
#   1. Copies allowed files from the current repo into TARGET_DIR.
#   2. Removes anything not on the allowlist.
#   3. Initialises a fresh git repo (or reuses one) and creates a single
#      "Initial commit" on main.
#
# After running, cd into TARGET_DIR and push:
#   cd ../openperimetry
#   git remote add origin https://github.com/openperimetry/openperimetry.git
#   git push -u origin main --force
#
# IMPORTANT: always run from the repo root (where this script lives under scripts/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="${1:-$REPO_ROOT/../openperimetry}"

echo "==> Exporting from $REPO_ROOT → $TARGET"

# ── Allowlist ────────────────────────────────────────────────────────
# Only these paths are copied. Everything else (infra/, .github/workflows
# with deploy secrets, marketing/, docs/superpowers/) stays private.

ALLOW=(
  # Root files
  README.md
  LICENSE
  NOTICE
  CONTRIBUTING.md
  SECURITY.md
  CODE_OF_CONDUCT.md
  docker-compose.yml
  .gitignore

  # Web
  web/package.json
  web/package-lock.json
  web/tsconfig.json
  web/tsconfig.app.json
  web/tsconfig.node.json
  web/vite.config.ts
  web/eslint.config.js
  web/index.html
  web/Dockerfile
  web/.env.example
  web/public/
  web/src/
  web/e2e/

  # API
  api/package.json
  api/package-lock.json
  api/tsconfig.json
  api/Dockerfile
  api/.env.example
  api/src/

  # CI (public-safe)
  .github/workflows/ci.yml

  # Scripts
  scripts/export-public.sh
)

# ── Clean target ─────────────────────────────────────────────────────

mkdir -p "$TARGET"

# Remove everything in target except .git (preserve remote config if
# the repo was already initialised from a prior run).
find "$TARGET" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +

# ── Copy allowlisted paths ───────────────────────────────────────────

for item in "${ALLOW[@]}"; do
  src="$REPO_ROOT/$item"
  dst="$TARGET/$item"

  if [ ! -e "$src" ]; then
    echo "  SKIP (missing): $item"
    continue
  fi

  mkdir -p "$(dirname "$dst")"

  if [ -d "$src" ]; then
    # Directory — use rsync for clean recursive copy, excluding
    # node_modules, dist, and other build artifacts.
    rsync -a \
      --exclude='node_modules' \
      --exclude='dist' \
      --exclude='.DS_Store' \
      --exclude='playwright-report' \
      --exclude='test-results' \
      --exclude='*.db' \
      --exclude='*.db-*' \
      --exclude='*.sqlite' \
      --exclude='*.sqlite-*' \
      "$src/" "$dst/"
  else
    cp "$src" "$dst"
  fi
  echo "  OK: $item"
done

# ── Strip private files that sneaked through directory copies ─────────

# ddbStore is included (it's Apache-licensed code, not a secret), but
# make sure no .env, terraform state, or secret-bearing files slipped in.
rm -f "$TARGET/api/.env" "$TARGET/web/.env" "$TARGET/web/.env.local"
rm -rf "$TARGET/api/data/"
rm -rf "$TARGET/web/node_modules" "$TARGET/api/node_modules"

# ── Verify no tiktak / personal references leaked ────────────────────

echo ""
echo "==> Scanning for private references..."
LEAKS=$(grep -rIl 'tiktak\|tiktakme\|daniel\.tom@tiktak' "$TARGET" 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  echo "  WARNING: found private references in:"
  echo "$LEAKS" | sed 's/^/    /'
  echo "  Review these files before pushing."
else
  echo "  Clean — no private references found."
fi

# ── Git init + single commit ─────────────────────────────────────────

cd "$TARGET"
if [ ! -d .git ]; then
  git init -b main
fi

git add -A
git commit -m "Initial commit — OpenPerimetry visual field self-test

Apache-2.0 licensed. See README.md for setup instructions.

Squashed from the private development repository with fresh history."

echo ""
echo "==> Done. Target: $TARGET"
echo "    To push:"
echo "      cd $TARGET"
echo "      git remote add origin https://github.com/openperimetry/openperimetry.git"
echo "      git push -u origin main --force"
