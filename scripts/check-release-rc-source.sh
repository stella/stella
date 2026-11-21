#!/usr/bin/env bash
# RC creation defers build evidence, retaining the source and incident gates.
set -euo pipefail
repo="${1:?repository is required}"
sha="${2:?candidate SHA is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tree_proof_verifier="${RELEASE_TREE_PROOF_VERIFIER:-$script_dir/verify-release-tree-proof.sh}"
bash "$tree_proof_verifier" --allow-pr-head "$repo" "$sha" "$sha"
bash "$script_dir/check-release-open-incidents.sh" "$repo"
