#!/usr/bin/env bash
# A stable release changes pointers, preserving the RC artifact identities.
set -euo pipefail
rc_manifest="$1"
release_ref="$2"
release_sha="$3"
[[ "$release_ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
jq -e --arg sha "$release_sha" --arg ref "$release_ref" '
  .commit == $sha and (.version | startswith($ref + "-rc."))
  and .webImage.targetEnvironment == "staging"
  and .productionWebImage.targetEnvironment == "production"
  and ([.image.digest, .webImage.digest, .productionWebImage.digest] |
    all(test("^sha256:[a-f0-9]{64}$")))
' "$rc_manifest" >/dev/null
jq --arg version "$release_ref" '.version = $version' "$rc_manifest"
