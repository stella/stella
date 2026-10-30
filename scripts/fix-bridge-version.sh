#!/usr/bin/env bash
set -euo pipefail

base_ref="${BASE_SHA:?BASE_SHA is required}"
types_path=apps/desktop/src-tauri/src/types.rs
bridge_files=(
  apps/desktop/src-tauri/src/bridge.rs
  apps/desktop/src-tauri/src/commands.rs
  apps/desktop/src-tauri/src/types.rs
  apps/desktop/src/shared/rpc.gen.ts
  apps/desktop/src/shared/rpc.ts
  packages/api-contract/src/desktop-edit-file-types.ts
)

if git diff --quiet "$base_ref"...HEAD -- "${bridge_files[@]}"; then
  exit 0
fi

version_re='^pub const BRIDGE_VERSION: u32 = ([0-9]+);'
extract_version() {
  local line
  line=$(grep -m 1 -E "$version_re" || true)
  [[ "$line" =~ $version_re ]] && printf '%s\n' "${BASH_REMATCH[1]}"
}

base_version=$(git show "$base_ref:$types_path" | extract_version)
head_version=$(extract_version < "$types_path")
: "${base_version:?Could not parse base BRIDGE_VERSION}"
: "${head_version:?Could not parse head BRIDGE_VERSION}"

if (( head_version > base_version )); then
  exit 0
fi

next_version=$((base_version + 1))
sed -i.bak -E "s/^pub const BRIDGE_VERSION: u32 = [0-9]+;/pub const BRIDGE_VERSION: u32 = $next_version;/" "$types_path"
rm -f "$types_path.bak"
echo "Raised BRIDGE_VERSION from $head_version to $next_version."
