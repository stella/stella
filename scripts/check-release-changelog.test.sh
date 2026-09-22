#!/usr/bin/env bash
#
# Tests for scripts/check-release-changelog.sh: a stable release is either a
# maintenance release or embeds a screenshot or video.
#
# Run locally:    bash scripts/check-release-changelog.test.sh
# Wired into CI in .github/workflows/ci.yml.
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/scripts/check-release-changelog.sh"
PASS=0
FAIL=0
FAIL_NAMES=()

run_case() {
  local name="$1" version="$2" changelog="$3" expected_exit="$4"
  local root actual_out actual_exit
  root="$(mktemp -d)"
  mkdir -p "$root/docs/changelog"
  if [[ -n "$changelog" ]]; then
    printf '%s' "$changelog" > "$root/docs/changelog/v${version}.md"
  fi
  actual_out=$(cd "$root" && bash "$SCRIPT" --version "$version" 2>&1) \
    && actual_exit=0 || actual_exit=$?
  rm -rf "$root"

  if [[ "$actual_exit" != "$expected_exit" ]]; then
    FAIL=$((FAIL + 1))
    FAIL_NAMES+=("$name")
    printf '  ✗  %s (expected exit %s, got %s; output: %s)\n' \
      "$name" "$expected_exit" "$actual_exit" "$actual_out"
    return
  fi
  PASS=$((PASS + 1))
  printf '  ✓  %s\n' "$name"
}

IMAGE='![The new panel](https://github.com/user-attachments/assets/example-image-id)'
VIDEO='<video controls src="https://github.com/user-attachments/assets/example-video-id"></video>'

echo "Running check-release-changelog.sh tests..."

run_case "maintenance release needs no media" "1.2.3" \
  $'# Maintenance release\n\nStella includes reliability and maintenance improvements.\n' 0
run_case "feature release with an image" "1.2.3" \
  $'# Table improvements\n\nFaster sorting.\n\n'"$IMAGE"$'\n' 0
run_case "feature release with a video" "1.2.3" \
  $'# Table improvements\n\n'"$VIDEO"$'\n' 0
run_case "feature release without media" "1.2.3" \
  $'# Table improvements\n\nFaster sorting.\n' 1
run_case "blank changelog" "1.2.3" $'\n' 1
run_case "missing changelog" "1.2.3" "" 1
run_case "maintenance heading below the first line" "1.2.3" \
  $'# Table improvements\n\n# Maintenance release\n' 1
run_case "image over plain http" "1.2.3" \
  $'# Table improvements\n\n![Panel](http://example.com/panel.png)\n' 1
run_case "image inline in a sentence" "1.2.3" \
  $'# Table improvements\n\nSee ![Panel](https://example.com/panel.png) here.\n' 1
run_case "prerelease needs no changelog" "1.2.3-rc.1" "" 0

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -ne 0 ]]; then
  printf 'Failed cases:\n'
  printf '  - %s\n' "${FAIL_NAMES[@]}"
  exit 1
fi
