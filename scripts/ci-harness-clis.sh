#!/usr/bin/env bash
# Installs the agent CLIs apps/desktop/src-tauri/harness/pins.json pins, for
# the agent engine's tests against a real CLI on a Linux CI runner: Codex, as
# the static binary of its GitHub release at the pinned version. The download
# URL and SHA-256 come from ci-clis.gen.json beside the pins, which
# scripts/generate-harness-releases.ts writes from upstream metadata; a table
# for another version than the pinned one fails the install.
#
# Usage: bash scripts/ci-harness-clis.sh <directory>
#
# The binary lands in <directory>/codex-<version>/, which then goes on
# GITHUB_PATH; STELLA_REAL_HARNESS_CLIS on GITHUB_ENV names what is installed.
# The agent engine's tests read it to require the CLI, and Turbo hashes it
# into their cache key. The binary runs here only with an emptied
# environment, and nothing here signs in or reaches a model provider.
set -euo pipefail

if (($# != 1)); then
  echo 'usage: ci-harness-clis.sh <directory>' >&2
  exit 2
fi
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
harness="$root/apps/desktop/src-tauri/harness"

version=$(jq -r '.codex // empty' "$harness/pins.json")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "pins.json names no Codex version" >&2
  exit 1
fi
table_version=$(jq -r '.codex.version // empty' "$harness/ci-clis.gen.json")
if [[ "$table_version" != "$version" ]]; then
  echo "ci-clis.gen.json is for Codex '$table_version', not the pinned $version; run bun scripts/generate-harness-releases.ts --write" >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x64 ;;
  Linux-aarch64) platform=linux-arm64 ;;
  *)
    echo "No Codex binary is installed for $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac
url=$(jq -r --arg p "$platform" '.codex.assets[$p].url // empty' "$harness/ci-clis.gen.json")
sha256=$(jq -r --arg p "$platform" '.codex.assets[$p].sha256 // empty' "$harness/ci-clis.gen.json")
if [[ "$url" != https://github.com/openai/codex/releases/download/* || ! "$sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "ci-clis.gen.json has no Codex binary for $platform" >&2
  exit 1
fi

folder="$1/codex-$version"
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
bash "$root/scripts/retry.sh" curl -fsSL --max-time 180 -o "$download/codex.zst" "$url"
echo "$sha256  $download/codex.zst" | sha256sum --check --quiet -
mkdir -p "$folder"
zstd -d -q -f "$download/codex.zst" -o "$folder/codex"
chmod 755 "$folder/codex"
installed=$(env -i HOME="$download" PATH=/usr/bin:/bin "$folder/codex" --version)
if [[ "$installed" != "codex-cli $version" ]]; then
  echo "The unpacked binary reports '$installed', not Codex $version" >&2
  exit 1
fi
echo "Codex $version installed for $platform"

if [[ -n "${GITHUB_PATH:-}" && -n "${GITHUB_ENV:-}" ]]; then
  echo "$folder" >> "$GITHUB_PATH"
  echo "STELLA_REAL_HARNESS_CLIS=codex@$version" >> "$GITHUB_ENV"
fi
