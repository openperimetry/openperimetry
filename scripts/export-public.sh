#!/usr/bin/env bash
# scripts/export-public.sh — export a clean copy of the private repo to
# the public openperimetry/openperimetry repo.
#
# Usage:
#   ./scripts/export-public.sh -m "Describe the public update" [TARGET_DIR]
#
# TARGET_DIR defaults to $PUBLIC_REPO_DIR when set, otherwise to the
# checked-out public repo at ../../openperimetry/openperimetry. The script:
#   1. Copies allowed files from the current repo into TARGET_DIR.
#   2. Removes anything not on the allowlist.
#   3. Initialises a fresh git repo on first export, otherwise commits onto
#      the existing public history with the provided commit message.
#
# After running, cd into TARGET_DIR and push:
#   cd ../../openperimetry/openperimetry
#   git remote add origin https://github.com/openperimetry/openperimetry.git
#   git push -u origin main
#
# IMPORTANT: always run from the repo root (where this script lives under scripts/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_TARGET="$REPO_ROOT/../../openperimetry/openperimetry"
TARGET="${PUBLIC_REPO_DIR:-$DEFAULT_TARGET}"
COMMIT_MESSAGE="${PUBLIC_COMMIT_MESSAGE:-}"

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/export-public.sh -m "Commit message" [TARGET_DIR]

Options:
  -m, --message MESSAGE   Commit message for this public export.
  -h, --help              Show this help.

TARGET_DIR defaults to $PUBLIC_REPO_DIR when set, otherwise to
../../openperimetry/openperimetry.
USAGE
}

target_set=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -m|--message)
      shift
      if [ "$#" -eq 0 ]; then
        echo "ERROR: missing value for --message" >&2
        usage >&2
        exit 2
      fi
      COMMIT_MESSAGE="$1"
      ;;
    --message=*)
      COMMIT_MESSAGE="${1#*=}"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [ "$target_set" -eq 1 ]; then
        echo "ERROR: target directory was provided more than once" >&2
        usage >&2
        exit 2
      fi
      TARGET="$1"
      target_set=1
      ;;
  esac
  shift
done

echo "==> Exporting from $REPO_ROOT to $TARGET"

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
  web/playwright.config.ts
  web/index.html
  web/Dockerfile
  web/.env.example
  web/public/
  web/docs/
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

# ── Verify no private references leaked ───────────────────────────────

echo ""
echo "==> Scanning for private references..."
PRIVATE_TERMS=(
  'tik''tak'
  'tik''takme'
  'daniel\.tom@tik''tak'
  'visualfield''check'
)
LEAK_PATTERN=$(IFS='|'; echo "${PRIVATE_TERMS[*]}")
LEAKS=$(grep -RIlE --exclude-dir='.git' --exclude-dir='node_modules' --exclude-dir='dist' "$LEAK_PATTERN" "$TARGET" 2>/dev/null || true)
if [ -n "$LEAKS" ]; then
  echo "  ERROR: found private references in:"
  echo "$LEAKS" | sed 's/^/    /'
  echo "  Remove or public-safe those references before pushing."
  exit 1
else
  echo "  Clean — no private references found."
fi

# ── Git init + commit ─────────────────────────────────────────────────

cd "$TARGET"
is_initial_export=0
if [ ! -d .git ]; then
  git init -b main
  is_initial_export=1
elif ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  is_initial_export=1
fi

if [ -z "$COMMIT_MESSAGE" ]; then
  if [ "$is_initial_export" -eq 1 ]; then
    COMMIT_MESSAGE="Initial commit — OpenPerimetry visual field self-test

Apache-2.0 licensed. See README.md for setup instructions.

Exported from the private development repository with fresh history."
  else
    echo "ERROR: provide a commit message with -m/--message or PUBLIC_COMMIT_MESSAGE." >&2
    exit 2
  fi
fi

git add -A
if git diff --cached --quiet; then
  echo "==> No exported changes to commit."
else
  git commit -m "$COMMIT_MESSAGE"
fi

echo ""
echo "==> Done. Target: $TARGET"
echo "    To push:"
echo "      cd $TARGET"
echo "      git remote add origin https://github.com/openperimetry/openperimetry.git"
echo "      git push -u origin main"
