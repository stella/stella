#!/usr/bin/env bash
set -euo pipefail

echo "changed=false" >> "$GITHUB_OUTPUT"

# Assess the current tree before deduplication: an existing pull request is
# not evidence that it covers a newly published advisory or a pinned package.
audit_status=0
bun --no-env-file scripts/dependency-audit.ts --assess || audit_status=$?
if (( audit_status > 2 )); then
  exit "$audit_status"
fi

# A stable branch makes retries and the six-hour schedule converge on one
# remediation pull request. The publishing action refreshes that branch when
# the pull request already exists, so preparation must never refuse a retry.
bun --no-env-file scripts/dependency-audit.ts --prepare-remediation
bun --no-env-file install --lockfile-only
# Runs after the fix so acceptances it resolved are removed in the same pull
# request; pruning only removes entries, so it never accepts an advisory.
bun --no-env-file scripts/dependency-audit.ts --prune-baseline
if ! git diff --quiet -- bun.lock bunfig.toml scripts/dependency-audit-baseline.json ':(glob)**/package.json'; then
  echo "changed=true" >> "$GITHUB_OUTPUT"
  exit 0
fi

echo "No lockfile or baseline update is available; the full audit remains the gate."
