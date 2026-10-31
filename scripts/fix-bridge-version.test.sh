#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/fix-bridge-version.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cd "$root"
git init -q -b main
git config user.email test@example.invalid
git config user.name test
mkdir -p apps/desktop/src-tauri/src apps/desktop/src/shared apps/desktop/fixtures/rpc packages/api-contract/src
printf 'pub const BRIDGE_VERSION: u32 = 4;\n' > apps/desktop/src-tauri/src/types.rs
printf '{\n  "bridgeVersion": 4,\n  "other": true\n}\n' > apps/desktop/fixtures/rpc/app-snapshot.json
printf '// bridge\n' > apps/desktop/src-tauri/src/bridge.rs
git add -A && git commit -qm base
base=$(git rev-parse HEAD)
git checkout -qb feature

printf '// changed\n' >> apps/desktop/src-tauri/src/bridge.rs
git commit -qam changed
BASE_SHA="$base" bash "$SCRIPT"
grep -q '^pub const BRIDGE_VERSION: u32 = 5;$' apps/desktop/src-tauri/src/types.rs
grep -q '^  "bridgeVersion": 5,$' apps/desktop/fixtures/rpc/app-snapshot.json

git reset --hard -q HEAD
sed -i 's/= 4;/= 6;/' apps/desktop/src-tauri/src/types.rs
BASE_SHA="$base" bash "$SCRIPT"
grep -q '^pub const BRIDGE_VERSION: u32 = 6;$' apps/desktop/src-tauri/src/types.rs
grep -q '^  "bridgeVersion": 4,$' apps/desktop/fixtures/rpc/app-snapshot.json

git reset --hard -q "$base"
printf '// unrelated\n' > unrelated.ts
git add unrelated.ts && git commit -qm unrelated
BASE_SHA="$base" bash "$SCRIPT"
grep -q '^pub const BRIDGE_VERSION: u32 = 4;$' apps/desktop/src-tauri/src/types.rs
grep -q '^  "bridgeVersion": 4,$' apps/desktop/fixtures/rpc/app-snapshot.json

echo "fix-bridge-version tests passed"
