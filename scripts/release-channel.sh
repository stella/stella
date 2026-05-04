#!/usr/bin/env bash
#
# Single source of truth for the desktop release channel name
# derived from a release tag. Used by the release-desktop.yml
# workflow in three places that MUST agree on the same channel:
#
#   1. tauri.conf.json `plugins.updater.endpoints[0]`  (baked
#      into the binary at build time, determines which manifest
#      every install of this build polls)
#   2. The S3 path the latest.json mirror writes to
#      (`s3://<bucket>/desktop/<channel_dir>/latest.json`)
#   3. The CloudFront invalidation path
#
# If those three diverge for the same tag, builds in one channel
# would auto-update from a different channel's manifest. Centralise
# the derivation here, test it, and call this script from each
# place instead of inlining the regex.
#
# Usage:
#   bash scripts/release-channel.sh <tag>
# Prints the channel directory name on stdout:
#   v0.0.2          -> "prod"   (no suffix, stable channel)
#   v0.0.2-rc.1     -> "rc"
#   v0.0.2-beta.3   -> "beta"
#   v1.2.3-alpha.7  -> "alpha"
#
# Tag must be a valid semver release ref accepted by release.yml
# (`^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$`); invalid input
# exits 1 to fail fast in CI.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 1
fi

tag="$1"

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$ ]]; then
  echo "::error::invalid release tag: $tag" >&2
  exit 1
fi

if [[ "$tag" != *-* ]]; then
  # Stable release (no `-suffix.N`) routes to the production
  # channel directory.
  echo "prod"
  exit 0
fi

# Strip the leading `v...-` to get `<channel>.<n>`, then drop
# everything from the first `.` onward to get just the channel.
suffix="${tag#*-}"
channel="${suffix%%.*}"
echo "$channel"
