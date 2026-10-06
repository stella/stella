#!/usr/bin/env bash
# Bind the immutable image subject to the source checkout and resolved history.
set -euo pipefail
sha=""
main_sha=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha) sha="${2-}"; shift 2 ;;
    --main-sha) main_sha="${2-}"; shift 2 ;;
    *) echo "::error::Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ || ! "$main_sha" =~ ^[0-9a-f]{40}$ || "${GITHUB_REPOSITORY:-}" != stella/stella ]]; then
  echo "::error::Staging provenance requires exact source and history commits in Stella." >&2
  exit 1
fi
checkout_sha=$(git rev-parse --verify HEAD^{commit})
if [[ "$checkout_sha" != "$sha" ]]; then
  echo "::error::Staging provenance source does not match the build checkout." >&2
  exit 1
fi
jq -cn --arg commit "$checkout_sha" --arg main "$main_sha" \
  '{repository:"https://github.com/stella/stella",commit:$commit,mainCommit:$main}'
