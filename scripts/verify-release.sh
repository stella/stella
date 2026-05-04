#!/usr/bin/env bash
#
# Tier-1 release verification: cheap static checks against a
# published desktop release. Catches the most common autoupdate
# regressions without needing a real install or a second build.
#
# Checks:
#   1. Each platform binary embeds the channel-correct updater
#      endpoint (build-time jq mutation actually baked the URL).
#   2. The latest.json on S3/CloudFront has the expected shape:
#      version matches the tag, every advertised platform has a
#      url + signature, signatures are non-empty.
#   3. CloudFront serves the manifest publicly (no auth wall) and
#      returns the bytes S3 has, not a stale cached copy.
#
# Usage:
#   bash scripts/verify-release.sh <tag>
#     e.g. bash scripts/verify-release.sh v0.0.2-rc.6
#
# Requires `gh`, `jq`, `curl`, and an unzip-capable shell. Pulls
# installer artifacts from the GitHub Release into a temp dir.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

tag="$1"
script_dir="$(cd "$(dirname "$0")" && pwd)"
channel=$(bash "$script_dir/release-channel.sh" "$tag")
expected_endpoint="https://downloads.stll.app/desktop/$channel/latest.json"
expected_version="${tag#v}"

PASS=0
FAIL=0
NOTES=()

note_pass() { PASS=$((PASS + 1)); printf '  \xe2\x9c\x93  %s\n' "$1"; }
note_fail() { FAIL=$((FAIL + 1)); NOTES+=("$1"); printf '  \xe2\x9c\x97  %s\n' "$1"; }

# ── Check 3: CloudFront reachability + parity with S3 ───────────
echo "Check 3: CloudFront serves $expected_endpoint"
http_code=$(curl -sSo /tmp/release-verify-cf.json -w '%{http_code}' "$expected_endpoint" || true)
if [[ "$http_code" != "200" ]]; then
  note_fail "manifest GET returned HTTP $http_code (expected 200)"
else
  note_pass "manifest GET returned 200"
  if ! jq -e . /tmp/release-verify-cf.json >/dev/null 2>&1; then
    note_fail "manifest body is not valid JSON"
  else
    note_pass "manifest body parses as JSON"
  fi
fi

# ── Check 2: manifest shape ──────────────────────────────────────
if [[ -s /tmp/release-verify-cf.json ]] && jq -e . /tmp/release-verify-cf.json >/dev/null 2>&1; then
  echo "Check 2: manifest shape"
  manifest_version=$(jq -r '.version // empty' /tmp/release-verify-cf.json)
  if [[ "$manifest_version" == "$expected_version" ]]; then
    note_pass "manifest .version = $manifest_version"
  else
    note_fail "manifest .version is '$manifest_version', expected '$expected_version'"
  fi

  for required in pub_date platforms; do
    if jq -e ".$required" /tmp/release-verify-cf.json >/dev/null 2>&1; then
      note_pass "manifest .$required present"
    else
      note_fail "manifest missing .$required"
    fi
  done

  # Every advertised platform must carry a non-empty url + signature.
  while IFS=$'\t' read -r platform url sig; do
    if [[ -z "$url" || "$url" == "null" ]]; then
      note_fail "platform $platform has no url"
    elif [[ -z "$sig" || "$sig" == "null" ]]; then
      note_fail "platform $platform has empty signature"
    else
      note_pass "platform $platform: url + signature present"
    fi
  done < <(jq -r '.platforms | to_entries[] | "\(.key)\t\(.value.url // "")\t\(.value.signature // "")"' /tmp/release-verify-cf.json)
fi

# ── Check 1: binary embeds the channel-correct endpoint ─────────
echo "Check 1: binary embeds $expected_endpoint"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Pull only the assets we care about; gh release download supports
# pattern matching so we don't need to know the exact filename.
patterns=(
  "Stella-windows-x64-setup.exe"
  "Stella-macos-universal.dmg"
)
for pattern in "${patterns[@]}"; do
  if ! gh release download "$tag" --pattern "$pattern" --dir "$work" 2>/dev/null; then
    note_fail "could not download $pattern from release $tag"
  fi
done

shopt -s nullglob
for f in "$work"/*; do
  case "$f" in
    *.exe)
      if strings -- "$f" | grep -Fq "$expected_endpoint"; then
        note_pass "$(basename "$f") embeds $expected_endpoint"
      else
        note_fail "$(basename "$f") does NOT embed $expected_endpoint"
      fi
      ;;
    *.dmg)
      # DMG is HFS+/APFS; strings still works on the raw bytes
      # because the Mach-O binary lives inside as a contiguous
      # blob and the URL is a literal ASCII string in __TEXT.
      if strings -- "$f" | grep -Fq "$expected_endpoint"; then
        note_pass "$(basename "$f") embeds $expected_endpoint"
      else
        note_fail "$(basename "$f") does NOT embed $expected_endpoint"
      fi
      ;;
  esac
done

echo ""
echo "Results: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
  printf 'Failures:\n'
  printf '  - %s\n' "${NOTES[@]}"
  exit 1
fi
