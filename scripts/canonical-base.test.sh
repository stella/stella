#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# expect_base <expected ref or "error"> <remote name=url>...
expect_base() {
  local expected="$1" repo actual status=0 spec
  shift
  repo="$(mktemp -d "$work/repo.XXXXXX")"
  git -C "$repo" init --quiet
  for spec in "$@"; do
    git -C "$repo" remote add "${spec%%=*}" "${spec#*=}"
  done
  actual="$(
    cd "$repo"
    source "$script_dir/canonical-base.sh"
    canonical_base_ref 2>/dev/null
  )" || status=$?
  if [[ "$expected" == "error" ]]; then
    if [[ "$status" -eq 0 ]]; then
      echo "Expected no canonical base for: $*; got $actual" >&2
      exit 1
    fi
    return 0
  fi
  if [[ "$status" -ne 0 || "$actual" != "$expected" ]]; then
    echo "Expected $expected for: $*; got '$actual' (status $status)" >&2
    exit 1
  fi
}

canonical="https://github.com/stella/stella.git"
fork="https://github.com/someone/stella.git"

expect_base origin/main "origin=$canonical"
expect_base origin/main "origin=git@github.com:stella/stella.git"
expect_base origin/main "origin=https://github.com/stella/stella"
expect_base origin/main "origin=$canonical" "upstream=$canonical"
expect_base upstream/main "origin=$fork" "upstream=$canonical"
expect_base canonical/main "origin=$fork" "canonical=ssh://git@github.com/stella/stella.git"
# A look-alike repository name must not count as canonical.
expect_base error "origin=https://github.com/stella/stella-plane.git"
expect_base error "origin=$fork"
expect_base error

echo "canonical-base: all cases passed"
