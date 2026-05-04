#!/usr/bin/env bash
#
# Fail CI when files defining the desktop bridge surface change
# in a PR but BRIDGE_VERSION (in apps/desktop/src-tauri/src/types.rs)
# isn't bumped.
#
# Bumping the version forces the web app's feature-detection path
# (`snapshot.bridgeVersion >= N`) to be considered any time the
# desktop adds, removes, or changes a bridge endpoint or its
# advertised capabilities. Without this guard, a desktop change
# would land silently and the web app could only learn about it
# after every user finished auto-updating.
#
# False positives are tolerated: any edit (refactor, rename, log
# tweak) to a bridge file requires a version bump. The cost of an
# unnecessary bump is one integer; the cost of a missed bump is
# silent breakage between desktop and web releases.
set -euo pipefail

base="${GITHUB_BASE_REF:-main}"

# Use origin/<base> when running in CI, fall back to local <base>
# for ad-hoc invocation.
if git rev-parse --verify "origin/$base" >/dev/null 2>&1; then
  base_ref="origin/$base"
else
  base_ref="$base"
fi

bridge_files=(
  apps/desktop/src-tauri/src/bridge.rs
  apps/desktop/src-tauri/src/commands.rs
  apps/desktop/src/shared/rpc.ts
)

bridge_changed=false
for f in "${bridge_files[@]}"; do
  if ! git diff --quiet "$base_ref...HEAD" -- "$f"; then
    bridge_changed=true
    break
  fi
done

if [[ "$bridge_changed" == false ]]; then
  echo "No bridge-surface changes detected since $base_ref. OK."
  exit 0
fi

# Bridge surface changed — verify BRIDGE_VERSION strictly increased.
# Just diffing the line is not enough: a comment tweak or
# reformat would satisfy a `line changed` check while leaving the
# integer (and therefore `snapshot.bridgeVersion`) untouched, and
# the compatibility gate would silently no-op.
types_path=apps/desktop/src-tauri/src/types.rs
version_re='^pub const BRIDGE_VERSION: u32 = ([0-9]+);'

extract_version() {
  local content="$1" line
  line=$(printf '%s\n' "$content" | grep -E "$version_re" | head -n 1 || true)
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  [[ "$line" =~ $version_re ]] && echo "${BASH_REMATCH[1]}"
}

# Treat a missing file on base as version 0 — a brand-new bridge
# addition still needs a real version number on HEAD.
if base_content=$(git show "$base_ref:$types_path" 2>/dev/null); then
  old_version=$(extract_version "$base_content")
  : "${old_version:=0}"
else
  old_version=0
fi

if [[ ! -f "$types_path" ]]; then
  echo "::error::Bridge surface changed but $types_path is missing on HEAD." >&2
  exit 1
fi
new_version=$(extract_version "$(cat "$types_path")")

if [[ -z "$new_version" ]]; then
  echo "::error::Could not parse BRIDGE_VERSION integer from $types_path on HEAD." >&2
  exit 1
fi

if (( new_version <= old_version )); then
  cat >&2 <<MSG
::error::Bridge surface changed but BRIDGE_VERSION did not strictly increase ($old_version -> $new_version).

A change to one of these files implies the bridge protocol that
the web app talks to has shifted:
  - apps/desktop/src-tauri/src/bridge.rs
  - apps/desktop/src-tauri/src/commands.rs
  - apps/desktop/src/shared/rpc.ts

Bump BRIDGE_VERSION in $types_path to a value greater than $old_version
(and add a string to BRIDGE_CAPABILITIES if you added a new endpoint)
so the web app can feature-detect the change.
MSG
  exit 1
fi

echo "Bridge surface changed and BRIDGE_VERSION bumped $old_version -> $new_version. OK."
