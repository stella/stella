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

mapfile -t desired_files < <(git diff --name-only -- bunfig.toml ':(glob)**/bunfig.toml' | sort)
mapfile -t existing_files < <(
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls/$number/files" |
    jq -r '.[][] | .filename | select(. == "bunfig.toml" or endswith("/bunfig.toml"))' |
    sort
)

current=true
if [[ "${#desired_files[@]}" -ne "${#existing_files[@]}" ]]; then
  current=false
else
  for index in "${!desired_files[@]}"; do
    path="${desired_files[$index]}"
    if [[ "$path" != "${existing_files[$index]}" ]]; then
      current=false
      break
    fi
    if ! cmp --silent "$path" <(
      gh api --method GET "repos/$GITHUB_REPOSITORY/contents/$path" -f ref="$head" |
        jq -r '.content' |
        base64 --decode
    ); then
      current=false
      break
    fi
  done
fi

if [[ "$current" == "true" ]]; then
  echo "outcome=current" >> "$GITHUB_OUTPUT"
  echo "Removal PR #$number already contains the current removals."
  exit 0
fi

echo "outcome=write" >> "$GITHUB_OUTPUT"
