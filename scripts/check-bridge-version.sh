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

# Bridge surface changed — verify the BRIDGE_VERSION line in
# types.rs was modified in this PR.
version_diff=$(
  git diff "$base_ref...HEAD" -- apps/desktop/src-tauri/src/types.rs \
    | grep -E '^[+-]pub const BRIDGE_VERSION' \
    || true
)

if [[ -z "$version_diff" ]]; then
  cat >&2 <<'MSG'
::error::Bridge surface changed but BRIDGE_VERSION was not bumped.

A change to one of these files implies the bridge protocol that
the web app talks to has shifted:
  - apps/desktop/src-tauri/src/bridge.rs
  - apps/desktop/src-tauri/src/commands.rs
  - apps/desktop/src/shared/rpc.ts

Bump BRIDGE_VERSION in apps/desktop/src-tauri/src/types.rs (and add
a string to BRIDGE_CAPABILITIES if you added a new endpoint) so
the web app can feature-detect the change.
MSG
  exit 1
fi

echo "Bridge surface changed and BRIDGE_VERSION was updated. OK."
