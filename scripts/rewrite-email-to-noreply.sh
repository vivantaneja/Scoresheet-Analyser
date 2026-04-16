#!/usr/bin/env bash
# Run from repo root: bash scripts/rewrite-email-to-noreply.sh
# Rewrites vivantaneja@macbookpro.home -> GitHub noreply on all commits, then force-pushes main.
set -euo pipefail
cd "$(dirname "$0")/.."
OLD_EMAIL="vivantaneja@macbookpro.home"
NEW_EMAIL="251870416+vivantaneja@users.noreply.github.com"
rm -f .git/filter-repo/already_ran
git filter-repo --force --commit-callback "
old = b\"${OLD_EMAIL}\"
new = b\"${NEW_EMAIL}\"
if commit.author_email.lower() == old:
    commit.author_email = new
if commit.committer_email.lower() == old:
    commit.committer_email = new
"
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/vivantaneja/Scoresheet-Analyser.git
fi
git push --force origin main
echo "Done. Check GitHub contributors after a few minutes."
