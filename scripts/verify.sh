#!/usr/bin/env bash
# CI owns the check list; this wrapper supplies the canonical comparison ref.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
args=("$@")
has_base=false
for arg in "$@"; do
  [[ "$arg" != --base ]] || has_base=true
done
if [[ "$has_base" == false ]]; then
  source "$script_dir/canonical-base.sh"
  args+=(--base "$(canonical_base_ref)")
fi
exec bun "$script_dir/verify.ts" "${args[@]}"
