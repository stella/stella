#!/usr/bin/env bash
# Enforce the repository-variable hold on the queued tree.
set -euo pipefail

if [[ "${EVENT_NAME:-}" != "merge_group" || -z "${STELLA_MERGE_HOLD:-}" ]]; then
  exit 0
fi
if [[ ! "${MERGE_GROUP_HEAD_REF:-}" =~ /pr-([0-9]+)-[0-9a-f]+$ ]]; then
  echo "Merge group head ref does not name a pull request: ${MERGE_GROUP_HEAD_REF:-}" >&2
  exit 1
fi
number="${BASH_REMATCH[1]}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state=$(bash "$script_dir/release-pull-requests.sh" --repo "${REPOSITORY:?REPOSITORY is required}" --number "$number")
current_is_release=$(sed -n 's/^current_is_release=//p' <<<"$state")
case "$current_is_release" in
  true) exit 0 ;;
  false) printf 'MERGE HOLD: %s\n' "$STELLA_MERGE_HOLD" >&2; exit 1 ;;
  *) echo "Invalid release recognition response" >&2; exit 1 ;;
esac
