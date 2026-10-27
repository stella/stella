#!/usr/bin/env bash
set -euo pipefail

fix_branch="${FIX_BRANCH:-automation/dependency-audit-fix}"

# A stable branch makes retries and the six-hour schedule converge on one
# open fix pull request.
if [[ "$(gh pr list --state open --head "$fix_branch" --json number --jq length)" != 0 ]]; then
  echo "An open dependency audit fix pull request already exists."
  exit 0
fi

# `bun audit fix` exits 1 while unfixable advisories remain, even after it
# updated the lockfile; the lockfile diff decides, and the audit stays the gate.
if ! bun --no-env-file audit fix; then
  echo "Advisories remain after bun audit fix."
fi
# Runs after the fix so acceptances it resolved are removed in the same pull
# request; pruning only removes entries, so it never accepts an advisory.
bun --no-env-file scripts/dependency-audit.ts --prune-baseline
if ! git diff --quiet -- bun.lock scripts/dependency-audit-baseline.json ':(glob)**/package.json'; then
  # A source-only checkout has no tracking ref for an abandoned fix branch.
  # Lease the fetched tip explicitly, or require absence when creating it.
  fix_ref="refs/heads/$fix_branch"
  observed_sha="$(git -c credential.helper= -c credential.helper='!gh auth git-credential' ls-remote --heads origin "$fix_ref" | cut -f1)"
  if [[ -n "$observed_sha" ]]; then
    git -c credential.helper= -c credential.helper='!gh auth git-credential' fetch --no-tags origin "$fix_ref"
    observed_sha="$(git rev-parse FETCH_HEAD)"
  fi
  git config user.name "stella-dependency-audit[bot]"
  git config user.email "stella-dependency-audit[bot]@users.noreply.github.com"
  git checkout -B "$fix_branch"
  git add bun.lock scripts/dependency-audit-baseline.json ':(glob)**/package.json'
  git commit -m "chore(deps): update dependency audit state"
  git -c credential.helper= -c credential.helper='!gh auth git-credential' push "--force-with-lease=$fix_ref:$observed_sha" origin "$fix_branch"
  gh pr create --head "$fix_branch" --base main \
    --title "chore(deps): update dependency audit state" \
    --body "Updates resolved dependencies and removes acceptances whose advisory is no longer reported."
  exit 0
fi

echo "No lockfile or baseline update is available; the full audit remains the gate."
