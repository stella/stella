#!/usr/bin/env bash
#
# Decide whether the desktop (Tauri) release pipeline needs to build
# and publish installers for a given release tag, or whether it can
# safely carry the previous release forward untouched.
#
# WHY this exists
# ---------------
# Building + signing + notarizing the desktop app is expensive (tens
# of minutes across Windows + macOS) and, more importantly, every
# publish forces a ~30 MB redownload + restart on end users via the
# updater. A release that changed nothing desktop-relevant (a
# backend-only version bump, say) should NOT churn that update. This
# script centralises the "did anything the desktop actually ships
# change?" decision so both the workflow and its test exercise the
# exact same logic.
#
# The desktop app bundles only its own settings UI plus its single
# workspace dependency @stll/ui (packages/ui), which itself has no
# runtime workspace deps. It does NOT embed apps/web or
# packages/folio: desktop<->web compatibility is guaranteed by the
# bridge protocol version handshake (BRIDGE_VERSION in
# apps/desktop/src-tauri/src/types.rs vs MIN_DESKTOP_BRIDGE_VERSION
# in apps/web/src/lib/desktop-bridge.ts), not by version lockstep. So
# the desktop may lawfully skip releases; its version simply has gaps.
#
# Channel-EXACT comparison
# ------------------------
# We compare the current tag only against the most recent PRIOR tag on
# the SAME channel (prod/rc/beta/alpha, via scripts/release-channel.sh)
# that actually has a published desktop manifest. This differs from the
# older inline logic, which compared any prerelease against any other
# prerelease channel. That was not transitive: when rc and beta tags
# interleave, an rc release could diff against an intervening beta and
# leave the previous rc user's manifest permanently stale. Comparing
# same-channel-to-same-channel fixes that, and it is also what makes
# the stable (prod) channel skippable at all (the old code always
# rebuilt stable).
#
# Transitivity / why "has latest.json" is the right marker
# --------------------------------------------------------
# A release that SKIPS still ends up with the previous release's
# latest.json: the workflow's carry-forward job copies the prior
# stable release's desktop assets (installers + latest.json) onto the
# skipped release before flipping it to `--latest`. So "has a
# latest.json asset" marks EVERY release a desktop client would have
# received on that channel, whether freshly built or carried forward.
# Diffing against the most recent such same-channel tag is therefore
# sound: each skipped link in the chain was itself verified diff-empty
# against its own predecessor, so an empty diff against the latest
# shipped-or-carried tag implies no desktop change since the last
# build the user actually installed.
#
# Interface
# ---------
#   bash scripts/detect-desktop-release-changes.sh <current-tag>
# Requires:
#   - GH_TOKEN in the environment (used by `gh release view`).
#   - Run inside the repo checkout with full history AND tags fetched
#     (git diff + git tag both need them).
# Prints GitHub-Actions-output style lines on stdout (so the caller
# can `>> "$GITHUB_OUTPUT"`); all human-readable logging goes to
# stderr:
#   should_build=true|false
#   previous_tag=<tag>     (empty when no comparable predecessor found)
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <current-tag>" >&2
  exit 1
fi

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "::error::GH_TOKEN must be set (used by 'gh release view')" >&2
  exit 1
fi

current_tag="$1"

# Resolve the sibling channel script relative to this file so the
# workflow, the test harness (which runs from a fixture repo cwd),
# and a direct invocation all find the same implementation.
script_dir="$(cd "$(dirname "$0")" && pwd)"
release_channel="$script_dir/release-channel.sh"

current_channel="$(bash "$release_channel" "$current_tag")"
echo "Current tag $current_tag is on channel '$current_channel'" >&2

# Paths whose changes justify a fresh desktop build. Each is here
# because it ends up inside the shipped binary or drives the release
# pipeline that produces it:
#   - apps/desktop/                          the app itself
#   - packages/ui/                           its only workspace dep
#                                            (verified: no transitive
#                                            runtime workspace deps)
#   - scripts/rename-desktop-artifacts.sh    stable artifact naming
#   - scripts/build-updater-manifest.sh      latest.json generation
#   - scripts/release-channel.sh             channel routing
#   - scripts/detect-desktop-release-changes.sh  this decision itself
#   - .github/workflows/release-desktop.yml  the pipeline definition
# Deliberately NOT included:
#   - apps/web/ and packages/folio/: not bundled by the desktop app
#     (the old "the Tauri build embeds the web bundle" comment was
#     stale and wrong; compatibility is the bridge handshake).
#   - VERSION: every tag exists because VERSION bumped, so including
#     it would make the diff never empty and defeat the skip entirely.
rebuild_paths=(
  "apps/desktop/"
  "packages/ui/"
  "scripts/rename-desktop-artifacts.sh"
  "scripts/build-updater-manifest.sh"
  "scripts/release-channel.sh"
  "scripts/detect-desktop-release-changes.sh"
  ".github/workflows/release-desktop.yml"
)

# Find the most recent prior tag on the SAME channel that has a
# published desktop manifest (latest.json). bash 3.2 on macOS runners
# has no `mapfile`, so stream `git tag` through a while-read loop.
previous_tag=""
while IFS= read -r tag; do
  [[ -z "$tag" || "$tag" == "$current_tag" ]] && continue

  # Skip tags whose shape release-channel.sh rejects (e.g. a malformed
  # or non-release tag) rather than aborting the whole run.
  tag_channel="$(bash "$release_channel" "$tag" 2>/dev/null)" || continue
  [[ "$tag_channel" != "$current_channel" ]] && continue

  # Only consider a tag whose GitHub Release actually carries a
  # latest.json asset: that is the marker of a release a desktop
  # client on this channel would have received (built or carried).
  if gh release view "$tag" --json assets --jq '.assets[].name' 2>/dev/null \
    | grep -qx 'latest.json'; then
    previous_tag="$tag"
    break
  fi
done < <(git tag --sort=-creatordate --list 'v*')

if [[ -z "$previous_tag" ]]; then
  echo "No prior '$current_channel' release with a desktop manifest; building." >&2
  echo "should_build=true"
  echo "previous_tag="
  exit 0
fi

echo "Comparing $previous_tag..$current_tag for desktop-relevant changes" >&2
# No `|| true` here: an empty diff still exits 0, so a non-zero status
# means git itself failed (bad revision, shallow history). Swallowing
# that would read as "no changes" and resolve to should_build=false,
# silently shipping a stale desktop; let `set -e` abort instead so the
# workflow fails loudly.
changed="$(git diff --name-only "$previous_tag" "$current_tag" -- "${rebuild_paths[@]}")"

if [[ -n "$changed" ]]; then
  echo "Desktop-relevant changes since $previous_tag:" >&2
  echo "$changed" >&2
  echo "should_build=true"
else
  echo "No desktop-relevant changes since $previous_tag; skipping build." >&2
  echo "should_build=false"
fi
echo "previous_tag=$previous_tag"
