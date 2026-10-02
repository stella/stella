#!/usr/bin/env bash
#
# Local counterpart of the CI autofix (.github/workflows/autofix.yml), which
# only runs on same-repository pull requests: regenerates the derived files
# your changes affect, applies safe lint fixes and formats the changed files.
# Fork pull requests need this before pushing, or the generated-files and
# format checks fail instead of being fixed.
#
# Usage:
#   bun run autofix                 # changes vs the canonical repository's main
#   bun run autofix --base <ref>
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

base_ref=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "Error: --base requires an argument" >&2
        exit 1
      fi
      base_ref="$2"
      shift 2
      ;;
    *)
      echo "Usage: bun run autofix [--base <ref>]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$base_ref" ]]; then
  source "$script_dir/canonical-base.sh"
  base_ref="$(canonical_base_ref)"
fi
merge_base="$(git merge-base "$base_ref" HEAD)"

# Committed, staged and unstaged changes plus untracked files. Deleted paths
# stay in the list: a deleted generator input still selects its generator.
changed_files() {
  {
    git diff --name-only "$merge_base"
    git ls-files --others --exclude-standard
  } | sort -u
}

plan="$(changed_files | bun scripts/autofix-plan.ts plan)"
generator_ids="$(sed -n 's/^ids=//p' <<<"$plan")"
if [[ -n "$generator_ids" ]]; then
  bun scripts/autofix-plan.ts run "$generator_ids"
fi

format_paths=()
lint_paths=()
while IFS= read -r path; do
  [[ -f "$path" && ! -L "$path" ]] || continue
  format_paths+=("./$path")
  if [[ "$path" =~ \.([cm]?[jt]s|[jt]sx)$ ]]; then
    lint_paths+=("./$path")
  fi
done < <(changed_files)

if ((${#lint_paths[@]} > 0)); then
  # Safe fixes only; exit 1 means findings remain, which `bun run lint` reports.
  lint_status=0
  bun --bun oxlint -c oxlint.config.ts --no-error-on-unmatched-pattern --fix "${lint_paths[@]}" || lint_status=$?
  if ((lint_status > 1)); then
    exit "$lint_status"
  fi
fi
if ((${#format_paths[@]} > 0)); then
  bun run format:guard
  bun --bun oxfmt -c .oxfmtrc.json --no-error-on-unmatched-pattern "${format_paths[@]}"
fi
# CI runs the ratchet improvement phase last, on the final tree, so a removed
# violation tightens the committed baseline instead of leaving slack.
if [[ "$(sed -n 's/^ratchet=//p' <<<"$plan")" == "true" ]]; then
  bun --no-install --no-env-file scripts/ratchet.ts --write-improvements-only --base "$merge_base"
fi
echo "autofix: compared against $base_ref; review and commit the changes"
