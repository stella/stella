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
exec bash scripts/verify.sh --fix-only --base "$base_ref"
