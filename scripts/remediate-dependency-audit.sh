#!/usr/bin/env bash
set -euo pipefail

fix_branch="${FIX_BRANCH:-automation/dependency-audit-fix}"

# A stable branch makes retries and the six-hour schedule converge on one
# open fix pull request.
if [[ "$(gh pr list --state open --head "$fix_branch" --json number --jq length)" != 0 ]]; then
  echo "An open dependency audit fix pull request already exists."
  exit 0
fi

bun --no-env-file audit fix
if ! git diff --quiet -- bun.lock; then
  git config user.name "stella-dependency-audit[bot]"
  git config user.email "stella-dependency-audit[bot]@users.noreply.github.com"
  git checkout -B "$fix_branch"
  git add bun.lock
  git commit -m "fix: resolve dependency audit findings"
  git -c credential.helper= -c credential.helper='!gh auth git-credential' push --force-with-lease origin "$fix_branch"
  gh pr create --head "$fix_branch" --base main \
    --title "fix: resolve dependency audit findings" \
    --body "Updates resolved dependencies to address the current high or critical advisory findings."
  exit 0
fi

echo "No lockfile update is available; the full audit remains the gate."
