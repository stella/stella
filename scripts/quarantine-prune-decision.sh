#!/usr/bin/env bash
set -euo pipefail

proposal="$(gh pr list --repo "$GITHUB_REPOSITORY" \
  --state open --base main --head "$PRUNE_BRANCH" \
  --json number,headRefOid,isCrossRepository,autoMergeRequest \
  --jq 'map(select(.isCrossRepository == false))[0] | if . == null then empty else [.number, .headRefOid, (.autoMergeRequest != null)] | @tsv end')"

if [[ -z "$proposal" ]]; then
  echo "outcome=write" >> "$GITHUB_OUTPUT"
  exit 0
fi

IFS=$'\t' read -r number head queued <<< "$proposal"
{
  echo "pull-request-number=$number"
  echo "head=$head"
} >> "$GITHUB_OUTPUT"

if [[ "$queued" == "true" ]]; then
  echo "outcome=queued" >> "$GITHUB_OUTPUT"
  echo "Removal PR #$number is already queued; leaving its head unchanged."
  exit 0
fi

desired="$(git diff --no-ext-diff -- bunfig.toml ':(glob)**/bunfig.toml')"
existing="$(gh pr diff "$number" --repo "$GITHUB_REPOSITORY" --patch)"
if [[ "$existing" == "$desired" ]]; then
  echo "outcome=unchanged" >> "$GITHUB_OUTPUT"
  echo "Removal PR #$number already contains the current removals."
  exit 0
fi

echo "outcome=write" >> "$GITHUB_OUTPUT"
