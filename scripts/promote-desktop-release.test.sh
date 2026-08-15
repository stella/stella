#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
readonly GOOD_TAG="v0.7.2"
readonly PACKAGE_TAG="@stll/cli@0.6.0"
export GOOD_TAG PACKAGE_TAG

release_json() {
  local tag="$1"
  local omitted_asset="${2:-}"
  jq -cn \
    --arg tag "$tag" \
    --arg omitted_asset "$omitted_asset" \
    '{
      tag_name: $tag,
      draft: false,
      prerelease: false,
      assets: [
        {name: "Stella-macos-universal.dmg"},
        {name: "Stella-windows-x64-setup.exe"},
        {name: "latest.json"}
      ] | map(select(.name != $omitted_asset))
    }'
}

gh() {
  printf '%s\n' "$*" >> "$GH_CALL_LOG"
  if [[ "$1" == "release" && "$2" == "edit" ]]; then
    if [[ "$*" != "release edit $GOOD_TAG --repo stella/stella --latest" ]]; then
      echo "unexpected promotion command: $*" >&2
      return 2
    fi
    return 0
  fi
  if [[ "$1" != "api" ]]; then
    echo "unexpected gh command: $*" >&2
    return 2
  fi
  if [[ "$2" == "repos/stella/stella/releases/tags/$GOOD_TAG" ]]; then
    release_json "$GOOD_TAG" "${STELLA_TEST_OMIT_ASSET:-}"
    return 0
  fi
  if [[ "$2" == "repos/stella/stella/releases/latest" ]]; then
    release_json "${STELLA_TEST_LATEST_TAG:-$GOOD_TAG}"
    return 0
  fi
  echo "unexpected API path: $2" >&2
  return 2
}
export -f gh release_json

curl() {
  printf 'curl %s\n' "$*" >> "$GH_CALL_LOG"
}
export -f curl

run_promotion() {
  (
    cd "$work"
    GH_REPO="stella/stella" \
    RELEASE_REF="$GOOD_TAG" \
    GH_CALL_LOG="$GH_CALL_LOG" \
      bash "$script_dir/promote-desktop-release.sh"
  )
}

export GH_CALL_LOG="$work/gh-calls"
: > "$GH_CALL_LOG"
run_promotion
grep -Fxq "release edit $GOOD_TAG --repo stella/stella --latest" "$GH_CALL_LOG"
grep -Fxq "api repos/stella/stella/releases/latest" "$GH_CALL_LOG"
grep -Fq \
  "https://github.com/stella/stella/releases/latest/download/Stella-macos-universal.dmg" \
  "$GH_CALL_LOG"
grep -Fq \
  "https://github.com/stella/stella/releases/latest/download/Stella-windows-x64-setup.exe" \
  "$GH_CALL_LOG"

: > "$GH_CALL_LOG"
export STELLA_TEST_LATEST_TAG="$PACKAGE_TAG"
if run_promotion >"$work/hijacked.out" 2>"$work/hijacked.err"; then
  echo "expected a package release latest pointer to fail" >&2
  exit 1
fi
grep -Fq "must be a stable desktop release tag" "$work/hijacked.err"
unset STELLA_TEST_LATEST_TAG

for required_asset in \
  "Stella-macos-universal.dmg" \
  "Stella-windows-x64-setup.exe" \
  "latest.json"; do
  : > "$GH_CALL_LOG"
  export STELLA_TEST_OMIT_ASSET="$required_asset"
  if run_promotion >"$work/incomplete.out" 2>"$work/incomplete.err"; then
    echo "expected a release missing $required_asset to fail before promotion" >&2
    exit 1
  fi
  grep -Fq "missing a required desktop asset" "$work/incomplete.err"
  if grep -Fq "release edit" "$GH_CALL_LOG"; then
    echo "release missing $required_asset was promoted" >&2
    exit 1
  fi
done
unset STELLA_TEST_OMIT_ASSET

echo "promote-desktop-release tests passed"
