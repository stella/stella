#!/usr/bin/env bash
# Promote a fully assembled stable desktop release, then prove that GitHub's
# /releases/latest pointer and its required assets resolve to that release.
set -euo pipefail

repo="${GH_REPO:?GH_REPO is required}"
release_ref="${RELEASE_REF:?RELEASE_REF is required}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! "$release_ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::Refusing to promote non-stable desktop tag '$release_ref'" >&2
  exit 1
fi

# Never move the public pointer to an incomplete release. This also protects
# manual recovery runs whose preceding jobs may have been skipped or rerun.
GH_REPO="$repo" \
STELLA_DESKTOP_RELEASE_API_PATH="repos/${repo}/releases/tags/${release_ref}" \
STELLA_DESKTOP_RELEASE_EXPECTED_TAG="$release_ref" \
  bash "$script_dir/check-desktop-release-policy.sh"

# --repo is deliberate even though GH_REPO is set: this command must work in a
# fresh GitHub Actions job with no checkout or ambient git repository.
gh release edit "$release_ref" --repo "$repo" --latest

GH_REPO="$repo" \
STELLA_DESKTOP_RELEASE_EXPECTED_TAG="$release_ref" \
  bash "$script_dir/check-desktop-release-policy.sh"
