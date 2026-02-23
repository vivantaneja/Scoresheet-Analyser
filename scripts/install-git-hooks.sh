#!/bin/sh
# Install Git hooks so .env can never be committed.
# Run once after git init or clone: sh scripts/install-git-hooks.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR" || exit 1
HOOKS_DIR="$ROOT_DIR/.git/hooks"

if [ ! -d ".git" ]; then
  echo "Not a Git repo. Run 'git init' first."
  exit 1
fi

mkdir -p "$HOOKS_DIR"
cp "$SCRIPT_DIR/pre-commit.hook" "$HOOKS_DIR/pre-commit"
chmod +x "$HOOKS_DIR/pre-commit"
echo "Installed pre-commit hook (blocks committing .env)."
