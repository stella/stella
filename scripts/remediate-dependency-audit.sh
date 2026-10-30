#!/usr/bin/env bash
set -euo pipefail

fix_branch="${FIX_BRANCH:-automation/dependency-audit-fix}"
echo "changed=false" >> "$GITHUB_OUTPUT"

# Assess the current tree before deduplication: an existing pull request is
# not evidence that it covers a newly published advisory or a pinned package.
audit_status=0
bun --no-env-file scripts/dependency-audit.ts --assess || audit_status=$?
if (( audit_status > 2 )); then
  exit "$audit_status"
fi

# A stable branch makes retries and the six-hour schedule converge on one
# open fix pull request.
if [[ "$(gh pr list --state open --head "$fix_branch" --json number --jq length)" != 0 ]]; then
  echo "An open dependency audit fix pull request already exists; unresolved findings above still require action."
  exit "$audit_status"
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
  echo "changed=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "No lockfile or baseline update is available; the full audit remains the gate."
