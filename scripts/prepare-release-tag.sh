#!/usr/bin/env bash
# Select only RC identity and numbering. Build proofs belong to finalization.
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo=""
sha=""
tree_proof_verifier="${RELEASE_TREE_PROOF_VERIFIER:-$script_dir/verify-release-tree-proof.sh}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --sha) sha="${2:?--sha needs a value}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$repo" && -n "$sha" ]] || { echo "::error::--repo and --sha are required" >&2; exit 2; }
identity=$(RELEASE_PROOF_REPOSITORY="$repo" RELEASE_TREE_PROOF_VERIFIER="$tree_proof_verifier" bash "$script_dir/check-release-candidate.sh" "$sha")
version=""
while IFS='=' read -r key value; do
  case "$key" in
    sha) sha="$value" ;;
    value) version="$value" ;;
  esac
done <<< "$identity"
receipt=$(bash "$script_dir/release-rc-number.sh" "${version:?candidate VERSION is required}" "$sha")
printf 'sha=%s\nvalue=%s\n%s\n' "$sha" "$version" "$receipt"
