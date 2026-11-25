#!/usr/bin/env bash
# Installs the agent CLIs apps/desktop/src-tauri/harness/pins.json pins, for
# the agent engine's tests against a real CLI on a Linux CI runner: Codex, as
# the static binary of its GitHub release at the pinned version, checked
# against the SHA-256 digest GitHub reports for the asset.
#
# Usage: GH_TOKEN=... bash scripts/ci-harness-clis.sh <directory>
#
# The binary lands in <directory>/codex-<version>/, which then goes on
# GITHUB_PATH; STELLA_REAL_HARNESS_CLIS on GITHUB_ENV names what is installed.
# The agent engine's tests read it to require the CLI, and Turbo hashes it
# into their cache key. Nothing here signs in or reaches a model provider.
set -euo pipefail

if (($# != 1)); then
  echo 'usage: ci-harness-clis.sh <directory>' >&2
  exit 2
fi
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
gh_retry="$root/scripts/gh-retry.sh"

version=$(jq -r '.codex // empty' "$root/apps/desktop/src-tauri/harness/pins.json")
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "pins.json names no Codex version" >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) target=x86_64-unknown-linux-musl ;;
  Linux-aarch64) target=aarch64-unknown-linux-musl ;;
  *)
    echo "No Codex binary is installed for $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac
asset="codex-$target.zst"
tag="rust-v$version"

digest=$(bash "$gh_retry" api "repos/openai/codex/releases/tags/$tag" \
  --jq ".assets[] | select(.name == \"$asset\") | .digest")
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "GitHub reports no SHA-256 digest for $asset of $tag" >&2
  exit 1
fi

folder="$1/codex-$version"
download=$(mktemp -d)
trap 'rm -rf "$download"' EXIT
bash "$gh_retry" release download "$tag" --repo openai/codex \
  --pattern "$asset" --dir "$download"
echo "${digest#sha256:}  $download/$asset" | sha256sum --check --quiet -
mkdir -p "$folder"
zstd -d -q -f "$download/$asset" -o "$folder/codex"
chmod 755 "$folder/codex"
installed=$("$folder/codex" --version)
if [[ "$installed" != "codex-cli $version" ]]; then
  echo "The unpacked binary reports '$installed', not Codex $version" >&2
  exit 1
fi
echo "Codex $version installed from $asset"

if [[ -n "${GITHUB_PATH:-}" && -n "${GITHUB_ENV:-}" ]]; then
  echo "$folder" >> "$GITHUB_PATH"
  echo "STELLA_REAL_HARNESS_CLIS=codex@$version" >> "$GITHUB_ENV"
fi
