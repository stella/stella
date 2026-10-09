#!/usr/bin/env bash
set -euo pipefail

fix_branch="${FIX_BRANCH:-automation/dependency-audit-fix}"
issue_title="${ISSUE_TITLE:-Dependency audit has an unpatched advisory}"

# A stable branch and title are identities, not display text: they make retries
# and the six-hour schedule converge on one open remediation.
if [[ "$(gh pr list --state open --head "$fix_branch" --json number --jq length)" != 0 ]]; then
  echo "An open dependency audit fix pull request already exists."
  exit 0
fi
if [[ "$(gh issue list --state open --search "in:title $issue_title" --json title --jq "[.[] | select(.title == \"$issue_title\")] | length")" != 0 ]]; then
  echo "An open dependency audit issue already exists."
  exit 0
fi

bun --no-env-file audit fix
if ! git diff --quiet -- bun.lock; then
  git config user.name "stella-dependency-audit[bot]"
  git config user.email "stella-dependency-audit[bot]@users.noreply.github.com"
  git checkout -B "$fix_branch"
  git add bun.lock
  git commit -m "fix: resolve dependency audit findings"
  git push --force-with-lease origin "$fix_branch"
  gh pr create --head "$fix_branch" --base main \
    --title "fix: resolve dependency audit findings" \
    --body "Updates resolved dependencies to address the current high or critical advisory findings."
  exit 0
fi

gh issue create --title "$issue_title" \
  --label main-health-incident \
  --body "The full dependency audit reports a high or critical advisory, but the registry currently exposes no lockfile fix."
